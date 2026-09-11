import { describe, expect, it } from 'vitest';
import { fakeDataChannelPair } from '../test/fake-data-channel';
import {
  type ChannelMessage,
  createDataChannelDuplex,
  type DuplexChannel,
} from './duplex-channel';

function duplexPair(threshold?: number) {
  const [dcA, dcB] = fakeDataChannelPair();
  return {
    dcA,
    dcB,
    a: createDataChannelDuplex(dcA, threshold),
    b: createDataChannelDuplex(dcB, threshold),
  };
}

/** Collect what `channel` receives until `count` messages have arrived. */
function collect(
  channel: DuplexChannel,
  count: number,
): Promise<ChannelMessage[]> {
  return new Promise((resolve) => {
    const received: ChannelMessage[] = [];
    const unsubscribe = channel.subscribe((message) => {
      received.push(message);
      if (received.length === count) {
        unsubscribe();
        resolve(received);
      }
    });
  });
}

const text = (message: ChannelMessage) =>
  typeof message === 'string' ? message : Array.from(new Uint8Array(message));

describe('createDataChannelDuplex', () => {
  it('carries text and binary messages in both directions at once', async () => {
    const { a, b } = duplexPair();
    const atB = collect(b, 2);
    const atA = collect(a, 2);

    await Promise.all([
      a.sendText('from a'),
      b.sendBinary(new Uint8Array([9, 8, 7])),
      a.sendBinary(new Uint8Array([1, 2, 3])),
      b.sendText('from b'),
    ]);

    expect((await atB).map(text)).toEqual(['from a', [1, 2, 3]]);
    expect((await atA).map(text)).toEqual([[9, 8, 7], 'from b']);
  });

  it('delivers binary messages as ArrayBuffer carrying exactly the view', async () => {
    const { a, b } = duplexPair();
    const received = collect(b, 1);
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);

    await a.sendBinary(backing.subarray(2, 5));

    const [message] = await received;
    expect(message).toBeInstanceOf(ArrayBuffer);
    expect(text(message)).toEqual([2, 3, 4]);
  });

  it('broadcasts every message to every subscriber', async () => {
    const { a, b } = duplexPair();
    const first = collect(b, 2);
    const second = collect(b, 2);

    await a.sendText('one');
    await a.sendText('two');

    expect(await first).toEqual(['one', 'two']);
    expect(await second).toEqual(['one', 'two']);
  });

  it('stops delivering to a listener once it unsubscribes', async () => {
    const { a, b } = duplexPair();
    const seen: ChannelMessage[] = [];
    const unsubscribe = b.subscribe((message) => seen.push(message));
    const both = collect(b, 2);

    await a.sendText('kept');
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();
    await a.sendText('missed');
    await both;

    expect(seen).toEqual(['kept']);
  });

  it('keeps call order when a later send could overtake one waiting on backpressure', async () => {
    const { dcA, a, b } = duplexPair(4);
    const received = collect(b, 3);

    dcA.hold();
    const first = a.sendBinary(new Uint8Array(8));
    // Over the threshold now, so the next send must wait for the drain, and
    // the text behind it must not slip past.
    const second = a.sendBinary(new Uint8Array(8));
    const third = a.sendText('after');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dcA.sent).toHaveLength(1);

    dcA.release();
    await Promise.all([first, second, third]);

    expect(
      (await received).map((m) => (typeof m === 'string' ? m : 'bin')),
    ).toEqual(['bin', 'bin', 'after']);
  });

  it('sends at once ahead of sends waiting on backpressure', async () => {
    const { dcA, a, b } = duplexPair(4);
    const received = collect(b, 3);

    dcA.hold();
    const first = a.sendBinary(new Uint8Array(8));
    const queued = a.sendBinary(new Uint8Array(8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.sendNow('urgent')).toBe(true);
    dcA.release();
    await Promise.all([first, queued]);

    expect(
      (await received).map((m) => (typeof m === 'string' ? m : 'bin')),
    ).toEqual(['bin', 'urgent', 'bin']);
  });

  it('reports a send-now on a closed or failed channel as not sent', () => {
    const closed = duplexPair();
    closed.a.close();
    expect(closed.a.sendNow('late')).toBe(false);

    const failed = duplexPair();
    failed.dcA.fail();
    expect(failed.a.sendNow('late')).toBe(false);
    expect(failed.dcA.sent).toHaveLength(0);
  });

  it('tells a late onEnd listener how the channel ended', async () => {
    const { dcB, b } = duplexPair();
    dcB.fail();
    const heard: string[] = [];
    b.onEnd((reason) => heard.push(reason));
    expect(heard).toEqual(['error']);
  });

  it('fails sends once the channel is closed', async () => {
    const { a } = duplexPair();
    a.close();

    await expect(a.sendText('late')).rejects.toThrow('Data channel not open');
    await expect(a.sendBinary(new Uint8Array(1))).rejects.toThrow(
      'Data channel not open',
    );
  });

  it('fails sends and waits after a channel error even while it still reports open', async () => {
    const { dcA, a } = duplexPair();
    dcA.fail();
    expect(dcA.readyState).toBe('open');

    await expect(a.sendText('late')).rejects.toThrow('Data channel failed');
    await expect(a.sendBinary(new Uint8Array(1))).rejects.toThrow(
      'Data channel failed',
    );
    expect(dcA.sent).toHaveLength(0);
  });

  it('fails a send waiting on backpressure when the channel errors under it', async () => {
    const { dcA, a } = duplexPair(4);
    dcA.hold();
    await a.sendBinary(new Uint8Array(8));
    const waiting = a.sendBinary(new Uint8Array(8));
    await new Promise((resolve) => setTimeout(resolve, 20));

    dcA.fail();

    await expect(waiting).rejects.toThrow('Data channel failed');
    expect(dcA.sent).toHaveLength(1);
  });

  it('reports a failed send to its caller without stalling the sends behind it', async () => {
    const { dcA, a, b } = duplexPair();
    const received = collect(b, 1);
    const send = dcA.send.bind(dcA);
    dcA.send = () => {
      dcA.send = send;
      throw new TypeError('Message too large');
    };

    const failed = a.sendText('rejected');
    const next = a.sendText('delivered');

    await expect(failed).rejects.toThrow('Message too large');
    await expect(next).resolves.toBeUndefined();
    expect(await received).toEqual(['delivered']);
  });

  it('resolves flush at once when nothing is buffered', async () => {
    const { a } = duplexPair();
    await expect(a.flush()).resolves.toBeUndefined();
  });

  it('resolves flush once held sends have left the buffer', async () => {
    const { dcA, a } = duplexPair();
    dcA.hold();
    await a.sendBinary(new Uint8Array(8));
    let flushed = false;
    const flushing = a.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(flushed).toBe(false);

    dcA.release();

    await flushing;
    expect(flushed).toBe(true);
  });

  it('waits in flush for a send still queued behind backpressure', async () => {
    const { dcA, a } = duplexPair(4);
    dcA.hold();
    await a.sendBinary(new Uint8Array(8));
    // Over the threshold, so this one has not reached the channel yet.
    const queued = a.sendBinary(new Uint8Array(8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dcA.sent).toHaveLength(1);
    const flushing = a.flush();

    dcA.release();

    await flushing;
    await queued;
    expect(dcA.sent).toHaveLength(2);
    expect(dcA.bufferedAmount).toBe(0);
  });

  it('does not wait in flush for a send-now made after its turn', async () => {
    const { dcA, a } = duplexPair(4);
    dcA.hold();
    await a.sendBinary(new Uint8Array(8));
    let flushed = false;
    const flushing = a.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.sendNow('late')).toBe(true);

    // The bytes the flush covers leave; the later ones stay behind them.
    dcA.release(1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(dcA.bufferedAmount).toBe(4);
    expect(flushed).toBe(true);
    await flushing;
    dcA.release();
  });

  it('rejects flush when the channel closes under a send still queued', async () => {
    const { dcA, a } = duplexPair(4);
    dcA.hold();
    await a.sendBinary(new Uint8Array(8));
    const queued = a.sendBinary(new Uint8Array(8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const flushing = a.flush();

    a.close();

    await expect(queued).rejects.toThrow('closed before send completed');
    await expect(flushing).rejects.toThrow(
      'Data channel closed with 8 bytes unsent',
    );
  });

  it('resolves flush when the peer hangs up after the buffer emptied', async () => {
    const { dcB, a } = duplexPair();
    await a.sendText('last');
    await new Promise((resolve) => setTimeout(resolve, 10));

    dcB.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(a.flush()).resolves.toBeUndefined();
  });

  it('rejects flush when the channel closes with bytes still buffered', async () => {
    const { dcA, dcB, a } = duplexPair();
    dcA.hold();
    await a.sendBinary(new Uint8Array(8));
    const flushing = a.flush();

    dcB.close();

    await expect(flushing).rejects.toThrow(
      'Data channel closed with 8 bytes unsent',
    );
  });

  it('fails a send waiting on backpressure when the channel closes under it', async () => {
    const { dcA, a } = duplexPair(4);
    dcA.hold();
    await a.sendBinary(new Uint8Array(8));
    const waiting = a.sendBinary(new Uint8Array(8));
    // Let it reach the drain wait before the channel goes.
    await new Promise((resolve) => setTimeout(resolve, 20));

    a.close();

    await expect(waiting).rejects.toThrow(
      'Data channel closed before send completed',
    );
  });
});
