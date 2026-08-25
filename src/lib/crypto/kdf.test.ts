import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './aes-gcm';
import {
  ANSWER_CONFIRMATION_BYTES,
  CONFIRMATION_CODE_LENGTH,
} from './constants';
import { deriveSharedSecretKey, generateECDHKeyPair } from './ecdh';
import {
  type ConfirmationCodeBinding,
  deriveAnswerConfirmation,
  deriveConfirmationCode,
  deriveHandshakeSealKeys,
  derivePinSessionKeys,
  generateSalt,
} from './kdf';
import { generatePin } from './pin';
import { derivePakeSecret, finishPake, startPake } from './spake2';

const IDENTITIES = {
  transferId: 'a1b2c3d4e5f60718',
  senderPubkey: 'a'.repeat(64),
  receiverPubkey: 'b'.repeat(64),
};

/** Complete a SPAKE2 exchange with a shared PIN; both sides' root keys. */
async function pakeRoots(): Promise<{
  sender: CryptoKey;
  receiver: CryptoKey;
}> {
  const secret = await derivePakeSecret(generatePin());
  const a = startPake('sender', secret);
  const b = startPake('receiver', secret);
  const [sender, receiver] = await Promise.all([
    finishPake('sender', a.secret, secret, a.message, b.message, IDENTITIES),
    finishPake('receiver', b.secret, secret, b.message, a.message, IDENTITIES),
  ]);
  return { sender, receiver };
}

