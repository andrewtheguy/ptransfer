import { base64ToUint8Array, uint8ArrayToBase64 } from '../nostr/events';
import { assembleChunks, sha256 } from './codec';
import {
  DOWNLOAD_RETRY_PASS_DELAY_MS,
  DOWNLOAD_SWEEP_PASSES,
} from './constants';
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
import { NostrFileCancelledError } from './upload';

export interface DownloadProgress {
  chunksDone: number;
  chunksTotal: number;
  relay?: string;
  /** Running totals for the whole transfer; one object, mutated in place. */
  stats: NostrFileTransferStats;
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

  assertManifestWindow(manifest, keyBytes);
  const aesKey = await importDecryptKey(keyBytes);

  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };

  const stats = createTransferStats('receiver', 'stored');
  stats.fileBytes = manifest.fileSize;
  stats.chunkSize = manifest.chunkSize;
  stats.chunksTotal = manifest.totalChunks;
  for (const relay of manifest.relays) relayStatsFor(stats, relay);
  const downloadStarted = Date.now();

  const chunks: (Uint8Array | null)[] = new Array(manifest.totalChunks).fill(
    null,
  );
  let chunksDone = 0;
  onProgress({ chunksDone, chunksTotal: manifest.totalChunks, stats });

  const fetchFromRelay = (relay: string, indices: number[]) =>
    fetchChunksFromRelay(pool, manifest, aesKey, relay, indices, {
      have: (index) => chunks[index] !== null,
      onChunk: (index, plaintext) => {
        chunks[index] = plaintext;
        chunksDone++;
        stats.phaseMs.transfer = Date.now() - downloadStarted;
        onProgress({
          chunksDone,
          chunksTotal: manifest.totalChunks,
          relay,
          stats,
        });
      },
      throwIfCancelled,
      stats,
    });

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
    stats.sweepPasses++;
    await runPass((_relayPos, missing) => missing);
  }
  stats.phaseMs.transfer = Date.now() - downloadStarted;

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
