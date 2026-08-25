import { describe, expect, test } from 'vitest';
import { extractChunkParam } from './chunk-utils';
import { generatePin, PIN_CHARSET, PIN_LENGTH } from './crypto';
import { buildPinUrl, extractPinFromUrl } from './pin-link';

const ORIGIN = 'https://ptransfer.example';

/** Swap one character for a different one from the charset. */
function corrupt(pin: string): string {
  const replacement =
    PIN_CHARSET[(PIN_CHARSET.indexOf(pin[0]) + 1) % PIN_CHARSET.length];
  return replacement + pin.slice(1);
}

describe('PIN links', () => {
  test('round-trips a generated PIN', () => {
    const pin = generatePin();
    expect(extractPinFromUrl(buildPinUrl(ORIGIN, pin))).toBe(pin);
  });

  test('lands on the consolidated receive screen', () => {
    const url = new URL(buildPinUrl(ORIGIN, generatePin()));
    expect(url.pathname).toBe('/receive');
  });

  test('a trailing slash on the origin does not double up', () => {
    const pin = generatePin();
    expect(buildPinUrl(`${ORIGIN}/`, pin)).toBe(buildPinUrl(ORIGIN, pin));
  });

  test('rejects a PIN whose checksum does not hold', () => {
    const pin = generatePin();
    expect(extractPinFromUrl(buildPinUrl(ORIGIN, corrupt(pin)))).toBeNull();
  });

  test('rejects a truncated PIN rather than returning part of one', () => {
    const pin = generatePin();
    expect(
      extractPinFromUrl(`${ORIGIN}/receive#p=${pin.slice(0, 6)}`),
    ).toBeNull();
  });

  test('rejects other fragment shapes', () => {
    const pin = generatePin();
    expect(extractPinFromUrl(`${ORIGIN}/receive#${pin}`)).toBeNull();
    expect(extractPinFromUrl(`${ORIGIN}/receive?p=${pin}`)).toBeNull();
    expect(extractPinFromUrl(`${ORIGIN}/receive`)).toBeNull();
  });

  test('rejects input that is not a URL', () => {
    expect(extractPinFromUrl(generatePin())).toBeNull();
    expect(extractPinFromUrl('')).toBeNull();
    expect(extractPinFromUrl('not a url at all')).toBeNull();
  });

  // The `=` separator is what keeps the two QR vocabularies apart: a PIN link
  // must never look like an offer chunk to the Code Exchange parser.
  test('a PIN link is not a chunk URL', () => {
    expect(extractChunkParam(buildPinUrl(ORIGIN, generatePin()))).toBeNull();
  });

  test('a bare PIN would have collided without the separator', () => {
    const pin = generatePin();
    expect(pin).toHaveLength(PIN_LENGTH);
    expect(extractChunkParam(`${ORIGIN}/receive#${pin}`)).toBe(pin);
  });
});
