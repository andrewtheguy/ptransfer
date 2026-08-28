import { describe, expect, it } from 'vitest';
import {
  deriveSharedSecretKey,
  generateECDHKeyPair,
  generateSalt,
} from '@/lib/crypto';
import { deriveRelaySession } from '@/lib/nostr-file/session';
import { deriveOnionPassword, parseOnionAnnouncement } from './code-relay';

/** A shared secret as the two sides of a Code Exchange arrive at it. */
async function agreedSecret(): Promise<CryptoKey> {
  const sender = await generateECDHKeyPair();
  const receiver = await generateECDHKeyPair();
  return deriveSharedSecretKey(sender.privateKey, receiver.publicKeyBytes);
}

// A real v3 address, so the checksum in it verifies: the Tor Project's own.
const ONION = '2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion';

describe('deriveOnionPassword', () => {
  it('is the same on both sides and never travels', async () => {
    const secret = await agreedSecret();
    const salt = generateSalt();
    expect(await deriveOnionPassword(secret, salt)).toBe(
      await deriveOnionPassword(secret, salt),
    );
  });

  it('changes with the salt, so one exchange never reuses another password', async () => {
    const secret = await agreedSecret();
    expect(await deriveOnionPassword(secret, generateSalt())).not.toBe(
      await deriveOnionPassword(secret, generateSalt()),
    );
  });

  it('is independent of the relay session the same secret produces', async () => {
    const secret = await agreedSecret();
    const salt = generateSalt();
    const password = await deriveOnionPassword(secret, salt);
    const session = await deriveRelaySession(secret, salt);
    // The three outputs of one secret — password, transfer id, file key — are
    // separate HKDF labels: holding one must say nothing about the others.
    expect(password).not.toContain(session.transferId);
    expect(password).not.toBe(
      Array.from(session.keyBytes, (b) => String.fromCharCode(b)).join(''),
    );
  });

  it('is key material rather than something to type', async () => {
    const password = await deriveOnionPassword(
      await agreedSecret(),
      generateSalt(),
    );
    // 32 bytes of base64. The Tor handshake takes an opaque string, so the
    // online-guessing bounds a human-length password needs do not apply.
    expect(password).toHaveLength(44);
  });
});

describe('parseOnionAnnouncement', () => {
  it('accepts the sender announcement and keeps the bound spelling', () => {
    const address = parseOnionAnnouncement({
      t: 'onion',
      onion: `${ONION}:9735`,
    });
    expect(address?.host).toBe(ONION);
    expect(address?.port).toBe(9735);
    // What both peers bind their SPAKE2 transcript to, port and all.
    expect(address?.onion).toBe(`${ONION}:9735`);
  });

  it('refuses anything that is not one', () => {
    for (const value of [
      null,
      'onion',
      { t: 'hello' },
      { t: 'onion' },
      { t: 'onion', onion: 42 },
      // A wrong checksum is a corrupt address, not a service to build a
      // rendezvous circuit for.
      { t: 'onion', onion: `${'a'.repeat(56)}.onion:9735` },
      { t: 'onion', onion: 'example.com:9735' },
      { t: 'onion', onion: `${ONION}:${'9'.repeat(120)}` },
    ]) {
      expect(parseOnionAnnouncement(value)).toBeNull();
    }
  });
});
