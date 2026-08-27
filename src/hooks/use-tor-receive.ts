import { useCallback, useEffect, useRef, useState } from 'react';
import { isValidPin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferState } from '@/lib/nostr';
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
 *
 * The sender may be another browser tab or ptransfer-cli's
 * `ptransfer tor send`.
 */

export interface TorReceiveRequest {
  /** `<address>.onion` or `<address>.onion:<port>`, as the sender showed it. */
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

  const teardown = useCallback(async () => {
    const framed = framedRef.current;
    framedRef.current = null;
    await framed?.close();
    const client = clientRef.current;
    clientRef.current = null;
    await closeTorClient(client);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setState({ status: 'idle' });
    void teardown();
  }, [teardown]);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    setReceivedContent(null);
    setState({ status: 'idle' });
    void teardown();
  }, [teardown]);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      void teardown();
    },
    [teardown],
  );

  const receive = useCallback(
    async (request: TorReceiveRequest) => {
      if (receivingRef.current) return;
      receivingRef.current = true;
      cancelledRef.current = false;
      setReceivedContent(null);

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

        setState({
          status: 'connecting',
          message: 'Loading the Tor client...',
        });
        const client = await bootstrapTorClient({
          bridge: request.bridge,
          onStatus: (message) => {
            if (cancelledRef.current) return;
            setState({ status: 'connecting', message });
          },
        });
        clientRef.current = client;
        if (cancelledRef.current) throw new Error('Cancelled');

        setState({
          status: 'connecting',
          message: `Building a circuit to ${parsed.host}...`,
        });
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
        const payload = await receiveFileOverTor(
          framed,
          keys.contentKey,
          metadata.contentEncoding,
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

        // The ACK is the last frame of the conversation and the sender is
        // waiting on it; its close is the receipt that it arrived. Failing to
        // get one does not undo a file that is already written and verified,
        // so it is reported rather than raised.
        try {
          await framed.waitForClose();
        } catch (error) {
          console.warn('[tor] The sender never acknowledged receipt:', error);
        }

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
    [teardown],
  );

  return { state, receivedContent, receive, cancel, reset };
}
