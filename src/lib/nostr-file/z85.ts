// Z85 (ZeroMQ base85) with partial final blocks, used for event content:
// ~1.25x expansion vs base64's ~1.33x, and the alphabet contains no
// characters JSON needs to escape.

const Z85_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';

const Z85_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < Z85_ALPHABET.length; i++) {
    table[Z85_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Encode arbitrary-length bytes as Z85. A trailing group of r bytes (1-3) is
 * zero-padded to 4, encoded, and truncated to r+1 characters (the Ascii85
 * partial-block scheme applied to the Z85 alphabet).
 */
export function encodeZ85(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const remaining = Math.min(4, data.length - i);
    let value = 0;
    for (let j = 0; j < 4; j++) {
      value = value * 256 + (j < remaining ? data[i + j] : 0);
    }
    let digits = '';
    for (let j = 0; j < 5; j++) {
      digits = Z85_ALPHABET[value % 85] + digits;
      value = Math.floor(value / 85);
    }
    out += remaining === 4 ? digits : digits.slice(0, remaining + 1);
  }
  return out;
}

/**
 * Decode Z85 produced by encodeZ85. Throws on invalid characters or an
 * impossible trailing length (a lone final character cannot encode a byte).
 */
export function decodeZ85(text: string): Uint8Array {
  const remainder = text.length % 5;
  if (remainder === 1) {
    throw new Error('Invalid Z85 length');
  }
  const outLength =
    Math.floor(text.length / 5) * 4 + (remainder ? remainder - 1 : 0);
  const out = new Uint8Array(outLength);
  let outPos = 0;
  for (let i = 0; i < text.length; i += 5) {
    const groupLen = Math.min(5, text.length - i);
    let value = 0;
    for (let j = 0; j < 5; j++) {
      // Pad short trailing groups with the max digit (mirrors zero-byte
      // padding on encode).
      let digit = 84;
      if (j < groupLen) {
        const code = text.charCodeAt(i + j);
        digit = code < 128 ? Z85_DECODE_TABLE[code] : -1;
        if (digit < 0) {
          throw new Error('Invalid Z85 character');
        }
      }
      value = value * 85 + digit;
    }
    if (value > 0xffffffff) {
      throw new Error('Invalid Z85 group (overflow)');
    }
    const byteCount = groupLen === 5 ? 4 : groupLen - 1;
    for (let j = 0; j < byteCount; j++) {
      out[outPos++] = (value / 256 ** (3 - j)) & 0xff;
    }
  }
  return out;
}
