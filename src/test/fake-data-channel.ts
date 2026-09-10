/**
 * An in-memory pair of connected RTCDataChannel stand-ins, enough of the
 * interface for `createDataChannelDuplex` to run against in a unit test.
 *
 * Each side delivers what it sends to the other in order, as separate tasks
 * the way a browser does. `hold()` stops delivery so sends pile up in
 * `bufferedAmount`, and `release()` lets them through, which is how a test
 * drives backpressure.
 */
export class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  /** Every message this side has sent, in order. */
  readonly sent: (string | ArrayBuffer)[] = [];

  private peer: FakeDataChannel | null = null;
  private held = false;
  private queue: (string | ArrayBuffer)[] = [];

  static pair(): [FakeDataChannel, FakeDataChannel] {
    const a = new FakeDataChannel();
    const b = new FakeDataChannel();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 'open') {
      throw new DOMException('RTCDataChannel is not open', 'InvalidStateError');
    }
    const message =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : (new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            ).slice().buffer as ArrayBuffer);
    this.sent.push(message);
    this.queue.push(message);
    this.bufferedAmount += sizeOf(message);
    if (!this.held) this.flush();
  }

  /** Stop delivering sends; they accumulate in `bufferedAmount`. */
  hold() {
    this.held = true;
  }

  /** Deliver everything held, and resume delivering as sends happen. */
  release() {
    this.held = false;
    this.flush();
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const peer = this.peer;
    setTimeout(() => {
      this.dispatchEvent(new Event('close'));
      if (peer && peer.readyState !== 'closed') {
        peer.readyState = 'closed';
        peer.dispatchEvent(new Event('close'));
      }
    }, 0);
  }

  /** Fire an 'error' event, as a failed SCTP association would. */
  fail() {
    this.dispatchEvent(new Event('error'));
  }

  private flush() {
    const messages = this.queue;
    this.queue = [];
    for (const message of messages) {
      setTimeout(() => {
        const wasAbove = this.bufferedAmount > this.bufferedAmountLowThreshold;
        this.bufferedAmount -= sizeOf(message);
        if (this.peer?.readyState === 'open') {
          this.peer.dispatchEvent(
            new MessageEvent('message', { data: message }),
          );
        }
        if (
          wasAbove &&
          this.bufferedAmount <= this.bufferedAmountLowThreshold
        ) {
          this.dispatchEvent(new Event('bufferedamountlow'));
        }
      }, 0);
    }
  }
}

function sizeOf(message: string | ArrayBuffer): number {
  return typeof message === 'string'
    ? new TextEncoder().encode(message).length
    : message.byteLength;
}

/** The pair, typed as what `createDataChannelDuplex` accepts. */
export function fakeDataChannelPair(): [
  FakeDataChannel & RTCDataChannel,
  FakeDataChannel & RTCDataChannel,
] {
  return FakeDataChannel.pair() as [
    FakeDataChannel & RTCDataChannel,
    FakeDataChannel & RTCDataChannel,
  ];
}
