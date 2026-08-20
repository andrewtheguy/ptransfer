import { SimplePool } from 'nostr-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { wipeBufferSource } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import {
  generateNostrFilePayloadBinary,
  type NostrFilePayload,
} from '@/lib/manual-signaling';
import type { TransferState } from '@/lib/nostr';
import { uint8ArrayToBase64 } from '@/lib/nostr/events';
import {
  NOSTR_FILE_MAX_BYTES,
  NostrFileCancelledError,
  uploadFileToNostr,
} from '@/lib/nostr-file';
import type { TransferSource } from '@/lib/transfer-source';

export interface UseNostrRelaySendReturn {
  state: TransferState;
  send: (content: TransferSource) => Promise<void>;
  /** One-way flow: the user confirms the receiver has the code. */
  finish: () => void;
  cancel: () => void;
}

async function readSourceFully(
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

export function useNostrRelaySend(): UseNostrRelaySendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });

  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const poolRef = useRef<SimplePool | null>(null);
  const expiryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExpiryTimeout = useCallback(() => {
    if (expiryTimeoutRef.current) {
      clearTimeout(expiryTimeoutRef.current);
      expiryTimeoutRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    clearExpiryTimeout();
    if (poolRef.current) {
      poolRef.current.destroy();
      poolRef.current = null;
    }
    setState({ status: 'idle' });
  }, [clearExpiryTimeout]);

  // On unmount: stop the pending expiry timer (so it can't setState on an
  // unmounted component) and close any open relay sockets. No setState here.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      clearExpiryTimeout();
      if (poolRef.current) {
        poolRef.current.destroy();
        poolRef.current = null;
      }
    },
    [clearExpiryTimeout],
  );

  const finish = useCallback(() => {
    clearExpiryTimeout();
    setState((prev) =>
      prev.status === 'showing_payload'
        ? {
            status: 'complete',
            message: 'File relayed via Nostr!',
            contentType: 'file',
          }
        : prev,
    );
  }, [clearExpiryTimeout]);

  const send = useCallback(
    async (content: TransferSource) => {
      // Guard against concurrent invocations
      if (sendingRef.current) return;
      sendingRef.current = true;
      cancelledRef.current = false;

      const isCancelled = () => cancelledRef.current;

      try {
        // Validate and sanitize metadata
        const fileName = (content.name || '').trim();
        if (!fileName) {
          setState({ status: 'error', message: 'Missing file name' });
          return;
        }
        const mimeType = content.type || 'application/octet-stream';

        if (
          !Number.isFinite(content.estimatedSize) ||
          content.estimatedSize < 0 ||
          (content.size !== null &&
            (!Number.isFinite(content.size) || content.size <= 0))
        ) {
          setState({ status: 'error', message: 'Invalid file size' });
          return;
        }
        // Pre-read bound; the exact byte count is re-checked while reading
        // (ZIP sources only know their real size at end of stream).
        if ((content.size ?? content.estimatedSize) > NOSTR_FILE_MAX_BYTES) {
          setState({
            status: 'error',
            message: `File exceeds ${formatFileSize(NOSTR_FILE_MAX_BYTES)} Nostr relay limit`,
          });
          return;
        }

        setState({ status: 'preparing', message: 'Preparing file...' });
        const data = await readSourceFully(content, isCancelled);
        if (data.length === 0) {
          setState({ status: 'error', message: 'File is empty' });
          return;
        }
        if (cancelledRef.current) return;

        const fileMetadata = { fileName, fileSize: data.length, mimeType };
        const pool = new SimplePool();
        poolRef.current = pool;

        const { manifest, keyBytes } = await uploadFileToNostr(
          data,
          fileMetadata,
          {
            pool,
            isCancelled,
            onProgress: (p) => {
              if (cancelledRef.current) return;
              switch (p.phase) {
                case 'hashing':
                  setState({
                    status: 'preparing',
                    message: 'Encrypting file...',
                    fileMetadata,
                  });
                  break;
                case 'discovering':
                  setState({
                    status: 'discovering_relays',
                    message: 'Discovering Nostr relays...',
                    fileMetadata,
                  });
                  break;
                case 'health_check':
                  setState({
                    status: 'discovering_relays',
                    message: `Testing relays... ${p.relaysHealthy ?? 0} working of ${p.relaysChecked ?? 0} checked`,
                    fileMetadata,
                  });
                  break;
                case 'uploading':
                  setState({
                    status: 'uploading',
                    message: 'Saving encrypted pieces to relays...',
                    progress: {
                      current: Math.min(
                        (p.chunksDone ?? 0) *
                          manifestChunkEstimate(
                            data.length,
                            p.chunksTotal ?? 1,
                          ),
                        data.length,
                      ),
                      total: data.length,
                    },
                    fileMetadata,
                  });
                  break;
              }
            },
          },
        );
        if (cancelledRef.current) {
          wipeBufferSource(keyBytes);
          return;
        }

        const payload: NostrFilePayload = {
          ...manifest,
          type: 'nostr-file',
          key: uint8ArrayToBase64(keyBytes),
        };
        wipeBufferSource(keyBytes);
        const payloadBinary = generateNostrFilePayloadBinary(payload);

        // The relay copies expire on their own; flip to an error when the
        // sender leaves the code on screen past its lifetime.
        clearExpiryTimeout();
        const msUntilExpiry = manifest.expiresAt * 1000 - Date.now();
        expiryTimeoutRef.current = setTimeout(() => {
          if (!cancelledRef.current) {
            setState({
              status: 'error',
              message:
                'The relay copies expired. Start a new transfer to send this file.',
            });
          }
        }, msUntilExpiry);

        setState({
          status: 'showing_payload',
          message:
            'Upload complete. Show this code to the receiver — they have 1 hour to download.',
          payloadData: payloadBinary,
          expiresAt: manifest.expiresAt,
          contentType: 'file',
          fileMetadata,
          currentRelays: manifest.relays,
        });
      } catch (error) {
        if (
          !cancelledRef.current &&
          !(error instanceof NostrFileCancelledError)
        ) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to send',
          });
        }
      } finally {
        sendingRef.current = false;
        if (poolRef.current) {
          poolRef.current.destroy();
          poolRef.current = null;
        }
      }
    },
    [clearExpiryTimeout],
  );

  return useMemo(
    () => ({ state, send, finish, cancel }),
    [state, send, finish, cancel],
  );
}

// Progress in bytes from chunk counts (chunks are equal-sized except the last).
function manifestChunkEstimate(fileSize: number, totalChunks: number): number {
  return Math.ceil(fileSize / Math.max(totalChunks, 1));
}
