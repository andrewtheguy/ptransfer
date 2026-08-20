/**
 * Utilities for splitting binary payloads into URL-based QR chunks
 * and reassembling them on the receiver side.
 *
 * Chunk wire format (before base64url):
 *   chunk 0: [1 byte: chunk_index][1 byte: total_chunks][4 bytes: payload_crc32_be][N bytes: data]
 *   chunk 1..N-1: [1 byte: chunk_index][1 byte: total_chunks][N bytes: data]
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function isValidPayloadChecksum(
  payload: Uint8Array,
  expectedChecksum: number,
): boolean {
  return computeCrc32(payload) === expectedChecksum >>> 0;
}

export function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64urlDecode(encoded: string): Uint8Array {
  // Restore standard base64 characters
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Split a binary payload into chunks with [index][total] headers.
 * Chunk index 0 includes payload-wide CRC32 for final integrity validation.
 * Distributes data evenly across chunks so all QR codes are similar size.
 * Returns an array of Uint8Array chunks ready for base64url encoding.
 */
export function chunkPayload(
  binary: Uint8Array,
  maxDataBytes = 400,
): Uint8Array[] {
  if (binary.length === 0) {
    throw new Error('Payload cannot be empty');
  }

  const totalChunks = Math.max(1, Math.ceil(binary.length / maxDataBytes));
  if (totalChunks > 255) {
    throw new Error(
      `Payload too large: would need ${totalChunks} chunks (max 255)`,
    );
  }

  // Distribute evenly: each chunk gets floor or ceil of (total / chunks)
  const baseSize = Math.floor(binary.length / totalChunks);
  const remainder = binary.length % totalChunks;
  const payloadChecksum = computeCrc32(binary);

  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < totalChunks; i++) {
    // First `remainder` chunks get one extra byte
    const sliceLen = baseSize + (i < remainder ? 1 : 0);
    const dataSlice = binary.slice(offset, offset + sliceLen);
    offset += sliceLen;

    const headerSize = i === 0 ? 6 : 2;
    const chunk = new Uint8Array(headerSize + dataSlice.length);
    chunk[0] = i; // chunk_index
    chunk[1] = totalChunks; // total_chunks
    if (i === 0) {
      chunk[2] = (payloadChecksum >>> 24) & 0xff;
      chunk[3] = (payloadChecksum >>> 16) & 0xff;
      chunk[4] = (payloadChecksum >>> 8) & 0xff;
      chunk[5] = payloadChecksum & 0xff;
      chunk.set(dataSlice, 6);
    } else {
      chunk.set(dataSlice, 2);
    }
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Build a URL for a single chunk.
 * Format: {baseUrl}/r#{base64url}
 */
export function buildChunkUrl(baseUrl: string, chunk: Uint8Array): string {
  const encoded = base64urlEncode(chunk);
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/r#${encoded}`;
}

/**
 * Parse a base64url-encoded chunk string into its components.
 * Returns null if the chunk is invalid.
 */
export function parseChunk(encoded: string): {
  index: number;
  total: number;
  data: Uint8Array;
  checksum?: number;
} | null {
  try {
    const bytes = base64urlDecode(encoded);
    if (bytes.length < 3) return null; // Need at least index + total + 1 byte data

    const index = bytes[0];
    const total = bytes[1];
    if (total === 0 || index >= total) return null;

    if (index === 0) {
      if (bytes.length < 7) return null; // Need index + total + checksum(4) + 1 byte data
      const checksum =
        (bytes[2] * 0x1000000 +
          (bytes[3] << 16) +
          (bytes[4] << 8) +
          bytes[5]) >>>
        0;
      const data = bytes.slice(6);
      return { index, total, data, checksum };
    }

    const data = bytes.slice(2);
    return { index, total, data, checksum: undefined };
  } catch {
    return null;
  }
}

/**
 * Reassemble chunks into the original binary payload.
 * Returns null if any chunk is missing.
 */
export function reassembleChunks(
  chunks: Map<number, Uint8Array>,
  total: number,
): Uint8Array | null {
  if (chunks.size !== total) return null;

  // Verify all indices present
  for (let i = 0; i < total; i++) {
    if (!chunks.has(i)) return null;
  }

  // Calculate total size
  let totalSize = 0;
  for (let i = 0; i < total; i++) {
    totalSize += chunks.get(i)!.length;
  }

  // Assemble
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (let i = 0; i < total; i++) {
    const chunk = chunks.get(i)!;
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Extract the chunk payload token from the URL fragment.
 * Supports only fragment format: /r#{base64url}
 */
export function extractChunkParam(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hash = parsed.hash;
    if (!hash || hash.length < 2) return null;

    const payload = hash.slice(1);
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;

    return payload;
  } catch {
    return null;
  }
}
