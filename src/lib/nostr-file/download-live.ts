import { wipeBufferSource } from '../crypto/memory';
import { generateEphemeralKeys, uint8ArrayToBase64 } from '../nostr/events';
import { assembleChunks, sha256 } from './codec';
import { CLOCK_SKEW_TOLERANCE_SEC, LIVE_IDLE_TIMEOUT_MS } from './constants';
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
import {
  createTransferStats,
  type NostrFileTransferStats,
  relayStatsFor,
} from './stats';
import { Deferred } from './sync';
import { NostrFileCancelledError } from './upload';

export interface LiveReceiveProgress {
  chunksDone: number;
  chunksTotal: number;
  /** chunks the sender has announced as uploaded */
  available: number;
  /** the sender has sent at least one control message */
  senderConnected: boolean;
  /** Running totals for the whole transfer; one object, mutated in place. */
  stats: NostrFileTransferStats;
}

/**
 * Live (single-copy) relay transfer, receiver side.
 *
 * Joins the control channel on the manifest's control relays, then follows
 * the sender's availability announcements: the announcements carry the data
 * ring (adopted on first sight; empty while the sender is still discovering
 * storage relays), and each announced chunk is fetched from the one ring
 * relay it was placed on; whatever cannot be fetched or decrypted is
 * reported back with the placement that was tried, and retried only once the
 * sender announces a new placement for it. Resolves with the verified file.
 */
export async function receiveFileLive(
  manifest: NostrFileManifest,
  keyBytes: Uint8Array,
  opts: {
    onProgress: (p: LiveReceiveProgress) => void;
    isCancelled: () => boolean;
    pool: NostrFilePool;
  },
): Promise<Uint8Array> {
  const { onProgress, isCancelled, pool } = opts;

  assertManifestWindow(manifest, keyBytes);
  let controlKey: CryptoKey;
  try {
    controlKey = await deriveControlKey(keyBytes, manifest.transferId);
  } catch (err) {
    wipeBufferSource(keyBytes);
    throw err;
  }
  const aesKey = await importDecryptKey(keyBytes);
  const { secretKey } = generateEphemeralKeys();

  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };

  const controlRelays = manifest.controlRelays;
  // Data ring, adopted from the first availability announcement carrying one.
  let ring: string[] = [];
  const total = manifest.totalChunks;
  const chunks: (Uint8Array | null)[] = new Array(total).fill(null);
  let chunksDone = 0;
  let upto = 0;
  // Latest announced placement: ring position per chunk and re-send
  // generation for the chunks that were re-sent.
  let map = '';
  const gens = new Map<number, number>();
  // Placement ([pos, gen]) last tried for a chunk still missing.
  const lastTried: ([number, number] | null)[] = new Array(total).fill(null);
  let lastSenderN = 0;
  let lastPeerAt = 0;
  const startedAt = Date.now();

  const stats = createTransferStats('receiver');
  stats.fileBytes = manifest.fileSize;
  stats.chunkSize = manifest.chunkSize;
  stats.chunksTotal = total;
  for (const relay of controlRelays) relayStatsFor(stats, relay, 'control');

  let finished = false;
  let succeeded = false;
  let cycleRunning = false;
  let cyclePending = false;
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
    const runCycle = async (ch: ControlChannel): Promise<void> => {
      cycleRunning = true;
      try {
        do {
          cyclePending = false;
          stats.ackCycles++;
          const availN = lastSenderN;
          const byPos = new Map<number, number[]>();
          const tried = new Map<number, [number, number]>();
          for (let i = 0; i < upto; i++) {
            if (chunks[i]) continue;
            const [pos, gen] = placementOf(i);
            const prev = lastTried[i];
            if (prev && prev[0] === pos && prev[1] === gen) continue;
            tried.set(i, [pos, gen]);
            const list = byPos.get(pos) ?? [];
            list.push(i);
            byPos.set(pos, list);
          }
          await Promise.all(
            [...byPos].map(([pos, indices]) =>
              fetchChunksFromRelay(pool, manifest, aesKey, ring[pos], indices, {
                have: (index) => chunks[index] !== null,
                onChunk: (index, plaintext) => {
                  chunks[index] = plaintext;
                  chunksDone++;
                  report();
                },
                throwIfCancelled,
                stats,
              }),
            ),
          );
          for (const [index, placement] of tried) {
            if (!chunks[index]) lastTried[index] = placement;
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
            const data = assembleChunks(chunks, manifest.fileSize);
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
      if (!channel) return;
      if (cycleRunning) {
        cyclePending = true;
        return;
      }
      cyclePromise = runCycle(channel).catch(fail);
    };

    channel = openControlChannel(pool, controlRelays, {
      transferId: manifest.transferId,
      key: controlKey,
      role: 'receiver',
      secretKey,
      since: manifest.createdAt - CLOCK_SKEW_TOLERANCE_SEC,
      expiresAt: manifest.expiresAt,
      authors: [manifest.pubkey],
      stats,
      onMessage: (raw, pubkey) => {
        if (finished || pubkey !== manifest.pubkey) return;
        const msg = parseSenderMessage(raw, total);
        if (!msg || msg.n <= lastSenderN) return;
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
      if (now / 1000 > manifest.expiresAt) {
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
              : "No response from the sender. Make sure the sender's page is still open and showing the code.",
          ),
        );
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
