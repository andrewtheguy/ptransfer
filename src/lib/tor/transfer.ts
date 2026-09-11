import { SLOW_TRANSPORT_MAX_BYTES } from '@/lib/crypto';
import type {
  ChannelEndReason,
  ChannelListener,
  ChannelMessage,
} from '@/lib/duplex-channel';
import {
  createTransferReceiver,
  type SendOptions,
  sendFileOverLink,
  type TransferLink,
} from '@/lib/p2p-transfer';
import { createAdaptiveAppendSink } from '@/lib/scratch-sink';
import type { TransferSource, WireEncoding } from '@/lib/transfer-source';
import { LINGER_TIMEOUT_MS, type TorFramedStream } from './framing';

/**
 * The file transfer itself, once a Tor stream has been framed and the
 * handshake has produced a content key.
 *
 * Above the framing this is the *same* protocol as the WebRTC data path —
 * encrypted chunks one way, acknowledgments and the receiver's verdict the
 * other — so it runs on the shared implementation in `lib/p2p-transfer.ts`
 * rather than a second copy of it. All this module adds is the link that
 * turns a pull-based framed stream into the push-fed, bidirectional one the
 * protocol runs on, and the transport's own size ceiling.
 */

/**
 * Largest payload a Tor transfer carries, measured on the sender's input.
 *
 * The same ceiling the Nostr file relay works under, for the same reasons —
 * see `SLOW_TRANSPORT_MAX_BYTES`. It is a hard limit rather than advice
 * because it is the *receiver's* rule too: a receiver refuses a larger offer
 * outright, so a sender that ignored it would only discover the disagreement
 * after a bootstrap and a handshake.
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

/** A framed Tor stream as a `TransferLink`. */
export interface TorLink extends TransferLink {
  /**
   * Resolve once the peer has closed its end, or reject after `timeoutMs`.
   *
   * Over Tor the close is the delivery receipt for the last message of a
   * conversation: whoever sent it waits for the peer to hang up before
   * tearing the stream down, since the peer closes as soon as it has acted on
   * that message.
   */
  waitForPeerClose: (timeoutMs?: number) => Promise<void>;
}

/**
 * Wrap a framed stream whose handshake is over as a `TransferLink`.
 *
 * From here on one read loop owns the stream's incoming side and hands every
 * frame to the link's subscribers — which must therefore subscribe right
 * after this returns, before the loop's first read completes. A frame that
 * arrives with nobody subscribed is dropped, as on a data channel.
 */
export function createTorLink(framed: TorFramedStream): TorLink {
  const listeners = new Set<ChannelListener>();
  const enders = new Set<(reason: ChannelEndReason) => void>();
  let endedWith: ChannelEndReason | null = null;
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  const end = (reason: ChannelEndReason) => {
    if (endedWith !== null) return;
    endedWith = reason;
    resolveEnded();
    for (const ender of Array.from(enders)) ender(reason);
    enders.clear();
  };

  void (async () => {
    try {
      for (;;) {
        const frame = await framed.receive();
        if (frame === null) {
          end('closed');
          return;
        }
        const message: ChannelMessage = frame.isString
          ? new TextDecoder().decode(frame.data)
          : // Subscribers expect to own an exact-size ArrayBuffer.
            (frame.data.buffer.slice(
              frame.data.byteOffset,
              frame.data.byteOffset + frame.data.byteLength,
            ) as ArrayBuffer);
        for (const listener of Array.from(listeners)) {
          try {
            listener(message);
          } catch (error) {
            console.error('[tor] A link listener failed:', error);
          }
        }
      }
    } catch (error) {
      // A malformed frame (or a stream that broke mid-frame) ends the
      // conversation; the transfer above reports what that meant.
      console.info('[tor] The transfer stream ended:', error);
      end('error');
    }
  })();

  const whileOpen = <T>(send: () => Promise<T>): Promise<T> =>
    endedWith === null
      ? send()
      : Promise.reject(new Error('The Tor stream is closed'));

  return {
    sendBinary: (data) => whileOpen(() => framed.sendBinary(data)),
    sendText: (text) => whileOpen(() => framed.sendText(text)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEnd(listener) {
      if (endedWith !== null) {
        listener(endedWith);
        return () => {};
      }
      enders.add(listener);
      return () => {
        enders.delete(listener);
      };
    },
    async waitForPeerClose(timeoutMs = LINGER_TIMEOUT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `The peer did not close the stream within ${Math.round(timeoutMs / 1000)}s`,
              ),
            ),
          timeoutMs,
        );
      });
      try {
        await Promise.race([ended, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Send `source` over an authenticated Tor stream and wait for the receiver's
 * verdict. Returns the wire byte count.
 */
export function sendFileOverTor(
  framed: TorFramedStream,
  contentKey: CryptoKey,
  source: TransferSource,
  opts: Omit<SendOptions, 'maxWireBytes'> = {},
): Promise<number> {
  return sendFileOverLink(createTorLink(framed), contentKey, source, {
    ...opts,
    maxWireBytes: TOR_MAX_WIRE_BYTES,
  });
}

export interface TorReceiveOptions {
  onProgress?: (current: number, total: number) => void;
  /** The sender's advertised input size: a progress hint, never a bound. */
  estimatedBytes?: number;
  /** Return true to abandon the transfer; the sender is told. */
  isCancelled?: () => boolean;
}

/**
 * Receive a payload from an authenticated Tor stream.
 *
 * The receiver acknowledges every chunk it stores and ends by sending its
 * verdict, `done`, which is the last message of the conversation — so this
 * then waits for the sender to hang up, its receipt that the verdict landed.
 * A missing receipt does not undo a file that is already written and
 * verified, so it is reported rather than raised.
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
  const link = createTorLink(framed);
  receiver.attach(link);

  const cancelPoll = setInterval(() => {
    if (opts.isCancelled?.()) receiver.dispose();
  }, 250);
  let payload: Blob;
  try {
    payload = await receiver.done;
  } catch (error) {
    await sink.discard().catch(() => undefined);
    throw error;
  } finally {
    clearInterval(cancelPoll);
  }

  try {
    await link.waitForPeerClose();
  } catch (error) {
    console.warn('[tor] The sender never acknowledged receipt:', error);
  }
  return payload;
}
