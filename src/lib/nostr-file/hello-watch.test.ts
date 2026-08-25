import { describe, expect, it } from 'vitest';
import { generateEphemeralKeys } from '../nostr/events';
import { deriveControlKey, openControlChannel } from './control';
import { watchForReceiverHello } from './hello-watch';
import { createMockPool } from './mock-pool';

const RELAYS = ['wss://r1.example', 'wss://r2.example'];
const session = () => ({
  transferId: 'b'.repeat(32),
  keyBytes: new Uint8Array(32).fill(3),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settled(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => true), sleep(50).then(() => false)]);
}

describe('watchForReceiverHello', () => {
  it('resolves on the receiver hello, including one sent before subscribing', async () => {
    const pool = createMockPool();
    const s = session();
    const since = Math.floor(Date.now() / 1000) - 60;
    const receiver = openControlChannel(pool, RELAYS, {
      transferId: s.transferId,
      key: await deriveControlKey(s.keyBytes, s.transferId),
      role: 'receiver',
      secretKey: generateEphemeralKeys().secretKey,
      since,
      expiresAt: since + 3600,
      onMessage: () => {},
    });
    await receiver.send({ t: 'hello' });

    const watch = watchForReceiverHello(pool, RELAYS, s, {
      since,
      expiresAt: since + 3600,
    });
    await expect(watch.hello).resolves.toBeUndefined();
    // The key bytes are borrowed, not consumed.
    expect(s.keyBytes.every((b) => b === 3)).toBe(true);
    receiver.close();
  });

  it('ignores messages that are not hello and stays pending after close', async () => {
    const pool = createMockPool();
    const s = session();
    const since = Math.floor(Date.now() / 1000) - 60;
    const watch = watchForReceiverHello(pool, RELAYS, s, {
      since,
      expiresAt: since + 3600,
    });
    const receiver = openControlChannel(pool, RELAYS, {
      transferId: s.transferId,
      key: await deriveControlKey(s.keyBytes, s.transferId),
      role: 'receiver',
      secretKey: generateEphemeralKeys().secretKey,
      since,
      expiresAt: since + 3600,
      onMessage: () => {},
    });
    await receiver.send({ t: 'done' });
    expect(await settled(watch.hello)).toBe(false);

    watch.close();
    await receiver.send({ t: 'hello' });
    expect(await settled(watch.hello)).toBe(false);
    receiver.close();
  });

  it('ignores a hello sealed under a different session', async () => {
    const pool = createMockPool();
    const s = session();
    const since = Math.floor(Date.now() / 1000) - 60;
    const watch = watchForReceiverHello(pool, RELAYS, s, {
      since,
      expiresAt: since + 3600,
    });
    const other = openControlChannel(pool, RELAYS, {
      transferId: s.transferId,
      key: await deriveControlKey(new Uint8Array(32).fill(9), s.transferId),
      role: 'receiver',
      secretKey: generateEphemeralKeys().secretKey,
      since,
      expiresAt: since + 3600,
      onMessage: () => {},
    });
    await other.send({ t: 'hello' });
    expect(await settled(watch.hello)).toBe(false);
    watch.close();
    other.close();
  });
});
