import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppendSink } from '@/lib/append-sink';
import { isValidPin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferState } from '@/lib/nostr';
import { createAdaptiveAppendSink } from '@/lib/scratch-sink';
import {
  bootstrapTorClient,
  closeTorClient,
  type TorBridge,
} from '@/lib/tor/client';
import { TorFramedStream } from '@/lib/tor/framing';
import { runTorClientHandshake, sendReady } from '@/lib/tor/handshake';
import { parseOnionAddress } from '@/lib/tor/onion-address';
import { receiveFileOverTor, TOR_MAX_TRANSFER_BYTES } from '@/lib/tor/transfer';
import type { WebtorClient } from '@/lib/tor/webtor';
import type { ReceivedContent } from '@/lib/types';

/**
 * Receiving a file from a v3 onion service, given the address and the one-time
 * password the sender showed.
 *
 * This tab is the client: it bootstraps its own Tor client, builds a
 * rendezvous circuit to the address, and authenticates with the password. Tor
 * already proves the *service* is the one the address names; the SPAKE2
 * handshake on top proves this client is the intended receiver, and produces
 * the content key in the same stroke.
 */

export interface TorReceiveRequest {
  /**
   * `<address>.onion`, as the sender showed it. A `:<port>` is accepted and
   * wins over the default, so an address carrying an explicit port still connects.
   */
  address: string;
  password: string;
  bridge: TorBridge;
}

export interface UseTorReceiveReturn {
  state: TransferState;
  receivedContent: ReceivedContent | null;
  receive: (request: TorReceiveRequest) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useTorReceive(): UseTorReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);

  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);
  const clientRef = useRef<WebtorClient | null>(null);
  const framedRef = useRef<TorFramedStream | null>(null);
  // Storage behind the received payload, which receivedContent.data reads
  // from until a reset or the next receive drops it.
  const sinkRef = useRef<AppendSink | null>(null);

  const discardSink = useCallback(() => {
    const sink = sinkRef.current;
    sinkRef.current = null;
    if (sink) void sink.discard();
  }, []);

  // Everything this owns is taken and cleared before the first await.
  // `receive` releases its guard before tearing down, so a Receive Another can
  // be underway while these closes are still in flight; a ref read afterwards
  // would be the new transfer's stream or client, and closing it would kill it.
  const teardown = useCallback(async () => {
    const framed = framedRef.current;
    const client = clientRef.current;
    framedRef.current = null;
    clientRef.current = null;
    await framed?.close();
    await closeTorClient(client);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setState({ status: 'idle' });
    void teardown();
  }, [teardown]);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    discardSink();
    setReceivedContent(null);
    setState({ status: 'idle' });
    void teardown();
  }, [teardown, discardSink]);

  // Navigating away ends the transfer and drops a completed payload: nothing
  // reaches this hook once it is gone, so neither can be read again.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      discardSink();
      void teardown();
    },
    [teardown, discardSink],
  );

  const receive = useCallback(
    async (request: TorReceiveRequest) => {
      if (receivingRef.current) return;
      receivingRef.current = true;
      cancelledRef.current = false;
      setReceivedContent(null);
      // The previous transfer's payload (if any) is gone from the UI now.
      discardSink();

      try {
        // Both inputs are checked before the bootstrap, which otherwise spends
        // minutes building circuits only to reject them afterwards.
        const parsed = parseOnionAddress(request.address);
        if (!parsed) {
          throw new Error(
            'That is not a valid onion address — check for typos.',
          );
        }
        if (!isValidPin(request.password)) {
          throw new Error('Invalid password — check for typos.');
        }

        const onStatus = (message: string) => {
          if (cancelledRef.current) return;
          setState({ status: 'connecting', message });
        };

        onStatus('Loading the Tor client...');
        const client = await bootstrapTorClient({
          bridge: request.bridge,
          onStatus,
        });
        clientRef.current = client;
        if (cancelledRef.current) throw new Error('Cancelled');

        onStatus(`Building a circuit to ${parsed.host}...`);
        const stream = await client.connectStream(parsed.host, parsed.port);
        const framed = new TorFramedStream(stream);
        framedRef.current = framed;
        if (cancelledRef.current) throw new Error('Cancelled');

        setState({ status: 'connecting', message: 'Authenticating...' });
        const { keys, metadata } = await runTorClientHandshake(
          framed,
          request.password,
          parsed.onion,
        );

        // fileSize is the sender's input size — a progress hint that bounds
        // nothing on the wire — but a sender offering more than the limit is
        // not worth connecting a transfer for.
        if (metadata.fileSize > TOR_MAX_TRANSFER_BYTES) {
          throw new Error(
            `The sender is offering ${formatFileSize(metadata.fileSize)}, over the ${formatFileSize(TOR_MAX_TRANSFER_BYTES)} limit of the Tor transport.`,
          );
        }

        const fileMetadata = {
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
        };
        setState({
          status: 'receiving',
          message: 'Receiving over Tor...',
          contentType: 'file',
          fileMetadata,
          progress: { current: 0, total: metadata.fileSize },
        });

        await sendReady(framed);
        const sink = await createAdaptiveAppendSink(metadata.fileSize);
        const payload = await receiveFileOverTor(
          framed,
          keys.contentKey,
          metadata.contentEncoding,
          sink,
          {
            estimatedBytes: metadata.fileSize,
            isCancelled: () => cancelledRef.current,
            onProgress: (current, total) =>
              setState({
                status: 'receiving',
                message: 'Receiving over Tor...',
                contentType: 'file',
                fileMetadata,
                progress: { current, total },
              }),
          },
        );

        // Cancelling between the last frame and this point still means the
        // user asked for nothing: publishing the payload here would hand back
        // a file — and a 'complete' state — after `cancel()` reset the UI.
        // Nothing else will read the payload, so its scratch file goes now.
        if (cancelledRef.current) {
          await sink.discard();
          return;
        }

        sinkRef.current = sink;
        setReceivedContent({
          contentType: 'file',
          data: payload,
          fileName: metadata.fileName,
          fileSize: payload.size,
          mimeType: metadata.mimeType,
        });
        setState({
          status: 'complete',
          message: 'File received',
          contentType: 'file',
          fileMetadata,
          progress: { current: payload.size, total: payload.size },
        });
      } catch (error) {
        if (!cancelledRef.current) {
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'The Tor transfer failed',
          });
        }
      } finally {
        receivingRef.current = false;
        await teardown();
      }
    },
    [teardown, discardSink],
  );

  return { state, receivedContent, receive, cancel, reset };
}
