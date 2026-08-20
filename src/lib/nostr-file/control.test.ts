import { describe, expect, it } from 'vitest';
import { generateEphemeralKeys } from '../nostr/events';
import { PUBLISH_BACKOFF_BASE_MS, PUBLISH_MAX_RETRIES } from './constants';
import {
  buildControlEvent,
  controlChannelTag,
  decodeControlMessage,
  deriveControlKey,
  encodeControlMessage,
  encodePosition,
  openControlChannel,
  parseReceiverMessage,
  parseSenderMessage,
} from './control';
import { createMockPool } from './mock-pool';

const TRANSFER_ID = 'a'.repeat(32);
const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example'];

function fixedKeyBytes(fill = 7): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe('control channel key and sealing', () => {
  it('derives the same non-extractable key on both ends', async () => {
    const a = await deriveControlKey(fixedKeyBytes(), TRANSFER_ID);
    const b = await deriveControlKey(fixedKeyBytes(), TRANSFER_ID);
    expect(a.extractable).toBe(false);
    const sealed = await encodeControlMessage(a, TRANSFER_ID, 'sender', {
      t: 'avail',
      n: 1,
      upto: 3,
      map: 'ABC',
      gens: [],
    });
    expect(
      await decodeControlMessage(b, TRANSFER_ID, 'sender', sealed),
    ).toEqual({ t: 'avail', n: 1, upto: 3, map: 'ABC', gens: [] });
  });

  it('keeps a full 3200-chunk placement map small on the wire', async () => {
    const key = await deriveControlKey(fixedKeyBytes(), TRANSFER_ID);
    let map = '';
    for (let i = 0; i < 3200; i++) map += encodePosition(i % 16);
    const sealed = await encodeControlMessage(key, TRANSFER_ID, 'sender', {
      t: 'avail',
      n: 50,
      upto: 3200,
      map,
      gens: [
        [17, 1],
        [900, 2],
      ],
    });
    // Deflate collapses the periodic map: a few hundred bytes, not 3.2 KB.
    expect(sealed.length).toBeLessThan(600);
    expect(
      parseSenderMessage(
        await decodeControlMessage(key, TRANSFER_ID, 'sender', sealed),
        3200,
        16,
      ),
    ).toMatchObject({
      t: 'avail',
      upto: 3200,
      gens: [
        [17, 1],
        [900, 2],
      ],
    });
  });

  it('binds messages to the role and the transfer', async () => {
    const key = await deriveControlKey(fixedKeyBytes(), TRANSFER_ID);
    const sealed = await encodeControlMessage(key, TRANSFER_ID, 'receiver', {
      t: 'done',
      n: 2,
    });
    // A receiver message cannot be replayed as a sender message...
    await expect(
      decodeControlMessage(key, TRANSFER_ID, 'sender', sealed),
    ).rejects.toThrow();
    // ...nor read under another transfer's key.
    const otherKey = await deriveControlKey(fixedKeyBytes(), 'b'.repeat(32));
    await expect(
      decodeControlMessage(otherKey, TRANSFER_ID, 'receiver', sealed),
    ).rejects.toThrow();
    // A different file key yields a different control key.
    const otherFileKey = await deriveControlKey(fixedKeyBytes(8), TRANSFER_ID);
    await expect(
      decodeControlMessage(otherFileKey, TRANSFER_ID, 'receiver', sealed),
    ).rejects.toThrow();
  });

  it('tags control events for the channel filter, not the chunk namespace', () => {
    const { secretKey } = generateEphemeralKeys();
    const event = buildControlEvent(secretKey, {
      transferId: TRANSFER_ID,
      role: 'sender',
      n: 5,
      content: 'x',
      expiresAt: 1_700_003_600,
    });
    const tags = Object.fromEntries(event.tags.map((t) => [t[0], t[1]]));
    expect(tags.d).toBe(`${TRANSFER_ID}:ctl:sender:5`);
    expect(tags.x).toBe(controlChannelTag(TRANSFER_ID));
    expect(tags.expiration).toBe('1700003600');
    expect(event.tags.find((t) => t[0] === 'chunk')).toBeUndefined();
  });
});

