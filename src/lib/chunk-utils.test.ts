import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  buildChunkUrl,
  chunkPayload,
  extractChunkParam,
  isValidPayloadChecksum,
  parseChunk,
  reassembleChunks,
} from './chunk-utils';

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const data = new Uint8Array([0, 1, 255, 128, 63, 62, 43]);
    expect(base64urlDecode(base64urlEncode(data))).toEqual(data);
  });

  it('round-trips empty array', () => {
    const data = new Uint8Array(0);
    expect(base64urlDecode(base64urlEncode(data))).toEqual(data);
  });

  it('produces URL-safe characters only', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const encoded = base64urlEncode(data);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('chunkPayload / reassembleChunks', () => {
  it('round-trips: chunk then reassemble equals original', () => {
    const original = new Uint8Array(1200);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const chunks = chunkPayload(original, 400);

    expect(chunks.length).toBe(3);

    const map = new Map<number, Uint8Array>();
    let checksum: number | null = null;
    for (const chunk of chunks) {
      const parsed = parseChunk(base64urlEncode(chunk));
      expect(parsed).not.toBeNull();
      if (parsed!.index === 0) {
        expect(typeof parsed!.checksum).toBe('number');
        checksum = parsed!.checksum!;
      } else {
        expect(parsed!.checksum).toBeUndefined();
      }
      map.set(parsed!.index, parsed!.data);
    }

    const reassembled = reassembleChunks(map, 3);
    expect(reassembled).toEqual(original);
    expect(checksum).not.toBeNull();
    expect(isValidPayloadChecksum(reassembled!, checksum!)).toBe(true);
  });

  it('handles out-of-order reassembly', () => {
    const original = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const chunks = chunkPayload(original, 3);

    expect(chunks.length).toBe(3);

    // Insert in reverse order
    const map = new Map<number, Uint8Array>();
    let checksum: number | null = null;
    for (let i = chunks.length - 1; i >= 0; i--) {
      const parsed = parseChunk(base64urlEncode(chunks[i]));
      expect(parsed).not.toBeNull();
      if (parsed!.index === 0) checksum = parsed!.checksum!;
      map.set(parsed!.index, parsed!.data);
    }

    const reassembled = reassembleChunks(map, 3);
    expect(reassembled).toEqual(original);
    expect(checksum).not.toBeNull();
    expect(isValidPayloadChecksum(reassembled!, checksum!)).toBe(true);
  });

  it('duplicate chunk is idempotent', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const chunks = chunkPayload(original, 3);

    const map = new Map<number, Uint8Array>();
    for (const chunk of chunks) {
      const parsed = parseChunk(base64urlEncode(chunk));
      expect(parsed).not.toBeNull();
      map.set(parsed!.index, parsed!.data);
    }
    // Re-add first chunk
    const firstParsed = parseChunk(base64urlEncode(chunks[0]));
    expect(firstParsed).not.toBeNull();
    map.set(firstParsed!.index, firstParsed!.data);

    expect(map.size).toBe(2);
    const reassembled = reassembleChunks(map, 2);
    expect(reassembled).toEqual(original);
  });

  it('single-chunk case (payload <= maxDataBytes)', () => {
    const original = new Uint8Array([1, 2, 3]);
    const chunks = chunkPayload(original, 400);

    expect(chunks.length).toBe(1);
    expect(chunks[0][0]).toBe(0); // index
    expect(chunks[0][1]).toBe(1); // total

    const parsed = parseChunk(base64urlEncode(chunks[0]));
    expect(parsed).not.toBeNull();
    expect(parsed!.index).toBe(0);
    expect(parsed!.total).toBe(1);
    expect(typeof parsed!.checksum).toBe('number');

    const map = new Map<number, Uint8Array>();
    map.set(parsed!.index, parsed!.data);
    const reassembled = reassembleChunks(map, 1);
    expect(reassembled).toEqual(original);
    expect(isValidPayloadChecksum(reassembled!, parsed!.checksum!)).toBe(true);
  });

  it('produces one chunk when payload length equals maxDataBytes', () => {
    const maxDataBytes = 400;
    const original = new Uint8Array(maxDataBytes);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;

    const chunks = chunkPayload(original, maxDataBytes);
    expect(chunks.length).toBe(1);
    expect(chunks[0][0]).toBe(0);
    expect(chunks[0][1]).toBe(1);

    const parsed = parseChunk(base64urlEncode(chunks[0]));
    expect(parsed).not.toBeNull();
    expect(parsed!.index).toBe(0);
    expect(parsed!.total).toBe(1);
    expect(typeof parsed!.checksum).toBe('number');

    const map = new Map<number, Uint8Array>();
    map.set(parsed!.index, parsed!.data);
    const reassembled = reassembleChunks(map, 1);
    expect(reassembled).toEqual(original);
    expect(isValidPayloadChecksum(reassembled!, parsed!.checksum!)).toBe(true);
  });

  it('throws for empty payload', () => {
    const original = new Uint8Array(0);
    expect(() => chunkPayload(original, 400)).toThrow(
      'Payload cannot be empty',
    );
  });

  it('returns null when chunks are incomplete', () => {
    const original = new Uint8Array(1200);
    const chunks = chunkPayload(original, 400);

    const map = new Map<number, Uint8Array>();
    const parsed = parseChunk(base64urlEncode(chunks[0]));
    expect(parsed).not.toBeNull();
    map.set(parsed!.index, parsed!.data);

    expect(reassembleChunks(map, 3)).toBeNull();
  });
});

