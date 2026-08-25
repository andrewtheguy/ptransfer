#!/usr/bin/env npx tsx
/**
 * Inspect a copied pTransfer Code Exchange payload (PT01 container).
 *
 * The container is [PT01][xorObfuscate([mag!][deflate(JSON)], hourly seed)]
 * (see src/lib/code-signaling.ts). The app only tries the current and
 * previous hourly seed buckets; this tool scans back much further so old
 * copies can still be inspected, and reports which bucket matched.
 *
 * Usage: npx tsx scripts/inspect-code-payload.ts [base64-data]
 *    or: echo '<base64-data>' | npx tsx scripts/inspect-code-payload.ts
 */

import { createInterface } from 'node:readline';
import zlib from 'node:zlib';

const MAGIC_HEADER = 'PT01';
const INNER_MAGIC = 'mag!';
const BUCKET_SEC = 3600;
const BASE_SEED = 0x9e3779b9;
// How far back to scan for the matching hourly seed (30 days), plus one
// bucket into the future for clock skew.
const MAX_BUCKETS_BACK = 24 * 30;

function getSeedForBucket(bucketEpoch: number): number {
  let h = BASE_SEED ^ bucketEpoch;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function xorObfuscate(data: Uint8Array, seed: number): Uint8Array {
  let state = seed;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    state = xorshift32(state);
    out[i] = data[i] ^ (state & 0xff);
  }
  return out;
}

async function readStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('');
}

function payloadKind(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'type' in payload) {
    const type = (payload as { type: unknown }).type;
    switch (type) {
      case 'offer':
        return 'signaling offer (WebRTC Code Exchange)';
      case 'answer':
        return 'signaling answer (WebRTC Code Exchange)';
      case 'nostr-file':
        return 'nostr-file (Nostr file relay manifest + decryption key)';
      default:
        return `unknown (type=${JSON.stringify(type)})`;
    }
  }
  return 'unknown (no type field)';
}

async function main(): Promise<void> {
  const [, , base64Arg] = process.argv;
  const base64Data = base64Arg || (await readStdin());

  if (!base64Data.trim()) {
    console.error(
      'Usage: npx tsx scripts/inspect-code-payload.ts [base64-data]\n' +
        "   or: echo '<base64-data>' | npx tsx scripts/inspect-code-payload.ts",
    );
    process.exit(1);
  }

  const binary = Buffer.from(base64Data.trim(), 'base64');

  const magic = binary.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC_HEADER) {
    console.error(
      `Invalid magic header: expected "${MAGIC_HEADER}", got "${magic}"`,
    );
    console.error('Hex bytes:', binary.subarray(0, 4).toString('hex'));
    process.exit(1);
  }

  console.log(`Magic header: ${MAGIC_HEADER} ✓`);
  console.log('Total binary length:', binary.length, 'bytes');

  const obfuscated = new Uint8Array(binary.subarray(4));
  const currentBucket = Math.floor(Date.now() / 1000 / BUCKET_SEC);
  const innerMagicBytes = Buffer.from(INNER_MAGIC, 'ascii');

  // Scan buckets newest-first: one into the future (clock skew), then back.
  for (let offset = -1; offset <= MAX_BUCKETS_BACK; offset++) {
    const bucket = currentBucket - offset;
    const seed = getSeedForBucket(bucket);

    // Cheap check: de-obfuscate only the 4-byte inner magic first.
    const head = xorObfuscate(obfuscated.subarray(0, 4), seed);
    if (!innerMagicBytes.equals(head)) continue;

    const inner = xorObfuscate(obfuscated, seed);
    let jsonBytes: Buffer;
    try {
      // fflate's deflateSync emits raw deflate (no zlib header).
      jsonBytes = zlib.inflateRawSync(inner.subarray(4));
    } catch {
      // Inner magic collision on the wrong bucket — keep scanning.
      continue;
    }

    const bucketStart = new Date(bucket * BUCKET_SEC * 1000);
    const ageHours = offset < 0 ? 0 : offset;
    console.log(
      `Seed bucket: ${bucketStart.toISOString()} (~${ageHours}h ago)`,
    );
    console.log('Compressed payload:', obfuscated.length - 4, 'bytes');
    console.log('Decompressed JSON:', jsonBytes.length, 'bytes');

    const payload = JSON.parse(jsonBytes.toString('utf8')) as unknown;
    console.log('Payload kind:', payloadKind(payload));
    console.log('\n=== Payload ===');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.error(
    `\nNo seed bucket matched within the last ${MAX_BUCKETS_BACK} hours.`,
  );
  console.error(
    'The data is corrupted, truncated, or older than the scan window.',
  );
  process.exit(1);
}

void main();
