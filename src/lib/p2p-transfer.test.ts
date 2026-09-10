import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeDataChannelPair } from '../test/fake-data-channel';
import { installOpfsMock, type OpfsMock } from '../test/opfs-mock';
import { ENCRYPTION_CHUNK_SIZE, encryptChunk } from './crypto';
import {
  type ChannelEndReason,
  type ChannelMessage,
  createDataChannelDuplex,
  type DuplexChannel,
} from './duplex-channel';
import { P2PConnectionError } from './errors';
import {
  CANCELLED_REASON,
  type ControlMessage,
  cancelOverLink,
  createTransferReceiver,
  encodeControl,
  parseControl,
  sendFileOverLink,
  TransferAbortedError,
  type TransferLink,
} from './p2p-transfer';
import { createAdaptiveAppendSink } from './scratch-sink';
import {
  createFileTransferSource,
  type TransferSource,
  type WireEncoding,
} from './transfer-source';

let opfs: OpfsMock;

beforeAll(() => {
  opfs = installOpfsMock();
});

afterAll(() => {
  opfs.uninstall();
});

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function makePlaintext(totalBytes: number): Uint8Array {
  const data = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) data[i] = (i * 31 + 7) % 256;
  return data;
}

function zipSource(data: Uint8Array, size: number | null = data.length) {
  return {
    name: 'bundle.zip',
    type: 'application/zip',
    size,
    estimatedSize: data.length,
    projectedWireBytes: data.length,
    precompressed: true,
    stream: () => new Blob([data as BlobPart]).stream(),
  } satisfies TransferSource;
}

