import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, TorFramedStream } from './framing';
import { createOnionStreamPair } from './mock-stream';
import type { OnionStream } from './webtor';

function pair(): [TorFramedStream, TorFramedStream] {
  const [a, b] = createOnionStreamPair();
  return [new TorFramedStream(a), new TorFramedStream(b)];
}

describe('TorFramedStream', () => {
  it('round-trips binary and text frames', async () => {
    const [a, b] = pair();

    await a.sendBinary(new Uint8Array([0, 1, 99, 104, 117, 110, 107]));
    await a.sendText('DONE:1:2');

    const binary = await b.receive();
    expect(binary?.isString).toBe(false);
    expect(Array.from(binary?.data ?? [])).toEqual([
      0, 1, 99, 104, 117, 110, 107,
    ]);

    const text = await b.receive();
    expect(text?.isString).toBe(true);
    expect(new TextDecoder().decode(text?.data)).toBe('DONE:1:2');
  });

  it('reassembles a frame split across reads', async () => {
    // A Tor stream hands over whatever bytes have arrived, and one encrypted
    // chunk spans many of those reads.
    const [raw, other] = createOnionStreamPair();
    const framed = new TorFramedStream(other);
    const payload = new Uint8Array(20_000).map((_, i) => i % 251);

    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, payload.length, false);
    await raw.sendBytes(header.subarray(0, 3));
    await raw.sendBytes(header.subarray(3));
    for (let offset = 0; offset < payload.length; offset += 8192) {
      await raw.sendBytes(payload.subarray(offset, offset + 8192));
    }

    const message = await framed.receive();
    expect(message?.isString).toBe(false);
    expect(message?.data).toEqual(payload);
  });

  it('carries a full-size chunk in one frame', async () => {
    const [a, b] = pair();
    const chunk = new Uint8Array(MAX_FRAME_BYTES).fill(7);

    const sending = a.sendBinary(chunk);
    const received = await b.receive();
    await sending;

    expect(received?.data.length).toBe(MAX_FRAME_BYTES);
  });

  it('refuses to send more than one chunk per frame', async () => {
    const [a] = pair();
    await expect(
      a.sendBinary(new Uint8Array(MAX_FRAME_BYTES + 1)),
    ).rejects.toThrow(/exceeds/);
  });

  it('treats a close between frames as a clean end', async () => {
    const [a, b] = pair();
    await a.sendText('DONE:0:0');
    await a.close();

    expect(await b.receive()).not.toBeNull();
    expect(await b.receive()).toBeNull();
  });

  it('refuses an oversized announced length before allocating', async () => {
    const [raw, other] = createOnionStreamPair();
    const framed = new TorFramedStream(other);

    const header = new Uint8Array([0, 0xff, 0xff, 0xff, 0xff]);
    await raw.sendBytes(header);

    await expect(framed.receive()).rejects.toThrow(/over the/);
  });

  it('refuses an unknown frame kind', async () => {
    const [raw, other] = createOnionStreamPair();
    const framed = new TorFramedStream(other);
    await raw.sendBytes(new Uint8Array([9, 0, 0, 0, 0]));

    await expect(framed.receive()).rejects.toThrow(/Unknown frame kind/);
  });

  it('treats a truncated header as an error, not a clean end', async () => {
    const [raw, other] = createOnionStreamPair();
    const framed = new TorFramedStream(other);

    await raw.sendBytes(new Uint8Array([1, 0, 0]));
    await raw.close();

    await expect(framed.receive()).rejects.toThrow(/mid-frame/);
  });

  it('refuses a binary frame where the handshake expects text', async () => {
    const [a, b] = pair();
    await a.sendBinary(new Uint8Array([1, 2, 3]));
    await expect(b.receiveText()).rejects.toThrow(/binary frame/);
  });

  it('reports a peer that closed during the handshake', async () => {
    const [a, b] = pair();
    await a.close();
    await expect(b.receiveText()).rejects.toThrow(/closed the connection/);
  });

  it('returns from waitForClose when the peer hangs up', async () => {
    const [a, b] = pair();
    await a.sendText('ACK');

    const waiting = a.waitForClose(5_000);
    expect(await b.receive()).not.toBeNull();
    await b.close();

    // The close is the receipt for `ACK`, so it is the success case.
    await expect(waiting).resolves.toBeUndefined();
  });

  it('fails waitForClose when the peer never hangs up', async () => {
    // A peer holding the stream open past the linger timeout never
    // acknowledged the last frame, and saying otherwise would report a
    // delivery that may not have happened.
    const [a] = pair();
    await a.sendText('ACK');
    await expect(a.waitForClose(20)).rejects.toThrow(/did not close/);
  });

  it('treats a read failure as the end of the conversation', async () => {
    // A peer that has already torn its circuit down answers a read with an
    // error rather than an end of stream; over Tor that is the same event.
    let reads = 0;
    const stream: OnionStream = {
      send: () => Promise.resolve(undefined),
      sendBytes: () => Promise.resolve(undefined),
      receive: () => {
        reads += 1;
        return Promise.reject(new Error('Stream not connected'));
      },
      close: () => Promise.resolve(undefined),
    };
    const framed = new TorFramedStream(stream);

    // The close is still the receipt for the last frame sent.
    await expect(framed.waitForClose(5_000)).resolves.toBeUndefined();
    expect(await framed.receive()).toBeNull();
    // The stream is not read again once it has ended.
    expect(reads).toBe(1);
  });

  it('closes at most once and never throws', async () => {
    let closes = 0;
    const stream: OnionStream = {
      send: () => Promise.resolve(undefined),
      sendBytes: () => Promise.resolve(undefined),
      receive: () => Promise.resolve(null),
      close: () => {
        closes += 1;
        return Promise.reject(new Error('already gone'));
      },
    };
    const framed = new TorFramedStream(stream);

    await expect(framed.close()).resolves.toBeUndefined();
    await expect(framed.close()).resolves.toBeUndefined();
    expect(closes).toBe(1);
  });
});
