import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installOpfsMock, type OpfsMock } from '../test/opfs-mock';
import { ENCRYPTION_CHUNK_SIZE, encryptChunk } from './crypto';
import {
  ACK,
  createDataChannelTransport,
  createTransferReceiver,
  sendFileOverTransport,
} from './p2p-transfer';
import { createAdaptiveAppendSink } from './scratch-sink';
import {
  createFileTransferSource,
  type TransferSource,
  type WireEncoding,
} from './transfer-source';
import type { WebRTCConnection } from './webrtc';

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
 * Wire a sender directly into a receiver: every encrypted chunk and the DONE
 * control string are fed to the receiver as they are produced, and the
 * receiver's completion is answered with the ACK the sender waits for.
 */
async function roundTrip(
  source: TransferSource,
  encoding: WireEncoding,
): Promise<{ wireBytes: number; blob: Blob }> {
  const key = await makeKey();
  const sink = await createAdaptiveAppendSink(source.estimatedSize);
  const receiver = createTransferReceiver(key, encoding, sink, {
    estimatedBytes: source.estimatedSize,
  });
  receiver.start();

  const channel = Object.assign(new EventTarget(), {
    readyState: 'open' as RTCDataChannelState,
  }) as unknown as RTCDataChannel;
  const rtc = {
    async sendWithBackpressure(data: Uint8Array) {
      receiver.onMessage(data.slice().buffer as ArrayBuffer);
    },
    send(data: string) {
      receiver.onMessage(data);
      receiver.done
        .then(() => {
          channel.dispatchEvent(new MessageEvent('message', { data: ACK }));
        })
        .catch(() => {});
    },
    getDataChannel() {
      return channel;
    },
  } as unknown as WebRTCConnection;

  const wireBytes = await sendFileOverTransport(
    createDataChannelTransport(rtc),
    key,
    source,
  );
  const blob = await receiver.done;
  return { wireBytes, blob };
}

describe('sendFileOverTransport', () => {
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
      name: 'stream.zip',
      type: 'application/zip',
      size: null,
      estimatedSize: ENCRYPTION_CHUNK_SIZE + 3,
      projectedWireBytes: ENCRYPTION_CHUNK_SIZE + 3,
      precompressed: true,
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

    const channel = Object.assign(new EventTarget(), {
      readyState: 'open' as RTCDataChannelState,
    }) as unknown as RTCDataChannel;
    let firstChunkSent!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkSent = resolve;
    });
    const controls: string[] = [];
    const rtc = {
      async sendWithBackpressure() {
        firstChunkSent();
      },
      send(data: string) {
        controls.push(data);
        queueMicrotask(() => {
          channel.dispatchEvent(new MessageEvent('message', { data: ACK }));
        });
      },
      getDataChannel() {
        return channel;
      },
    } as unknown as WebRTCConnection;

    const sending = sendFileOverTransport(
      createDataChannelTransport(rtc),
      key,
      source,
    );
    await firstChunk;
    expect(remainderReleased).toBe(false);
    releaseRemainder();

    await expect(sending).resolves.toBe(ENCRYPTION_CHUNK_SIZE + 3);
    expect(controls).toEqual([`DONE:2:${ENCRYPTION_CHUNK_SIZE + 3}`]);
  });

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
    const source: TransferSource = {
      name: 'bundle.zip',
      type: 'application/zip',
      size: null,
      estimatedSize: data.length,
      projectedWireBytes: data.length,
      precompressed: true,
      stream: () => new Blob([data as BlobPart]).stream(),
    };

    const { wireBytes, blob } = await roundTrip(source, 'identity');

    expect(wireBytes).toBe(data.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
  });
});

describe('createTransferReceiver', () => {
  it('appends in-order chunks into the sink and resolves the payload', async () => {
    const key = await makeKey();
    const totalBytes = ENCRYPTION_CHUNK_SIZE + 1234;
    const plaintext = makePlaintext(totalBytes);
    const messages = await encryptAll(key, plaintext);

    const sink = await createAdaptiveAppendSink(totalBytes);
    const progress: number[] = [];
    const receiver = createTransferReceiver(key, 'identity', sink, {
      estimatedBytes: totalBytes,
      onProgress: (current) => progress.push(current),
    });
    receiver.start();

    for (const message of messages) receiver.onMessage(message);
    receiver.onMessage(`DONE:${messages.length}:${totalBytes}`);

    const blob = await receiver.done;
    expect(blob.size).toBe(totalBytes);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plaintext);
    expect(progress.at(-1)).toBe(totalBytes);
    await sink.discard();
  });

  it('resolves an empty payload for a zero-byte transfer', async () => {
    const key = await makeKey();
    const sink = await createAdaptiveAppendSink(0);
    const receiver = createTransferReceiver(key, 'identity', sink);
    receiver.start();
    receiver.onMessage('DONE:0:0');
    const blob = await receiver.done;
    expect(blob.size).toBe(0);
  });

  it('rejects chunks that arrive out of the data-channel order', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(ENCRYPTION_CHUNK_SIZE + 100);
    const messages = await encryptAll(key, plaintext);

    const sink = await createAdaptiveAppendSink(plaintext.length);
    const receiver = createTransferReceiver(key, 'identity', sink);
    receiver.start();
    receiver.onMessage(messages[1]);

    await expect(receiver.done).rejects.toThrow(
      'Unexpected streamed chunk index',
    );
  });

  it('rejects a duplicate chunk index', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(100);
    const [message] = await encryptAll(key, plaintext);

    const sink = await createAdaptiveAppendSink(100);
    const receiver = createTransferReceiver(key, 'identity', sink);
    receiver.start();
    receiver.onMessage(message);
    receiver.onMessage(message.slice(0));

    await expect(receiver.done).rejects.toThrow(
      'Unexpected streamed chunk index',
    );
  });

  it('rejects a tampered chunk', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(100);
    const [message] = await encryptAll(key, plaintext);
    const tampered = new Uint8Array(message.slice(0));
    tampered[tampered.length - 1] ^= 0xff;

    const sink = await createAdaptiveAppendSink(100);
    const receiver = createTransferReceiver(key, 'identity', sink);
    receiver.start();
    receiver.onMessage(tampered.buffer as ArrayBuffer);

    await expect(receiver.done).rejects.toThrow();
  });

  it('rejects a DONE count that disagrees with received chunks', async () => {
    const key = await makeKey();
    const plaintext = makePlaintext(100);
    const [message] = await encryptAll(key, plaintext);

    const sink = await createAdaptiveAppendSink(100);
    const receiver = createTransferReceiver(key, 'identity', sink);
    receiver.start();
    receiver.onMessage(message);
    receiver.onMessage('DONE:2:100');

    await expect(receiver.done).rejects.toThrow('Invalid DONE message');
  });

  it('rejects a deflated payload that does not inflate cleanly', async () => {
    const key = await makeKey();
    // Valid ciphertext whose plaintext is not a raw-deflate stream.
    const [message] = await encryptAll(key, makePlaintext(100));

    const sink = await createAdaptiveAppendSink(100);
    const receiver = createTransferReceiver(key, 'deflate-raw', sink);
    receiver.start();
    receiver.onMessage(message);
    receiver.onMessage('DONE:1:100');

    await expect(receiver.done).rejects.toThrow();
  });

  it('aborts an idle transfer via the stall watchdog', async () => {
    const key = await makeKey();
    const sink = await createAdaptiveAppendSink(100);
    const receiver = createTransferReceiver(key, 'identity', sink, {
      stallTimeoutMs: 20,
    });
    receiver.start();

    await expect(receiver.done).rejects.toThrow('Transfer stalled');
  });
});
