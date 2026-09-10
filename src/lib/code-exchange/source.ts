import { MAX_MESSAGE_SIZE, SLOW_TRANSPORT_MAX_BYTES } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata } from '@/lib/nostr';
import { TOR_MAX_WIRE_BYTES } from '@/lib/tor/transfer';
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';

/**
 * What an offer says about `content`, or why it cannot be offered at all.
 *
 * The same checks whichever way the offer travels, since it is the same
 * offer: a name, a finite size within the direct path's limit, and a single
 * file that is not empty.
 */
export function describeSendSource(
  content: TransferSource,
): { metadata: TransferMetadata } | { error: string } {
  const fileName = (content.name || '').trim();
  if (!fileName) return { error: 'Missing file name' };

  const fileSize = content.size ?? content.estimatedSize;
  if (
    !Number.isFinite(fileSize) ||
    fileSize < 0 ||
    !Number.isFinite(content.estimatedSize) ||
    content.estimatedSize < 0
  ) {
    return { error: 'Invalid file size' };
  }

  if (content.size !== null && fileSize <= 0) {
    return { error: 'File is empty' };
  }

  if (fileSize > MAX_MESSAGE_SIZE || content.estimatedSize > MAX_MESSAGE_SIZE) {
    return { error: `File exceeds ${formatFileSize(MAX_MESSAGE_SIZE)} limit` };
  }

  return {
    metadata: {
      contentType: 'file',
      fileName,
      fileSize,
      contentEncoding: wireEncodingFor(content),
      mimeType: content.type || 'application/octet-stream',
    },
  };
}

/**
 * Why the Tor fallback could not carry `content`, or null when it could.
 *
 * Checked while the selection is still a selection, before an offer asks for
 * that fallback: by the time the fallback runs, the codes have been exchanged
 * and a bootstrap spent, and the sender would be learning that the fallback
 * it selected cannot carry what it offered. A ZIP's headers and entry paths
 * are wire bytes no file size accounts for, so a selection of many tiny files
 * can pass the size check and still not fit.
 */
export function torFallbackRefusal(content: TransferSource): string | null {
  if (content.estimatedSize > SLOW_TRANSPORT_MAX_BYTES) {
    return `This selection is ${formatFileSize(content.estimatedSize)}, over the ${formatFileSize(SLOW_TRANSPORT_MAX_BYTES)} the anonymous fallback's Tor transport allows.`;
  }
  if (content.projectedWireBytes > TOR_MAX_WIRE_BYTES) {
    return `This selection needs up to ${formatFileSize(content.projectedWireBytes)} on the wire, over the ${formatFileSize(TOR_MAX_WIRE_BYTES)} the Tor transport allows. Archive overhead grows with the number of files; send fewer of them.`;
  }
  return null;
}
