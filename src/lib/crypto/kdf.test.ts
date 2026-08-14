import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './aes-gcm';
import { CONFIRMATION_CODE_LENGTH } from './constants';
import { deriveSharedSecretKey, generateECDHKeyPair } from './ecdh';
import {
  type ConfirmationCodeBinding,
  deriveConfirmationCode,
  deriveNostrSessionKeys,
  generateSalt,
} from './kdf';

describe('Nostr session KDF', () => {
  it('derives non-extractable session keys that are not interchangeable', async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const shared = await deriveSharedSecretKey(
      alice.privateKey,
      bob.publicKeyBytes,
    );
    const keys = await deriveNostrSessionKeys(shared, generateSalt());

    for (const key of [keys.signals, keys.content]) {
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe('AES-GCM');
      expect(key.usages).toEqual(['encrypt', 'decrypt']);
    }

    const plaintext = new TextEncoder().encode('signal payload');
    const encrypted = await encrypt(keys.signals, plaintext);

    await expect(decrypt(keys.signals, encrypted)).resolves.toEqual(plaintext);
    await expect(decrypt(keys.content, encrypted)).rejects.toThrow();
  });

  it('both ECDH peers derive the same session keys', async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const salt = generateSalt();

    const aliceKeys = await deriveNostrSessionKeys(
      await deriveSharedSecretKey(alice.privateKey, bob.publicKeyBytes),
      salt,
    );
    const bobKeys = await deriveNostrSessionKeys(
      await deriveSharedSecretKey(bob.privateKey, alice.publicKeyBytes),
      salt,
    );

    const plaintext = new TextEncoder().encode('cross-peer check');
    const encrypted = await encrypt(aliceKeys.content, plaintext);
    await expect(decrypt(bobKeys.content, encrypted)).resolves.toEqual(
      plaintext,
    );
  });
});

describe('Confirmation code', () => {
  const binding: ConfirmationCodeBinding = {
    transferId: 'a1b2c3d4e5f60718',
    senderNonce: 'c2VuZGVyLW5vbmNlLTAwMDAwMDA=',
    receiverNonce: 'cmVjZWl2ZXItbm9uY2UtMDAwMDA=',
    transcriptHash: 'f'.repeat(64),
  };

  it('both ECDH peers derive the same code', async () => {
    const sender = await generateECDHKeyPair();
    const receiver = await generateECDHKeyPair();
    const salt = generateSalt();

    const senderCode = await deriveConfirmationCode(
      await deriveSharedSecretKey(sender.privateKey, receiver.publicKeyBytes),
      salt,
      binding,
    );
    const receiverCode = await deriveConfirmationCode(
      await deriveSharedSecretKey(receiver.privateKey, sender.publicKeyBytes),
      salt,
      binding,
    );

    expect(senderCode).toBe(receiverCode);
    expect(senderCode).toHaveLength(CONFIRMATION_CODE_LENGTH);
    expect(senderCode).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('a different peer key yields a different code', async () => {
    // This is what stops a front-runner: they hold a different ECDH key, so
    // the code their browser shows is not the one the sender is expecting.
    const sender = await generateECDHKeyPair();
    const receiver = await generateECDHKeyPair();
    const attacker = await generateECDHKeyPair();
    const salt = generateSalt();

    const forReceiver = await deriveConfirmationCode(
      await deriveSharedSecretKey(sender.privateKey, receiver.publicKeyBytes),
      salt,
      binding,
    );
    const forAttacker = await deriveConfirmationCode(
      await deriveSharedSecretKey(sender.privateKey, attacker.publicKeyBytes),
      salt,
      binding,
    );

    expect(forAttacker).not.toBe(forReceiver);
  });

  it('a substituted rendezvous transcript yields a different code', async () => {
    // The attack this closes: a live-PIN attacker republishes the rendezvous
    // with rewritten file metadata but passes both ECDH keys through untouched,
    // so the shared secret — and every other binding value — is unchanged.
    // Only the transcript differs, and it has to be enough on its own.
    const sender = await generateECDHKeyPair();
    const receiver = await generateECDHKeyPair();
    const salt = generateSalt();
    const shared = await deriveSharedSecretKey(
      sender.privateKey,
      receiver.publicKeyBytes,
    );

    const honest = await deriveConfirmationCode(shared, salt, binding);
    const tampered = await deriveConfirmationCode(shared, salt, {
      ...binding,
      transcriptHash: `${'f'.repeat(63)}e`,
    });

    expect(tampered).not.toBe(honest);
  });

  it('the code is bound to the transfer id and both nonces', async () => {
    const sender = await generateECDHKeyPair();
    const receiver = await generateECDHKeyPair();
    const salt = generateSalt();
    const shared = await deriveSharedSecretKey(
      sender.privateKey,
      receiver.publicKeyBytes,
    );

    const base = await deriveConfirmationCode(shared, salt, binding);

    for (const changed of [
      { ...binding, transferId: '0000000000000000' },
      { ...binding, senderNonce: 'b3RoZXItc2VuZGVyLW5vbmNlLTA=' },
      { ...binding, receiverNonce: 'b3RoZXItcmVjZWl2ZXItbm9uY2U=' },
    ]) {
      expect(await deriveConfirmationCode(shared, salt, changed)).not.toBe(
        base,
      );
    }

    // A different transfer salt separates it too.
    expect(
      await deriveConfirmationCode(shared, generateSalt(), binding),
    ).not.toBe(base);
  });

  it('rejects a salt shorter than the transfer salt', async () => {
    const sender = await generateECDHKeyPair();
    const receiver = await generateECDHKeyPair();
    const shared = await deriveSharedSecretKey(
      sender.privateKey,
      receiver.publicKeyBytes,
    );

    await expect(
      deriveConfirmationCode(shared, new Uint8Array(8), binding),
    ).rejects.toThrow(/Salt too short/);
  });
});
