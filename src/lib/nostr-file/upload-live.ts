import { wipeBufferSource } from '../crypto/memory';
import { generateEphemeralKeys, uint8ArrayToBase64 } from '../nostr/events';
import {
  chunkAad,
  compressPayload,
  encodeChunkContent,
  sha256,
  splitIntoChunks,
} from './codec';
import {
  CLOCK_SKEW_TOLERANCE_SEC,
  LIVE_BATCH_CHUNKS,
  LIVE_HEARTBEAT_MS,
  LIVE_IDLE_TIMEOUT_MS,
  LIVE_MIN_RETRANSMITS_PER_CHUNK,
  LIVE_RELAY_DEMOTE_GIVEUPS,
  LIVE_RELAY_DEMOTE_MISSES,
  NOSTR_FILE_CHUNK_SIZE,
  NOSTR_FILE_EXPIRATION_SEC,
  NOSTR_FILE_MANIFEST_VERSION,
  NOSTR_FILE_MAX_BYTES,
  UPLOAD_CHUNK_CONCURRENCY,
} from './constants';
import {
  type AckMessage,
  type AvailMessage,
  deriveControlKey,
  encodePosition,
  openControlChannel,
  parseReceiverMessage,
} from './control';
import { buildChunkEvent } from './events';
import type { NostrFileManifest } from './manifest';
import type { NostrFilePool } from './pool';
import type { RelaySession } from './session';
import { type NostrFileTransferStats, relayStatsFor } from './stats';
import { Deferred, Signal } from './sync';
import {
  NostrFileCancelledError,
  type PreparedStorageRelays,
  publishWithRetry,
} from './upload';

export interface LiveSendProgress {
  phase: 'hashing' | 'transfer';
  chunksDone?: number;
  chunksTotal?: number;
  /** transfer phase: the receiver has sent at least one control message */
  receiverConnected?: boolean;
  /** transfer phase: chunks the receiver reported holding */
  receiverHave?: number;
  /** transfer phase: chunks re-sent after the receiver could not fetch them */
  resent?: number;
  /** transfer phase: relays no longer used because the receiver cannot read from them */
  relaysDemoted?: number;
  /** Running totals for the whole transfer; one object, mutated in place. */
  stats: NostrFileTransferStats;
}

/**
 * Live (single-copy) relay transfer, sender side — the Code Exchange data
 * path when no direct connection could be made.
 *
 * Nothing is uploaded ahead of time: this runs only once WebRTC has failed.
 * The session (transfer id + file key) was derived from the exchange's ECDH
 * secret on both sides, the control relays are the ones the offer named, and
 * the storage ring was already being prepared behind the exchange
 * (`prepareStorageRelays`), so the first thing this does is hash and chunk
 * the file and send the manifest over the encrypted control channel; the
 * ring is adopted as soon as it resolves. The sender then stays online: each chunk is published to one ring relay (chunk i → ring[i % N],
 * walking the ring on rejection), the ring itself plus availability are
 * announced over the encrypted control channel after every LIVE_BATCH_CHUNKS
 * chunks, and the receiver's acknowledgements name the
 * chunks it could not fetch — only those are re-sent, to another relay.
 * A relay the receiver keeps missing chunks on (it acknowledges writes but
 * does not serve them) is demoted: new chunks and re-sends skip it while
 * any other relay is left. Resolves once the receiver reports the verified
 * file, or throws when the transfer cannot complete (relay failure, expiry,
 * peer gone).
 */
