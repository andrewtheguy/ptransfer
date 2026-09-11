import type { Event, Filter } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  awaitCarriedOffer,
  type CarriageClient,
  carryOfferForAnswer,
  openCarriedCode,
  sealCarriedCode,
} from './code-carriage';
import { createSignalingEvent, generateEphemeralKeys } from './events';

function signalsKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function matches(filter: Filter, event: Event): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  for (const tag of ['t', 'p'] as const) {
    const wanted = filter[`#${tag}`];
    if (!wanted) continue;
    const values = event.tags.filter((t) => t[0] === tag).map((t) => t[1]);
    if (!values.some((value) => wanted.includes(value))) return false;
  }
  return true;
}

/** An in-memory relay every client shares; `published` is its log. */
function relayHub() {
  const subscriptions = new Map<
    string,
    { filter: Filter; onEvent: (event: Event) => void }
  >();
  const published: Event[] = [];
  let next = 0;
  const client: CarriageClient = {
    publish(event) {
      published.push(event);
      for (const { filter, onEvent } of subscriptions.values()) {
        if (matches(filter, event)) setTimeout(() => onEvent(event), 0);
      }
      return Promise.resolve();
    },
    subscribe(filters, onEvent) {
      const id = String(next++);
      subscriptions.set(id, { filter: filters[0], onEvent });
      return id;
    },
    unsubscribe(id) {
      subscriptions.delete(id);
    },
    query: async () => [],
  };
  return { client, published };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSFER_ID = '0123456789abcdef';

describe('sealed codes', () => {
  it('open under the key that sealed them, byte for byte', async () => {
    const key = await signalsKey();
    const code = new Uint8Array([0x50, 0x54, 0x30, 0x31, 1, 2, 3, 255]);
    const sealed = await sealCarriedCode(key, { type: 'offer', code });

    await expect(openCarriedCode(key, sealed)).resolves.toEqual({
      type: 'offer',
      code,
    });
  });

  it('do not open under another key, and refuse anything misshapen', async () => {
    const key = await signalsKey();
    const sealed = await sealCarriedCode(key, {
      type: 'answer',
      code: new Uint8Array([1]),
    });

    await expect(openCarriedCode(await signalsKey(), sealed)).resolves.toBe(
      null,
    );
    await expect(
      openCarriedCode(key, new Uint8Array([1, 2, 3])),
    ).resolves.toBeNull();
    const { encrypt } = await import('../crypto/aes-gcm');
    const wrongType = await encrypt(
      key,
      new TextEncoder().encode(
        JSON.stringify({ type: 'signal', code: 'AQ==' }),
      ),
    );
    await expect(openCarriedCode(key, wrongType)).resolves.toBeNull();
  });
});

describe('carrying the codes', () => {
  async function session() {
    const hub = relayHub();
    const key = await signalsKey();
    const sender = generateEphemeralKeys();
    const receiver = generateEphemeralKeys();
    return { hub, key, sender, receiver };
  }

  it('delivers the offer to the receiver and its answer back', async () => {
    const { hub, key, sender, receiver } = await session();
    const offer = new Uint8Array([10, 20, 30]);
    const answer = new Uint8Array([40, 50]);

    const waiting = awaitCarriedOffer({
      client: hub.client,
      secretKey: receiver.secretKey,
      transferId: TRANSFER_ID,
      senderPubkey: sender.publicKey,
      signalsKey: key,
      isCancelled: () => false,
      timeoutMs: 5_000,
      timeoutMessage: 'no offer',
    });
    const carrying = carryOfferForAnswer({
      client: hub.client,
      secretKey: sender.secretKey,
      transferId: TRANSFER_ID,
      senderPubkey: sender.publicKey,
      receiverPubkey: receiver.publicKey,
      signalsKey: key,
      isCancelled: () => false,
      offer,
      retryMs: 1_000,
      timeoutMs: 5_000,
    });

    await expect(waiting.offer).resolves.toEqual(offer);
    await waiting.answer(answer);
    await expect(carrying).resolves.toEqual(answer);
    waiting.close();

    // What the relay holds is ciphertext: no trace of the codes' framing.
    for (const event of hub.published) {
      expect(atob(event.content)).not.toContain('"type"');
    }
  });

  it('answers each repeat of the offer it answered, and ignores a different one', async () => {
    const { hub, key, sender, receiver } = await session();
    const offer = new Uint8Array([1, 2, 3]);
    const publishOffer = async (code: Uint8Array) =>
      hub.client.publish(
        createSignalingEvent(
          sender.secretKey,
          sender.publicKey,
          TRANSFER_ID,
          await sealCarriedCode(key, { type: 'offer', code }),
        ),
      );
    const answersSent = () =>
      hub.published.filter((event) => event.pubkey === receiver.publicKey)
        .length;

    const waiting = awaitCarriedOffer({
      client: hub.client,
      secretKey: receiver.secretKey,
      transferId: TRANSFER_ID,
      senderPubkey: sender.publicKey,
      signalsKey: key,
      isCancelled: () => false,
      timeoutMs: 5_000,
      timeoutMessage: 'no offer',
    });
    await publishOffer(offer);
    await expect(waiting.offer).resolves.toEqual(offer);
    await waiting.answer(new Uint8Array([9]));
    expect(answersSent()).toBe(1);

    await publishOffer(offer);
    await tick();
    expect(answersSent()).toBe(2);

    await publishOffer(new Uint8Array([7, 7, 7]));
    await tick();
    expect(answersSent()).toBe(2);
    waiting.close();
  });

  it('ignores codes sealed under another session', async () => {
    const { hub, key, sender, receiver } = await session();
    const waiting = awaitCarriedOffer({
      client: hub.client,
      secretKey: receiver.secretKey,
      transferId: TRANSFER_ID,
      senderPubkey: sender.publicKey,
      signalsKey: key,
      isCancelled: () => false,
      timeoutMs: 50,
      timeoutMessage: 'no offer',
    });
    await hub.client.publish(
      createSignalingEvent(
        sender.secretKey,
        sender.publicKey,
        TRANSFER_ID,
        await sealCarriedCode(await signalsKey(), {
          type: 'offer',
          code: new Uint8Array([1]),
        }),
      ),
    );

    await expect(waiting.offer).rejects.toThrow('no offer');
  });

  it('republishes the offer until an answer comes back, then gives up at the deadline', async () => {
    const { hub, key, sender, receiver } = await session();

    await expect(
      carryOfferForAnswer({
        client: hub.client,
        secretKey: sender.secretKey,
        transferId: TRANSFER_ID,
        senderPubkey: sender.publicKey,
        receiverPubkey: receiver.publicKey,
        signalsKey: key,
        isCancelled: () => false,
        offer: new Uint8Array([1]),
        retryMs: 20,
        timeoutMs: 110,
      }),
    ).rejects.toThrow('did not answer');
    expect(hub.published.length).toBeGreaterThanOrEqual(3);
  });

  it('stops waiting for the offer when cancelled', async () => {
    const { hub, key, sender, receiver } = await session();
    let cancelled = false;
    const waiting = awaitCarriedOffer({
      client: hub.client,
      secretKey: receiver.secretKey,
      transferId: TRANSFER_ID,
      senderPubkey: sender.publicKey,
      signalsKey: key,
      isCancelled: () => cancelled,
      timeoutMs: 5_000,
      timeoutMessage: 'no offer',
    });
    cancelled = true;

    await expect(waiting.offer).rejects.toThrow('Cancelled');
  });
});
