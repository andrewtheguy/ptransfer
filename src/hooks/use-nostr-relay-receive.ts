import { SimplePool } from 'nostr-tools';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NostrFilePayload } from '@/lib/manual-signaling';
import type { TransferState } from '@/lib/nostr';
import {
  decodePayloadKey,
  downloadFileFromNostr,
  NostrFileCancelledError,
} from '@/lib/nostr-file';
import type { ReceivedContent } from '@/lib/types';

export interface UseNostrRelayReceiveReturn {
  state: TransferState;
  receivedContent: ReceivedContent | null;
  start: (payload: NostrFilePayload) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useNostrRelayReceive(): UseNostrRelayReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);

  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);
  const poolRef = useRef<SimplePool | null>(null);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    receivingRef.current = false;
    if (poolRef.current) {
      poolRef.current.destroy();
      poolRef.current = null;
    }
    setState({ status: 'idle' });
  }, []);

  const reset = useCallback(() => {
    cancel();
    setReceivedContent(null);
  }, [cancel]);

  const start = useCallback(async (payload: NostrFilePayload) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return;
    receivingRef.current = true;
    cancelledRef.current = false;
    setReceivedContent(null);

    const fileMetadata = {
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      mimeType: payload.mimeType,
    };

    try {
      setState({
        status: 'fetching',
        message: 'Fetching encrypted pieces from Nostr relays...',
        progress: { current: 0, total: payload.fileSize },
        contentType: 'file',
        fileMetadata,
        expiresAt: payload.expiresAt,
        currentRelays: payload.relays,
      });

      const pool = new SimplePool();
      poolRef.current = pool;
      const keyBytes = decodePayloadKey(payload.key);
      const chunkBytes = Math.ceil(
        payload.fileSize / Math.max(payload.totalChunks, 1),
      );

      const data = await downloadFileFromNostr(payload, keyBytes, {
        pool,
        isCancelled: () => cancelledRef.current,
        onProgress: (p) => {
          if (cancelledRef.current) return;
          setState({
            status: 'fetching',
            message: `Fetching encrypted pieces... ${p.chunksDone}/${p.chunksTotal}`,
            progress: {
              current: Math.min(p.chunksDone * chunkBytes, payload.fileSize),
              total: payload.fileSize,
            },
            contentType: 'file',
            fileMetadata,
            expiresAt: payload.expiresAt,
            currentRelays: payload.relays,
          });
        },
      });
      if (cancelledRef.current) return;

      setReceivedContent({
        contentType: 'file',
        data: new Blob([data as BlobPart], {
          type: payload.mimeType || 'application/octet-stream',
        }),
        fileName: payload.fileName,
        fileSize: data.length,
        mimeType: payload.mimeType,
      });
      setState({
        status: 'complete',
        message: 'File received via Nostr!',
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
          message: error instanceof Error ? error.message : 'Failed to receive',
        });
      }
    } finally {
      receivingRef.current = false;
      if (poolRef.current) {
        poolRef.current.destroy();
        poolRef.current = null;
      }
    }
  }, []);

  return useMemo(
    () => ({ state, receivedContent, start, cancel, reset }),
    [state, receivedContent, start, cancel, reset],
  );
}
