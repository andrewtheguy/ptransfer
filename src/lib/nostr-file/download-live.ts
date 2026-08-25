import { wipeBufferSource } from '../crypto/memory';
import { generateEphemeralKeys, uint8ArrayToBase64 } from '../nostr/events';
import { assembleChunks, decompressPayload, sha256 } from './codec';
import {
  CLOCK_SKEW_TOLERANCE_SEC,
  LIVE_FETCH_RETRY_MS,
  LIVE_IDLE_TIMEOUT_MS,
} from './constants';
import {
  type ChunkPlacement,
  type ControlChannel,
  decodePosition,
  deriveControlKey,
  openControlChannel,
  parseSenderMessage,
} from './control';
import {
  assertManifestWindow,
  fetchChunksFromRelay,
  importDecryptKey,
} from './fetch';
import type { NostrFileManifest } from './manifest';
import type { NostrFilePool } from './pool';
import type { RelaySession } from './session';
import {
  createTransferStats,
  type NostrFileTransferStats,
  relayStatsFor,
} from './stats';
import { Deferred } from './sync';
import { NostrFileCancelledError } from './upload';

export interface LiveReceiveProgress {
  /** Null until the sender's manifest has arrived. */
  manifest: NostrFileManifest | null;
  chunksDone: number;
  /** 0 until the manifest has arrived. */
  chunksTotal: number;
  /** chunks the sender has announced as uploaded */
  available: number;
  /** the sender has sent at least one control message */
  senderConnected: boolean;
  /** Running totals for the whole transfer; one object, mutated in place. */
  stats: NostrFileTransferStats;
}

/**
 * Live (single-copy) relay transfer, receiver side — the Code Exchange
 * data path when no direct connection could be made.
 *
 * Joins the control channel on the offer's control relays with the session
 * derived from the exchange's ECDH secret, waits for the sender's manifest
 * (its first message; a late joiner reads it from the backlog), then follows
 * the sender's availability announcements: the announcements carry the data
 * ring (adopted on first sight; empty while the sender is still discovering
 * storage relays), and each announced chunk is fetched from the one ring
 * relay it was placed on; whatever cannot be fetched or decrypted is
 * reported back with the placement that was tried, and retried when the
 * sender announces a new placement for it — or from the same placement once
 * LIVE_FETCH_RETRY_MS has passed, on the receiver's own clock, so a piece
 * whose fetch merely timed out recovers even when no announcement arrives.
 * Resolves with the verified file.
 */
