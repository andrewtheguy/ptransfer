import { describe, expect, test } from 'vitest';
import {
  PIN_CHARSET,
  PIN_HINT_LENGTH,
  PIN_LENGTH,
  PIN_LOCATOR_LENGTH,
  PIN_ROTATION_MS,
} from './constants';
import {
  computePinHintFromLocator,
  generatePin,
  getPinBucket,
  getPinLocator,
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

  test('the charset carries no symbols or ambiguous characters', () => {
    expect(PIN_CHARSET).toHaveLength(55);
    expect(PIN_CHARSET).toMatch(/^[A-Za-z2-9]+$/);
    for (const ambiguous of ['0', '1', 'I', 'O', 'i', 'l', 'o']) {
      expect(PIN_CHARSET.includes(ambiguous)).toBe(false);
    }
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
    const data = 'AbCDefGhjkm';
    const pin = data + computeChecksumForTest(data);
    expect(isValidPin(pin)).toBe(true);
    expect(isValidPin(pin.toUpperCase())).toBe(false);
  });

  test('getPinLocator returns the leading locator segment', () => {
    const pin = generatePin();
    const locator = getPinLocator(pin);
    expect(locator).toHaveLength(PIN_LOCATOR_LENGTH);
    expect(pin.startsWith(locator)).toBe(true);
  });

  test('hint is deterministic per bucket and differs across buckets and locators', async () => {
    const locator = getPinLocator(generatePin());

    const currentBucket = getPinBucket();
    const current = await computePinHintFromLocator(locator, currentBucket);
    expect(current).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`));
    expect(await computePinHintFromLocator(locator, currentBucket)).toBe(
      current,
    );

    const previous = await computePinHintFromLocator(
      locator,
      currentBucket - 1,
    );
    expect(previous).toMatch(new RegExp(`^[0-9a-f]{${PIN_HINT_LENGTH}}$`));
    expect(previous).not.toBe(current);

    let otherLocator = getPinLocator(generatePin());
    while (otherLocator === locator)
      otherLocator = getPinLocator(generatePin());
    expect(
      await computePinHintFromLocator(otherLocator, currentBucket),
    ).not.toBe(current);
  });

  test('hint depends only on the locator, not the rest of the PIN', async () => {
    // The property the whole split rests on: the published tag is a function of
    // the public locator alone, so it cannot confirm a guess at the secret
    // characters. Two PINs sharing a locator are indistinguishable by hint.
    const bucket = getPinBucket();
    const first = generatePin();
    const locator = getPinLocator(first);

    let second = generatePin();
    while (second === first) second = generatePin();
    const shared = locator + second.slice(PIN_LOCATOR_LENGTH);

    expect(shared).not.toBe(first);
    expect(await computePinHintFromLocator(getPinLocator(shared), bucket)).toBe(
      await computePinHintFromLocator(locator, bucket),
    );
  });

  test('only the current and previous PIN buckets are active', () => {
    const now = 10 * PIN_ROTATION_MS + 1;
    expect(isPinBucketActive(10, now)).toBe(true);
    expect(isPinBucketActive(9, now)).toBe(true);
    expect(isPinBucketActive(8, now)).toBe(false);
    expect(isPinBucketActive(11, now)).toBe(false);
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
