/**
 * Live end-to-end test of the experimental Nostr file relay against real
 * public relays: uploads a random file, encodes/parses its own manual
 * payload, downloads it back, and byte-compares.
 *
 * Publishes real (expiring, NIP-40) events to public relays — run manually,
 * not part of `npm test`:
 *
 *   npx tsx tests/live_nostr_file_e2e.ts
 */
import { SimplePool } from 'nostr-tools';
import { downloadFileFromNostr } from '../src/lib/nostr-file/download';
import {
  generateNostrFilePayloadBinary,
  type NostrFilePayload,
  parseAnyManualPayload,
} from '../src/lib/manual-signaling';
import { uint8ArrayToBase64 } from '../src/lib/nostr/events';
import { sha256 } from '../src/lib/nostr-file/codec';
import type { RelayPoolState, RelayPoolStorage } from '../src/lib/nostr-file/relay-pool';
import { uploadFileToNostr } from '../src/lib/nostr-file/upload';

const FILE_SIZE = 100 * 1024;

function memoryStorage(): RelayPoolStorage {
  let state: RelayPoolState | null = null;
  return {
    get: () => state,
    set(s) {
      state = s;
    },
  };
}

async function main() {
  const data = new Uint8Array(FILE_SIZE);
  for (let offset = 0; offset < FILE_SIZE; offset += 65536) {
    crypto.getRandomValues(data.subarray(offset, offset + 65536));
  }

  const pool = new SimplePool();
  try {
    console.log('Uploading', FILE_SIZE, 'random bytes to Nostr relays...');
    const started = Date.now();
    const { manifest, keyBytes } = await uploadFileToNostr(
      data,
      {
        fileName: 'live-e2e.bin',
        fileSize: FILE_SIZE,
        mimeType: 'application/octet-stream',
      },
      {
        pool,
        storage: memoryStorage(),
        isCancelled: () => false,
        onProgress: (p) => {
          if (p.phase === 'health_check') {
            process.stdout.write(
              `\rhealth check: ${p.relaysHealthy}/${p.relaysChecked} healthy `,
            );
          } else if (p.phase === 'uploading') {
            process.stdout.write(
              `\ruploading: ${p.chunksDone}/${p.chunksTotal} chunks      `,
            );
          }
        },
      },
    );
    console.log(`\nUpload done in ${Date.now() - started}ms`);
    console.log('Relays:', manifest.relays.join(', '));

    // Round-trip the manual payload exactly as the UI does
    const payloadBinary = generateNostrFilePayloadBinary({
      ...manifest,
      type: 'nostr-file',
      key: uint8ArrayToBase64(keyBytes),
    } satisfies NostrFilePayload);
    console.log('Manual payload size:', payloadBinary.length, 'bytes');
    const parsed = parseAnyManualPayload(payloadBinary);
    if (parsed?.kind !== 'nostr-file') {
      throw new Error('Payload round-trip failed');
    }

    const downloadStarted = Date.now();
    const downloaded = await downloadFileFromNostr(
      parsed.payload,
      Uint8Array.from(atob(parsed.payload.key), (c) => c.charCodeAt(0)),
      {
        pool,
        isCancelled: () => false,
        onProgress: (p) => {
          process.stdout.write(
            `\rdownloading: ${p.chunksDone}/${p.chunksTotal} chunks from ${p.relay ?? '...'}      `,
          );
        },
      },
    );
    console.log(`\nDownload done in ${Date.now() - downloadStarted}ms`);

    if (downloaded.length !== data.length) {
      throw new Error(
        `Size mismatch: sent ${data.length}, got ${downloaded.length}`,
      );
    }
    const sentHash = uint8ArrayToBase64(await sha256(data));
    const gotHash = uint8ArrayToBase64(await sha256(downloaded));
    if (sentHash !== gotHash) {
      throw new Error('Hash mismatch after round trip');
    }
    console.log('OK: byte-for-byte round trip through Nostr relays succeeded');
  } finally {
    pool.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
  });
