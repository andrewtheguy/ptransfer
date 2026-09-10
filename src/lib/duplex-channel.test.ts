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
    await expect(b.waitFor((m) => m === 'kept', 1000, 'kept')).resolves.toBe(
      'kept',
    );
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

  it('resolves waitFor on the first accepted message and leaves the rest to other subscribers', async () => {
    const { a, b } = duplexPair();
    const everything = collect(b, 3);

    const waited = b.waitFor((m) => m === 'ACK', 1000, 'acknowledgment');
    await a.sendText('noise');
    await a.sendBinary(new Uint8Array([1]));
    await a.sendText('ACK');

    await expect(waited).resolves.toBe('ACK');
    expect((await everything).map(text)).toEqual(['noise', [1], 'ACK']);
  });

  it('rejects waitFor when the peer closes the channel', async () => {
    const { dcA, b } = duplexPair();
    const waited = b.waitFor(() => true, 1000, 'acknowledgment');

    dcA.close();

    await expect(waited).rejects.toThrow(
      'Data channel closed before acknowledgment',
    );
  });

  it('rejects waitFor at once when this side closes the channel', async () => {
    const { b } = duplexPair();
    const waited = b.waitFor(() => true, 60_000, 'acknowledgment');

    b.close();

    await expect(waited).rejects.toThrow(
      'Data channel closed before acknowledgment',
    );
    await expect(b.waitFor(() => true, 1000, 'acknowledgment')).rejects.toThrow(
      'Data channel closed before acknowledgment',
    );
  });

  it('rejects waitFor on a channel error', async () => {
    const { dcB, b } = duplexPair();
    const waited = b.waitFor(() => true, 1000, 'acknowledgment');

    dcB.fail();

    await expect(waited).rejects.toThrow(
      'Data channel error while waiting for acknowledgment',
    );
  });

  it('rejects waitFor after the timeout', async () => {
    const { b } = duplexPair();

    await expect(b.waitFor(() => true, 10, 'acknowledgment')).rejects.toThrow(
      'Timeout waiting for acknowledgment',
    );
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
    await expect(a.waitFor(() => true, 1000, 'acknowledgment')).rejects.toThrow(
      'Data channel error while waiting for acknowledgment',
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
