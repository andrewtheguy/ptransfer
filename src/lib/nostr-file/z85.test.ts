import { describe, expect, it } from 'vitest';
import { decodeZ85, encodeZ85 } from './z85';

describe('Z85 codec', () => {
  it('round-trips the ZeroMQ reference vector', () => {
    // https://rfc.zeromq.org/spec/32/ "HelloWorld" test case
    const bytes = new Uint8Array([
      0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b,
    ]);
    expect(encodeZ85(bytes)).toBe('HelloWorld');
    expect(decodeZ85('HelloWorld')).toEqual(bytes);
  });

  it('round-trips all lengths 0..64', () => {
    for (let len = 0; len <= 64; len++) {
      const data = crypto.getRandomValues(new Uint8Array(len));
      const encoded = encodeZ85(data);
      // 5 chars per 4 bytes, r+1 chars for a trailing group of r bytes
      const expectedLen =
        Math.floor(len / 4) * 5 + (len % 4 ? (len % 4) + 1 : 0);
      expect(encoded.length).toBe(expectedLen);
      expect(decodeZ85(encoded)).toEqual(data);
    }
  });

  it('produces JSON-escape-free output', () => {
    const data = crypto.getRandomValues(new Uint8Array(4096));
    const encoded = encodeZ85(data);
    expect(JSON.stringify(encoded)).toBe(`"${encoded}"`);
  });

  it('rejects invalid characters and impossible lengths', () => {
    expect(() => decodeZ85('abc~e')).toThrow();
    expect(() => decodeZ85('a')).toThrow(); // lone trailing char
    expect(() => decodeZ85('#####')).toThrow(); // > 2^32 - 1
  });

  it('is ~1.25x expansion (smaller than base64)', () => {
    const data = new Uint8Array(32768);
    expect(encodeZ85(data).length).toBe(40960);
  });
});
