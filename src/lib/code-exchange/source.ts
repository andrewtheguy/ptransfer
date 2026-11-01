import { MAX_MESSAGE_SIZE, SLOW_TRANSPORT_MAX_BYTES } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import { t } from '@/lib/i18n';
import type { TransferMetadata } from '@/lib/nostr';
import { TOR_MAX_WIRE_BYTES } from '@/lib/tor/transfer';
import type { TransferSource } from '@/lib/transfer-source';

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
  if (!fileName)
    return {
      error: t({
        en: 'Missing file name',
        es: 'Falta el nombre del archivo',
      }),
    };

  const fileSize = content.size ?? content.estimatedSize;
  if (
    !Number.isFinite(fileSize) ||
    fileSize < 0 ||
    !Number.isFinite(content.estimatedSize) ||
    content.estimatedSize < 0
  ) {
    return {
      error: t({
        en: 'Invalid file size',
        es: 'Tamaño de archivo no válido',
      }),
    };
  }

  if (content.size !== null && fileSize <= 0) {
    return { error: t({ en: 'File is empty', es: 'El archivo está vacío' }) };
  }

  if (fileSize > MAX_MESSAGE_SIZE || content.estimatedSize > MAX_MESSAGE_SIZE) {
    const limit = formatFileSize(MAX_MESSAGE_SIZE);
    return {
      error: t({
        en: `File exceeds ${limit} limit`,
        es: `El archivo supera el límite de ${limit}`,
      }),
    };
  }

  return {
    metadata: {
      contentType: 'file',
      fileName,
      fileSize,
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
    const size = formatFileSize(content.estimatedSize);
    const limit = formatFileSize(SLOW_TRANSPORT_MAX_BYTES);
    return t({
      en: `This selection is ${size}, over the ${limit} the anonymous fallback's Tor transport allows.`,
      es: `Esta selección ocupa ${size}, más de los ${limit} que permite el transporte por Tor de la alternativa anónima.`,
    });
  }
  if (content.projectedWireBytes > TOR_MAX_WIRE_BYTES) {
    const size = formatFileSize(content.projectedWireBytes);
    const limit = formatFileSize(TOR_MAX_WIRE_BYTES);
    return t({
      en: `This selection needs up to ${size} on the wire, over the ${limit} the Tor transport allows. Archive overhead grows with the number of files; send fewer of them.`,
      es: `Esta selección necesita hasta ${size} en la red, más de los ${limit} que permite el transporte por Tor. La sobrecarga del archivo ZIP crece con el número de archivos; envía menos.`,
    });
  }
  return null;
}
