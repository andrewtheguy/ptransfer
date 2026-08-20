#!/usr/bin/env npx tsx
/**
 * Decrypt clipboard data from pTransfer QR mode
 * Usage: npx tsx scripts/decrypt-clipboard.ts <pin> [base64-data]
 *    or: echo '<base64-data>' | npx tsx scripts/decrypt-clipboard.ts <pin>
 */

import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import zlib from 'node:zlib';

async function readStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('');
}

const PBKDF2_ITERATIONS = 600_000;
const AES_NONCE_LENGTH = 12;

function deriveKey(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function decrypt(key: Buffer, encrypted: Buffer): Buffer {
  const nonce = encrypted.subarray(0, AES_NONCE_LENGTH);
  const ciphertext = encrypted.subarray(AES_NONCE_LENGTH, -16);
  const tag = encrypted.subarray(-16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted;
}

async function main(): Promise<void> {
  const [, , pin, base64Arg] = process.argv;

  if (!pin) {
    console.error(
      'Usage: npx tsx scripts/decrypt-clipboard.ts <pin> [base64-data]',
    );
    console.error(
      '   or: echo "<base64-data>" | npx tsx scripts/decrypt-clipboard.ts <pin>',
    );
    process.exit(1);
  }

  // Read base64 data from argument or stdin
  const base64Data = base64Arg || (await readStdin());

  if (!base64Data.trim()) {
    console.error('Error: No base64 data provided');
    process.exit(1);
  }

  // Decode base64
  const binary = Buffer.from(base64Data.trim(), 'base64');

  // Verify magic header "SS01"
  const magic = binary.subarray(0, 4).toString('ascii');
  if (magic !== 'SS01') {
    console.error(`Invalid magic header: expected "SS01", got "${magic}"`);
    console.error('Hex bytes:', binary.subarray(0, 4).toString('hex'));
    process.exit(1);
  }

  console.log('Magic header: SS01 ✓');
  console.log('Total binary length:', binary.length, 'bytes');

  // Extract salt and encrypted data
  const salt = binary.subarray(4, 20);
  const encrypted = binary.subarray(20);

  console.log('Salt:', salt.toString('hex'));
  console.log('Encrypted length:', encrypted.length, 'bytes');

  // Derive key
  console.log('\nDeriving key with PBKDF2 (600k iterations)...');
  const key = await deriveKey(pin, salt);

  // Decrypt and decompress
  try {
    const compressed = await decrypt(key, encrypted);
    console.log('Compressed payload:', compressed.length, 'bytes');

    // Decompress (deflate was used before encryption)
    const jsonBytes = zlib.inflateSync(compressed);
    console.log('Decompressed JSON:', jsonBytes.length, 'bytes');
    console.log(
      'Compression ratio:',
      `${((compressed.length / jsonBytes.length) * 100).toFixed(1)}%`,
    );

    const json = jsonBytes.toString('utf8');

    console.log('\n=== Decrypted Payload Raw ===');
    console.log(json);

    const payload = JSON.parse(json) as unknown;

    console.log('\n=== Decrypted Payload Prettified ===');
    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(
      '\nDecryption failed:',
      err instanceof Error ? err.message : String(err),
    );
    console.error('(Wrong PIN or corrupted data)');
    process.exit(1);
  }
}

void main();
