import type { Event } from 'nostr-tools';
import { wipeBufferSource } from '../crypto/memory';
import { generateEphemeralKeys, uint8ArrayToBase64 } from '../nostr/events';
import { chunkAad, encodeChunkContent, sha256, splitIntoChunks } from './codec';
import {
  CHUNK_REPLICATION,
  MIN_CHUNK_RELAY_SUCCESS,
  NOSTR_FILE_CHUNK_SIZE,
  NOSTR_FILE_EXPIRATION_SEC,
  NOSTR_FILE_MANIFEST_VERSION,
  NOSTR_FILE_MAX_BYTES,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_BACKOFF_CAP_MS,
  PUBLISH_BACKOFF_JITTER_MS,
  PUBLISH_MAX_RETRIES,
  UPLOAD_CHUNK_CONCURRENCY,
  UPLOAD_RELAY_COUNT,
} from './constants';
import { buildChunkEvent } from './events';
import { type NostrFileManifest, stripeRelays } from './manifest';
import type { NostrFilePool } from './pool';
import {
  createLocalStorageRelayPool,
  getRelayCandidates,
  healthCheckRelays,
  type RelayPoolStorage,
  selectUploadRelays,
} from './relay-pool';

export class NostrFileCancelledError extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'NostrFileCancelledError';
  }
}

export interface UploadProgress {
  phase: 'hashing' | 'discovering' | 'health_check' | 'uploading';
  chunksDone?: number;
  chunksTotal?: number;
  relaysChecked?: number;
  relaysHealthy?: number;
}

export interface UploadResult {
  manifest: NostrFileManifest;
  /** Raw AES key for embedding into the manual payload. Caller MUST wipe. */
  keyBytes: Uint8Array;
}

