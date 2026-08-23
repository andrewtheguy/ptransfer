import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  assembleChunks,
  chunkAad,
  compressPayload,
  decodeChunkContent,
  decompressPayload,
  encodeChunkContent,
  sha256,
  splitIntoChunks,
} from './codec';

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('compressPayload / decompressPayload', () => {
  it('deflates a single-file payload as a whole and round-trips it', () => {
    const data = new TextEncoder().encode('hello world '.repeat(10_000));
    const { payload, compression } = compressPayload(data, false);
    expect(compression).toBe('deflate');
    expect(payload.length).toBeLessThan(data.length);
    expect(decompressPayload(payload, compression, data.length)).toEqual(data);
  });

  it('deflates an incompressible single-file payload too, and round-trips it', () => {
    const data = crypto.getRandomValues(new Uint8Array(65536));
    const { payload, compression } = compressPayload(data, false);
    expect(compression).toBe('deflate');
    expect(decompressPayload(payload, compression, data.length)).toEqual(data);
  });

  it('never recompresses a precompressed payload (multi-file/folder ZIP flow)', () => {
    const data = new TextEncoder().encode('hello world '.repeat(10_000));
    const { payload, compression } = compressPayload(data, true);
    expect(compression).toBe('none');
    expect(payload).toBe(data);
    expect(decompressPayload(payload, compression, data.length)).toBe(data);
  });

  it('rejects a size mismatch in either mode (decompression-bomb guard)', () => {
    const data = new Uint8Array(10_000).fill(97);
    const deflated = deflateSync(data);
    // Claimed plaintext smaller than the real inflate output.
    expect(() => decompressPayload(deflated, 'deflate', 9_999)).toThrow();
    expect(() => decompressPayload(deflated, 'deflate', 100)).toThrow();
    // Claimed plaintext larger than the real inflate output.
    expect(() => decompressPayload(deflated, 'deflate', 10_001)).toThrow();
    expect(() => decompressPayload(data, 'none', 9_999)).toThrow();
    expect(decompressPayload(deflated, 'deflate', 10_000)).toEqual(data);
  });
});

describe('splitIntoChunks / assembleChunks', () => {
  it('round-trips exact and partial chunk sizes', () => {
    for (const size of [1, 999, 1024, 2048, 2049]) {
      const data = crypto.getRandomValues(new Uint8Array(size));
      const chunks = splitIntoChunks(data, 1024);
      expect(chunks.length).toBe(Math.ceil(size / 1024));
      expect(assembleChunks(chunks, size)).toEqual(data);
    }
  });

  it('rejects empty input', () => {
    expect(() => splitIntoChunks(new Uint8Array(0), 1024)).toThrow();
  });

  it('assembleChunks throws on missing chunk or size mismatch', () => {
    const data = crypto.getRandomValues(new Uint8Array(3000));
    const chunks: (Uint8Array | null)[] = splitIntoChunks(data, 1024);
    expect(() => assembleChunks(chunks, 2999)).toThrow();
    chunks[1] = null;
    expect(() => assembleChunks(chunks, 3000)).toThrow(/Missing chunk 1/);
  });
});

describe('chunk content codec', () => {
  it('round-trips through AES-GCM + Z85', async () => {
    const key = await makeKey();
    const chunk = crypto.getRandomValues(new Uint8Array(32768));
    const aad = chunkAad('a'.repeat(32), 3, 10);
    const content = await encodeChunkContent(key, chunk, aad);
    expect(typeof content).toBe('string');
    const decoded = await decodeChunkContent(key, content, aad);
    expect(decoded).toEqual(chunk);
  });

  it('encoded 32 KiB chunk stays under 64 KB', async () => {
    const key = await makeKey();
    const chunk = crypto.getRandomValues(new Uint8Array(32768));
    const aad = chunkAad('a'.repeat(32), 0, 1);
    const content = await encodeChunkContent(key, chunk, aad);
    expect(content.length).toBeLessThan(64 * 1024);
  });

  it('rejects a chunk larger than maxSize', async () => {
    const key = await makeKey();
    const aad = chunkAad('a'.repeat(32), 0, 1);
    const content = await encodeChunkContent(key, new Uint8Array(200), aad);
    await expect(decodeChunkContent(key, content, aad, 100)).rejects.toThrow(
      /chunk size/,
    );
  });

  it('rejects tampered content', async () => {
    const key = await makeKey();
    const aad = chunkAad('a'.repeat(32), 0, 1);
    const content = await encodeChunkContent(key, new Uint8Array(100), aad);
    const tail = content.endsWith('00') ? '11' : '00';
    const tampered = `${content.slice(0, -2)}${tail}`;
    await expect(decodeChunkContent(key, tampered, aad)).rejects.toThrow();
  });

  it('rejects wrong AAD (index or transfer substitution)', async () => {
    const key = await makeKey();
    const content = await encodeChunkContent(
      key,
      new Uint8Array(100),
      chunkAad('a'.repeat(32), 0, 2),
    );
    await expect(
      decodeChunkContent(key, content, chunkAad('a'.repeat(32), 1, 2)),
    ).rejects.toThrow();
    await expect(
      decodeChunkContent(key, content, chunkAad('b'.repeat(32), 0, 2)),
    ).rejects.toThrow();
  });
});

describe('sha256', () => {
  it('matches a known digest', async () => {
    const digest = await sha256(new TextEncoder().encode('abc'));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    expect(hex).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
