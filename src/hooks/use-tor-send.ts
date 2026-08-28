import { useCallback, useEffect, useRef, useState } from 'react';
import { generatePin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata, TransferState } from '@/lib/nostr';
import {
  bootstrapTorClient,
  closeTorClient,
  type TorBridge,
} from '@/lib/tor/client';
import { formatOnionAddress, TOR_DEFAULT_PORT } from '@/lib/tor/onion-address';
import { serveUntilSent } from '@/lib/tor/serve';
import { TOR_MAX_TRANSFER_BYTES, TOR_MAX_WIRE_BYTES } from '@/lib/tor/transfer';
import type { OnionService, WebtorClient } from '@/lib/tor/webtor';
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';

/**
 * Sending a file over a v3 onion service this browser tab publishes.
 *
 * The tab is the server: it generates the service identity, establishes
 * introduction points, uploads a signed descriptor, and answers the streams
 * clients open on the rendezvous circuits. The address and a one-time password
 * are the whole rendezvous — no application signaling relay, lookup hint, or
 * third-party identity. Tor relays carry the circuits, and the descriptor stays
 * retrievable by anyone holding the onion address until it expires.
 *
 * Unlike a PIN, all 11 password data characters are secret; the twelfth is the
 * deterministic checksum. There is no public locator segment because there is
 * no signaling record to look up. There is no additional confirmation code:
 * the receiver enters the password separately, and a wrong password simply
 * fails to open the claim (see lib/tor/handshake.ts).
 *
 * The receiver may be another browser tab or ptransfer-cli's
 * `ptransfer tor receive`; the two speak the same handshake and framing.
 */

export interface UseTorSendReturn {
  state: TransferState;
  /**
   * `<address>.onion` as the receiver is given it, once the descriptor is
   * published. The port is implicit — see `formatOnionAddress`.
   */
  onionAddress: string | null;
  /** The one-time password the receiver needs alongside the address. */
  password: string | null;
  send: (content: TransferSource) => Promise<void>;
  cancel: () => void;
}

export function useTorSend(bridge: TorBridge): UseTorSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [onionAddress, setOnionAddress] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const clientRef = useRef<WebtorClient | null>(null);
  const serviceRef = useRef<OnionService | null>(null);

  // Everything this owns is taken and cleared before the first await. `send`
  // releases its guard before tearing down, so a Retry can be underway while
  // these closes are still in flight; a ref read afterwards would be the new
  // transfer's service or client, and closing it would kill it.
  const teardown = useCallback(async () => {
    const service = serviceRef.current;
    const client = clientRef.current;
    serviceRef.current = null;
    clientRef.current = null;
    if (service) {
      try {
        await service.close();
      } catch (error) {
        console.info('[tor] Failed to withdraw the onion service:', error);
      }
    }
    await closeTorClient(client);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    void teardown();
  }, [teardown]);

  // A tab that navigates away must take its introduction points and circuits
  // with it; nothing here outlives the transfer screen.
  useEffect(() => () => void cancel(), [cancel]);

  const send = useCallback(
    async (content: TransferSource) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      cancelledRef.current = false;

      const fileName = content.name;
      const fileSize = content.estimatedSize;
      const mimeType = content.type;
      const fileMetadata = { fileName, fileSize, mimeType };

      try {
        if (fileSize > TOR_MAX_TRANSFER_BYTES) {
          throw new Error(
            `The Tor transport carries at most ${formatFileSize(TOR_MAX_TRANSFER_BYTES)}; this selection is ${formatFileSize(fileSize)}.`,
          );
        }
        // A ZIP's headers and entry paths are wire bytes that no file size
        // accounts for, so a selection of many tiny files can pass the check
        // above and still not fit. Refusing here costs a moment; finding out
        // while producing bytes costs a bootstrap, a handshake, and — with no
        // resume — the whole transfer.
        if (content.projectedWireBytes > TOR_MAX_WIRE_BYTES) {
          throw new Error(
            `This selection needs up to ${formatFileSize(content.projectedWireBytes)} on the wire, over the ${formatFileSize(TOR_MAX_WIRE_BYTES)} the Tor transport allows. Archive overhead grows with the number of files; send fewer of them.`,
          );
        }

        setState({
          status: 'connecting',
          message: 'Loading the Tor client...',
          contentType: 'file',
          fileMetadata,
        });

        const client = await bootstrapTorClient({
          bridge,
          onStatus: (message) => {
            if (cancelledRef.current) return;
            setState({
              status: 'connecting',
              message,
              contentType: 'file',
              fileMetadata,
            });
          },
        });
        clientRef.current = client;
        if (cancelledRef.current) throw new Error('Cancelled');

        setState({
          status: 'connecting',
          message:
            'Establishing introduction points and publishing the descriptor...',
          contentType: 'file',
          fileMetadata,
        });
        const service = await client.publishOnionService();
        serviceRef.current = service;
        if (cancelledRef.current) throw new Error('Cancelled');

        // Two strings out of one address: `onion` is what the handshake binds
        // and always carries the port, while what the receiver is handed
        // leaves the port implicit.
        const onion = `${service.onionAddress}:${TOR_DEFAULT_PORT}`;
        const transferPassword = generatePin();
        setOnionAddress(
          formatOnionAddress(service.onionAddress, TOR_DEFAULT_PORT),
        );
        setPassword(transferPassword);

        const metadata: TransferMetadata = {
          contentType: 'file',
          fileName,
          fileSize,
          contentEncoding: wireEncodingFor(content),
          mimeType,
        };

        await serveUntilSent({
          service,
          onion,
          password: transferPassword,
          metadata,
          content,
          fileMetadata,
          isCancelled: () => cancelledRef.current,
          setState,
        });

        setState({
          status: 'complete',
          message: 'File sent',
          contentType: 'file',
          fileMetadata,
          progress: { current: fileSize, total: fileSize },
        });
      } catch (error) {
        if (!cancelledRef.current) {
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'The Tor transfer failed',
            contentType: 'file',
            fileMetadata,
          });
        }
      } finally {
        sendingRef.current = false;
        await teardown();
      }
    },
    [bridge, teardown],
  );

  return { state, onionAddress, password, send, cancel };
}
