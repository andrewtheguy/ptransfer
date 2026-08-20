import { wipeBufferSource } from '../crypto/memory';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../nostr/events';
import { assembleChunks, chunkAad, decodeChunkContent, sha256 } from './codec';
import {
  CLOCK_SKEW_TOLERANCE_SEC,
  DOWNLOAD_RETRY_PASS_DELAY_MS,
  DOWNLOAD_SWEEP_PASSES,
  RELAY_QUERY_MAX_WAIT_MS,
} from './constants';
import { buildChunkFilters, parseChunkEvent } from './events';
import type { NostrFileManifest } from './manifest';
import type { NostrFilePool } from './pool';
import { NostrFileCancelledError } from './upload';

export interface DownloadProgress {
  chunksDone: number;
  chunksTotal: number;
  relay?: string;
}

function missingIndices(chunks: (Uint8Array | null)[]): number[] {
  const missing: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i]) missing.push(i);
  }
  return missing;
}

/** Whether chunk `index` was placed on the relay at ring position `relayPos`. */
function isPlacedOn(
  manifest: NostrFileManifest,
  index: number,
  relayPos: number,
): boolean {
  const n = manifest.relays.length;
  const offset = (((relayPos - index) % n) + n) % n;
  return offset < manifest.replication;
}

/**
 * Retrieve, verify, and reassemble a file saved to nostr relays.
 *
 * All relays are read in parallel. The first pass asks each relay only for
 * the chunks striped onto it (stripeRelays placement); sweep passes then ask
 * every relay for whatever is still missing, which covers fallback placements
 * and transient failures. Every chunk is authenticated by its AES-GCM tag
 * under transfer/index-bound AAD; the assembled file must match the
 * manifest's whole-file hash.
 */
export async function downloadFileFromNostr(
  manifest: NostrFileManifest,
  keyBytes: Uint8Array,
  opts: {
    onProgress: (p: DownloadProgress) => void;
    isCancelled: () => boolean;
    pool: NostrFilePool;
  },
): Promise<Uint8Array> {
  const { onProgress, isCancelled, pool } = opts;
  const nowSec = Math.floor(Date.now() / 1000);

  if (nowSec > manifest.expiresAt + CLOCK_SKEW_TOLERANCE_SEC) {
    wipeBufferSource(keyBytes);
    throw new Error(
      'This transfer has expired — relay copies are only kept for 1 hour. Ask the sender to start a new transfer.',
    );
  }
  if (manifest.createdAt > nowSec + CLOCK_SKEW_TOLERANCE_SEC) {
    wipeBufferSource(keyBytes);
    throw new Error(
      'This transfer appears to be from the future — check that your device clock is set correctly.',
    );
  }

  let aesKey: CryptoKey;
  try {
    aesKey = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      'AES-GCM',
      false,
      ['decrypt'],
    );
  } finally {
    // Wipe on success and on import failure alike.
    wipeBufferSource(keyBytes);
  }

  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };

  const chunks: (Uint8Array | null)[] = new Array(manifest.totalChunks).fill(
    null,
  );
  let chunksDone = 0;
  onProgress({ chunksDone, chunksTotal: manifest.totalChunks });

  const fetchFromRelay = async (
    relay: string,
    indices: number[],
  ): Promise<void> => {
    const filters = buildChunkFilters(
      manifest.pubkey,
      manifest.transferId,
      indices,
    );
    for (const filter of filters) {
      throwIfCancelled();
      let events: Awaited<ReturnType<NostrFilePool['querySync']>>;
      try {
        events = await pool.querySync([relay], filter, {
          maxWait: RELAY_QUERY_MAX_WAIT_MS,
        });
      } catch {
        continue;
      }
      for (const event of events) {
        const parsed = parseChunkEvent(
          event,
          manifest.pubkey,
          manifest.transferId,
        );
        if (!parsed) continue;
        const { index, content } = parsed;
        if (index >= manifest.totalChunks || chunks[index]) continue;
        let plaintext: Uint8Array;
        try {
          plaintext = await decodeChunkContent(
            aesKey,
            content,
            chunkAad(manifest.transferId, index, manifest.totalChunks),
            manifest.chunkSize,
          );
        } catch {
          // Tampered or corrupt chunk — leave it missing, another relay
          // may hold a good copy.
          continue;
        }
        // Another relay's worker may have decoded this chunk meanwhile.
        if (chunks[index]) continue;
        chunks[index] = plaintext;
        chunksDone++;
        onProgress({ chunksDone, chunksTotal: manifest.totalChunks, relay });
      }
    }
  };

  // One worker per relay; a cancelled worker rejects and the rest wind down
  // at their own next cancellation check.
  const runPass = async (
    wanted: (relayPos: number, missing: number[]) => number[],
  ): Promise<void> => {
    const missing = missingIndices(chunks);
    const results = await Promise.allSettled(
      manifest.relays.map(async (relay, relayPos) => {
        const indices = wanted(relayPos, missing);
        if (indices.length > 0) await fetchFromRelay(relay, indices);
      }),
    );
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failure) throw failure.reason;
  };

  // Placement pass: each relay serves only its stripe.
  await runPass((relayPos, missing) =>
    missing.filter((index) => isPlacedOn(manifest, index, relayPos)),
  );
  // Sweep passes: every relay is asked for everything still missing.
  for (let pass = 0; pass < DOWNLOAD_SWEEP_PASSES; pass++) {
    if (missingIndices(chunks).length === 0) break;
    // Brief pause so transiently failed or dropped relay connections have
    // a moment to recover before the retry pass.
    await new Promise((r) => setTimeout(r, DOWNLOAD_RETRY_PASS_DELAY_MS));
    throwIfCancelled();
    await runPass((_relayPos, missing) => missing);
  }

  const stillMissing = missingIndices(chunks);
  if (stillMissing.length > 0) {
    throw new Error(
      `${stillMissing.length} of ${manifest.totalChunks} pieces could not be retrieved — the relay copies may have expired or been dropped. Ask the sender to start a new transfer.`,
    );
  }

  const data = assembleChunks(chunks, manifest.fileSize);
  const hash = uint8ArrayToBase64(await sha256(data));
  if (hash !== manifest.fileHash) {
    throw new Error('File integrity check failed — the download was corrupted');
  }
  return data;
}

/** Decode the payload's base64 key field into raw bytes. */
export function decodePayloadKey(key: string): Uint8Array {
  return base64ToUint8Array(key);
}
