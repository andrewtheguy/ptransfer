/**
 * A bidirectional message channel between two connected peers.
 *
 * Once a WebRTC data channel opens, neither side is the sender or the
 * receiver of the channel itself: both may send and both may listen, at any
 * time. The file transfer (`lib/p2p-transfer.ts`) is one client of it —
 * chunks and `DONE` one way, `ACK` the other — and anything else the two
 * peers need to say to each other once connected rides the same channel
 * beside it.
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
   * Hand every incoming message to `listener` until the returned function is
   * called. Every current subscriber sees every message.
   */
  subscribe: (listener: ChannelListener) => () => void;
  /**
   * Resolve with the first incoming message `accept` returns true for;
   * messages it declines are left to the other subscribers. Rejects if the
   * channel closes or errors first, or after `timeoutMs`. `purpose` names what
   * is awaited in those errors ("acknowledgment").
   *
   * With `clockStart`, listening begins now but the `timeoutMs` clock starts
   * only once it resolves, so a reply can be listened for before the message
   * it answers has gone out without that send eating into the reply's time.
   * If `clockStart` rejects, the wait rejects with its error.
   */
  waitFor: (
    accept: (message: ChannelMessage) => boolean,
    timeoutMs: number,
    purpose: string,
    clockStart?: Promise<unknown>,
  ) => Promise<ChannelMessage>;
  /** Close the channel. Pending waits reject; later sends fail. */
  close: () => void;
}

/**
 * Send-buffer ceiling. A send waits while the data channel's buffered amount
 * is above it, which keeps a fast producer from queueing a whole file in
 * memory ahead of a slow link.
 */
export const BACKPRESSURE_THRESHOLD = 1024 * 1024; // 1 MiB

/** Fallback poll for a drain whose 'bufferedamountlow' event never fires. */
const DRAIN_POLL_MS = 100;

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
  /** Pending waits, told when the channel can no longer answer them. */
  const enders = new Set<(reason: 'closed' | 'error') => void>();
  let closedLocally = false;
  // Set by an 'error' event. A browser may still report the channel open for
  // a moment after one, but nothing sent then can be relied on to arrive.
  let failed = false;
  let sendChain: Promise<void> = Promise.resolve();

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
  const end = (reason: 'closed' | 'error') => {
    for (const ender of Array.from(enders)) ender(reason);
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
    } else {
      // send() transmits exactly [byteOffset, byteOffset+byteLength). Callers
      // pass fresh, exact-size views (encryptChunk output), so no copy is
      // needed.
      dc.send(data as Uint8Array<ArrayBuffer>);
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

  const subscribe = (listener: ChannelListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const waitFor: DuplexChannel['waitFor'] = (
    accept,
    timeoutMs,
    purpose,
    clockStart,
  ) =>
    new Promise<ChannelMessage>((resolve, reject) => {
      if (!isOpen()) {
        reject(
          new Error(
            failed
              ? `Data channel error while waiting for ${purpose}`
              : `Data channel closed before ${purpose}`,
          ),
        );
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        enders.delete(onEnd);
        clearTimeout(timer);
        outcome();
      };
      const unsubscribe = subscribe((message) => {
        if (accept(message)) settle(() => resolve(message));
      });
      // A close or error means the awaited message can never arrive, so fail
      // at once instead of waiting out the timeout.
      const onEnd = (reason: 'closed' | 'error') => {
        settle(() =>
          reject(
            new Error(
              reason === 'closed'
                ? `Data channel closed before ${purpose}`
                : `Data channel error while waiting for ${purpose}`,
            ),
          ),
        );
      };
      enders.add(onEnd);
      const startClock = () => {
        if (settled) return;
        timer = setTimeout(() => {
          settle(() => reject(new Error(`Timeout waiting for ${purpose}`)));
        }, timeoutMs);
      };
      if (clockStart) {
        clockStart.then(startClock, (error: unknown) =>
          settle(() => reject(error)),
        );
      } else {
        startClock();
      }
    });

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
    subscribe,
    waitFor,
    close,
  };
}
