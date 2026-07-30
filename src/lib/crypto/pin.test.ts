import { describe, expect, test } from 'vitest';
import {
  PIN_CHARSET,
  PIN_FINGERPRINT_LENGTH,
  PIN_HINT_LENGTH,
  PIN_LENGTH,
  PIN_ROTATION_MS,
} from './constants';
import {
  computePinFingerprint,
  computePinHintFromRoot,
  derivePinAuthKey,
  derivePinRendezvousKey,
  generatePin,
  getPinBucket,
  importPinRoot,
  isPinBucketActive,
  isValidPin,
} from './pin';

describe('PIN Utilities', () => {
  test('generatePin produces a valid PIN from the configured charset', () => {
    const pin = generatePin();
    expect(pin).toHaveLength(PIN_LENGTH);
    expect([...pin].every((char) => PIN_CHARSET.includes(char))).toBe(true);
    expect(isValidPin(pin)).toBe(true);
  });

  test('checksum rejects a changed data character', () => {
    const pin = generatePin();
    const replacement =
      PIN_CHARSET[(PIN_CHARSET.indexOf(pin[0]) + 1) % PIN_CHARSET.length];
    expect(isValidPin(replacement + pin.slice(1))).toBe(false);
  });

  test('checksum detects a typical adjacent transposition', () => {
    const data = 'ABCDEFGHJKL';
    const pin = data + computeChecksumForTest(data);
    expect(isValidPin(pin)).toBe(true);
    const swapped = `BA${pin.slice(2)}`;
    expect(isValidPin(swapped)).toBe(false);
  });

  test('PIN validation is case sensitive', () => {
    const data = 'AbCDefGHJKL';
    const pin = data + computeChecksumForTest(data);
    expect(isValidPin(pin)).toBe(true);
    expect(isValidPin(pin.toUpperCase())).toBe(false);
  });

  test('importPinRoot returns a non-extractable HKDF key', async () => {
    const root = await importPinRoot(generatePin());
    expect(root.extractable).toBe(false);
    expect(root.algorithm.name).toBe('HKDF');
  });

  test('hint is deterministic per bucket and differs across buckets and PINs', async () => {
    const pin = generatePin();
    const root = await importPinRoot(pin);

    const currentBucket = getPinBucket();
    const current = await computePinHintFromRoot(root, currentBucket);
    expect(current).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`));
    expect(await computePinHintFromRoot(root, currentBucket)).toBe(current);

    const previous = await computePinHintFromRoot(root, currentBucket - 1);
    expect(previous).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`));
    expect(previous).not.toBe(current);

    const otherRoot = await importPinRoot(generatePin());
    expect(await computePinHintFromRoot(otherRoot, currentBucket)).not.toBe(
      current,
    );
  });

  test('only the current and previous PIN buckets are active', () => {
    const now = 10 * PIN_ROTATION_MS + 1;
    expect(isPinBucketActive(10, now)).toBe(true);
    expect(isPinBucketActive(9, now)).toBe(true);
    expect(isPinBucketActive(8, now)).toBe(false);
    expect(isPinBucketActive(11, now)).toBe(false);
  });

  test('fingerprint is stable and domain-separated from the hint', async () => {
    const pin = generatePin();
    const fp = await computePinFingerprint(pin);
    expect(fp).toMatch(new RegExp(`^[0-9a-f]{${PIN_FINGERPRINT_LENGTH}}$`));
    expect(await computePinFingerprint(pin)).toBe(fp);
    const root = await importPinRoot(pin);
    expect(fp).not.toBe(await computePinHintFromRoot(root, getPinBucket()));
  });

  test('fingerprint matches the cross-implementation vector', async () => {
    // Parity with secure-send-cli's pin_fingerprint (PBKDF2-SHA-256, 1k
    // iterations, salt "secure-send:pin-fingerprint:v2"), verified
    // independently.
    expect(await computePinFingerprint('A/B:C;D(E)F')).toBe('2e700e579152');
  });

  test('auth and rendezvous keys are distinct non-extractable AES keys', async () => {
    const root = await importPinRoot(generatePin());
    const authKey = await derivePinAuthKey(root);
    const rendezvousKey = await derivePinRendezvousKey(root);

    for (const key of [authKey, rendezvousKey]) {
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe('AES-GCM');
    }

    // Domain separation: a payload sealed with one key must not open with the other
    const plaintext = new TextEncoder().encode('payload');
    const { encrypt, decrypt } = await import('./aes-gcm');
    const sealed = await encrypt(authKey, plaintext);
    await expect(decrypt(rendezvousKey, sealed)).rejects.toThrow();
  });

  test('two peers derive identical values from the same PIN', async () => {
    const pin = generatePin();
    const senderRoot = await importPinRoot(pin);
    const receiverRoot = await importPinRoot(pin);

    const bucket = getPinBucket();
    expect(await computePinHintFromRoot(receiverRoot, bucket)).toBe(
      await computePinHintFromRoot(senderRoot, bucket),
    );
    const { encrypt, decrypt } = await import('./aes-gcm');
    const sealed = await encrypt(
      await derivePinAuthKey(senderRoot),
      new TextEncoder().encode('proof'),
    );
    const opened = await decrypt(await derivePinAuthKey(receiverRoot), sealed);
    expect(new TextDecoder().decode(opened)).toBe('proof');
  });
});

/** Mirror of the internal position-weighted checksum, for test vectors. */
function computeChecksumForTest(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += PIN_CHARSET.indexOf(data[i]) * (i + 1);
  }
  return PIN_CHARSET[sum % PIN_CHARSET.length];
}