export async function receiveFileLive(
  session: RelaySession,
  controlRelays: string[],
  opts: {
    onProgress: (p: LiveReceiveProgress) => void;
    isCancelled: () => boolean;
    pool: NostrFilePool;
    /**
     * unix seconds: the exchange's own start, backdated for the subscription
     * lower bound so a manifest published before this side joined is read
     * from the backlog.
     */
    since: number;
    /** unix seconds: the exchange's deadline, stamped on our own events. */
    expiresAt: number;
  },
): Promise<Uint8Array> {
  const { onProgress, isCancelled, pool } = opts;
  const { transferId, keyBytes } = session;

  let controlKey: CryptoKey;
  try {
    controlKey = await deriveControlKey(keyBytes, transferId);
  } catch (err) {
    wipeBufferSource(keyBytes);
    throw err;
  }
  const aesKey = await importDecryptKey(keyBytes);
  const { secretKey } = generateEphemeralKeys();

  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };

  // Everything sized by the manifest is bound once it arrives.
  let manifest: NostrFileManifest | null = null;
  let total = 0;
  let chunks: (Uint8Array | null)[] = [];
  // Placement ([pos, gen]) last tried for a chunk still missing, and when
  // that attempt finished — after LIVE_FETCH_RETRY_MS the same placement
  // becomes retryable (a transient fetch failure must not need a re-send).
  let lastTried: ([number, number] | null)[] = [];
  let lastTriedAt = new Float64Array(0);
  // Data ring, adopted from the first availability announcement carrying one.
  let ring: string[] = [];
  let chunksDone = 0;
  let upto = 0;
  // Latest announced placement: ring position per chunk and re-send
  // generation for the chunks that were re-sent.
  let map = '';
  const gens = new Map<number, number>();
  let lastSenderN = 0;
  let lastPeerAt = 0;
  const startedAt = Date.now();

  const stats = createTransferStats('receiver');
  for (const relay of controlRelays) relayStatsFor(stats, relay, 'control');

  let finished = false;
  let succeeded = false;
  let cycleRunning = false;
  let cyclePending = false;
  let lastCycleStartedAt = 0;
  let cyclePromise: Promise<void> = Promise.resolve();
  const outcome = new Deferred<Uint8Array>();

  const fail = (err: unknown) => {
    if (finished) return;
    finished = true;
    outcome.reject(err);
  };
  const succeed = (data: Uint8Array) => {
    if (finished) return;
    finished = true;
    succeeded = true;
    outcome.resolve(data);
  };
  const report = () => {
    stats.phaseMs.transfer = Date.now() - startedAt;
    onProgress({
      manifest,
      chunksDone,
      chunksTotal: total,
      available: upto,
      senderConnected: lastPeerAt > 0,
      stats,
    });
  };
  const placementOf = (index: number): [number, number] => [
    decodePosition(map[index]),
    gens.get(index) ?? 0,
  ];

  try {
    let channel: ControlChannel | null = null;

    // One fetch cycle: fetch whatever the latest announcement made available,
    // report the outcome, and repeat while another announcement queued a pass.
    const runCycle = async (
      ch: ControlChannel,
      manifest: NostrFileManifest,
    ): Promise<void> => {
      cycleRunning = true;
      try {
        do {
          cyclePending = false;
          lastCycleStartedAt = Date.now();
          stats.ackCycles++;
          const availN = lastSenderN;
          const byPos = new Map<number, number[]>();
          const tried = new Map<number, [number, number]>();
          for (let i = 0; i < upto; i++) {
            if (chunks[i]) continue;
            const [pos, gen] = placementOf(i);
            const prev = lastTried[i];
            if (
              prev &&
              prev[0] === pos &&
              prev[1] === gen &&
              lastCycleStartedAt - lastTriedAt[i] < LIVE_FETCH_RETRY_MS
            ) {
              continue;
            }
            tried.set(i, [pos, gen]);
            const list = byPos.get(pos) ?? [];
            list.push(i);
            byPos.set(pos, list);
          }
          await Promise.all(
            [...byPos].map(([pos, indices]) =>
              fetchChunksFromRelay(
                pool,
                transferId,
                manifest,
                aesKey,
                ring[pos],
                indices,
                {
                  have: (index) => chunks[index] !== null,
                  onChunk: (index, plaintext) => {
                    chunks[index] = plaintext;
                    chunksDone++;
                    report();
                  },
                  throwIfCancelled,
                  stats,
                },
              ),
            ),
          );
          for (const [index, placement] of tried) {
            if (!chunks[index]) {
              lastTried[index] = placement;
              lastTriedAt[index] = Date.now();
            }
          }
          if (finished) return;
          // Report the placement actually tried, never the latest announced
          // one: an announcement landing mid-cycle would otherwise blame a
          // relay this cycle never asked, costing a needless re-send and a
          // false strike against a healthy relay. A placement the sender has
          // already replaced is ignored on its side.
          const missing: ChunkPlacement[] = [];
          for (let i = 0; i < upto; i++) {
            const placement = lastTried[i];
            if (chunks[i] || !placement) continue;
            missing.push([i, placement[0], placement[1]]);
          }
          stats.missingReported += missing.length;
          await ch.send({
            t: 'ack',
            avail: availN,
            have: chunksDone,
            missing,
          });
          if (chunksDone === total) {
            // Chunks carry the compressed payload; the file hash covers the
            // decompressed plaintext, so inflate first (bounded by the
            // manifest's fileSize), then verify.
            const data = decompressPayload(
              assembleChunks(chunks, manifest.payloadSize),
              manifest.compression,
              manifest.fileSize,
            );
            const hash = uint8ArrayToBase64(await sha256(data));
            if (hash !== manifest.fileHash) {
              throw new Error(
                'File integrity check failed — the download was corrupted',
              );
            }
            // The file is complete and verified — hand it over first, then
            // tell the sender as a courtesy. A `done` no relay would take
            // must not sink a download that already succeeded; the sender's
            // idle watchdog covers a lost one.
            succeed(data);
            await ch.send({ t: 'done' }).catch(() => {});
            return;
          }
        } while (cyclePending && !finished);
      } finally {
        cycleRunning = false;
      }
    };

    // Announcements coalesce: one arriving mid-cycle queues exactly one more
    // pass. The guard stays out here so `cyclePromise` always tracks the
    // in-flight cycle — the teardown awaits it before closing the channel.
    const scheduleCycle = () => {
      if (!channel || !manifest) return;
      if (cycleRunning) {
        cyclePending = true;
        return;
      }
      cyclePromise = runCycle(channel, manifest).catch(fail);
    };

    // The sender's pubkey is learned from the manifest, so the subscription
    // cannot be narrowed by author up front; a message is trusted because it
    // opened under the session key, and once the manifest names the sender
    // every other author is ignored.
    channel = openControlChannel(pool, controlRelays, {
      transferId,
      key: controlKey,
      role: 'receiver',
      secretKey,
      since: opts.since - CLOCK_SKEW_TOLERANCE_SEC,
      expiresAt: opts.expiresAt,
      stats,
      onMessage: (raw, pubkey) => {
        if (finished) return;
        if (manifest && pubkey !== manifest.pubkey) return;
        const msg = parseSenderMessage(raw, manifest ? total : null);
        if (!msg || msg.n <= lastSenderN) return;
        if (msg.t === 'manifest') {
          // Exactly one manifest, and only from the key it names.
          if (manifest || msg.manifest.pubkey !== pubkey) return;
          try {
            assertManifestWindow(msg.manifest);
          } catch (err) {
            fail(err);
            return;
          }
          manifest = msg.manifest;
          total = manifest.totalChunks;
          chunks = new Array(total).fill(null);
          lastTried = new Array(total).fill(null);
          lastTriedAt = new Float64Array(total);
          stats.fileBytes = manifest.fileSize;
          stats.payloadBytes = manifest.payloadSize;
          stats.chunkSize = manifest.chunkSize;
          stats.chunksTotal = total;
          lastSenderN = msg.n;
          lastPeerAt = Date.now();
          report();
          return;
        }
        if (msg.t === 'avail' && msg.relays.length > 0) {
          if (ring.length === 0) {
            ring = msg.relays;
            for (const relay of ring) relayStatsFor(stats, relay, 'storage');
          } else if (
            msg.relays.length !== ring.length ||
            msg.relays.some((r, i) => r !== ring[i])
          ) {
            // The sender never changes its ring — a different one is forged
            // or corrupt. Dropped before bumping lastSenderN.
            return;
          }
        }
        lastSenderN = msg.n;
        lastPeerAt = Date.now();
        if (msg.t === 'cancel') {
          fail(new Error('The sender cancelled the transfer'));
          return;
        }
        upto = msg.upto;
        map = msg.map;
        gens.clear();
        for (const [index, gen] of msg.gens) gens.set(index, gen);
        report();
        // An empty-ring announcement is presence only — nothing to fetch.
        if (ring.length > 0 && upto > 0) scheduleCycle();
      },
    });
    const openChannel = channel;

    const watchdog = setInterval(() => {
      if (finished) return;
      if (isCancelled()) {
        fail(new NostrFileCancelledError());
        return;
      }
      const now = Date.now();
      if (now / 1000 > (manifest ? manifest.expiresAt : opts.expiresAt)) {
        fail(
          new Error(
            'The transfer expired before all pieces arrived — relay copies are only kept for 1 hour. Ask the sender to start a new transfer.',
          ),
        );
        return;
      }
      const sinceSender = now - (lastPeerAt > 0 ? lastPeerAt : startedAt);
      if (sinceSender > LIVE_IDLE_TIMEOUT_MS) {
        fail(
          new Error(
            lastPeerAt > 0
              ? 'The sender stopped responding. Both pages must stay open until the transfer completes.'
              : "No response from the sender over the relays. Make sure the sender's page is still open.",
          ),
        );
        return;
      }
      // Retry clock: with announced pieces still missing, run a cycle even
      // when no new announcement arrives — cooled-down placements are fetched
      // again and the missing list is re-asked, so a piece whose fetch timed
      // out never waits on the sender forever.
      if (
        ring.length > 0 &&
        upto > chunksDone &&
        !cycleRunning &&
        now - lastCycleStartedAt >= LIVE_FETCH_RETRY_MS
      ) {
        scheduleCycle();
      }
    }, 1000);

    try {
      report();
      await openChannel.send({ t: 'hello' });
      return await outcome.promise;
    } finally {
      finished = true;
      clearInterval(watchdog);
      await Promise.allSettled([cyclePromise]);
      if (!succeeded) {
        // Best effort: let the sender stop re-sending right away.
        await Promise.race([
          openChannel.send({ t: 'cancel' }).catch(() => {}),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
      openChannel.close();
    }
  } finally {
    wipeBufferSource(secretKey);
  }
}