describe('parseChunk', () => {
  it('returns null for invalid base64', () => {
    expect(parseChunk('!!invalid!!')).toBeNull();
  });

  it('returns null for too-short data', () => {
    // Just 2 bytes (index + total, no data)
    const twoBytes = base64urlEncode(new Uint8Array([0, 1]));
    expect(parseChunk(twoBytes)).toBeNull();
  });

  it('returns null when index >= total', () => {
    const bad = new Uint8Array([3, 2, 99]); // index=3, total=2
    expect(parseChunk(base64urlEncode(bad))).toBeNull();
  });

  it('returns null when total is 0', () => {
    const bad = new Uint8Array([0, 0, 99]);
    expect(parseChunk(base64urlEncode(bad))).toBeNull();
  });

  it('returns null when chunk 0 has no checksum bytes', () => {
    const bad = new Uint8Array([0, 1, 99]); // missing 4-byte checksum
    expect(parseChunk(base64urlEncode(bad))).toBeNull();
  });

  it('parses non-zero chunk without checksum field', () => {
    const chunk = new Uint8Array([1, 2, 99]);
    const parsed = parseChunk(base64urlEncode(chunk));
    expect(parsed).not.toBeNull();
    expect(parsed!.index).toBe(1);
    expect(parsed!.total).toBe(2);
    expect(parsed!.checksum).toBeUndefined();
    expect(parsed!.data).toEqual(new Uint8Array([99]));
  });
});

describe('payload checksum', () => {
  it('fails validation when reassembled payload is tampered', () => {
    const original = new Uint8Array(1200);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const chunks = chunkPayload(original, 400);

    const map = new Map<number, Uint8Array>();
    let checksum: number | null = null;
    for (const chunk of chunks) {
      const parsed = parseChunk(base64urlEncode(chunk));
      expect(parsed).not.toBeNull();
      if (parsed!.index === 0) checksum = parsed!.checksum!;
      map.set(parsed!.index, parsed!.data);
    }

    const reassembled = reassembleChunks(map, 3);
    expect(reassembled).not.toBeNull();
    expect(checksum).not.toBeNull();
    expect(isValidPayloadChecksum(reassembled!, checksum!)).toBe(true);

    const tampered = reassembled!.slice();
    tampered[0] ^= 0xff;
    expect(isValidPayloadChecksum(tampered, checksum!)).toBe(false);
  });
});

describe('buildChunkUrl / extractChunkParam', () => {
  it('builds and extracts URL with fragment payload', () => {
    const chunk = chunkPayload(new Uint8Array([1, 2, 3]), 400)[0];
    const url = buildChunkUrl('https://example.com', chunk);

    expect(url).toMatch(/^https:\/\/example\.com\/r#[A-Za-z0-9_-]+$/);
    const param = extractChunkParam(url);
    expect(param).not.toBeNull();

    const parsed = parseChunk(param!);
    expect(parsed).not.toBeNull();
    expect(parsed!.index).toBe(0);
    expect(parsed!.total).toBe(1);
    expect(parsed!.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('strips trailing slash from base URL', () => {
    const chunk = chunkPayload(new Uint8Array([99]), 400)[0];
    const url = buildChunkUrl('https://example.com/', chunk);
    expect(url).toMatch(/^https:\/\/example\.com\/r#[A-Za-z0-9_-]+$/);
    expect(url).not.toMatch(/\/\/r/);
  });

  it('returns null for URL without fragment payload', () => {
    expect(extractChunkParam('https://example.com/r')).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(extractChunkParam('not a url')).toBeNull();
  });
});