describe('Nostr session KDF', () => {
  it('derives non-extractable session keys that are not interchangeable', async () => {
    const { sender } = await pakeRoots();
    const keys = await derivePinSessionKeys(sender, generateSalt());

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

  it('both PAKE peers derive the same session keys', async () => {
    const { sender, receiver } = await pakeRoots();
    const salt = generateSalt();

    const senderKeys = await derivePinSessionKeys(sender, salt);
    const receiverKeys = await derivePinSessionKeys(receiver, salt);

    const plaintext = new TextEncoder().encode('cross-peer check');
    const encrypted = await encrypt(senderKeys.content, plaintext);
    await expect(decrypt(receiverKeys.content, encrypted)).resolves.toEqual(
      plaintext,
    );
  });

  it('claim and confirm seal keys are distinct and shared across peers', async () => {
    const { sender, receiver } = await pakeRoots();
    const salt = generateSalt();

    const senderSeals = await deriveHandshakeSealKeys(sender, salt);
    const receiverSeals = await deriveHandshakeSealKeys(receiver, salt);

    const plaintext = new TextEncoder().encode('claim body');
    const sealed = await encrypt(receiverSeals.claimKey, plaintext);
    // The sender opens the receiver's claim with its own derived claim key…
    await expect(decrypt(senderSeals.claimKey, sealed)).resolves.toEqual(
      plaintext,
    );
    // …and a claim can never be reflected back as a confirm.
    await expect(decrypt(senderSeals.confirmKey, sealed)).rejects.toThrow();
  });
});

describe('Confirmation code', () => {
  const binding: ConfirmationCodeBinding = {
    transferId: 'a1b2c3d4e5f60718',
    senderNonce: 'c2VuZGVyLW5vbmNlLTAwMDAwMDA=',
    receiverNonce: 'cmVjZWl2ZXItbm9uY2UtMDAwMDA=',
    transcriptHash: 'f'.repeat(64),
    metadataHash: 'e'.repeat(64),
  };

  it('both PAKE peers derive the same code', async () => {
    const { sender, receiver } = await pakeRoots();
    const salt = generateSalt();

    const senderCode = await deriveConfirmationCode(sender, salt, binding);
    const receiverCode = await deriveConfirmationCode(receiver, salt, binding);

    expect(senderCode).toBe(receiverCode);
    expect(senderCode).toHaveLength(CONFIRMATION_CODE_LENGTH);
    expect(senderCode).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('a different PAKE session yields a different code', async () => {
    // This is what stops a front-runner: they ran their own SPAKE2 session,
    // so the code their browser shows is not the one the sender is expecting.
    const { sender } = await pakeRoots();
    const { receiver: attacker } = await pakeRoots();
    const salt = generateSalt();

    const forReceiver = await deriveConfirmationCode(sender, salt, binding);
    const forAttacker = await deriveConfirmationCode(attacker, salt, binding);

    expect(forAttacker).not.toBe(forReceiver);
  });

  it('the code is bound to every handshake value', async () => {
    const { sender } = await pakeRoots();
    const salt = generateSalt();

    const base = await deriveConfirmationCode(sender, salt, binding);

    for (const changed of [
      { ...binding, transferId: '0000000000000000' },
      { ...binding, senderNonce: 'b3RoZXItc2VuZGVyLW5vbmNlLTA=' },
      { ...binding, receiverNonce: 'b3RoZXItcmVjZWl2ZXItbm9uY2U=' },
      // A republished rendezvous with any altered field.
      { ...binding, transcriptHash: `${'f'.repeat(63)}e` },
      // Substituted file metadata, which travels post-handshake and is bound
      // through its own digest.
      { ...binding, metadataHash: `${'e'.repeat(63)}f` },
    ]) {
      expect(await deriveConfirmationCode(sender, salt, changed)).not.toBe(
        base,
      );
    }

    // A different transfer salt separates it too.
    expect(
      await deriveConfirmationCode(sender, generateSalt(), binding),
    ).not.toBe(base);
  });

  it('rejects a salt shorter than the transfer salt', async () => {
    const { sender } = await pakeRoots();
    await expect(
      deriveConfirmationCode(sender, new Uint8Array(8), binding),
    ).rejects.toThrow(/Salt too short/);
  });
});

describe('Code Exchange answer confirmation', () => {
  const binding = {
    offerTranscriptHash: 'a'.repeat(64),
    answerTranscriptHash: 'b'.repeat(64),
  };

  /** The shared secret both sides of a Code Exchange reach. */
  async function ecdhSecret(): Promise<CryptoKey> {
    const [a, b] = await Promise.all([
      generateECDHKeyPair(),
      generateECDHKeyPair(),
    ]);
    return deriveSharedSecretKey(a.privateKey, b.publicKeyBytes);
  }

  it('derives a fixed-width tag, stable for one secret and transcript', async () => {
    const secret = await ecdhSecret();
    const salt = generateSalt();

    const first = await deriveAnswerConfirmation(secret, salt, binding);
    const second = await deriveAnswerConfirmation(secret, salt, binding);

    expect(first).toHaveLength(ANSWER_CONFIRMATION_BYTES);
    expect(first).toEqual(second);
  });

  it('separates both transcripts, salts, and shared secrets', async () => {
    const secret = await ecdhSecret();
    const salt = generateSalt();
    const base = await deriveAnswerConfirmation(secret, salt, binding);

    expect(
      await deriveAnswerConfirmation(secret, salt, {
        ...binding,
        offerTranscriptHash: 'c'.repeat(64),
      }),
    ).not.toEqual(base);
    expect(
      await deriveAnswerConfirmation(secret, salt, {
        ...binding,
        answerTranscriptHash: 'c'.repeat(64),
      }),
    ).not.toEqual(base);
    // The two halves are not interchangeable: swapping them is a different
    // binding, not the same one read the other way round.
    expect(
      await deriveAnswerConfirmation(secret, salt, {
        offerTranscriptHash: binding.answerTranscriptHash,
        answerTranscriptHash: binding.offerTranscriptHash,
      }),
    ).not.toEqual(base);
    expect(
      await deriveAnswerConfirmation(secret, generateSalt(), binding),
    ).not.toEqual(base);
    expect(
      await deriveAnswerConfirmation(await ecdhSecret(), salt, binding),
    ).not.toEqual(base);
  });

  it('rejects a salt below the minimum width', async () => {
    await expect(
      deriveAnswerConfirmation(await ecdhSecret(), new Uint8Array(8), binding),
    ).rejects.toThrow(/Salt too short/);
  });
});
