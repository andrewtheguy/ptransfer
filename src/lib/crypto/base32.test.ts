import { describe, expect, test } from 'vitest';
import { encodeCrockfordBase32, normalizeCrockfordBase32 } from './base32';
import { CONFIRMATION_CODE_BYTES, CONFIRMATION_CODE_LENGTH } from './constants';

describe('Crockford Base32', () => {
  test('encodes confirmation-code-sized input to exactly the display length', () => {
    const bytes = new Uint8Array(CONFIRMATION_CODE_BYTES).fill(0xab);
    const encoded = encodeCrockfordBase32(bytes);
    expect(encoded).toHaveLength(CONFIRMATION_CODE_LENGTH);
    expect(encoded).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  test('encodes known vectors most-significant bit first', () => {
    expect(encodeCrockfordBase32(new Uint8Array([0x00]))).toBe('00');
    expect(encodeCrockfordBase32(new Uint8Array([0xff]))).toBe('ZW');
    // 0x00 0x44 0x32 = 00000000 01000100 00110010
    //              -> 00000 00001 00010 00011 00100 -> 0, 1, 2, 3, 4
    expect(encodeCrockfordBase32(new Uint8Array([0x00, 0x44, 0x32]))).toBe(
      '01234',
    );
  });

  test('encodes the empty input as the empty string', () => {
    expect(encodeCrockfordBase32(new Uint8Array(0))).toBe('');
  });

  test('distinct inputs encode distinctly', () => {
    const a = encodeCrockfordBase32(new Uint8Array([1, 2, 3, 4, 5]));
    const b = encodeCrockfordBase32(new Uint8Array([1, 2, 3, 4, 6]));
    expect(a).not.toBe(b);
  });

  test('normalization folds the letters people confuse when reading aloud', () => {
    // I, L, and O are absent from the alphabet precisely so they can be read
    // back as the digits they resemble.
    expect(normalizeCrockfordBase32('IiLlOo')).toBe('111100');
  });

  test('normalization uppercases and drops transcription separators', () => {
    expect(normalizeCrockfordBase32('a4bc-d9zt')).toBe('A4BCD9ZT');
    expect(normalizeCrockfordBase32(' A4BC D9ZT \n')).toBe('A4BCD9ZT');
  });

  test('normalization discards characters outside the alphabet', () => {
    expect(normalizeCrockfordBase32('A4?B*C%9')).toBe('A4BC9');
    expect(normalizeCrockfordBase32('U')).toBe('');
  });

  test('an encoded value survives a round trip through normalization', () => {
    const encoded = encodeCrockfordBase32(new Uint8Array([9, 8, 7, 6, 5]));
    expect(normalizeCrockfordBase32(encoded)).toBe(encoded);
    expect(normalizeCrockfordBase32(encoded.toLowerCase())).toBe(encoded);
    expect(
      normalizeCrockfordBase32(`${encoded.slice(0, 4)}-${encoded.slice(4)}`),
    ).toBe(encoded);
  });
});
