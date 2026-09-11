/**
 * A bidirectional message channel between two connected peers.
 *
 * Once a WebRTC data channel opens, neither side is the sender or the
 * receiver of the channel itself: both may send and both may listen, at any
 * time. The file transfer (`lib/p2p-transfer.ts`) is one client of it —
 * chunks and control messages from the sender, nothing back — and anything
 * else the two peers need to say to each other once connected rides the same
 * channel beside it.
 *
 * Messages keep the text/binary distinction the data channel gives natively,
 * and arrive reliably and in order: whoever creates the underlying channel
 * creates it ordered and reliable (INTEROP_PROTOCOL.md §7). This file is the
 * shape alone, so the code that runs on it — the transfer, the Code Exchange
 * session — depends on no WebRTC type; `data-channel.ts` is the adapter that
 * turns an `RTCDataChannel` into one.
 *
 * Incoming messages are broadcast to every current subscriber, so several
 * clients can share the channel without taking messages from each other.
 * Nothing is held for a subscriber that has not arrived yet: a message that
 * lands while nobody is listening is dropped, so a client that must see
 * everything subscribes from the channel-open callback, before the first
 * message can be dispatched. That is deliberate — a peer could otherwise fill
 * this side's memory with messages nothing here will ever read.
 */

/** One message off the channel. Binary messages arrive as an ArrayBuffer. */
export type ChannelMessage = string | ArrayBuffer;

export type ChannelListener = (message: ChannelMessage) => void;

export interface DuplexChannel {
  /**
   * Send one binary message. Sends leave in call order, and each one resolves
   * only once the channel has room for more, so a producer that awaits every
   * send is paced by the peer.
   *
   * There is no timeout of its own: while the channel stays open and the
   * peer stops draining it, a send (and every send queued behind it) stays
   * pending indefinitely. It fails only when the channel closes or errors. A
   * caller that needs a bound races it, as the transfer's stall watchdog does.
   */
  sendBinary: (data: Uint8Array) => Promise<void>;
  /**
   * Send one text message, in call order with every other send. Waits on
   * backpressure like `sendBinary`, with the same lack of a timeout.
   */
  sendText: (text: string) => Promise<void>;
  /**
   * Send one text message at once, ahead of anything queued behind
   * backpressure, and report whether it went out. Only for a message after
   * which nothing else matters — a transfer's `abort` on the way out — since
   * it may overtake sends made before it.
   */
  sendNow: (text: string) => boolean;
  /**
   * Hand every incoming message to `listener` until the returned function is
   * called. Every current subscriber sees every message.
   */
  subscribe: (listener: ChannelListener) => () => void;
  /**
   * Resolve once every send made before the call has left the channel's
   * buffer — handed to the transport, which delivers from there — so the
   * caller may close without cutting off the tail. It waits its turn behind
   * sends still queued on backpressure, with the same lack of a timeout;
   * sends made after the call do not hold it up, and a send that failed on
   * its own has told its caller and is not waited for. Rejects if the
   * channel closes or errors with some of those bytes still buffered.
   */
  flush: () => Promise<void>;
  /**
   * Call `listener` once if the channel closes or errors, until the returned
   * function is called. A channel that has already ended calls it at once.
   */
  onEnd: (listener: (reason: ChannelEndReason) => void) => () => void;
  /** Close the channel. Pending waits reject; later sends fail. */
  close: () => void;
}

/** Why a channel can no longer carry messages. */
export type ChannelEndReason = 'closed' | 'error';
