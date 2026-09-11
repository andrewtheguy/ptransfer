import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeDataChannelPair } from '../test/fake-data-channel';
import { installOpfsMock, type OpfsMock } from '../test/opfs-mock';
import type { AppendSink } from './append-sink';
import { ENCRYPTION_CHUNK_SIZE, encryptChunk } from './crypto';
import { createDataChannelDuplex } from './data-channel';
import type {
  ChannelEndReason,
  ChannelMessage,
  DuplexChannel,
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

/** How many chunks the receiver has decrypted, over every test. */
const decrypts = vi.hoisted(() => ({ count: 0 }));
vi.mock('./crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crypto')>();
  return {
    ...actual,
    decryptChunk: (...args: Parameters<typeof actual.decryptChunk>) => {
      decrypts.count++;
      return actual.decryptChunk(...args);
    },
  };
});

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

/** A sink whose appends wait until `open()` is called, as slow storage would. */
function gatedSink(inner: AppendSink): AppendSink & { open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    append: async (bytes) => {
      await opened;
      await inner.append(bytes);
    },
    finish: () => inner.finish(),
    discard: () => inner.discard(),
    open,
  };
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
    flush: async () => {},
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
    expect(parseControl('{"t":"end","chunks":2,"bytes":9}')).toEqual({
      t: 'end',
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
    // Nothing travels from the receiver, so nothing of the kind is defined.
    expect(parseControl('{"t":"ack","chunks":3}')).toBeNull();
    expect(parseControl('{"t":"done","chunks":2,"bytes":9}')).toBeNull();
  });

  it('refuses a transfer message with malformed counts', () => {
    expect(() => parseControl('{"t":"end","chunks":-1,"bytes":9}')).toThrow();
    expect(() => parseControl('{"t":"end","chunks":1.5,"bytes":9}')).toThrow();
    expect(() => parseControl('{"t":"end","chunks":1}')).toThrow();
    expect(() => parseControl('{"t":"end","chunks":1,"bytes":"9"}')).toThrow();
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

    await expect(sending).resolves.toBe(ENCRYPTION_CHUNK_SIZE + 3);
    expect(peer.chunks()).toBe(2);
    expect(peer.controls()).toEqual([
      { t: 'end', chunks: 2, bytes: ENCRYPTION_CHUNK_SIZE + 3 },
    ]);
  });

  it('completes once its bytes are out, hearing nothing from the receiver', async () => {
    const key = await makeKey();
    const data = makePlaintext(ENCRYPTION_CHUNK_SIZE * 2 + 5);
    const peer = scriptedLink();

    await expect(
      sendFileOverLink(peer.link, key, zipSource(data)),
    ).resolves.toBe(data.length);

    expect(peer.chunks()).toBe(3);
    expect(peer.controls()).toEqual([
      { t: 'end', chunks: 3, bytes: data.length },
    ]);
    expect(peer.listeners()).toBe(0);
  });

  it('reports progress as the transport takes each chunk', async () => {
    const key = await makeKey();
    const data = makePlaintext(ENCRYPTION_CHUNK_SIZE * 3);
    const peer = scriptedLink();
    const progress: number[] = [];

    await sendFileOverLink(peer.link, key, zipSource(data), {
      onProgress: (current) => progress.push(current),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(data.length);
    for (const current of progress) {
      expect(current % ENCRYPTION_CHUNK_SIZE).toBe(0);
    }
  });

  it('tells the receiver when it is cancelled', async () => {
    const key = await makeKey();
    const [senderEnd] = fakeDataChannelPair();
    // A tiny threshold with the buffer held: the second chunk waits on
    // backpressure, which is where the cancel lands.
    const senderChannel = createDataChannelDuplex(senderEnd, 4);
    senderEnd.hold();
    let cancelled = false;
    const sending = sendFileOverLink(
      senderChannel,
      key,
      zipSource(makePlaintext(ENCRYPTION_CHUNK_SIZE * 3)),
      { isCancelled: () => cancelled },
    );
    await tick();
    cancelled = true;

    await expect(sending).rejects.toThrow('Cancelled');
    expect(parseControl(senderEnd.sent.at(-1) as string)).toEqual({
      t: 'abort',
      reason: 'cancelled',
    });
    senderChannel.close();
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

  it('fails as a connection problem when the link closes before the end is out', async () => {
    const key = await makeKey();
    const [senderEnd] = fakeDataChannelPair();
    const senderChannel = createDataChannelDuplex(senderEnd, 4);
    senderEnd.hold();
    const sending = sendFileOverLink(
      senderChannel,
      key,
      zipSource(makePlaintext(ENCRYPTION_CHUNK_SIZE * 3)),
    );
    await tick();

    senderEnd.close();

    const error = await sending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(P2PConnectionError);
    expect((error as Error).message).toMatch(/closed before the file/);
    // Nobody left to tell.
    expect(senderEnd.sent.every((m) => typeof m !== 'string')).toBe(true);
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

  it('aborts as a stall when the end never leaves the buffer', async () => {
    const key = await makeKey();
    const [senderEnd] = fakeDataChannelPair();
    const senderChannel = createDataChannelDuplex(senderEnd);
    // Everything fits under the threshold, so every send is accepted at
    // once; only the final drain has nothing to wait on but the peer.
    senderEnd.hold();

    await expect(
      sendFileOverLink(senderChannel, key, zipSource(makePlaintext(100)), {
        stallTimeoutMs: 20,
      }),
    ).rejects.toThrow('stopped draining');
    expect(senderEnd.sent).toHaveLength(3);
    expect(parseControl(senderEnd.sent[1] as string)?.t).toBe('end');
    expect(parseControl(senderEnd.sent[2] as string)?.t).toBe('abort');
    senderChannel.close();
  });

  it('completes when the receiver hangs up the moment it has the file', async () => {
    const key = await makeKey();
    const data = makePlaintext(ENCRYPTION_CHUNK_SIZE + 77);
    const sink = await createAdaptiveAppendSink(data.length);
    const receiver = createTransferReceiver(key, 'identity', sink);
    const [senderChannel, receiverChannel] = channelPair();
    receiver.attach(receiverChannel);
    // As the hooks do: the file is whole, so the connection goes.
    const received = receiver.done.then((blob) => {
      receiverChannel.close();
      return blob;
    });

    const wireBytes = await sendFileOverLink(
      senderChannel,
      key,
      zipSource(data),
    );
    const blob = await received;
    expect(wireBytes).toBe(data.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
  });

  it('fails when the receiver hangs up with bytes still in this side buffer', async () => {
    const key = await makeKey();
    const [senderEnd, receiverEnd] = fakeDataChannelPair();
    const senderChannel = createDataChannelDuplex(senderEnd);
    senderEnd.hold();
    const sending = sendFileOverLink(
      senderChannel,
      key,
      zipSource(makePlaintext(100)),
    );
    await tick();
    expect(senderEnd.sent).toHaveLength(2);

    receiverEnd.close();

    const error = await sending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(P2PConnectionError);
    expect((error as Error).message).toMatch(/closed before the file/);
    expect(senderEnd.sent).toHaveLength(2);
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
  });
});

describe('cancelOverLink', () => {
  it('tells the receiver at once over a channel, so it stops with the reason', async () => {
    const key = await makeKey();
    const sink = await createAdaptiveAppendSink(100);
    const receiver = createTransferReceiver(key, 'identity', sink);
    const [senderChannel, receiverChannel] = channelPair();
    receiver.attach(receiverChannel);

    // The sending side's user cancels before anything has gone out.
    expect(cancelOverLink(senderChannel)).toBe(true);

    const error = await receiver.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferAbortedError);
    expect((error as TransferAbortedError).reason).toBe(CANCELLED_REASON);
    expect((error as Error).message).toBe('The sender cancelled the transfer');
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

  it('stores in-order chunks and seals the file on an end that checks out, sending nothing', async () => {
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
    expect(peer.sent).toEqual([]);
    expect(peer.listeners()).toBe(0);
    await sink.discard();
  });

  it('accepts a zero-byte transfer', async () => {
    const { receiver, peer } = await attachedReceiver();
    peer.deliver({ t: 'end', chunks: 0, bytes: 0 });
    const blob = await receiver.done;
    expect(blob.size).toBe(0);
    expect(peer.sent).toEqual([]);
  });

  it('ignores text that is not a transfer message', async () => {
    const { receiver, peer } = await attachedReceiver();
    peer.deliver('hello');
    peer.deliver('{"t":"note"}');
    peer.deliver({ t: 'end', chunks: 0, bytes: 0 });
    await expect(receiver.done).resolves.toBeInstanceOf(Blob);
  });

  it('refuses chunks out of order', async () => {
    const { key, receiver, peer } = await attachedReceiver();
    const messages = await encryptAll(
      key,
      makePlaintext(ENCRYPTION_CHUNK_SIZE + 100),
    );

    peer.deliver(messages[1]);

    await expect(receiver.done).rejects.toThrow(
      'Unexpected streamed chunk index',
    );
    expect(peer.sent).toEqual([]);
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
  });

  it('refuses an end whose count disagrees with the chunks received', async () => {
    const { key, receiver, peer } = await attachedReceiver();
    const [message] = await encryptAll(key, makePlaintext(100));

    peer.deliver(message);
    peer.deliver({ t: 'end', chunks: 2, bytes: 100 });

    await expect(receiver.done).rejects.toThrow('Invalid end message');
  });

  it('ignores whatever arrives after a valid end', async () => {
    const { key, receiver, peer } = await attachedReceiver();
    const [message] = await encryptAll(key, makePlaintext(100));

    peer.deliver({ t: 'end', chunks: 0, bytes: 0 });
    // The link has been let go: nothing after the end is read.
    peer.deliver(message);
    peer.deliver({ t: 'end', chunks: 1, bytes: 100 });

    const blob = await receiver.done;
    expect(blob.size).toBe(0);
  });

  it('refuses a deflated payload that does not inflate cleanly', async () => {
    const { key, receiver, peer } = await attachedReceiver('deflate-raw');
    // Valid ciphertext whose plaintext is not a raw-deflate stream.
    const [message] = await encryptAll(key, makePlaintext(100));

    peer.deliver(message);
    peer.deliver({ t: 'end', chunks: 1, bytes: 100 });

    await expect(receiver.done).rejects.toThrow();
  });

  it('stops with the sender reason when the sender aborts', async () => {
    const { receiver, peer } = await attachedReceiver();

    peer.deliver({ t: 'abort', reason: 'The file is no longer readable' });

    const error = await receiver.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferAbortedError);
    expect((error as Error).message).toBe(
      'The sender stopped the transfer: The file is no longer readable',
    );
    expect(peer.sent).toEqual([]);
  });

  it('fails as a connection problem when the link closes mid-transfer', async () => {
    const { receiver, peer } = await attachedReceiver();

    peer.end('error');

    const error = await receiver.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(P2PConnectionError);
    expect(peer.sent).toEqual([]);
  });

  it('goes inert when it is abandoned, leaving the link to its caller', async () => {
    const { receiver, peer } = await attachedReceiver();

    receiver.dispose();

    await expect(receiver.done).rejects.toThrow('Cancelled');
    expect(peer.sent).toEqual([]);
    expect(peer.listeners()).toBe(0);
  });

  it('aborts an idle transfer via the stall watchdog', async () => {
    const { receiver } = await attachedReceiver('identity', {
      stallTimeoutMs: 20,
    });

    await expect(receiver.done).rejects.toThrow('Transfer stalled');
  });

  it('gives up when storage falls too far behind the link', async () => {
    const totalBytes = ENCRYPTION_CHUNK_SIZE * 2;
    const key = await makeKey();
    const inner = await createAdaptiveAppendSink(totalBytes);
    const sink = gatedSink(inner);
    const receiver = createTransferReceiver(key, 'identity', sink, {
      maxBacklogBytes: ENCRYPTION_CHUNK_SIZE,
    });
    const peer = scriptedLink();
    receiver.attach(peer.link);
    const messages = await encryptAll(key, makePlaintext(totalBytes));

    peer.deliver(messages[0]);
    peer.deliver(messages[1]);

    await expect(receiver.done).rejects.toThrow(
      'Storage could not keep up with the connection',
    );
    expect(peer.listeners()).toBe(0);
    sink.open();
    await inner.discard();
  });

  it('decrypts nothing still queued once it has given up', async () => {
    const totalBytes = ENCRYPTION_CHUNK_SIZE * 3;
    const key = await makeKey();
    const inner = await createAdaptiveAppendSink(totalBytes);
    const sink = gatedSink(inner);
    const receiver = createTransferReceiver(key, 'identity', sink, {
      maxBacklogBytes: ENCRYPTION_CHUNK_SIZE * 2,
    });
    const peer = scriptedLink();
    receiver.attach(peer.link);
    const messages = await encryptAll(key, makePlaintext(totalBytes));

    peer.deliver(messages[0]);
    peer.deliver(messages[1]);
    // The first chunk is decrypted and waiting on the write; the second is
    // queued behind it.
    await tick();
    const before = decrypts.count;
    peer.deliver(messages[2]);
    await expect(receiver.done).rejects.toThrow(
      'Storage could not keep up with the connection',
    );

    sink.open();
    await tick();

    expect(decrypts.count).toBe(before);
    await inner.discard();
  });

  it('bounds the backlog, not the file: storage that keeps up is never refused', async () => {
    const totalBytes = ENCRYPTION_CHUNK_SIZE * 2;
    const key = await makeKey();
    const sink = await createAdaptiveAppendSink(totalBytes);
    const receiver = createTransferReceiver(key, 'identity', sink, {
      maxBacklogBytes: ENCRYPTION_CHUNK_SIZE,
    });
    const peer = scriptedLink();
    receiver.attach(peer.link);
    const messages = await encryptAll(key, makePlaintext(totalBytes));

    for (const message of messages) {
      peer.deliver(message);
      // Each write finishes before the next chunk arrives.
      await tick();
    }
    peer.deliver({ t: 'end', chunks: 2, bytes: totalBytes });

    const blob = await receiver.done;
    expect(blob.size).toBe(totalBytes);
    await sink.discard();
  });

  /** A receiver on slow storage with every chunk and a valid `end` in hand. */
  async function receiverStoringAfterEnd(
    opts: Parameters<typeof createTransferReceiver>[3] = {},
  ) {
    const totalBytes = ENCRYPTION_CHUNK_SIZE + 5;
    const plaintext = makePlaintext(totalBytes);
    const key = await makeKey();
    const inner = await createAdaptiveAppendSink(totalBytes);
    const sink = gatedSink(inner);
    const receiver = createTransferReceiver(key, 'identity', sink, opts);
    const peer = scriptedLink();
    receiver.attach(peer.link);
    const messages = await encryptAll(key, plaintext);
    for (const message of messages) peer.deliver(message);
    peer.deliver({ t: 'end', chunks: messages.length, bytes: totalBytes });
    return { plaintext, inner, sink, receiver, peer };
  }

  it('seals the file when the sender hangs up after a valid end while chunks are still being stored', async () => {
    const { plaintext, inner, sink, receiver, peer } =
      await receiverStoringAfterEnd();
    // Everything is in hand, so the link was let go before it is stored.
    expect(peer.listeners()).toBe(0);
    // The sender moved on: an abort as its user starts another send, then
    // the close.
    peer.deliver({ t: 'abort', reason: CANCELLED_REASON });
    peer.end('closed');
    await tick();

    sink.open();

    const blob = await receiver.done;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plaintext);
    await inner.discard();
  });

  it('keeps storing after a valid end past the stall window', async () => {
    const { plaintext, inner, sink, receiver } = await receiverStoringAfterEnd({
      stallTimeoutMs: 20,
    });
    await tick(60);

    sink.open();

    const blob = await receiver.done;
    expect(blob.size).toBe(plaintext.length);
    await inner.discard();
  });

  it('can still be abandoned while it stores what arrived after the end', async () => {
    const { inner, sink, receiver } = await receiverStoringAfterEnd();

    receiver.dispose();
    sink.open();

    await expect(receiver.done).rejects.toThrow('Cancelled');
    await inner.discard();
  });
});