function backoffDelay(attempt: number): number {
  return (
    Math.min(PUBLISH_BACKOFF_BASE_MS * 2 ** attempt, PUBLISH_BACKOFF_CAP_MS) +
    Math.random() * PUBLISH_BACKOFF_JITTER_MS
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Publish one event to one relay with retries. Returns true when the relay
 * acknowledged the event.
 */
async function publishWithRetry(
  pool: NostrFilePool,
  relay: string,
  event: Event,
  isCancelled: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt <= PUBLISH_MAX_RETRIES; attempt++) {
    if (isCancelled()) return false;
    try {
      await Promise.all(pool.publish([relay], event));
      return true;
    } catch {
      if (attempt < PUBLISH_MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
      }
    }
  }
  return false;
}

/**
 * Save a file to nostr relays as temporary (NIP-40, 1 hour) chunk events.
 *
 * Chunks are striped across the relay batch (stripeRelays): each chunk goes
 * to CHUNK_REPLICATION relays, falling back to the next relays in the ring
 * when a placed relay rejects it, so every relay carries only a fraction of
 * the file and the total upload volume stays at replication × file size.
 *
 * Strict handover gate: resolves only after EVERY chunk has been acknowledged
 * by at least MIN_CHUNK_RELAY_SUCCESS relays — a partial upload always throws,
 * so a manifest for an incomplete file can never be handed to a receiver.
 * Orphaned chunks from failed/cancelled uploads are encrypted noise that
 * self-expires.
 */
export async function uploadFileToNostr(
  data: Uint8Array,
  meta: { fileName: string; mimeType: string },
  opts: {
    onProgress: (p: UploadProgress) => void;
    isCancelled: () => boolean;
    pool: NostrFilePool;
    storage?: RelayPoolStorage;
    relayOverride?: string[];
  },
): Promise<UploadResult> {
  const { onProgress, isCancelled, pool } = opts;
  const storage = opts.storage ?? createLocalStorageRelayPool();

  if (data.length === 0) throw new Error('Cannot send an empty file');
  if (data.length > NOSTR_FILE_MAX_BYTES) {
    throw new Error(
      `File too large for Nostr relay transfer (max ${NOSTR_FILE_MAX_BYTES / (1024 * 1024)} MB)`,
    );
  }

  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };

  // Hash + crypto material
  onProgress({ phase: 'hashing' });
  const fileHash = uint8ArrayToBase64(await sha256(data));
  const transferId = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const { secretKey, publicKey } = generateEphemeralKeys();

  try {
    const aesKey = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const chunks = splitIntoChunks(data, NOSTR_FILE_CHUNK_SIZE);
    const totalChunks = chunks.length;
    throwIfCancelled();

    // Relay selection
    let relays: string[];
    if (opts.relayOverride && opts.relayOverride.length > 0) {
      if (opts.relayOverride.length < MIN_CHUNK_RELAY_SUCCESS) {
        throw new Error(
          'Not enough working Nostr relays found. Try again, or use the normal Manual Exchange transfer.',
        );
      }
      relays = opts.relayOverride;
    } else {
      onProgress({ phase: 'discovering' });
      const candidates = await getRelayCandidates(pool, storage);
      throwIfCancelled();
      const healthy = await healthCheckRelays(pool, candidates, {
        isCancelled,
        onProgress: (relaysChecked, relaysHealthy) =>
          onProgress({ phase: 'health_check', relaysChecked, relaysHealthy }),
      });
      throwIfCancelled();
      if (healthy.length < MIN_CHUNK_RELAY_SUCCESS) {
        throw new Error(
          'Not enough working Nostr relays found. Try again, or use the normal Manual Exchange transfer.',
        );
      }
      relays = selectUploadRelays(healthy, UPLOAD_RELAY_COUNT, storage);
    }

    // Stripe chunks over the batch; strict all-confirmed gate.
    const replication = Math.min(CHUNK_REPLICATION, relays.length);
    const createdAt = Math.floor(Date.now() / 1000);
    let chunksDone = 0;
    onProgress({ phase: 'uploading', chunksDone, chunksTotal: totalChunks });

    let nextChunk = 0;
    let aborted = false;
    const worker = async (): Promise<void> => {
      while (true) {
        throwIfCancelled();
        if (aborted) return;
        const index = nextChunk++;
        if (index >= totalChunks) return;
        const aad = chunkAad(transferId, index, totalChunks);
        const content = await encodeChunkContent(aesKey, chunks[index], aad);
        const event = buildChunkEvent(secretKey, {
          transferId,
          index,
          total: totalChunks,
          content,
          createdAt,
        });
        const outcomes = await Promise.all(
          stripeRelays(relays, replication, index).map((relay) =>
            publishWithRetry(pool, relay, event, isCancelled),
          ),
        );
        let acks = outcomes.filter(Boolean).length;
        // Fallback: continue around the ring past the placed relays until
        // enough copies exist. The download's sweep pass finds these.
        for (
          let j = replication;
          j < relays.length && acks < MIN_CHUNK_RELAY_SUCCESS;
          j++
        ) {
          throwIfCancelled();
          const relay = relays[(index + j) % relays.length];
          if (await publishWithRetry(pool, relay, event, isCancelled)) acks++;
        }
        throwIfCancelled();
        if (acks < MIN_CHUNK_RELAY_SUCCESS) {
          aborted = true;
          throw new Error(
            `Chunk ${index + 1}/${totalChunks} could not be saved to enough relays — upload aborted`,
          );
        }
        chunksDone++;
        onProgress({
          phase: 'uploading',
          chunksDone,
          chunksTotal: totalChunks,
        });
      }
    };
    // allSettled so a failing worker's rejection is not left unhandled while
    // its siblings finish their in-flight chunks (they exit via `aborted`).
    const workerResults = await Promise.allSettled(
      Array.from(
        { length: Math.min(UPLOAD_CHUNK_CONCURRENCY, totalChunks) },
        worker,
      ),
    );
    const failure = workerResults.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failure) throw failure.reason;

    // All chunks confirmed — build the manifest. Relay order is the placement
    // ring and must not be changed.
    const manifest: NostrFileManifest = {
      v: NOSTR_FILE_MANIFEST_VERSION,
      fileName: meta.fileName,
      fileSize: data.length,
      mimeType: meta.mimeType,
      fileHash,
      transferId,
      pubkey: publicKey,
      chunkSize: NOSTR_FILE_CHUNK_SIZE,
      totalChunks,
      enc: 1,
      relays: [...relays],
      replication,
      createdAt,
      expiresAt: createdAt + NOSTR_FILE_EXPIRATION_SEC,
    };
    return { manifest, keyBytes };
  } catch (err) {
    wipeBufferSource(keyBytes);
    throw err;
  } finally {
    wipeBufferSource(secretKey);
  }
}
