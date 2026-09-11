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
 * creates it ordered and reliable (INTEROP_PROTOCOL.md §7).
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

/**
 * Send-buffer ceiling. A send waits while the data channel's buffered amount
 * is above it, which keeps a fast producer from queueing a whole file in
 * memory ahead of a slow link.
 */
export const BACKPRESSURE_THRESHOLD = 1024 * 1024; // 1 MiB

/** Fallback poll for a drain whose 'bufferedamountlow' event never fires. */
const DRAIN_POLL_MS = 100;

const utf8 = new TextEncoder();
/** What `bufferedAmount` counts for a text message. */
const utf8Length = (text: string) => utf8.encode(text).length;

/**
 * Wrap an open (or opening) RTCDataChannel as a `DuplexChannel`.
 *
 * Takes the channel's incoming messages over: the caller must not also read
 * them through `onmessage`, and subscribes here instead.
 */
export function createDataChannelDuplex(
  dc: RTCDataChannel,
  backpressureThreshold: number = BACKPRESSURE_THRESHOLD,
): DuplexChannel {
  // Subscribers read binary messages as ArrayBuffer; make it explicit rather
  // than relying on the browser default.
  dc.binaryType = 'arraybuffer';
  // Enables the 'bufferedamountlow' event the send path drains on.
  dc.bufferedAmountLowThreshold = backpressureThreshold;

  const listeners = new Set<ChannelListener>();
  /** Told once when the channel can no longer carry messages. */
  const enders = new Set<(reason: ChannelEndReason) => void>();
  /** Set once the channel has ended, so a late `onEnd` still hears it. */
  let endedWith: ChannelEndReason | null = null;
  let closedLocally = false;
  // Set by an 'error' event. A browser may still report the channel open for
  // a moment after one, but nothing sent then can be relied on to arrive.
  let failed = false;
  let sendChain: Promise<void> = Promise.resolve();
  /**
   * Bytes handed to `dc.send` so far. With `bufferedAmount`, which counts the
   * ones still waiting, it says how many have left — what `flush` waits on.
   */
  let sentBytes = 0;
  /**
   * Bytes `sendNow` put ahead of the queue. A flush discounts the ones sent
   * after it took its mark, which leave in place of the sends it waits on.
   */
  let aheadBytes = 0;

  const isOpen = () => !closedLocally && !failed && dc.readyState === 'open';
  /** Why a send cannot go out, once `isOpen()` says it cannot. */
  const notOpenError = () =>
    new Error(failed ? 'Data channel failed' : 'Data channel not open');

  dc.addEventListener('message', (event: MessageEvent) => {
    if (closedLocally) return;
    const data: unknown = event.data;
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) return;
    // A snapshot, so a listener that unsubscribes (or subscribes another)
    // while handling this message does not disturb the dispatch.
    for (const listener of Array.from(listeners)) {
      try {
        listener(data);
      } catch (error) {
        console.error('Data channel listener failed:', error);
      }
    }
  });
  const end = (reason: ChannelEndReason) => {
    if (endedWith !== null) return;
    endedWith = reason;
    for (const ender of Array.from(enders)) ender(reason);
    enders.clear();
  };
  dc.addEventListener('close', () => end('closed'));
  dc.addEventListener('error', (event) => {
    console.error('DataChannel error:', event);
    // Terminal before the waits are told, so nothing sent from their
    // rejection handlers slips through.
    failed = true;
    end('error');
  });

  const waitForDrain = () =>
    new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        dc.removeEventListener('bufferedamountlow', finish);
        clearInterval(poll);
        resolve();
      };
      // The poll also covers a channel that closes while draining, which
      // fires no 'bufferedamountlow'.
      const poll = setInterval(() => {
        if (!isOpen() || dc.bufferedAmount <= backpressureThreshold) finish();
      }, DRAIN_POLL_MS);
      dc.addEventListener('bufferedamountlow', finish);
    });

  const transmit = async (data: string | Uint8Array) => {
    if (!isOpen()) throw notOpenError();
    while (dc.bufferedAmount > backpressureThreshold) {
      await waitForDrain();
      if (failed) throw notOpenError();
      if (!isOpen()) {
        throw new Error('Data channel closed before send completed');
      }
    }
    if (typeof data === 'string') {
      dc.send(data);
      sentBytes += utf8Length(data);
    } else {
      // send() transmits exactly [byteOffset, byteOffset+byteLength). Callers
      // pass fresh, exact-size views (encryptChunk output), so no copy is
      // needed.
      dc.send(data as Uint8Array<ArrayBuffer>);
      sentBytes += data.byteLength;
    }
  };

  // One chain for every send, so a message sent while an earlier one waits on
  // backpressure cannot overtake it. A failed send does not break the chain
  // for the ones behind it; each still reports its own outcome.
  const enqueue = (data: string | Uint8Array): Promise<void> => {
    const sent = sendChain.then(() => transmit(data));
    sendChain = sent.catch(() => undefined);
    return sent;
  };

  const sendNow = (text: string): boolean => {
    if (!isOpen()) return false;
    try {
      dc.send(text);
      const length = utf8Length(text);
      sentBytes += length;
      aheadBytes += length;
      return true;
    } catch {
      return false;
    }
  };

  const subscribe = (listener: ChannelListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const flush = (): Promise<void> => {
    let mark = 0;
    let aheadAtMark = 0;
    // Takes its place in the send queue: a send waits its turn behind
    // backpressure before `dc.send` sees it, so the mark is read once every
    // send made before this call has been handed to the channel — or failed
    // and told its caller — and before any made after it.
    const marked = sendChain.then(() => {
      mark = sentBytes;
      aheadAtMark = aheadBytes;
    });
    sendChain = marked;
    return marked.then(
      () =>
        new Promise<void>((resolve, reject) => {
          // Bytes leave in order, so the ones sent by the mark are out once
          // this many have left in all — less what `sendNow` has put ahead
          // of them since, which leaves in their place.
          const left = () =>
            sentBytes - dc.bufferedAmount - (aheadBytes - aheadAtMark);
          let settled = false;
          const settle = (outcome: () => void) => {
            if (settled) return;
            settled = true;
            dc.removeEventListener('bufferedamountlow', check);
            clearInterval(poll);
            enders.delete(check);
            outcome();
          };
          // The buffer is read before the channel's state: a peer that hangs
          // up the moment it has everything can close the channel before
          // this side has looked, and `bufferedAmount` keeps its last value
          // past a close.
          const check = () => {
            if (left() >= mark) {
              settle(resolve);
            } else if (!isOpen()) {
              const unsent = mark - left();
              settle(() =>
                reject(
                  new Error(
                    failed
                      ? `Data channel failed with ${unsent} bytes unsent`
                      : `Data channel closed with ${unsent} bytes unsent`,
                  ),
                ),
              );
            }
          };
          // 'bufferedamountlow' fires at the threshold, not at empty, so the
          // poll is what sees the last bytes go.
          const poll = setInterval(check, DRAIN_POLL_MS);
          dc.addEventListener('bufferedamountlow', check);
          enders.add(check);
          check();
        }),
    );
  };

  const onEnd: DuplexChannel['onEnd'] = (listener) => {
    if (endedWith !== null) {
      listener(endedWith);
      return () => {};
    }
    enders.add(listener);
    return () => {
      enders.delete(listener);
    };
  };

  const close = () => {
    if (closedLocally) return;
    closedLocally = true;
    listeners.clear();
    // Closing the peer connection underneath a data channel fires no 'close'
    // event on it, so waits are ended here rather than left to the timeout.
    end('closed');
    try {
      dc.close();
    } catch {
      // Already closed.
    }
  };

  return {
    sendBinary: enqueue,
    sendText: enqueue,
    sendNow,
    subscribe,
    flush,
    onEnd,
    close,
  };
}