async function encryptAll(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<ArrayBuffer[]> {
  const messages: ArrayBuffer[] = [];
  for (let i = 0; i * ENCRYPTION_CHUNK_SIZE < plaintext.length; i++) {
    const chunk = plaintext.subarray(
      i * ENCRYPTION_CHUNK_SIZE,
      Math.min((i + 1) * ENCRYPTION_CHUNK_SIZE, plaintext.length),
    );
    const message = await encryptChunk(key, chunk, i);
    messages.push(message.buffer as ArrayBuffer);
  }
  return messages;
}

/**
 * Two ends of one duplex channel, the sender's and the receiver's, over an
 * in-memory data channel pair.
 */
function channelPair(): [DuplexChannel, DuplexChannel] {
  const [senderEnd, receiverEnd] = fakeDataChannelPair();
  return [
    createDataChannelDuplex(senderEnd),
    createDataChannelDuplex(receiverEnd),
  ];
}

/**
 * One end of a link the test plays the peer on: `deliver` hands this end a
 * message as if the peer sent it, and `sent` is everything this end sent.
 */
function scriptedLink() {
  const listeners = new Set<(message: ChannelMessage) => void>();
  const enders = new Set<(reason: ChannelEndReason) => void>();
  const sent: (string | Uint8Array)[] = [];
  const link: TransferLink = {
    sendBinary: async (data) => {
      sent.push(data);
    },
    sendText: async (text) => {
      sent.push(text);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEnd: (listener) => {
      enders.add(listener);
      return () => {
        enders.delete(listener);
      };
    },
  };
  return {
    link,
    sent,
    deliver(message: ChannelMessage | ControlMessage) {
      const wire =
        typeof message === 'string' || message instanceof ArrayBuffer
          ? message
          : encodeControl(message);
      for (const listener of Array.from(listeners)) listener(wire);
    },
    end(reason: ChannelEndReason) {
      for (const ender of Array.from(enders)) ender(reason);
    },
    /** Control messages this end sent, parsed. */
    controls(): ControlMessage[] {
      return sent
        .filter((m): m is string => typeof m === 'string')
        .map((m) => parseControl(m))
        .filter((m): m is ControlMessage => m !== null);
    },
    chunks(): number {
      return sent.filter((m) => typeof m !== 'string').length;
    },
    /** Message and end listeners still attached to this end. */
    listeners(): number {
      return listeners.size + enders.size;
    },
  };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a whole transfer over a duplex channel pair, as the hooks do. */
async function roundTrip(
  source: TransferSource,
  encoding: WireEncoding,
): Promise<{ wireBytes: number; blob: Blob }> {
  const key = await makeKey();
  const sink = await createAdaptiveAppendSink(source.estimatedSize);
  const receiver = createTransferReceiver(key, encoding, sink, {
    estimatedBytes: source.estimatedSize,
  });
  const [senderChannel, receiverChannel] = channelPair();
  receiver.attach(receiverChannel);

  const wireBytes = await sendFileOverLink(senderChannel, key, source);
  const blob = await receiver.done;
  return { wireBytes, blob };
}

describe('parseControl', () => {
  it('reads each control message', () => {
    expect(parseControl('{"t":"ack","chunks":3}')).toEqual({
      t: 'ack',
      chunks: 3,
    });
    expect(parseControl('{"t":"end","chunks":2,"bytes":9}')).toEqual({
      t: 'end',
      chunks: 2,
      bytes: 9,
    });
    expect(parseControl('{"t":"done","chunks":2,"bytes":9}')).toEqual({
      t: 'done',
      chunks: 2,
      bytes: 9,
    });
    expect(parseControl('{"t":"abort","reason":"disk full"}')).toEqual({
      t: 'abort',
      reason: 'disk full',
    });
  });

  it('leaves text that is not a transfer message to others', () => {
    expect(parseControl('hello')).toBeNull();
    expect(parseControl('[1,2]')).toBeNull();
    expect(parseControl('{"t":"note","chunks":1}')).toBeNull();
    expect(parseControl('{"chunks":1}')).toBeNull();
  });

  it('refuses a transfer message with malformed counts', () => {
    expect(() => parseControl('{"t":"ack","chunks":-1}')).toThrow();
    expect(() => parseControl('{"t":"ack","chunks":1.5}')).toThrow();
    expect(() => parseControl('{"t":"end","chunks":1}')).toThrow();
    expect(() => parseControl('{"t":"done","chunks":1,"bytes":"9"}')).toThrow();
  });

  it('caps an abort reason and tolerates a missing one', () => {
    const long = parseControl(
      encodeControl({ t: 'abort', reason: 'x'.repeat(500) }),
    );
    expect(long?.t === 'abort' && long.reason.length).toBe(200);
    expect(parseControl('{"t":"abort"}')).toEqual({ t: 'abort', reason: '' });
  });
});

describe('sendFileOverLink', () => {
  it('deflates a single-file source on the wire and the receiver restores it', async () => {
    // Compressible so the deflated wire stream is visibly smaller.
    const data = new TextEncoder().encode(
      'the same line of text, over and over\n'.repeat(8_000),
    );
    const source = createFileTransferSource(
      new File([data as BlobPart], 'notes.txt', { type: 'text/plain' }),
    );
    expect(source.precompressed).toBe(false);

    const { wireBytes, blob } = await roundTrip(source, 'deflate-raw');

    expect(wireBytes).toBeLessThan(data.length / 10);
    expect(blob.size).toBe(data.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
  });

  it('never recompresses a precompressed source: the wire carries its exact bytes', async () => {
    const data = makePlaintext(ENCRYPTION_CHUNK_SIZE + 1234);

    const { wireBytes, blob } = await roundTrip(
      zipSource(data, null),
      'identity',
    );

    expect(wireBytes).toBe(data.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
  });

  it('sends a full chunk before an unknown-size precompressed source has finished producing', async () => {
    const key = await makeKey();
    let releaseRemainder!: () => void;
    let remainderReleased = false;
    const remainderReady = new Promise<void>((resolve) => {
      releaseRemainder = () => {
        remainderReleased = true;
        resolve();
      };
    });
    const source: TransferSource = {
      ...zipSource(new Uint8Array(ENCRYPTION_CHUNK_SIZE + 3), null),
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(ENCRYPTION_CHUNK_SIZE));
          },
          async pull(controller) {
            await remainderReady;
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
    };
    const peer = scriptedLink();

    const sending = sendFileOverLink(peer.link, key, source);
    await tick();
    expect(peer.chunks()).toBe(1);
    expect(remainderReleased).toBe(false);
    releaseRemainder();
    await tick();

    expect(peer.controls()).toEqual([
      { t: 'end', chunks: 2, bytes: ENCRYPTION_CHUNK_SIZE + 3 },
    ]);
    peer.deliver({ t: 'done', chunks: 2, bytes: ENCRYPTION_CHUNK_SIZE + 3 });
    await expect(sending).resolves.toBe(ENCRYPTION_CHUNK_SIZE + 3);
  });

  it('never runs more than the window ahead of what the receiver has stored', async () => {
    const key = await makeKey();
    const data = makePlaintext(ENCRYPTION_CHUNK_SIZE * 5);
    const peer = scriptedLink();

    const sending = sendFileOverLink(peer.link, key, zipSource(data), {
      windowChunks: 2,
    });
    // Nothing acknowledged yet: the window is full at two.
    await vi.waitFor(() => expect(peer.chunks()).toBe(2));

    peer.deliver({ t: 'ack', chunks: 1 });
    await vi.waitFor(() => expect(peer.chunks()).toBe(3));

    peer.deliver({ t: 'ack', chunks: 3 });
    await vi.waitFor(() => {
      expect(peer.chunks()).toBe(5);
      expect(peer.controls()).toEqual([
        { t: 'end', chunks: 5, bytes: data.length },
      ]);
    });

    peer.deliver({ t: 'done', chunks: 5, bytes: data.length });
    await expect(sending).resolves.toBe(data.length);
  });

  it('reports progress from the receiver acknowledgments, not from its own sends', async () => {
    const key = await makeKey();
    const data = makePlaintext(ENCRYPTION_CHUNK_SIZE * 3);
    const peer = scriptedLink();
    const progress: number[] = [];

    const sending = sendFileOverLink(peer.link, key, zipSource(data), {
      onProgress: (current) => progress.push(current),
    });
    await tick();
    expect(peer.chunks()).toBe(3);
    expect(progress).toEqual([]);

    peer.deliver({ t: 'ack', chunks: 2 });
    await tick(150);
    expect(progress).toEqual([ENCRYPTION_CHUNK_SIZE * 2]);

    peer.deliver({ t: 'done', chunks: 3, bytes: data.length });
    await sending;
    expect(progress.at(-1)).toBe(data.length);
  });

  it('stops at once with the receiver reason when the receiver aborts', async () => {
    const key = await makeKey();
    const peer = scriptedLink();
    const sending = sendFileOverLink(
      peer.link,
      key,
      zipSource(makePlaintext(ENCRYPTION_CHUNK_SIZE * 3)),
      { windowChunks: 1 },
    );
    await tick();

    peer.deliver({ t: 'abort', reason: 'The disk is full' });

    const error = await sending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferAbortedError);
    expect((error as Error).message).toBe(
      'The receiver stopped the transfer: The disk is full',
    );
    // A receiver that gave up is not told to give up.
    expect(peer.controls().some((m) => m.t === 'abort')).toBe(false);
  });

  it('tells the receiver when it is cancelled', async () => {
    const key = await makeKey();
    const peer = scriptedLink();
    let cancelled = false;
    const sending = sendFileOverLink(
      peer.link,
      key,
      zipSource(makePlaintext(ENCRYPTION_CHUNK_SIZE * 3)),
      { windowChunks: 1, isCancelled: () => cancelled },
    );
    await tick();
    cancelled = true;

    await expect(sending).rejects.toThrow('Cancelled');
    expect(peer.controls().at(-1)).toEqual({
      t: 'abort',
      reason: 'cancelled',
    });
  });

  it('lets go of the link and tells the receiver when the source cannot be opened', async () => {
    const key = await makeKey();
    const peer = scriptedLink();
    const source: TransferSource = {
      ...zipSource(makePlaintext(100)),
      stream: () => {
        throw new Error('The file is no longer readable');
      },
    };

    await expect(sendFileOverLink(peer.link, key, source)).rejects.toThrow(
      'The file is no longer readable',
    );
    expect(peer.listeners()).toBe(0);
    expect(peer.controls().at(-1)?.t).toBe('abort');
  });

  it('refuses a verdict that does not match what was sent', async () => {
    const key = await makeKey();
    const data = makePlaintext(100);
    const peer = scriptedLink();
    const sending = sendFileOverLink(peer.link, key, zipSource(data));
    await tick();

    peer.deliver({ t: 'done', chunks: 1, bytes: data.length + 1 });

    await expect(sending).rejects.toThrow('different payload');
    expect(peer.controls().at(-1)?.t).toBe('abort');
  });

  it('refuses an acknowledgment for chunks it never sent', async () => {
    const key = await makeKey();
    const peer = scriptedLink();
    const sending = sendFileOverLink(
      peer.link,
      key,
      zipSource(makePlaintext(ENCRYPTION_CHUNK_SIZE * 3)),
      { windowChunks: 1 },
    );
    await tick();

    peer.deliver({ t: 'ack', chunks: 2 });

    await expect(sending).rejects.toThrow('never sent');
  });

  it('fails as a connection problem when the link closes before the verdict', async () => {
    const key = await makeKey();
    const peer = scriptedLink();
    const sending = sendFileOverLink(
      peer.link,
      key,
      zipSource(makePlaintext(100)),
    );
    await tick();

    peer.end('closed');

    const error = await sending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(P2PConnectionError);
    expect((error as Error).message).toMatch(/closed before the receiver/);
  });

  it('aborts as a stall when the receiver stops acknowledging', async () => {
    const key = await makeKey();
    const peer = scriptedLink();

    await expect(
      sendFileOverLink(peer.link, key, zipSource(makePlaintext(100)), {
        stallTimeoutMs: 20,
      }),
    ).rejects.toThrow('Transfer stalled');
    expect(peer.controls().at(-1)?.t).toBe('abort');
  });

  it('aborts as a stall when a chunk cannot leave a channel that stopped draining', async () => {
    const key = await makeKey();
    const [senderEnd] = fakeDataChannelPair();
    // The first chunk goes out, leaves the buffer over this tiny threshold,
    // and nothing drains it again.
    const senderChannel = createDataChannelDuplex(senderEnd, 4);
    senderEnd.hold();

    await expect(
      sendFileOverLink(
        senderChannel,
        key,
        zipSource(makePlaintext(ENCRYPTION_CHUNK_SIZE * 2)),
        { stallTimeoutMs: 20 },
      ),
    ).rejects.toThrow('Transfer stalled');
    // The one chunk that got out, then the abort — which does not wait its
    // turn behind a buffer that will never drain.
    expect(senderEnd.sent).toHaveLength(2);
    expect(senderEnd.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(parseControl(senderEnd.sent[1] as string)?.t).toBe('abort');
    senderChannel.close();
  });

  it('completes while both peers exchange other text messages over the same channel', async () => {
    const key = await makeKey();
    const data = makePlaintext(ENCRYPTION_CHUNK_SIZE * 3 + 17);
    const sink = await createAdaptiveAppendSink(data.length);
    const receiver = createTransferReceiver(key, 'identity', sink);
    const [senderChannel, receiverChannel] = channelPair();

    // Both peers talk beside the transfer, in plain text and in JSON of a
    // type the transfer does not define; neither side's client may trip over
    // it.
    const heardBySender: string[] = [];
    senderChannel.subscribe((message) => {
      if (typeof message === 'string') heardBySender.push(message);
    });
    receiverChannel.subscribe((message) => {
      if (typeof message !== 'string') {
        void receiverChannel.sendText('{"t":"note","from":"receiver"}');
      }
    });
    receiver.attach(receiverChannel);
    const chatter = setInterval(() => {
      void senderChannel.sendText('sender-note').catch(() => {});
    }, 1);

    try {
      const wireBytes = await sendFileOverLink(senderChannel, key, {
        ...zipSource(data),
      });
      const blob = await receiver.done;
      expect(wireBytes).toBe(data.length);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
    } finally {
      clearInterval(chatter);
    }
    expect(
      heardBySender.filter((m) => m.includes('"note"')).length,
    ).toBeGreaterThan(0);
    expect(parseControl(heardBySender.at(-1) ?? '')).toEqual({
      t: 'done',
      chunks: 4,
      bytes: data.length,
    });
  });
});

describe('cancelOverLink', () => {
  it('tells the peer at once over a channel, so the peer stops with the reason', async () => {
    const key = await makeKey();
    const [senderChannel, receiverChannel] = channelPair();
    const sending = sendFileOverLink(
      senderChannel,
      key,
      zipSource(makePlaintext(ENCRYPTION_CHUNK_SIZE * 64)),
      { windowChunks: 1 },
    );

    // The receiving side's user cancels before storing anything.
    expect(cancelOverLink(receiverChannel)).toBe(true);

    const error = await sending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferAbortedError);
    expect((error as TransferAbortedError).reason).toBe(CANCELLED_REASON);
    expect((error as Error).message).toBe(
      'The receiver cancelled the transfer',
    );
  });
});

describe('createTransferReceiver', () => {
  async function attachedReceiver(
    encoding: WireEncoding = 'identity',
    opts: Parameters<typeof createTransferReceiver>[3] = {},
    estimate = 100,
  ) {
    const key = await makeKey();
    const sink = await createAdaptiveAppendSink(estimate);
    const receiver = createTransferReceiver(key, encoding, sink, opts);
    const peer = scriptedLink();
    receiver.attach(peer.link);
    return { key, sink, receiver, peer };
  }

  it('stores in-order chunks, acknowledges each, and answers the end with its verdict', async () => {
    const totalBytes = ENCRYPTION_CHUNK_SIZE + 1234;
    const plaintext = makePlaintext(totalBytes);
    const progress: number[] = [];
    const { key, sink, receiver, peer } = await attachedReceiver(
      'identity',
      { estimatedBytes: totalBytes, onProgress: (c) => progress.push(c) },
      totalBytes,
    );
    const messages = await encryptAll(key, plaintext);

    for (const message of messages) peer.deliver(message);
    peer.deliver({ t: 'end', chunks: messages.length, bytes: totalBytes });

    const blob = await receiver.done;
    expect(blob.size).toBe(totalBytes);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plaintext);
    expect(progress.at(-1)).toBe(totalBytes);
    expect(peer.controls()).toEqual([
      { t: 'ack', chunks: 1 },
      { t: 'ack', chunks: 2 },
      { t: 'done', chunks: 2, bytes: totalBytes },
    ]);
    await sink.discard();
  });

  it('answers a zero-byte transfer', async () => {
    const { receiver, peer } = await attachedReceiver();
    peer.deliver({ t: 'end', chunks: 0, bytes: 0 });
    const blob = await receiver.done;
    expect(blob.size).toBe(0);
    expect(peer.controls()).toEqual([{ t: 'done', chunks: 0, bytes: 0 }]);
  });

  it('ignores text that is not a transfer message', async () => {
    const { receiver, peer } = await attachedReceiver();
    peer.deliver('hello');
    peer.deliver('{"t":"note"}');
    peer.deliver({ t: 'end', chunks: 0, bytes: 0 });
    await expect(receiver.done).resolves.toBeInstanceOf(Blob);
  });

  it('refuses chunks out of order, and tells the sender why', async () => {
    const { key, receiver, peer } = await attachedReceiver();
    const messages = await encryptAll(
      key,
      makePlaintext(ENCRYPTION_CHUNK_SIZE + 100),
    );

    peer.deliver(messages[1]);

    await expect(receiver.done).rejects.toThrow(
      'Unexpected streamed chunk index',
    );
    expect(peer.controls().at(-1)).toEqual({
      t: 'abort',
      reason: 'Unexpected streamed chunk index: 1',
    });
  });

  it('refuses a duplicate chunk index', async () => {
    const { key, receiver, peer } = await attachedReceiver();
    const [message] = await encryptAll(key, makePlaintext(100));

    peer.deliver(message);
    peer.deliver(message.slice(0));

    await expect(receiver.done).rejects.toThrow(
      'Unexpected streamed chunk index',
    );
  });

  it('refuses a chunk that does not authenticate', async () => {
    const { key, receiver, peer } = await attachedReceiver();
    const [message] = await encryptAll(key, makePlaintext(100));
    const tampered = new Uint8Array(message.slice(0));
    tampered[tampered.length - 1] ^= 0xff;

    peer.deliver(tampered.buffer as ArrayBuffer);

    await expect(receiver.done).rejects.toThrow('failed authentication');
    expect(peer.controls().at(-1)?.t).toBe('abort');
  });

  it('refuses an end whose count disagrees with the chunks received', async () => {
    const { key, receiver, peer } = await attachedReceiver();
    const [message] = await encryptAll(key, makePlaintext(100));

    peer.deliver(message);
    peer.deliver({ t: 'end', chunks: 2, bytes: 100 });

    await expect(receiver.done).rejects.toThrow('Invalid end message');
  });

  it('refuses a sender that overruns the window', async () => {
    const { key, receiver, peer } = await attachedReceiver('identity', {
      windowChunks: 1,
    });
    const messages = await encryptAll(
      key,
      makePlaintext(ENCRYPTION_CHUNK_SIZE * 2),
    );

    // The second chunk arrives before the first was acknowledged.
    peer.deliver(messages[0]);
    peer.deliver(messages[1]);

    await expect(receiver.done).rejects.toThrow('overran');
  });

  it('refuses a deflated payload that does not inflate cleanly', async () => {
    const { key, receiver, peer } = await attachedReceiver('deflate-raw');
    // Valid ciphertext whose plaintext is not a raw-deflate stream.
    const [message] = await encryptAll(key, makePlaintext(100));

    peer.deliver(message);
    peer.deliver({ t: 'end', chunks: 1, bytes: 100 });

    await expect(receiver.done).rejects.toThrow();
  });

  it('stops with the sender reason when the sender aborts, without answering it', async () => {
    const { receiver, peer } = await attachedReceiver();

    peer.deliver({ t: 'abort', reason: 'cancelled' });

    const error = await receiver.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferAbortedError);
    expect((error as Error).message).toBe('The sender cancelled the transfer');
    expect(peer.controls()).toEqual([]);
  });

  it('fails as a connection problem when the link closes mid-transfer', async () => {
    const { receiver, peer } = await attachedReceiver();

    peer.end('error');

    const error = await receiver.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(P2PConnectionError);
    expect(peer.controls()).toEqual([]);
  });

  it('tells the sender when it is abandoned', async () => {
    const { receiver, peer } = await attachedReceiver();

    receiver.dispose();

    await expect(receiver.done).rejects.toThrow('Cancelled');
    expect(peer.controls()).toEqual([{ t: 'abort', reason: 'cancelled' }]);
  });

  it('aborts an idle transfer via the stall watchdog', async () => {
    const { receiver } = await attachedReceiver('identity', {
      stallTimeoutMs: 20,
    });

    await expect(receiver.done).rejects.toThrow('Transfer stalled');
  });
});
