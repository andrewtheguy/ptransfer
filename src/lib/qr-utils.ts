import { t } from '@/lib/i18n';
import type { FastQrMode } from '@/lib/wasm/fastQrWasm';
import QRWorker from '@/workers/qrGenerator.worker?worker';

// Eager-load worker on module import for offline support
const worker = new QRWorker();
let requestId = 0;
const REQUEST_TIMEOUT_MS = 15000;

interface PendingRequest {
  resolve: (url: string) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingRequest>();

function takePendingRequest(id: number): PendingRequest | null {
  const request = pending.get(id);
  if (!request) {
    return null;
  }
  clearTimeout(request.timeoutId);
  pending.delete(id);
  return request;
}

function rejectAllPendingRequests(reason: string): void {
  for (const [id, request] of pending) {
    clearTimeout(request.timeoutId);
    request.reject(new Error(reason));
    pending.delete(id);
  }
}

function registerPendingRequest(
  resolve: (url: string) => void,
  reject: (error: Error) => void,
): number {
  const id = requestId++;
  const timeoutId = setTimeout(() => {
    const request = takePendingRequest(id);
    if (!request) {
      return;
    }
    request.reject(
      new Error(
        t({
          en: `QR generation timed out after ${REQUEST_TIMEOUT_MS}ms`,
          es: `Se agotó el tiempo para generar el código QR (${REQUEST_TIMEOUT_MS} ms)`,
        }),
      ),
    );
  }, REQUEST_TIMEOUT_MS);
  pending.set(id, { resolve, reject, timeoutId });
  return id;
}

// Set up message handler at module scope
worker.onmessage = (e: MessageEvent) => {
  const data = e.data as {
    id?: unknown;
    svg?: unknown;
    type?: unknown;
    error?: unknown;
  };

  if (typeof data.id !== 'number') {
    return;
  }

  const request = takePendingRequest(data.id);
  if (!request) {
    return;
  }

  if (data.type === 'success' && typeof data.svg === 'string') {
    request.resolve(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`,
    );
  } else {
    const errorMessage =
      typeof data.error === 'string' && data.error.length > 0
        ? data.error
        : t({
            en: 'QR generation failed',
            es: 'No se pudo generar el código QR',
          });
    request.reject(new Error(errorMessage));
  }
};

worker.onerror = (event: ErrorEvent) => {
  const suffix = event.message ? `: ${event.message}` : '';
  rejectAllPendingRequests(
    t({
      en: `QR worker error${suffix}`,
      es: `Error del worker de códigos QR${suffix}`,
    }),
  );
};

worker.onmessageerror = () => {
  rejectAllPendingRequests(
    t({
      en: 'QR worker message error',
      es: 'Error de mensaje del worker de códigos QR',
    }),
  );
};

interface QRCodeOptions {
  width?: number;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
}

function postGenerateRequest(
  buffer: ArrayBuffer,
  mode: FastQrMode,
  options: QRCodeOptions | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = registerPendingRequest(resolve, reject);
    try {
      worker.postMessage(
        {
          type: 'generate',
          id,
          binaryBuffer: buffer,
          mode,
          options: options || {},
        },
        [buffer],
      );
    } catch (error) {
      const request = takePendingRequest(id);
      if (!request) {
        return;
      }
      request.reject(
        error instanceof Error
          ? error
          : new Error(
              t({
                en: 'Failed to post QR generation request',
                es: 'No se pudo enviar la solicitud para generar el código QR',
              }),
            ),
      );
    }
  });
}

/**
 * Generate a QR code image from binary data
 * Returns a data URI (SVG image)
 * Uses 8-bit byte mode for binary data
 */
export function generateBinaryQRCode(
  data: Uint8Array,
  options?: QRCodeOptions,
): Promise<string> {
  // Copy out of the source view's underlying buffer so the worker gets an
  // exclusively-owned ArrayBuffer it can transfer without disturbing the caller.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  return postGenerateRequest(buffer, 'byte', options);
}

/**
 * Generate a QR code image from text data
 * Returns a data URI (SVG image)
 * Encoded as UTF-8 bytes; byte mode is left off so fast-qr can pick numeric/alphanumeric
 * mode for compatible payloads (shorter URLs).
 */
export function generateTextQRCode(
  text: string,
  options?: QRCodeOptions,
): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return postGenerateRequest(bytes.buffer as ArrayBuffer, 'auto', options);
}
