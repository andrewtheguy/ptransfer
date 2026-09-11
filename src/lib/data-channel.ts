import type {
  ChannelEndReason,
  ChannelListener,
  DuplexChannel,
} from './duplex-channel';

/**
 * An `RTCDataChannel` as a `DuplexChannel`: the backpressure, the send
 * ordering, and the flush that `duplex-channel.ts` promises, implemented on
 * what a data channel actually offers.
 */

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
      sentBytes += utf8Length(text);
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

  const flush = async (): Promise<void> => {
    let mark = 0;
    // Takes its place in the send queue: a send waits its turn behind
    // backpressure before `dc.send` sees it, so the mark is read once every
    // send made before this call has been handed to the channel — or failed
    // and told its caller — and before any made after it.
    const marked = sendChain.then(() => {
      mark = sentBytes;
    });
    sendChain = marked;
    await marked;
    await new Promise<void>((resolve, reject) => {
      // Bytes leave in order, so the ones sent by the mark are out once this
      // many have left in all. Whatever is sent after the mark — queued or by
      // `sendNow`, which only jumps the queue and not the channel's buffer —
      // sits behind them and is not waited for.
      const left = () => sentBytes - dc.bufferedAmount;
      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        dc.removeEventListener('bufferedamountlow', check);
        clearInterval(poll);
        enders.delete(check);
        outcome();
      };
      // The buffer is read before the channel's state: a peer that hangs up
      // the moment it has everything can close the channel before this side
      // has looked, and `bufferedAmount` keeps its last value past a close.
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
      // 'bufferedamountlow' fires at the threshold, not at empty, so the poll
      // is what sees the last bytes go.
      const poll = setInterval(check, DRAIN_POLL_MS);
      dc.addEventListener('bufferedamountlow', check);
      enders.add(check);
      check();
    });
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
