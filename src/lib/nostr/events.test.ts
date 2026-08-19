import { describe, expect, it } from 'vitest';
import { PIN_ACTIVE_BUCKETS, PIN_ROTATION_MS } from '../crypto/constants';
import { getPinBucket } from '../crypto/pin';
import {
  createHandshakeEvent,
  createRendezvousEvent,
  generateEphemeralKeys,
  generateHandshakeNonce,
  openHandshakePayload,
  parseHandshakeEvent,
  parseRendezvousEvent,
  sealHandshakePayload,
  uint8ArrayToBase64,
} from './events';
import type { RendezvousPayload } from './types';

async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('Nostr events', () => {
  it('round-trips rendezvous event tags and plaintext payload', () => {
    const { secretKey, publicKey } = generateEphemeralKeys();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const payload: RendezvousPayload = {
      type: 'rendezvous',
      transferId: 'transfer-id',
      senderPubkey: publicKey,
      pakeMessage: uint8ArrayToBase64(new Uint8Array(33).fill(2)),
      nonce: generateHandshakeNonce(),
      relays: ['wss://relay.example'],
    };

    const pinBucket = getPinBucket();
    const event = createRendezvousEvent(
      secretKey,
      payload,
      salt,
      'hint',
      pinBucket,
    );

    const parsed = parseRendezvousEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.hint).toBe('hint');
    expect(parsed?.transferId).toBe('transfer-id');
    expect(parsed?.salt).toEqual(salt);
    expect(parsed?.payload).toEqual(payload);

    // NIP-40 expiration tag is present and in the future
    const expiration = event.tags.find((t) => t[0] === 'expiration')?.[1];
    expect(Number(expiration)).toBe(
      ((pinBucket + PIN_ACTIVE_BUCKETS) * PIN_ROTATION_MS) / 1000,
    );
  });

  it('seals and opens handshake payloads with the session seal key', async () => {
    const { secretKey } = generateEphemeralKeys();
    const sealKey = await generateAesKey();
    const payload = {
      type: 'claim',
      transferId: 'transfer-id',
      senderNonce: generateHandshakeNonce(),
      receiverNonce: generateHandshakeNonce(),
    };
    const pakeMessage = new Uint8Array(33).fill(3);

    const event = createHandshakeEvent(
      secretKey,
      'sender-pubkey',
      'transfer-id',
      'claim',
      await sealHandshakePayload(sealKey, payload),
      pakeMessage,
    );

    const parsed = parseHandshakeEvent(event);
    expect(parsed).toMatchObject({
      recipientPubkey: 'sender-pubkey',
      transferId: 'transfer-id',
      type: 'claim',
    });
    expect(parsed?.pakeMessage).toEqual(pakeMessage);

    const opened = await openHandshakePayload(
      sealKey,
      parsed?.sealedPayload ?? new Uint8Array(),
    );
    expect(opened).toEqual(payload);
  });

  it('confirm events carry no PAKE element', async () => {
    const { secretKey } = generateEphemeralKeys();
    const sealKey = await generateAesKey();
    const event = createHandshakeEvent(
      secretKey,
      'receiver-pubkey',
      'transfer-id',
      'confirm',
      await sealHandshakePayload(sealKey, { type: 'confirm' }),
    );
    const parsed = parseHandshakeEvent(event);
    expect(parsed?.type).toBe('confirm');
    expect(parsed?.pakeMessage).toBeNull();
  });

  it('rejects handshake payloads sealed with a different session key', async () => {
    const { secretKey } = generateEphemeralKeys();
    const rightKey = await generateAesKey();
    const wrongKey = await generateAesKey();

    const event = createHandshakeEvent(
      secretKey,
      'sender-pubkey',
      'transfer-id',
      'confirm',
      await sealHandshakePayload(rightKey, { type: 'confirm' }),
    );
    const parsed = parseHandshakeEvent(event);
    expect(parsed?.type).toBe('confirm');

    await expect(
      openHandshakePayload(wrongKey, parsed?.sealedPayload ?? new Uint8Array()),
    ).rejects.toThrow();
  });

  it('does not parse signaling events as handshakes', () => {
    const { secretKey } = generateEphemeralKeys();
    const event = createHandshakeEvent(
      secretKey,
      'pk',
      'transfer-id',
      'claim',
      new Uint8Array([1]),
    );
    const tampered = {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === 'type' ? ['type', 'signal'] : tag,
      ),
    };
    expect(parseHandshakeEvent(tampered)).toBeNull();
  });
});
