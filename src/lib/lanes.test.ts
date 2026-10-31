import { describe, expect, it } from 'vitest';
import { fakeDataChannelPair } from '../test/fake-data-channel';
import { ENCRYPTION_CHUNK_SIZE } from './crypto';
import { createDataChannelDuplex } from './data-channel';
import {
  createLaneLink,
  encodeLaneMessage,
  MAX_EXTRA_LANES,
  parseLaneMessage,
} from './lanes';
import {
  createTransferReceiver,
  parseControl,
  sendFileOverLink,
} from './p2p-transfer';
import { createAdaptiveAppendSink } from './scratch-sink';
import type { TransferSource } from './transfer-source';

/**
 * Two ends of one connection over an in-memory data channel pair, with a
 * low enough backpressure threshold that a single chunk fills one, and the
 * fake channels themselves for counting what each carried.
 */
function connection() {
  const [senderEnd, receiverEnd] = fakeDataChannelPair();
  const threshold = ENCRYPTION_CHUNK_SIZE / 2;
  return {
    sender: createDataChannelDuplex(senderEnd, threshold),
    receiver: createDataChannelDuplex(receiverEnd, threshold),
    /** Binary messages the sender's end has sent. */
    chunks: () => senderEnd.sent.filter((m) => typeof m !== 'string').length,
    senderEnd,
  };
}

function plaintext(bytes: number): Uint8Array {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 13 + 5) % 256;
  return data;
}

function source(data: Uint8Array): TransferSource {
  return {
    name: 'file.bin',
    type: 'application/octet-stream',
    size: data.length,
    estimatedSize: data.length,
    projectedWireBytes: data.length,
    archive: false,
    stream: () => new Blob([data as BlobPart]).stream(),
  };
}

const key = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);

describe('createLaneLink', () => {
  it('spreads a transfer over every connection and the receiver restores it', async () => {
    const first = connection();
    const lane = connection();
    const sending = createLaneLink(first.sender);
    sending.add(lane.sender);
    const receiving = createLaneLink(first.receiver);
    receiving.add(lane.receiver);

    const data = plaintext(12 * ENCRYPTION_CHUNK_SIZE + 77);
    const k = await key();
    const receiver = createTransferReceiver(
      k,
      'identity',
      await createAdaptiveAppendSink(data.length),
    );
    receiver.attach(receiving.link);
    await sendFileOverLink(sending.link, k, source(data), {
      compressed: false,
    });

    const blob = await receiver.done;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
    expect(first.chunks()).toBeGreaterThan(0);
    expect(lane.chunks()).toBeGreaterThan(0);
    expect(first.chunks() + lane.chunks()).toBe(13);
  });

  it('drops a lane that ends before carrying anything', async () => {
    const first = connection();
    const lane = connection();
    const sending = createLaneLink(first.sender);
    sending.add(lane.sender);
    const ended: string[] = [];
    sending.link.onEnd((reason) => ended.push(reason));

    lane.sender.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ended).toEqual([]);
    expect(sending.size()).toBe(1);
    await sending.link.sendBinary(new Uint8Array(10));
    expect(first.chunks()).toBe(1);
  });

  it('ends when a lane that has carried chunks ends', async () => {
    const first = connection();
    const lane = connection();
    const sending = createLaneLink(first.sender);
    sending.add(lane.sender);
    const ended: string[] = [];
    sending.link.onEnd((reason) => ended.push(reason));

    // The first channel fills on one chunk, so the second goes to the lane.
    first.senderEnd.hold();
    await sending.link.sendBinary(new Uint8Array(ENCRYPTION_CHUNK_SIZE));
    await sending.link.sendBinary(new Uint8Array(ENCRYPTION_CHUNK_SIZE));
    expect(lane.chunks()).toBe(1);

    lane.sender.close();
    expect(ended).toEqual(['closed']);
  });

  it('ends when the first channel ends', () => {
    const first = connection();
    const sending = createLaneLink(first.sender);
    const ended: string[] = [];
    sending.link.onEnd((reason) => ended.push(reason));

    first.sender.close();
    expect(ended).toEqual(['closed']);
  });

  it('sends text on the first channel only', async () => {
    const first = connection();
    const lane = connection();
    const sending = createLaneLink(first.sender);
    sending.add(lane.sender);
    const heard: string[] = [];
    first.receiver.subscribe((m) => {
      if (typeof m === 'string') heard.push(m);
    });

    await sending.link.sendText('hello');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(heard).toEqual(['hello']);
    expect(lane.senderEnd.sent).toEqual([]);
  });
});

describe('parseLaneMessage', () => {
  it('reads an offer and an answer', () => {
    for (const t of ['lane-offer', 'lane-answer'] as const) {
      const message = { t, lane: 2, sdp: 'v=0' };
      expect(parseLaneMessage(encodeLaneMessage(message))).toEqual(message);
    }
  });

  it('ignores anything else, malformed lane messages included', () => {
    for (const text of [
      'not json',
      '{"t":"end","chunks":0,"bytes":0}',
      '{"t":"lane-offer","lane":0,"sdp":"v=0"}',
      `{"t":"lane-offer","lane":${MAX_EXTRA_LANES + 1},"sdp":"v=0"}`,
      '{"t":"lane-offer","lane":1.5,"sdp":"v=0"}',
      '{"t":"lane-offer","lane":1,"sdp":""}',
      '{"t":"lane-answer","lane":1}',
      JSON.stringify({ t: 'lane-offer', lane: 1, sdp: 'x'.repeat(70_000) }),
    ]) {
      expect(parseLaneMessage(text)).toBeNull();
    }
  });
});

// The transfer's own control messages are not lane messages, and the reverse.
describe('lane and transfer messages', () => {
  it('do not mistake each other', () => {
    expect(
      parseControl(encodeLaneMessage({ t: 'lane-offer', lane: 1, sdp: 'v=0' })),
    ).toBeNull();
  });
});
