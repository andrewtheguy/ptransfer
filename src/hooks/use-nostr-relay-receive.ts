import { SimplePool } from 'nostr-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NostrFileLivePayload } from '@/lib/manual-signaling';
import type { TransferState } from '@/lib/nostr';
import {
  decodePayloadKey,
  NostrFileCancelledError,
  receiveFileLive,
} from '@/lib/nostr-file';
import type { ReceivedContent } from '@/lib/types';
import { chunkBytesEstimate } from './nostr-relay-source';

export interface UseNostrRelayReceiveReturn {
  state: TransferState;
  receivedContent: ReceivedContent | null;
  start: (payload: NostrFileLivePayload) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useNostrRelayReceive(): UseNostrRelayReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);

  // Cancellation is per run: cancel() unlocks receivingRef, so a new receive
  // can start while the previous one is still winding down, and that run has
  // to keep seeing its own cancellation (and stop touching the shared state).
  const runRef = useRef<{ cancelled: boolean } | null>(null);
  const receivingRef = useRef(false);

  // The engine sends the sender a cancel notice first and closes its pool in
  // start()'s finally once it winds down.
  const cancel = useCallback(() => {
    if (runRef.current) runRef.current.cancelled = true;
    receivingRef.current = false;
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
      if (runRef.current) runRef.current.cancelled = true;
    },
    [],
  );

  const start = useCallback(async (payload: NostrFileLivePayload) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return;
    receivingRef.current = true;
    const run = { cancelled: false };
    runRef.current = run;
    setReceivedContent(null);

    const fileMetadata = {
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      mimeType: payload.mimeType,
    };
    const baseState = {
      contentType: 'file' as const,
      fileMetadata,
      expiresAt: payload.expiresAt,
      currentRelays: payload.controlRelays,
    };
    let lastStats: TransferState['stats'];

    try {
      setState({
        status: 'fetching',
        message: 'Connecting to the sender through Nostr relays...',
        progress: { current: 0, total: payload.fileSize },
        ...baseState,
      });

      // Reconnect dropped sockets: the control channel subscription has to
      // outlive transient relay hiccups.
      const pool = new SimplePool({ enableReconnect: true });
      const keyBytes = decodePayloadKey(payload.key);
      try {
        await doReceive(pool, keyBytes);
      } finally {
        // Close this run's sockets — never a newer run's pool.
        pool.destroy();
      }
    } catch (error) {
      if (!run.cancelled && !(error instanceof NostrFileCancelledError)) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
          stats: lastStats,
        });
      }
    } finally {
      // A cancelled run may have been superseded already; only the current
      // one may unlock receiving.
      if (runRef.current === run) receivingRef.current = false;
    }

    async function doReceive(
      pool: SimplePool,
      keyBytes: Uint8Array,
    ): Promise<void> {
      const chunkBytes = chunkBytesEstimate(
        payload.fileSize,
        payload.totalChunks,
      );
      const isCancelled = () => run.cancelled;

      const data = await receiveFileLive(payload, keyBytes, {
        pool,
        isCancelled,
        onProgress: (p) => {
          if (run.cancelled) return;
          lastStats = p.stats;
          setState({
            status: 'fetching',
            message: !p.senderConnected
              ? 'Waiting for the sender...'
              : p.chunksDone === p.chunksTotal
                ? 'All pieces received — verifying...'
                : `Receiving pieces... ${p.chunksDone}/${p.chunksTotal} (sender has uploaded ${p.available})`,
            progress: {
              current: Math.min(p.chunksDone * chunkBytes, payload.fileSize),
              total: payload.fileSize,
            },
            ...baseState,
            stats: p.stats,
          });
        },
      });
      if (run.cancelled) return;

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
  }, []);

  return useMemo(
    () => ({ state, receivedContent, start, cancel, reset }),
    [state, receivedContent, start, cancel, reset],
  );
}
