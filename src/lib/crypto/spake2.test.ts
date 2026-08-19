import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './aes-gcm';
import { deriveHandshakeSealKeys } from './kdf';
import { generatePin } from './pin';
import {
  derivePakeSecret,
  finishPake,
  isValidPakeMessage,
  PAKE_MESSAGE_LENGTH,
  type PakeIdentities,
  startPake,
} from './spake2';

const IDENTITIES: PakeIdentities = {
  transferId: 'a1b2c3d4e5f60718',
  senderPubkey: 'a'.repeat(64),
  receiverPubkey: 'b'.repeat(64),
};

/** Run a full two-sided SPAKE2 exchange and return both root keys. */
async function runExchange(
  senderSecret: Uint8Array,
  receiverSecret: Uint8Array,
  senderIdentities: PakeIdentities = IDENTITIES,
  receiverIdentities: PakeIdentities = senderIdentities,
): Promise<{ senderRoot: CryptoKey; receiverRoot: CryptoKey }> {
  const sender = startPake('sender', senderSecret);
  const receiver = startPake('receiver', receiverSecret);

  const [senderRoot, receiverRoot] = await Promise.all([
    finishPake(
      'sender',
      sender.secret,
      senderSecret,
      sender.message,
      receiver.message,
      senderIdentities,
    ),
    finishPake(
      'receiver',
      receiver.secret,
      receiverSecret,
      receiver.message,
      sender.message,
      receiverIdentities,
    ),
  ]);
  return { senderRoot, receiverRoot };
}

/**
 * Root keys are non-extractable, so equality is checked behaviorally: seal
 * under a key derived from one root and open under the other's counterpart.
 */
async function rootsAgree(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const salt = new Uint8Array(16).fill(3);
  const aKeys = await deriveHandshakeSealKeys(a, salt);
  const bKeys = await deriveHandshakeSealKeys(b, salt);
  const sealed = await encrypt(
    aKeys.claimKey,
    new TextEncoder().encode('proof'),
  );
  try {
    const opened = await decrypt(bKeys.claimKey, sealed);
    return new TextDecoder().decode(opened) === 'proof';
  } catch {
    return false;
  }
}

describe('SPAKE2 PIN handshake', () => {
  it('derives a valid nonzero reduced scalar from a PIN', async () => {
    const secret = await derivePakeSecret(generatePin());
    expect(secret).toHaveLength(32);
    expect(secret.some((b) => b !== 0)).toBe(true);
    // Deterministic across the two peers entering the same PIN.
    const again = await derivePakeSecret('AbCDefG2');
    expect(await derivePakeSecret('AbCDefG2')).toEqual(again);
  });

  it('both peers derive the same root key from the same PIN', async () => {
    const secret = await derivePakeSecret(generatePin());
    const { senderRoot, receiverRoot } = await runExchange(secret, secret);
    for (const key of [senderRoot, receiverRoot]) {
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe('HKDF');
    }
    expect(await rootsAgree(senderRoot, receiverRoot)).toBe(true);
  });

  it('published elements are single-use: two runs of the same PIN differ', async () => {
    const secret = await derivePakeSecret(generatePin());
    const first = startPake('sender', secret);
    const second = startPake('sender', secret);
    expect(first.message).not.toEqual(second.message);
  });

  it('a wrong PIN lands on a different root key', async () => {
    // This is the online-guess property: nothing throws, the keys simply
    // disagree, and the mismatch surfaces when a seal fails to open.
    const pin = generatePin();
    let otherPin = generatePin();
    while (otherPin === pin) otherPin = generatePin();

    const { senderRoot, receiverRoot } = await runExchange(
      await derivePakeSecret(pin),
      await derivePakeSecret(otherPin),
    );
    expect(await rootsAgree(senderRoot, receiverRoot)).toBe(false);
  });

  it('the root key is bound to the transfer id and both identities', async () => {
    const secret = await derivePakeSecret(generatePin());

    for (const changed of [
      { ...IDENTITIES, transferId: '0000000000000000' },
      { ...IDENTITIES, senderPubkey: 'c'.repeat(64) },
      { ...IDENTITIES, receiverPubkey: 'd'.repeat(64) },
    ]) {
      const { senderRoot, receiverRoot } = await runExchange(
        secret,
        secret,
        IDENTITIES,
        changed,
      );
      expect(await rootsAgree(senderRoot, receiverRoot)).toBe(false);
    }
  });

  it('rejects malformed and invalid peer elements', async () => {
    const secret = await derivePakeSecret(generatePin());
    const { secret: ephemeral, message } = startPake('sender', secret);

    const finishWith = (peer: Uint8Array) =>
      finishPake('sender', ephemeral, secret, message, peer, IDENTITIES);

    // Wrong length
    await expect(finishWith(new Uint8Array(32))).rejects.toThrow();
    // Right length, not a curve point
    const junk = new Uint8Array(PAKE_MESSAGE_LENGTH).fill(0xff);
    junk[0] = 0x02;
    await expect(finishWith(junk)).rejects.toThrow();
  });

  it('isValidPakeMessage screens wire elements', async () => {
    const secret = await derivePakeSecret(generatePin());
    const { message } = startPake('receiver', secret);
    expect(isValidPakeMessage(message)).toBe(true);
    expect(isValidPakeMessage(message.slice(1))).toBe(false);
    const junk = new Uint8Array(PAKE_MESSAGE_LENGTH).fill(0xff);
    junk[0] = 0x03;
    expect(isValidPakeMessage(junk)).toBe(false);
  });

  it('a tampered element breaks agreement even under the right PIN', async () => {
    // A relay that swaps an element for its own (without the PIN) must not
    // end up sharing a key with either side.
    const secret = await derivePakeSecret(generatePin());
    const attackerSecret = await derivePakeSecret(generatePin());

    const sender = startPake('sender', secret);
    const receiver = startPake('receiver', secret);
    const attacker = startPake('receiver', attackerSecret);

    const senderRoot = await finishPake(
      'sender',
      sender.secret,
      secret,
      sender.message,
      attacker.message, // substituted by the relay
      IDENTITIES,
    );
    const receiverRoot = await finishPake(
      'receiver',
      receiver.secret,
      secret,
      receiver.message,
      sender.message,
      IDENTITIES,
    );
    expect(await rootsAgree(senderRoot, receiverRoot)).toBe(false);
  });
});
