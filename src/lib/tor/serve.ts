import type { TransferMetadata, TransferState } from '@/lib/nostr';
import type { TransferSource } from '@/lib/transfer-source';
import { TorFramedStream } from './framing';
import { runTorServiceHandshake } from './handshake';
import { sendFileOverTor } from './transfer';
import type { OnionService } from './webtor';

/**
 * Answering an onion service's clients until one of them takes the file.
 *
 * Split out of `useTorSend` for a reason worth stating: the wait deadline
 * lives in the accept loop and must never end up wrapping a transfer — it once
 * did, on the CLI side, and the only way to hold that line is to drive this
 * loop without a Tor client behind it. `OnionService` is an interface, so a
 * test supplies its own.
 */

/**
 * How long the sender waits for a receiver that can authenticate.
 *
 * A resource backstop, not a security control: the password is single-use by
 * convention and the address dies with the tab either way. It bounds the
 * *wait*, not a transfer — once a peer has proved it knows the password it is
 * the receiver, and cutting its transfer off at an arbitrary minute would be a
 * speed-based size limit in disguise, which this transport deliberately does
 * not have. What polices a transfer is the stall window in `sendFileOverTor`.
 */
export const TOR_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long an accepted connection may take to authenticate before it is
 * dropped and the service goes back to waiting.
 *
 * Anyone who has the address can open the port, so an accepted connection is
 * not yet a receiver and must not be able to hold the service against the real
 * one. It covers the handshake only, which is a few frames.
 */
export const TOR_HANDSHAKE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How many connections may fail to authenticate before the tab gives up. The
 * password is far too long to guess — this bounds a stranger who found the
 * address hammering the service, not a realistic search.
 */
export const TOR_MAX_FAILED_HANDSHAKES = 20;

export interface ServeOptions {
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
export async function serveUntilSent(options: ServeOptions): Promise<void> {
  const { service, fileMetadata, isCancelled, setState } = options;
  const deadline = Date.now() + TOR_WAIT_TIMEOUT_MS;
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
      `No receiver authenticated within ${TOR_WAIT_TIMEOUT_MS / 60000} minutes. Start a new transfer.`,
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
      delivered = await serveConnection(framed, options);
    } catch (error) {
      failures += 1;
      console.warn('[tor] A connection failed:', error);
      if (failures >= TOR_MAX_FAILED_HANDSHAKES) {
        throw new Error(
          `Giving up after ${failures} failed connections. Start a new transfer.`,
        );
      }
      setState({
        status: 'waiting_for_receiver',
        message: `A connection failed (${failures}/${TOR_MAX_FAILED_HANDSHAKES}). Still waiting...`,
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

  // Only the handshake is on a clock. Past it the peer is the receiver, and
  // the transfer polices itself: a receiver that stops draining the circuit
  // trips the stall window in sendFileOverTor.
  const handshake = await withTimeout(
    runTorServiceHandshake(framed, password, onion, metadata),
    TOR_HANDSHAKE_TIMEOUT_MS,
    `The peer went quiet for ${TOR_HANDSHAKE_TIMEOUT_MS / 1000}s without authenticating`,
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
