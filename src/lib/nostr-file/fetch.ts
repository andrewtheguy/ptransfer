import { wipeBufferSource } from '../crypto/memory';
import { base64ToUint8Array } from '../nostr/events';
import { chunkAad, decodeChunkContent } from './codec';
import { CLOCK_SKEW_TOLERANCE_SEC, RELAY_QUERY_MAX_WAIT_MS } from './constants';
import { buildChunkFilters, parseChunkEvent } from './events';
import type { NostrFileManifest } from './manifest';
import type { NostrFilePool } from './pool';
import { type NostrFileTransferStats, relayStatsFor } from './stats';

/** Receiver-side pieces of the relay flow. */

/** Decode the payload's base64 key field into raw bytes. */
export function decodePayloadKey(key: string): Uint8Array {
  return base64ToUint8Array(key);
}

/**
 * Reject a manifest whose window is over (or not yet begun, by a device
 * clock that is far off). Wipes `keyBytes` before throwing.
 */
export function assertManifestWindow(
  manifest: NostrFileManifest,
  keyBytes: Uint8Array,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
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
}

/** Import the file key for decryption and wipe the raw bytes either way. */
export async function importDecryptKey(
  keyBytes: Uint8Array,
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      'AES-GCM',
      false,
      ['decrypt'],
    );
  } finally {
    wipeBufferSource(keyBytes);
  }
}

/**
 * Ask one relay for the given chunks, decrypt what comes back, and hand each
 * verified chunk to `onChunk`. Relay errors are swallowed (the chunk simply
 * stays missing); only cancellation propagates, via `throwIfCancelled`.
 */
export async function fetchChunksFromRelay(
  pool: NostrFilePool,
  manifest: NostrFileManifest,
  aesKey: CryptoKey,
  relay: string,
  indices: number[],
  opts: {
    have: (index: number) => boolean;
    onChunk: (index: number, plaintext: Uint8Array) => void;
    throwIfCancelled: () => void;
    /** Tally queries, events, bytes, duplicates, and corrupt chunks. */
    stats: NostrFileTransferStats;
  },
): Promise<void> {
  const { stats } = opts;
  const relayStats = relayStatsFor(stats, relay);
  const filters = buildChunkFilters(
    manifest.pubkey,
    manifest.transferId,
    indices,
  );
  for (const filter of filters) {
    opts.throwIfCancelled();
    stats.queries++;
    relayStats.queries++;
    let events: Awaited<ReturnType<NostrFilePool['querySync']>>;
    try {
      events = await pool.querySync([relay], filter, {
        maxWait: RELAY_QUERY_MAX_WAIT_MS,
      });
    } catch {
      stats.queryFailures++;
      relayStats.queryFailures++;
      continue;
    }
    for (const event of events) {
      stats.eventsReceived++;
      stats.bytesReceived += event.content.length;
      relayStats.eventsReceived++;
      relayStats.bytesDown += event.content.length;
      const parsed = parseChunkEvent(
        event,
        manifest.pubkey,
        manifest.transferId,
      );
      if (!parsed) {
        stats.corruptEvents++;
        relayStats.corruptEvents++;
        continue;
      }
      const { index, content } = parsed;
      if (index >= manifest.totalChunks) {
        stats.corruptEvents++;
        relayStats.corruptEvents++;
        continue;
      }
      if (opts.have(index)) {
        stats.duplicateEvents++;
        continue;
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await decodeChunkContent(
          aesKey,
          content,
          chunkAad(manifest.transferId, index, manifest.totalChunks),
          manifest.chunkSize,
        );
      } catch {
        // Tampered or corrupt chunk — leave it missing.
        stats.corruptEvents++;
        relayStats.corruptEvents++;
        continue;
      }
      // Another relay's worker may have decoded this chunk meanwhile.
      if (opts.have(index)) {
        stats.duplicateEvents++;
        continue;
      }
      relayStats.chunksSupplied++;
      opts.onChunk(index, plaintext);
    }
  }
}
