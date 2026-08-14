/**
 * Crockford Base32 — the encoding used for the confirmation code.
 *
 * The alphabet omits I, L, O, and U: the first three because they are the
 * characters people confuse with 1 and 0 when reading a code aloud, and U so
 * that no accidental word forms. Decoding is deliberately forgiving in exactly
 * those places, which is what makes the code safe to dictate over a phone call.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encode bytes as Crockford Base32, most-significant bit first.
 *
 * Output length is ceil(bytes.length * 8 / 5) characters. No padding is
 * emitted: the confirmation code is a fixed-width value both sides derive
 * independently, never a parsed container.
 */
export function encodeCrockfordBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(buffer >> bits) & 0x1f];
    }
  }

  // Left-align the trailing partial group, matching the standard.
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }

  return out;
}

/**
 * Normalize a hand-typed Crockford Base32 string for comparison.
 *
 * Uppercases, drops the separators people insert while transcribing (spaces
 * and hyphens), folds the ambiguous letters onto their digits (I/L -> 1,
 * O -> 0), and discards anything still outside the alphabet. Two codes are
 * equal when their normalized forms are.
 */
export function normalizeCrockfordBase32(input: string): string {
  let out = '';

  for (const char of input.toUpperCase()) {
    if (char === ' ' || char === '-' || char === '\t' || char === '\n')
      continue;
    if (char === 'I' || char === 'L') {
      out += '1';
      continue;
    }
    if (char === 'O') {
      out += '0';
      continue;
    }
    if (CROCKFORD_ALPHABET.includes(char)) out += char;
  }

  return out;
}
