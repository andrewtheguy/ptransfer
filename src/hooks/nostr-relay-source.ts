import { formatFileSize } from '@/lib/file-utils';
import type { TransferState } from '@/lib/nostr';
import {
  NOSTR_FILE_MAX_BYTES,
  NostrFileCancelledError,
} from '@/lib/nostr-file';
import type { TransferSource } from '@/lib/transfer-source';

/** Shared input handling for the stored and live Nostr relay send hooks. */

export async function readSourceFully(
  source: TransferSource,
  isCancelled: () => boolean,
): Promise<Uint8Array> {
  const reader = source.stream().getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (isCancelled()) throw new NostrFileCancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > NOSTR_FILE_MAX_BYTES) {
          throw new Error(
            `File exceeds ${formatFileSize(NOSTR_FILE_MAX_BYTES)} Nostr relay limit`,
          );
        }
        parts.push(value);
      }
    }
  } finally {
    // Cancel before releasing: an abandoned read (cancelled, or over the
    // size limit) has to close the source too, or a streamed ZIP keeps
    // packaging into a reader nobody is draining.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}

/**
 * Validate and sanitize a source's metadata up front. Returns an error state
 * to publish, or the clean name/type to proceed with.
 */
export function validateNostrRelaySource(
  content: TransferSource,
):
  | { ok: true; fileName: string; mimeType: string }
  | { ok: false; state: TransferState } {
  const fileName = (content.name || '').trim();
  if (!fileName) {
    return {
      ok: false,
      state: { status: 'error', message: 'Missing file name' },
    };
  }
  const mimeType = content.type || 'application/octet-stream';

  if (
    !Number.isFinite(content.estimatedSize) ||
    content.estimatedSize < 0 ||
    (content.size !== null &&
      (!Number.isFinite(content.size) || content.size <= 0))
  ) {
    return {
      ok: false,
      state: { status: 'error', message: 'Invalid file size' },
    };
  }
  // Pre-read bound; the exact byte count is re-checked while reading
  // (ZIP sources only know their real size at end of stream).
  if ((content.size ?? content.estimatedSize) > NOSTR_FILE_MAX_BYTES) {
    return {
      ok: false,
      state: {
        status: 'error',
        message: `File exceeds ${formatFileSize(NOSTR_FILE_MAX_BYTES)} Nostr relay limit`,
      },
    };
  }
  return { ok: true, fileName, mimeType };
}

// Progress in bytes from chunk counts (chunks are equal-sized except the last).
export function chunkBytesEstimate(
  fileSize: number,
  totalChunks: number,
): number {
  return Math.ceil(fileSize / Math.max(totalChunks, 1));
}
