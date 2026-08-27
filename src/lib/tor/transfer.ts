import { SLOW_TRANSPORT_MAX_BYTES } from '@/lib/crypto';
import {
  ACK,
  ACK_TIMEOUT_MS,
  createTransferReceiver,
  DONE_PREFIX,
  type SendOptions,
  sendFileOverTransport,
  type TransferTransport,
} from '@/lib/p2p-transfer';
import { createAdaptiveAppendSink } from '@/lib/scratch-sink';
import type { TransferSource, WireEncoding } from '@/lib/transfer-source';
import type { TorFramedStream } from './framing';

/**
 * The file transfer itself, once a Tor stream has been framed and the
 * handshake has produced a content key.
 *
 * Above the framing this is the *same* protocol as the WebRTC data path —
 * encrypted chunks, a `DONE:<chunks>:<bytes>` trailer, an `ACK` back — so it
 * runs on the shared implementation in `lib/p2p-transfer.ts` rather than a
 * second copy of it. All this module adds is the pull-to-push adaptation a
 * stream needs and the transport's own size ceiling.
 */

/**
 * Largest payload a Tor transfer carries, measured on the sender's input.
 *
 * The same ceiling the Nostr file relay works under, for the same reasons —
 * see `SLOW_TRANSPORT_MAX_BYTES`. It is a hard limit rather than advice
 * because it is the *receiver's* rule too: ptransfer-cli refuses a larger
 * offer outright, so a sender that ignored it would only discover the
 * disagreement after a bootstrap and a handshake.
 */
export const TOR_MAX_TRANSFER_BYTES = SLOW_TRANSPORT_MAX_BYTES;

/**
 * The size past which a Tor transfer is worth a word to the sender.
 *
 * Advice, not a rule, and nothing enforces it. A circuit's throughput is the
 * luck of the relays it was built from: tens of megabytes sometimes arrive in
 * moments and sometimes crawl, and since this transport cannot resume, a slow
 * one that drops starts over. That spread is exactly why this is not a limit —
 * a fixed ceiling would refuse transfers that would have finished fine, and
 * only the sender knows how much time the file is worth.
 */
export const TOR_SUGGESTED_MAX_BYTES = 1024 * 1024;

/**
 * Wire allowance for that payload. A single file is deflated on the wire,
 * which grows incompressible input very slightly, and a generated ZIP adds
 * per-entry headers — neither is known until the bytes are produced, so the
 * wire ceiling carries a margin over the input limit. The margin is a flat
 * 1 MiB: deflate's worst case is a fraction of a percent, and the rest is
 * headroom for a selection of many small files, whose ZIP headers are what
 * actually add up.
 */
export const TOR_MAX_WIRE_BYTES = TOR_MAX_TRANSFER_BYTES + 1024 * 1024;

/**
 * The framed Tor stream as a `TransferTransport`.
 *
 * `sendBytes` resolves once the bytes have been handed to the circuit, which
 * is the backpressure the sender's stall window is measuring.
 */
export function createTorTransport(framed: TorFramedStream): TransferTransport {
  return {
    sendBinary: (data) => framed.sendBinary(data),
    sendText: (text) => framed.sendText(text),
    waitForAck: () => waitForTorAck(framed),
  };
}

/** Read frames until the receiver's `ACK` arrives, or the wait runs out. */
async function waitForTorAck(framed: TorFramedStream): Promise<void> {
  const acknowledged = (async () => {
    for (;;) {
      const message = await framed.receive();
      if (message === null) {
        throw new Error('The Tor stream closed before acknowledgment');
      }
      if (!message.isString) continue; // Ignore stray binary messages.
      const text = new TextDecoder().decode(message.data);
      if (text === ACK) return;
      // Ignore any other control string.
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timeout waiting for acknowledgment')),
      ACK_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([acknowledged, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send `source` over an authenticated Tor stream and wait for the receiver's
 * `ACK`. Returns the wire byte count.
 */
export function sendFileOverTor(
  framed: TorFramedStream,
  contentKey: CryptoKey,
  source: TransferSource,
  opts: Omit<SendOptions, 'maxWireBytes'> = {},
): Promise<number> {
  return sendFileOverTransport(createTorTransport(framed), contentKey, source, {
    ...opts,
    maxWireBytes: TOR_MAX_WIRE_BYTES,
  });
}

export interface TorReceiveOptions {
  onProgress?: (current: number, total: number) => void;
  /** The sender's advertised input size: a progress hint, never a bound. */
  estimatedBytes?: number;
  /** Return true to abandon the transfer between messages. */
  isCancelled?: () => boolean;
}

/**
 * Receive a payload from an authenticated Tor stream and acknowledge it.
 *
 * The stream is pull-based and the shared receiver is push-fed, so this is the
 * loop between them: every frame goes to the receiver until it seals the
 * payload. Only then is `ACK` sent — it means the bytes are authenticated and
 * written, which is exactly what the sender treats it as.
 */
export async function receiveFileOverTor(
  framed: TorFramedStream,
  contentKey: CryptoKey,
  encoding: WireEncoding,
  opts: TorReceiveOptions = {},
): Promise<Blob> {
  const sink = await createAdaptiveAppendSink(opts.estimatedBytes ?? 0);
  const receiver = createTransferReceiver(contentKey, encoding, sink, {
    onProgress: opts.onProgress,
    estimatedBytes: opts.estimatedBytes,
    maxWireBytes: TOR_MAX_WIRE_BYTES,
  });
  receiver.start();

  // `DONE` is the last frame the sender sends before it waits for `ACK`, so
  // the pump stops there and hands the stream back. It has to stop rather than
  // park in another read: this side still writes `ACK` and then waits for the
  // sender's close, and a second concurrent reader on the same stream would be
  // competing for those bytes.
  let sawDone = false;
  const pump = (async () => {
    while (!sawDone) {
      const message = await framed.receive();
      // A close between frames ends the pump; whether that was the end of a
      // completed transfer or the middle of one is settled below.
      if (message === null) return;
      if (opts.isCancelled?.()) throw new Error('Cancelled');
      if (message.isString) {
        const text = new TextDecoder().decode(message.data);
        sawDone = text.startsWith(DONE_PREFIX);
        receiver.onMessage(text);
      } else {
        // The receiver's ArrayBuffer path expects to own the bytes.
        receiver.onMessage(
          message.data.buffer.slice(
            message.data.byteOffset,
            message.data.byteOffset + message.data.byteLength,
          ) as ArrayBuffer,
        );
      }
    }
  })();

  // A chunk that fails to authenticate settles the transfer while the pump is
  // still parked on a read the sender may never satisfy, so a rejection — and
  // only a rejection — cuts the wait short. On that path the stream is dead to
  // this side and the caller tears it down.
  const failed = receiver.done.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => {
      throw error;
    },
  );
  failed.catch(() => undefined);

  let payload: Blob;
  try {
    await Promise.race([pump, failed]);
    if (!sawDone) {
      throw new Error('The Tor stream closed before the transfer completed');
    }
    payload = await receiver.done;
  } catch (error) {
    receiver.dispose();
    await sink.discard().catch(() => undefined);
    throw error;
  }

  await framed.sendText(ACK);
  return payload;
}
