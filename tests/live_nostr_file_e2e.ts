/**
 * Live end-to-end test of the experimental Nostr file relay against real
 * public relays: sender and receiver run side by side (two pools, like two
 * browsers), coordinate over the encrypted control channel, and the result
 * is byte-compared.
 *
 * Publishes real (expiring, NIP-40) events to public relays — run manually,
 * not part of `npm test`:
 *
 *   npx tsx tests/live_nostr_file_e2e.ts
 *
 * NOSTR_E2E_FILE_MB overrides the file size (default 0.1, max 100), e.g.
 *   NOSTR_E2E_FILE_MB=100 npx tsx tests/live_nostr_file_e2e.ts
 */
import { SimplePool } from 'nostr-tools';
import {
  generateNostrFilePayloadBinary,
  type NostrFileLivePayload,
  parseAnyManualPayload,
} from '../src/lib/manual-signaling';
import { uint8ArrayToBase64 } from '../src/lib/nostr/events';
import { sha256 } from '../src/lib/nostr-file/codec';
import { receiveFileLive } from '../src/lib/nostr-file/download-live';
import type { NostrFileManifest } from '../src/lib/nostr-file/manifest';
import type {
  RelayPoolState,
  RelayPoolStorage,
} from '../src/lib/nostr-file/relay-pool';
import { sendFileLive } from '../src/lib/nostr-file/upload-live';

const FILE_MB = Number(process.env.NOSTR_E2E_FILE_MB ?? '0.1');
if (!Number.isFinite(FILE_MB) || FILE_MB <= 0 || FILE_MB > 100) {
  throw new Error('NOSTR_E2E_FILE_MB must be a number in (0, 100]');
}
const FILE_SIZE = Math.round(FILE_MB * 1024 * 1024);

function memoryStorage(): RelayPoolStorage {
  let state: RelayPoolState | null = null;
  return {
    get: () => state,
    set(s) {
      state = s;
    },
  };
}

function randomFile(): Uint8Array {
  const data = new Uint8Array(FILE_SIZE);
  for (let offset = 0; offset < FILE_SIZE; offset += 65536) {
    crypto.getRandomValues(data.subarray(offset, offset + 65536));
  }
  return data;
}

function keyFromPayload(key: string): Uint8Array {
  return Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
}

async function verify(sent: Uint8Array, got: Uint8Array): Promise<void> {
  if (got.length !== sent.length) {
    throw new Error(`Size mismatch: sent ${sent.length}, got ${got.length}`);
  }
  const sentHash = uint8ArrayToBase64(await sha256(sent));
  const gotHash = uint8ArrayToBase64(await sha256(got));
  if (sentHash !== gotHash) throw new Error('Hash mismatch after round trip');
  console.log('OK: byte-for-byte round trip through Nostr relays succeeded');
}

async function runLive(data: Uint8Array) {
  const senderPool = new SimplePool({ enableReconnect: true });
  const receiverPool = new SimplePool({ enableReconnect: true });
  try {
    console.log(
      'Sending',
      FILE_SIZE,
      'random bytes through Nostr relays (single copy)...',
    );
    const started = Date.now();
    let handoverResolve!: (p: NostrFileLivePayload) => void;
    const handover = new Promise<NostrFileLivePayload>((resolve) => {
      handoverResolve = resolve;
    });

    const sendDone = sendFileLive(
      data,
      { fileName: 'live-e2e.bin', mimeType: 'application/octet-stream' },
      {
        pool: senderPool,
        storage: memoryStorage(),
        isCancelled: () => false,
        onReady: (manifest: NostrFileManifest, keyBytes) => {
          console.log(
            `\nCode ready after ${Date.now() - started}ms; relays (${manifest.relays.length}):`,
            manifest.relays.join(', '),
          );
          const payloadBinary = generateNostrFilePayloadBinary({
            ...manifest,
            type: 'nostr-file-live',
            key: uint8ArrayToBase64(keyBytes),
          } satisfies NostrFileLivePayload);
          console.log('Manual payload size:', payloadBinary.length, 'bytes');
          const parsed = parseAnyManualPayload(payloadBinary);
          if (parsed?.kind !== 'nostr-file-live') {
            throw new Error('Payload round-trip failed');
          }
          handoverResolve(parsed.payload);
        },
        onProgress: (p) => {
          if (p.phase === 'health_check') {
            process.stdout.write(
              `\rhealth check: ${p.relaysHealthy}/${p.relaysChecked} healthy `,
            );
          } else if (p.phase === 'transfer') {
            process.stdout.write(
              `\rsender: uploaded ${p.chunksDone}/${p.chunksTotal}, receiver has ${p.receiverHave ?? 0}, re-sent ${p.resent ?? 0}, relays demoted ${p.relaysDemoted ?? 0}      `,
            );
          }
        },
      },
    );
    sendDone.catch(() => {});

    const payload = await Promise.race([
      handover,
      sendDone.then(() => {
        throw new Error('sender finished before handing over the code');
      }),
    ]);

    const receiveStarted = Date.now();
    const received = await receiveFileLive(
      payload,
      keyFromPayload(payload.key),
      {
        pool: receiverPool,
        isCancelled: () => false,
        onProgress: () => {},
      },
    );
    console.log(`\nReceiver done in ${Date.now() - receiveStarted}ms`);
    await sendDone;
    console.log(`Sender done in ${Date.now() - started}ms total`);
    await verify(data, received);
  } finally {
    senderPool.destroy();
    receiverPool.destroy();
  }
}

runLive(randomFile())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFAILED:', err);
    process.exit(1);
  });
