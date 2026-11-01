import { SLOW_TRANSPORT_MAX_BYTES } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import { t } from '@/lib/i18n';
import { NostrFileCancelledError } from '@/lib/nostr-file';
import type { TransferSource } from '@/lib/transfer-source';

/** Input handling for the Nostr relay fallback. */

export async function readSourceFully(
  source: TransferSource,
  isCancelled: () => boolean,
): Promise<Uint8Array> {
  // The relay is a slow transport, so an archive deflates its entries.
  const reader = source.stream(true).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (isCancelled()) throw new NostrFileCancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > SLOW_TRANSPORT_MAX_BYTES) {
          const limit = formatFileSize(SLOW_TRANSPORT_MAX_BYTES);
          throw new Error(
            t({
              en: `File exceeds ${limit} Nostr relay limit`,
              es: `El archivo supera el límite de ${limit} de los relays de Nostr`,
            }),
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

// Plaintext bytes represented by one chunk, for progress display. Chunks
// carry the compressed payload, so this maps the done/total chunk fraction
// proportionally onto the original file size.
export function chunkBytesEstimate(
  fileSize: number,
  totalChunks: number,
): number {
  return Math.ceil(fileSize / Math.max(totalChunks, 1));
}
