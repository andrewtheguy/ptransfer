import { SimplePool } from 'nostr-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { wipeBufferSource } from '@/lib/crypto';
import {
  generateNostrFilePayloadBinary,
  type NostrFilePayload,
} from '@/lib/manual-signaling';
import type { TransferState } from '@/lib/nostr';
import { uint8ArrayToBase64 } from '@/lib/nostr/events';
import { NostrFileCancelledError, uploadFileToNostr } from '@/lib/nostr-file';
import type { TransferSource } from '@/lib/transfer-source';
import {
  chunkBytesEstimate,
  readSourceFully,
  validateNostrRelaySource,
} from './nostr-relay-source';

export interface UseNostrRelaySendReturn {
  state: TransferState;
  send: (content: TransferSource) => Promise<void>;
  /** One-way flow: the user confirms the receiver has the code. */
  finish: () => void;
  cancel: () => void;
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
            stats: prev.stats,
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
      let lastStats: TransferState['stats'];

      try {
        const checked = validateNostrRelaySource(content);
        if (!checked.ok) {
          setState(checked.state);
          return;
        }
        const { fileName, mimeType } = checked;

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
              lastStats = p.stats;
              switch (p.phase) {
                case 'hashing':
                  setState({
                    status: 'preparing',
                    message: 'Encrypting file...',
                    fileMetadata,
                    stats: p.stats,
                  });
                  break;
                case 'discovering':
                  setState({
                    status: 'discovering_relays',
                    message: 'Discovering Nostr relays...',
                    fileMetadata,
                    stats: p.stats,
                  });
                  break;
                case 'health_check':
                  setState({
                    status: 'discovering_relays',
                    message: `Testing relays... ${p.relaysHealthy ?? 0} working of ${p.relaysChecked ?? 0} checked`,
                    fileMetadata,
                    stats: p.stats,
                  });
                  break;
                case 'uploading':
                  setState({
                    status: 'uploading',
                    message: 'Saving encrypted pieces to relays...',
                    progress: {
                      current: Math.min(
                        (p.chunksDone ?? 0) *
                          chunkBytesEstimate(data.length, p.chunksTotal ?? 1),
                        data.length,
                      ),
                      total: data.length,
                    },
                    fileMetadata,
                    stats: p.stats,
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
          stats: lastStats,
        });
      } catch (error) {
        if (
          !cancelledRef.current &&
          !(error instanceof NostrFileCancelledError)
        ) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to send',
            stats: lastStats,
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
