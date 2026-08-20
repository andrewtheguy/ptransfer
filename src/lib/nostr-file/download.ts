import { wipeBufferSource } from '../crypto/memory';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../nostr/events';
import { assembleChunks, chunkAad, decodeChunkContent, sha256 } from './codec';
import { CLOCK_SKEW_TOLERANCE_SEC, RELAY_QUERY_MAX_WAIT_MS } from './constants';
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

/**
 * Retrieve, verify, and reassemble a file saved to nostr relays.
 *
 * Iterates the manifest's relays one at a time, fetching only the still
 * missing chunks from each (read-side load spreading). Every chunk is
 * authenticated by its AES-GCM tag under transfer/index-bound AAD; the
 * assembled file must match the manifest's whole-file hash.
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

  const aesKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    'AES-GCM',
    false,
    ['decrypt'],
  );
  wipeBufferSource(keyBytes);

  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };

  const chunks: (Uint8Array | null)[] = new Array(manifest.totalChunks).fill(
    null,
  );
  let chunksDone = 0;
  onProgress({ chunksDone, chunksTotal: manifest.totalChunks });

  // Two full passes over the relay list: the second catches chunks a relay
  // failed to deliver transiently on the first.
  for (let pass = 0; pass < 2; pass++) {
    for (const relay of manifest.relays) {
      const missing = missingIndices(chunks);
      if (missing.length === 0) break;
      const filters = buildChunkFilters(
        manifest.pubkey,
        manifest.transferId,
        missing,
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
          try {
            chunks[index] = await decodeChunkContent(
              aesKey,
              content,
              chunkAad(manifest.transferId, index, manifest.totalChunks),
            );
            chunksDone++;
            onProgress({
              chunksDone,
              chunksTotal: manifest.totalChunks,
              relay,
            });
          } catch {
            // Tampered or corrupt chunk — leave it missing, another relay
            // may hold a good copy.
          }
        }
      }
    }
    if (missingIndices(chunks).length === 0) break;
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