export async function sendFileLive(
  data: Uint8Array,
  meta: {
    fileName: string;
    mimeType: string;
    /** Payloads from the multi-file/folder ZIP flow are never recompressed. */
    precompressed: boolean;
  },
  opts: {
    /** Ownership of `session.keyBytes` transfers here; it is wiped on return. */
    session: RelaySession;
    /** Proven signaling relays carrying the control channel (from the offer). */
    controlRelays: string[];
    /**
     * The storage ring being prepared behind the exchange, on the same pool.
     * Its discovery tallies are continued here; the background sweep behind
     * it belongs to the caller and runs on.
     */
    storageRelays: PreparedStorageRelays;
    onProgress: (p: LiveSendProgress) => void;
    isCancelled: () => boolean;
    pool: NostrFilePool;
  },
): Promise<void> {
  const { onProgress, isCancelled, pool, controlRelays } = opts;
  const { transferId, keyBytes } = opts.session;

  if (data.length === 0) {
    wipeBufferSource(keyBytes);
    throw new Error('Cannot send an empty file');
  }
  if (data.length > NOSTR_FILE_MAX_BYTES) {
    wipeBufferSource(keyBytes);
    throw new Error(
      `File too large for Nostr relay transfer (max ${NOSTR_FILE_MAX_BYTES / (1024 * 1024)} MiB)`,
    );
  }

  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };

  const stats = opts.storageRelays.stats;
  stats.fileBytes = data.length;
  stats.chunkSize = NOSTR_FILE_CHUNK_SIZE;
  for (const relay of controlRelays) relayStatsFor(stats, relay, 'control');

  const { secretKey, publicKey } = generateEphemeralKeys();
  try {
    onProgress({ phase: 'hashing', stats });
    const hashStarted = Date.now();
    const fileHash = uint8ArrayToBase64(await sha256(data));
    stats.phaseMs.hash = Date.now() - hashStarted;
    // One deflate pass over the whole file before chunking, so a compressible
    // file collapses into few chunks. A payload the multi-file/folder flow
    // already compressed (a ZIP with deflated entries) travels as-is instead of
    // being recompressed.
    const compressStarted = Date.now();
    const { payload, compression } = compressPayload(data, meta.precompressed);
    stats.phaseMs.compress = Date.now() - compressStarted;
    stats.payloadBytes = payload.length;
    const aesKey = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const controlKey = await deriveControlKey(keyBytes, transferId);
    const chunks = splitIntoChunks(payload, NOSTR_FILE_CHUNK_SIZE);
    const total = chunks.length;
    stats.chunksTotal = total;
    throwIfCancelled();

    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + NOSTR_FILE_EXPIRATION_SEC;
    const manifest: NostrFileManifest = {
      v: NOSTR_FILE_MANIFEST_VERSION,
      fileName: meta.fileName,
      fileSize: data.length,
      mimeType: meta.mimeType,
      fileHash,
      pubkey: publicKey,
      compression,
      payloadSize: payload.length,
      chunkSize: NOSTR_FILE_CHUNK_SIZE,
      totalChunks: total,
      enc: 2,
      createdAt,
      expiresAt,
    };

    // Placement state. `placedPos[i]` is the ring position holding chunk i
    // (-1 while unplaced), `gen[i]` how many times it was re-sent, and
    // `nextOffset[i]` where the next attempt starts walking the ring.
    const placedPos = new Int32Array(total).fill(-1);
    const gen = new Uint32Array(total);
    const nextOffset = new Uint32Array(total);
    // The data ring is late-bound: it was being prepared behind the exchange
    // and may still be resolving. Empty ring = still looking.
    let ring: string[] = [];
    let ringSize = 0;
    let maxRetransmits = LIVE_MIN_RETRANSMITS_PER_CHUNK;
    // Receiver-reported misses and publish give-ups per ring position; a
    // position past either threshold is demoted (never all of them —
    // something must stay).
    let misses = new Uint32Array(0);
    let giveUps = new Uint32Array(0);
    const demoted = new Set<number>();
    let upto = 0; // chunks [0, upto) are all placed
    let chunksDone = 0;
    let resent = 0;
    let nextChunk = 0;
    const retryQueue: number[] = [];
    const pendingRetry = new Set<number>();

    let finished = false;
    let succeeded = false;
    const outcome = new Deferred<void>();
    const work = new Signal();
    const control = new Signal();
    let availDirty = false;

    let receiverPubkey: string | null = null;
    let receiverHave = 0;
    let lastPeerN = 0;
    let lastPeerAt = 0;

    const stop = () => {
      finished = true;
      work.notify();
      control.notify();
    };
    const fail = (err: unknown) => {
      if (finished) return;
      outcome.reject(err);
      stop();
    };
    const succeed = () => {
      if (finished) return;
      succeeded = true;
      outcome.resolve();
      stop();
    };
    const transferStarted = Date.now();
    const report = () => {
      stats.chunksResent = resent;
      stats.relaysDemoted = demoted.size;
      stats.phaseMs.transfer = Date.now() - transferStarted;
      onProgress({
        phase: 'transfer',
        chunksDone,
        chunksTotal: total,
        receiverConnected: receiverPubkey !== null,
        receiverHave,
        resent,
        relaysDemoted: demoted.size,
        stats,
      });
    };

    /**
     * Ring positions to try for a chunk, starting at `startOffset` from its
     * home position: healthy relays first (in ring order), demoted ones only
     * as a last resort.
     */
    const candidatePositions = (index: number, startOffset: number) => {
      const healthy: number[] = [];
      const fallback: number[] = [];
      for (let j = 0; j < ringSize; j++) {
        const pos = (index + ((startOffset + j) % ringSize)) % ringSize;
        (demoted.has(pos) ? fallback : healthy).push(pos);
      }
      return [...healthy, ...fallback];
    };

    const demote = (pos: number) => {
      if (demoted.size >= ringSize - 1) return;
      demoted.add(pos);
      relayStatsFor(stats, ring[pos], 'storage').demoted = true;
    };

    const handleAck = (msg: AckMessage) => {
      receiverHave = Math.max(receiverHave, msg.have);
      for (const [index, pos, g] of msg.missing) {
        // The receiver tried a placement we have since replaced — it will
        // see the new one on the next announcement.
        if (placedPos[index] !== pos || gen[index] !== g) continue;
        if (pendingRetry.has(index)) continue;
        misses[pos]++;
        relayStatsFor(stats, ring[pos], 'storage').missesReported++;
        if (misses[pos] >= LIVE_RELAY_DEMOTE_MISSES) demote(pos);
        if (gen[index] >= maxRetransmits) {
          fail(
            new Error(
              `Piece ${index + 1} of ${total} could not be delivered after ${gen[index]} re-sends — transfer aborted`,
            ),
          );
          return;
        }
        pendingRetry.add(index);
        retryQueue.push(index);
      }
      work.notify();
    };

    const channel = openControlChannel(pool, controlRelays, {
      transferId,
      key: controlKey,
      role: 'sender',
      secretKey,
      since: createdAt - CLOCK_SKEW_TOLERANCE_SEC,
      expiresAt,
      stats,
      onMessage: (raw, pubkey) => {
        if (finished || pubkey === publicKey) return;
        // First valid peer wins; only the code holder can seal messages.
        if (receiverPubkey !== null && pubkey !== receiverPubkey) return;
        const msg = parseReceiverMessage(raw, total, ringSize);
        if (!msg || msg.n <= lastPeerN) return;
        lastPeerN = msg.n;
        receiverPubkey = pubkey;
        lastPeerAt = Date.now();
        switch (msg.t) {
          case 'hello':
            // The receiver just joined: announce what is already placed now
            // instead of leaving it idle until the next heartbeat (a relay
            // that will not serve the stored backlog gives it nothing).
            availDirty = true;
            control.notify();
            break;
          case 'ack':
            handleAck(msg);
            break;
          case 'done':
            succeed();
            return;
          case 'cancel':
            fail(new Error('The receiver cancelled the transfer'));
            return;
        }
        report();
      },
    });

    try {
      // The manifest goes first, ahead of any availability, so a receiver
      // that joins late reads it from the backlog before the placements.
      await channel.send({ t: 'manifest', manifest });
      report();

      const buildAvail = (): Omit<AvailMessage, 'n'> => {
        let map = '';
        const gens: [number, number][] = [];
        for (let i = 0; i < upto; i++) {
          map += encodePosition(placedPos[i]);
          if (gen[i] !== 0) gens.push([i, gen[i]]);
        }
        return { t: 'avail', upto, relays: ring, map, gens };
      };

      const worker = async (): Promise<void> => {
        while (!finished) {
          throwIfCancelled();
          let index: number;
          let isRetry = false;
          if (retryQueue.length > 0) {
            index = retryQueue.shift() as number;
            isRetry = true;
          } else if (nextChunk < total) {
            index = nextChunk++;
          } else {
            await work.wait(1000);
            continue;
          }
          const aad = chunkAad(transferId, index, total);
          const content = await encodeChunkContent(aesKey, chunks[index], aad);
          if (!isRetry) stats.encodedBytes += content.length;
          const event = buildChunkEvent(secretKey, {
            transferId,
            index,
            total,
            content,
            createdAt,
          });
          // Walk the ring from this chunk's next offset (healthy relays
          // first) until one accepts; a re-send therefore starts past the
          // relay the receiver could not read from. Candidates are re-ranked
          // before every attempt so a demotion that lands mid-walk counts.
          let placed = -1;
          const tried = new Set<number>();
          while (placed < 0 && tried.size < ringSize) {
            if (finished) return;
            throwIfCancelled();
            const pos = candidatePositions(index, nextOffset[index]).find(
              (p) => !tried.has(p),
            );
            if (pos === undefined) break;
            tried.add(pos);
            nextOffset[index] =
              (((pos - index) % ringSize) + ringSize + 1) % ringSize;
            if (
              await publishWithRetry(pool, ring[pos], event, isCancelled, stats)
            ) {
              placed = pos;
            } else if (++giveUps[pos] >= LIVE_RELAY_DEMOTE_GIVEUPS) {
              // Rejected through every retry: stop starting walks here.
              demote(pos);
            }
          }
          throwIfCancelled();
          if (placed < 0) {
            throw new Error(
              `Chunk ${index + 1}/${total} could not be saved to any relay — transfer aborted`,
            );
          }
          placedPos[index] = placed;
          if (isRetry) {
            gen[index]++;
            resent++;
            pendingRetry.delete(index);
          } else {
            chunksDone++;
          }
          const prevUpto = upto;
          while (upto < total && placedPos[upto] >= 0) upto++;
          if (
            isRetry ||
            upto === total ||
            Math.floor(prevUpto / LIVE_BATCH_CHUNKS) !==
              Math.floor(upto / LIVE_BATCH_CHUNKS)
          ) {
            availDirty = true;
            control.notify();
          }
          report();
        }
      };

      // Announce new availability as soon as it exists; otherwise repeat the
      // latest announcement on every heartbeat so a lost message (either
      // direction) is recovered on the next beat.
      const controlLoop = async (): Promise<void> => {
        while (!finished) {
          if (!availDirty) {
            await control.wait(LIVE_HEARTBEAT_MS);
            if (finished) break;
          }
          availDirty = false;
          await channel.send(buildAvail());
        }
      };

      const watchdog = setInterval(() => {
        if (finished) return;
        if (isCancelled()) {
          fail(new NostrFileCancelledError());
          return;
        }
        const now = Date.now();
        if (now / 1000 > expiresAt) {
          fail(
            new Error(
              'The relay copies expired before the receiver finished. Start a new transfer.',
            ),
          );
          return;
        }
        if (
          upto === total &&
          lastPeerAt > 0 &&
          now - lastPeerAt > LIVE_IDLE_TIMEOUT_MS
        ) {
          fail(
            new Error(
              'The receiver stopped responding. Ask them to keep the page open and try again.',
            ),
          );
        }
      }, 1000);

      // First announcement goes out right away: an empty-ring avail tells a
      // receiver that the sender is here while storage relays are still
      // being found.
      availDirty = true;
      const loop = controlLoop().catch(fail);

      // The ring lands whenever its preparation finishes; workers exist only
      // once it does. A failure rejects `outcome`, and the teardown's
      // best-effort cancel tells a waiting receiver to stop.
      let workers: Promise<unknown> = Promise.resolve();
      const uploadStart = (async () => {
        const dataRelays = await opts.storageRelays.ring;
        if (finished) return;
        ring = dataRelays;
        ringSize = dataRelays.length;
        misses = new Uint32Array(ringSize);
        giveUps = new Uint32Array(ringSize);
        maxRetransmits = Math.max(ringSize, LIVE_MIN_RETRANSMITS_PER_CHUNK);
        availDirty = true;
        control.notify();
        workers = Promise.all(
          Array.from(
            { length: Math.min(UPLOAD_CHUNK_CONCURRENCY, total) },
            () => worker().catch(fail),
          ),
        );
      })().catch(fail);

      try {
        await outcome.promise;
      } finally {
        stop();
        clearInterval(watchdog);
        await Promise.allSettled([uploadStart, workers, loop]);
        if (!succeeded) {
          // Best effort: let the receiver stop waiting right away.
          await Promise.race([
            channel.send({ t: 'cancel' }).catch(() => {}),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        }
      }
    } finally {
      channel.close();
    }
  } finally {
    wipeBufferSource(keyBytes);
    wipeBufferSource(secretKey);
  }
}
