import { SimplePool } from 'nostr-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  NostrFileLivePayload,
  NostrFilePayload,
} from '@/lib/manual-signaling';
import type { TransferState } from '@/lib/nostr';
import {
  decodePayloadKey,
  downloadFileFromNostr,
  NostrFileCancelledError,
  receiveFileLive,
} from '@/lib/nostr-file';
import type { ReceivedContent } from '@/lib/types';
import { chunkBytesEstimate } from './nostr-relay-source';

export interface UseNostrRelayReceiveReturn {
  state: TransferState;
  receivedContent: ReceivedContent | null;
  start: (payload: NostrFilePayload | NostrFileLivePayload) => Promise<void>;
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
  const liveRef = useRef(false);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    receivingRef.current = false;
    // The stored download has nothing to tell anyone: drop the sockets now.
    // The live flow sends the sender a cancel notice first and closes its
    // own pool when it winds down.
    if (!liveRef.current && poolRef.current) {
      poolRef.current.destroy();
      poolRef.current = null;
    }
    setState({ status: 'idle' });
  }, []);

  const reset = useCallback(() => {
    cancel();
    setReceivedContent(null);
  }, [cancel]);

  // Flag cancellation when the component unmounts mid-download; the engine
  // winds down and its pool is closed in start()'s finally (no setState here).
  useEffect(
    () => () => {
      cancelledRef.current = true;
      receivingRef.current = false;
      if (!liveRef.current && poolRef.current) {
        poolRef.current.destroy();
        poolRef.current = null;
      }
    },
    [],
  );

  const start = useCallback(
    async (payload: NostrFilePayload | NostrFileLivePayload) => {
      // Guard against concurrent invocations
      if (receivingRef.current) return;
      receivingRef.current = true;
      cancelledRef.current = false;
      setReceivedContent(null);

      const live = payload.type === 'nostr-file-live';
      liveRef.current = live;
      const fileMetadata = {
        fileName: payload.fileName,
        fileSize: payload.fileSize,
        mimeType: payload.mimeType,
      };
      const baseState = {
        contentType: 'file' as const,
        fileMetadata,
        expiresAt: payload.expiresAt,
        currentRelays: payload.relays,
      };
      let lastStats: TransferState['stats'];

      try {
        setState({
          status: 'fetching',
          message: live
            ? 'Connecting to the sender through Nostr relays...'
            : 'Fetching encrypted pieces from Nostr relays...',
          progress: { current: 0, total: payload.fileSize },
          ...baseState,
        });

        const pool = new SimplePool(live ? { enableReconnect: true } : {});
        poolRef.current = pool;
        const keyBytes = decodePayloadKey(payload.key);
        try {
          await run(pool, keyBytes);
        } finally {
          // Close this run's sockets — never a newer run's pool.
          pool.destroy();
          if (poolRef.current === pool) poolRef.current = null;
        }
      } catch (error) {
        if (
          !cancelledRef.current &&
          !(error instanceof NostrFileCancelledError)
        ) {
          setState({
            status: 'error',
            message:
              error instanceof Error ? error.message : 'Failed to receive',
            stats: lastStats,
          });
        }
      } finally {
        receivingRef.current = false;
      }

      async function run(
        pool: SimplePool,
        keyBytes: Uint8Array,
      ): Promise<void> {
        const chunkBytes = chunkBytesEstimate(
          payload.fileSize,
          payload.totalChunks,
        );
        const isCancelled = () => cancelledRef.current;
        const progressOf = (chunksDone: number) => ({
          current: Math.min(chunksDone * chunkBytes, payload.fileSize),
          total: payload.fileSize,
        });

        const data = live
          ? await receiveFileLive(payload, keyBytes, {
              pool,
              isCancelled,
              onProgress: (p) => {
                if (cancelledRef.current) return;
                lastStats = p.stats;
                setState({
                  status: 'fetching',
                  message: !p.senderConnected
                    ? 'Waiting for the sender...'
                    : p.chunksDone === p.chunksTotal
                      ? 'All pieces received — verifying...'
                      : `Receiving pieces... ${p.chunksDone}/${p.chunksTotal} (sender has uploaded ${p.available})`,
                  progress: progressOf(p.chunksDone),
                  ...baseState,
                  stats: p.stats,
                });
              },
            })
          : await downloadFileFromNostr(payload, keyBytes, {
              pool,
              isCancelled,
              onProgress: (p) => {
                if (cancelledRef.current) return;
                lastStats = p.stats;
                setState({
                  status: 'fetching',
                  message: `Fetching encrypted pieces... ${p.chunksDone}/${p.chunksTotal}`,
                  progress: progressOf(p.chunksDone),
                  ...baseState,
                  stats: p.stats,
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
          stats: lastStats,
        });
      }
    },
    [],
  );

  return useMemo(
    () => ({ state, receivedContent, start, cancel, reset }),
    [state, receivedContent, start, cancel, reset],
  );
}
