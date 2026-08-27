import { useCallback, useEffect, useRef, useState } from 'react';
import { generatePin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata, TransferState } from '@/lib/nostr';
import {
  bootstrapTorClient,
  closeTorClient,
  type TorBridge,
} from '@/lib/tor/client';
import { TorFramedStream } from '@/lib/tor/framing';
import { runTorServiceHandshake } from '@/lib/tor/handshake';
import { TOR_DEFAULT_PORT } from '@/lib/tor/onion-address';
import { sendFileOverTor, TOR_MAX_TRANSFER_BYTES } from '@/lib/tor/transfer';
import type { OnionService, WebtorClient } from '@/lib/tor/webtor';
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';

/**
 * Sending a file over a v3 onion service this browser tab publishes.
 *
 * The tab is the server: it generates the service identity, establishes
 * introduction points, uploads a signed descriptor, and answers the streams
 * clients open on the rendezvous circuits. The address and a one-time password
 * are the whole rendezvous — no relay, no lookup hint, no third-party
 * identity, and nothing published that a later observer could correlate.
 *
 * Unlike a PIN, the password's *entire* 12 characters are secret: there is no
 * public locator segment, because there is nothing public to look anything up
 * in. That is also why there is no confirmation code here — the pair is only
 * ever handed over together, and a wrong password simply fails to open the
 * claim (see lib/tor/handshake.ts).
 *
 * The receiver may be another browser tab or ptransfer-cli's
 * `ptransfer tor receive`; the two speak the same handshake and framing.
 */

/**
 * How long the tab keeps the service up, from publish to a delivered file. A
 * resource backstop, not a security control: the password is single-use by
 * convention and the address dies with the tab either way.
 */
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long one accepted connection may take before it is dropped and the
 * service goes back to waiting.
 *
 * Anyone who has the address can open the port, so an accepted connection is
 * not yet a receiver and must not be able to hold the service against the real
 * one. The bound covers a whole turn — handshake and a megabyte crawling down
 * a Tor circuit — so it is generous; the point is only that it exists.
 */
const CONNECTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How many connections may fail to authenticate before the tab gives up. The
 * password is far too long to guess — this bounds a stranger who found the
 * address hammering the service, not a realistic search.
 */
const MAX_FAILED_HANDSHAKES = 20;

export interface UseTorSendReturn {
  state: TransferState;
  /** `<address>.onion:<port>`, once the descriptor is published. */
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

        // The port is part of the string both sides bind the handshake to, so
        // it is displayed rather than implied.
        const onion = `${service.onionAddress}:${TOR_DEFAULT_PORT}`;
        const transferPassword = generatePin();
        setOnionAddress(onion);
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

interface ServeOptions {
  service: OnionService;
  onion: string;
  password: string;
  metadata: TransferMetadata;
  content: TransferSource;
  fileMetadata: { fileName: string; fileSize: number; mimeType: string };
  isCancelled: () => boolean;
  setState: (state: TransferState) => void;
}

/**
 * Accept connections until one of them takes the file.
 *
 * A connection that cannot authenticate and one that drops mid-transfer are
 * both just a connection that did not deliver the file: the address and
 * password are untouched either way, so the receiver can come back, and the
 * failure count bounds a stranger who found the address from hammering it.
 */
async function serveUntilSent(options: ServeOptions): Promise<void> {
  const { service, fileMetadata, isCancelled, setState } = options;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let failures = 0;

  setState({
    status: 'waiting_for_receiver',
    message: 'Waiting for a receiver...',
    contentType: 'file',
    fileMetadata,
  });

  for (;;) {
    if (isCancelled()) throw new Error('Cancelled');

    // The deadline covers waiting for a connection, not only the gaps between
    // them: a service nobody ever reaches is exactly when this most needs to
    // stop on its own.
    const stream = await withTimeout(
      service.accept(),
      Math.max(1, deadline - Date.now()),
      `No transfer finished within ${WAIT_TIMEOUT_MS / 60000} minutes. Start a new transfer.`,
    );
    if (stream === null) {
      if (isCancelled()) throw new Error('Cancelled');
      throw new Error('The onion service stopped accepting connections');
    }

    const framed = new TorFramedStream(stream);
    setState({
      status: 'connecting',
      message: 'A receiver connected; authenticating...',
      contentType: 'file',
      fileMetadata,
    });

    let delivered = false;
    try {
      delivered = await withTimeout(
        serveConnection(framed, options),
        CONNECTION_TIMEOUT_MS,
        `The peer went quiet for ${CONNECTION_TIMEOUT_MS / 1000}s`,
      );
    } catch (error) {
      failures += 1;
      console.warn('[tor] A connection failed:', error);
      if (failures >= MAX_FAILED_HANDSHAKES) {
        throw new Error(
          `Giving up after ${failures} failed connections. Start a new transfer.`,
        );
      }
      setState({
        status: 'waiting_for_receiver',
        message: `A connection failed (${failures}/${MAX_FAILED_HANDSHAKES}). Still waiting...`,
        contentType: 'file',
        fileMetadata,
      });
      continue;
    } finally {
      await framed.close();
    }

    if (delivered) return;

    // A receiver that declined after seeing the metadata leaves the password
    // untouched, and the source is repeatable, so the next one gets the file
    // from the start.
    setState({
      status: 'waiting_for_receiver',
      message: 'The receiver cancelled. Still waiting...',
      contentType: 'file',
      fileMetadata,
    });
  }
}

/** One accepted connection: authenticate the peer, then hand it the file. */
async function serveConnection(
  framed: TorFramedStream,
  options: ServeOptions,
): Promise<boolean> {
  const { onion, password, metadata, content, fileMetadata, setState } =
    options;

  const handshake = await runTorServiceHandshake(
    framed,
    password,
    onion,
    metadata,
  );
  if (handshake.outcome === 'cancelled') return false;

  setState({
    status: 'transferring',
    message: 'Receiver authenticated; sending over Tor...',
    contentType: 'file',
    fileMetadata,
    progress: { current: 0, total: fileMetadata.fileSize },
  });

  await sendFileOverTor(framed, handshake.keys.contentKey, content, {
    onProgress: (current, total) =>
      setState({
        status: 'transferring',
        message: 'Sending over Tor...',
        contentType: 'file',
        fileMetadata,
        progress: { current, total },
      }),
    isCancelled: options.isCancelled,
  });
  return true;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
