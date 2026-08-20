import { SimplePool } from 'nostr-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { wipeBufferSource } from '@/lib/crypto';
import {
  generateNostrFilePayloadBinary,
  type NostrFileLivePayload,
} from '@/lib/manual-signaling';
import type { TransferState } from '@/lib/nostr';
import { uint8ArrayToBase64 } from '@/lib/nostr/events';
import { NostrFileCancelledError, sendFileLive } from '@/lib/nostr-file';
import type { TransferSource } from '@/lib/transfer-source';
import {
  chunkBytesEstimate,
  readSourceFully,
  validateNostrRelaySource,
} from './nostr-relay-source';

export interface UseNostrRelayLiveSendReturn {
  state: TransferState;
  send: (content: TransferSource) => Promise<void>;
  cancel: () => void;
}

/**
 * Live (single-copy) Nostr relay send. The code is shown as soon as relays
 * are selected (`showing_payload`) and stays up while the upload and the
 * receiver's download run side by side; the state completes on its own when
 * the receiver confirms the verified file.
 */
export function useNostrRelayLiveSend(): UseNostrRelayLiveSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });

  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const poolRef = useRef<SimplePool | null>(null);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    setState({ status: 'idle' });
  }, []);

  // On unmount: flag cancellation so the engine winds down and closes the
  // pool itself. No setState here.
  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    [],
  );

  const send = useCallback(async (content: TransferSource) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    cancelledRef.current = false;

    const isCancelled = () => cancelledRef.current;

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
      // Reconnect dropped sockets: the control channel subscription has to
      // outlive transient relay hiccups.
      const pool = new SimplePool({ enableReconnect: true });
      poolRef.current = pool;

      let payloadBinary: Uint8Array | null = null;
      let expiresAt = 0;
      let relays: string[] = [];

      await sendFileLive(data, fileMetadata, {
        pool,
        isCancelled,
        onReady: (manifest, keyBytes) => {
          const payload: NostrFileLivePayload = {
            ...manifest,
            type: 'nostr-file-live',
            key: uint8ArrayToBase64(keyBytes),
          };
          wipeBufferSource(keyBytes);
          payloadBinary = generateNostrFilePayloadBinary(payload);
          expiresAt = manifest.expiresAt;
          relays = manifest.relays;
        },
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
              break;
            case 'transfer': {
              if (!payloadBinary) break;
              const chunksDone = p.chunksDone ?? 0;
              const chunksTotal = p.chunksTotal ?? 1;
              const have = p.receiverHave ?? 0;
              const uploaded = chunksDone === chunksTotal;
              let message: string;
              if (!p.receiverConnected) {
                message = uploaded
                  ? 'All pieces uploaded. Waiting for the receiver to enter the code...'
                  : `Uploading pieces (${chunksDone}/${chunksTotal})... waiting for the receiver to enter the code.`;
              } else if (have >= chunksTotal) {
                message = 'Receiver has every piece — verifying...';
              } else {
                message = `Receiver connected — has ${have}/${chunksTotal} pieces (uploaded ${chunksDone}/${chunksTotal}${
                  p.resent ? `, re-sent ${p.resent}` : ''
                }).`;
              }
              setState({
                status: 'showing_payload',
                message,
                payloadData: payloadBinary,
                expiresAt,
                progress: {
                  current: Math.min(
                    have * chunkBytesEstimate(data.length, chunksTotal),
                    data.length,
                  ),
                  total: data.length,
                },
                contentType: 'file',
                fileMetadata,
                currentRelays: relays,
              });
              break;
            }
          }
        },
      });
      if (cancelledRef.current) return;

      setState({
        status: 'complete',
        message: 'File relayed via Nostr!',
        contentType: 'file',
        fileMetadata,
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
      // Close this run's sockets — never a newer run's pool.
      if (poolRef.current) {
        poolRef.current.destroy();
        poolRef.current = null;
      }
    }
  }, []);

  return useMemo(() => ({ state, send, cancel }), [state, send, cancel]);
}