describe('control message validation', () => {
  it('accepts well-formed messages and rejects out-of-range fields', () => {
    expect(
      parseSenderMessage(
        { t: 'avail', n: 1, upto: 4, map: 'ABCB', gens: [[2, 1]] },
        4,
        3,
      ),
    ).toEqual({ t: 'avail', n: 1, upto: 4, map: 'ABCB', gens: [[2, 1]] });
    // upto past the chunk count
    expect(
      parseSenderMessage(
        { t: 'avail', n: 1, upto: 5, map: 'ABCAB', gens: [] },
        4,
        3,
      ),
    ).toBeNull();
    // map length must equal upto
    expect(
      parseSenderMessage(
        { t: 'avail', n: 1, upto: 4, map: 'ABC', gens: [] },
        4,
        3,
      ),
    ).toBeNull();
    // placement at a relay position outside the ring, or not a position
    expect(
      parseSenderMessage(
        { t: 'avail', n: 1, upto: 4, map: 'ABCD', gens: [] },
        4,
        3,
      ),
    ).toBeNull();
    expect(
      parseSenderMessage(
        { t: 'avail', n: 1, upto: 4, map: 'AB!C', gens: [] },
        4,
        3,
      ),
    ).toBeNull();
    // generation for a chunk not yet announced, or a zero generation
    expect(
      parseSenderMessage(
        { t: 'avail', n: 1, upto: 2, map: 'AB', gens: [[3, 1]] },
        4,
        3,
      ),
    ).toBeNull();
    expect(
      parseSenderMessage(
        { t: 'avail', n: 1, upto: 2, map: 'AB', gens: [[1, 0]] },
        4,
        3,
      ),
    ).toBeNull();
    expect(parseSenderMessage({ t: 'ack', n: 1 }, 4, 3)).toBeNull();
    expect(parseSenderMessage({ t: 'cancel', n: 1.5 }, 4, 3)).toBeNull();
    expect(parseSenderMessage('nope', 4, 3)).toBeNull();

    expect(
      parseReceiverMessage(
        { t: 'ack', n: 3, avail: 2, have: 1, missing: [[1, 1, 0]] },
        4,
        3,
      ),
    ).toEqual({ t: 'ack', n: 3, avail: 2, have: 1, missing: [[1, 1, 0]] });
    expect(parseReceiverMessage({ t: 'hello', n: 1 }, 4, 3)).toEqual({
      t: 'hello',
      n: 1,
    });
    expect(
      parseReceiverMessage(
        { t: 'ack', n: 3, avail: 2, have: 9, missing: [] },
        4,
        3,
      ),
    ).toBeNull();
    expect(
      parseReceiverMessage(
        { t: 'ack', n: 3, avail: 2, have: 1, missing: [[4, 0, 0]] },
        4,
        3,
      ),
    ).toBeNull();
    expect(parseReceiverMessage({ t: 'avail', n: 1 }, 4, 3)).toBeNull();
  });
});

describe('openControlChannel', () => {
  it('delivers sealed messages across roles, including the stored backlog', async () => {
    const pool = createMockPool();
    const key = await deriveControlKey(fixedKeyBytes(), TRANSFER_ID);
    const sender = generateEphemeralKeys();
    const receiver = generateEphemeralKeys();
    const since = Math.floor(Date.now() / 1000) - 600;
    const expiresAt = since + 4200;

    const toReceiver: unknown[] = [];
    const receiverChannel = openControlChannel(pool, RELAYS, {
      transferId: TRANSFER_ID,
      key,
      role: 'receiver',
      secretKey: receiver.secretKey,
      since,
      expiresAt,
      authors: [sender.publicKey],
      onMessage: (m) => toReceiver.push(m),
    });
    // The receiver speaks before the sender has subscribed; the sender must
    // still get it from the relays' stored copies.
    await receiverChannel.send({ t: 'hello' });

    const toSender: { message: unknown; pubkey: string }[] = [];
    const senderChannel = openControlChannel(pool, RELAYS, {
      transferId: TRANSFER_ID,
      key,
      role: 'sender',
      secretKey: sender.secretKey,
      since,
      expiresAt,
      onMessage: (message, pubkey) => toSender.push({ message, pubkey }),
    });
    await senderChannel.send({ t: 'avail', upto: 2, map: 'AB', gens: [] });
    await new Promise((r) => setTimeout(r, 10));

    expect(toSender).toEqual([
      { message: { t: 'hello', n: 1 }, pubkey: receiver.publicKey },
    ]);
    // Our own events never loop back; the peer's arrive once despite being
    // stored on three relays.
    expect(toReceiver).toEqual([
      { t: 'avail', upto: 2, map: 'AB', gens: [], n: 1 },
    ]);

    senderChannel.close();
    receiverChannel.close();
    await expect(senderChannel.send({ t: 'cancel' })).rejects.toThrow(/closed/);
  });

  it('resolves a send once any relay accepts and rejects when none do', async () => {
    const key = await deriveControlKey(fixedKeyBytes(), TRANSFER_ID);
    const { secretKey } = generateEphemeralKeys();
    const since = Math.floor(Date.now() / 1000);
    const open = (pool: ReturnType<typeof createMockPool>) =>
      openControlChannel(pool, RELAYS, {
        transferId: TRANSFER_ID,
        key,
        role: 'sender',
        secretKey,
        since,
        expiresAt: since + 3600,
        onMessage: () => {},
      });

    const partial = open(
      createMockPool({ failRelays: new Set(RELAYS.slice(0, 2)) }),
    );
    await expect(partial.send({ t: 'cancel' })).resolves.toBeUndefined();
    partial.close();

    const dead = open(createMockPool({ failRelays: new Set(RELAYS) }));
    const started = Date.now();
    await expect(dead.send({ t: 'cancel' })).rejects.toThrow(/Lost contact/);
    // Every relay is retried with doubling backoff, all of them in parallel,
    // so the whole send takes at least one relay's backoff schedule.
    const backoffTotal =
      PUBLISH_BACKOFF_BASE_MS * (2 ** PUBLISH_MAX_RETRIES - 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(backoffTotal * 0.95);
    dead.close();
  }, 15000);
});
