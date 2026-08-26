#!/usr/bin/env bun

/**
 * Live end-to-end test of the Nostr file relay — the Code Exchange data
 * path taken when no direct WebRTC connection can be made — against real
 * public relays: sender and receiver run side by side (two pools, like two
 * browsers) with a shared session, as both sides of a failed exchange would
 * have, coordinate over the encrypted control channel, and the result is
 * byte-compared.
 *
 * Publishes real (expiring, NIP-40) events to public relays — run manually,
 * not part of `bun run test`:
 *
 *   bun run test:live:nostr-file
 *
 * NOSTR_E2E_FILE_MB overrides the file size (default 0.1, max 100), e.g.
 *   NOSTR_E2E_FILE_MB=100 bun run test:live:nostr-file
 *
 * NOSTR_E2E_TIMEOUT_MS overrides the whole-run deadline (default 15 min);
 * past it, both sides cancel and the run fails with a timeout error.
 */
import { uint8ArrayToBase64 } from '../src/lib/nostr/events';
import { sha256 } from '../src/lib/nostr-file/codec';
import { receiveFileLive } from '../src/lib/nostr-file/download-live';
import type {
  CachedRelay,
  RelayPoolState,
  RelayPoolStorage,
} from '../src/lib/nostr-file/relay-pool';
import type { RelaySession } from '../src/lib/nostr-file/session';
import { createTransferStats } from '../src/lib/nostr-file/stats';
import { createTransferPool } from '../src/lib/nostr-file/transfer-pool';
import {
  prepareStorageRelays,
  resolveTransferRelays,
} from '../src/lib/nostr-file/upload';
import { sendFileLive } from '../src/lib/nostr-file/upload-live';

const FILE_MB = Number(process.env.NOSTR_E2E_FILE_MB ?? '0.1');
if (!Number.isFinite(FILE_MB) || FILE_MB <= 0 || FILE_MB > 100) {
  throw new Error('NOSTR_E2E_FILE_MB must be a number in (0, 100]');
}
const FILE_SIZE = Math.round(FILE_MB * 1024 * 1024);

const TIMEOUT_MS = Number(process.env.NOSTR_E2E_TIMEOUT_MS ?? 15 * 60 * 1000);
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  throw new Error('NOSTR_E2E_TIMEOUT_MS must be a positive number');
}

function memoryStorage(): RelayPoolStorage {
  let state: RelayPoolState | null = null;
  let relayHealth: CachedRelay[] = [];
  return {
    getState: async () => state,
    setState: async (s) => {
      state = s;
    },
    getRelayHealth: async () => relayHealth,
    setRelayHealth: async (relays) => {
      relayHealth = relays;
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

// In the app both sides derive this from the exchange's ECDH secret; here
// the two "browsers" just share random material the same way.
function newSession(): { sender: RelaySession; receiver: RelaySession } {
  const transferId = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    sender: { transferId, keyBytes: new Uint8Array(keyBytes) },
    receiver: { transferId, keyBytes: new Uint8Array(keyBytes) },
  };
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
  const senderPool = createTransferPool();
  const receiverPool = createTransferPool();
  // Shared deadline: both engines poll this as their cancellation check, so a
  // stalled run winds down on both sides instead of hanging forever.
  const deadline = Date.now() + TIMEOUT_MS;
  const deadlineExceeded = () => Date.now() > deadline;
  // Ends the background relay sweep with the pools.
  const sweepAbort = new AbortController();
  try {
    // What the sender does while building its offer: resolve the relays the
    // offer names, filling any defunct default from a full-size-proven
    // discovered relay. On a failed direct connection they carry the relay
    // transfer's control channel.
    const started = Date.now();
    const relayStorage = memoryStorage();
    const selection = await resolveTransferRelays(senderPool, relayStorage, {
      isCancelled: deadlineExceeded,
      stats: createTransferStats('sender'),
      onControlProgress: (checked, healthy) =>
        process.stdout.write(`\rcontrol relays: ${healthy}/${checked} healthy `),
      onUploadProgress: (p) => {
        if (p.phase === 'health_check') {
          process.stdout.write(
            `\rbackfill health check: ${p.relaysHealthy}/${p.relaysChecked} healthy `,
          );
        }
      },
    });
    const controlRelays = selection.controlRelays;
    console.log(
      `\nControl relays ready after ${Date.now() - started}ms (${controlRelays.length}):`,
      controlRelays.join(', '),
    );
    // Behind a real exchange the storage ring is prepared as soon as the
    // control relays are known, while WebRTC is still trying; here the direct
    // attempt is taken as failed at once. The ring reuses the resolution's
    // storage (and whatever the backfill's discovery left over, if any).
    const storageRelays = prepareStorageRelays(senderPool, {
      controlRelays,
      storage: relayStorage,
      stats: selection.stats,
      discovered: selection.discovered,
      signal: sweepAbort.signal,
      isCancelled: deadlineExceeded,
      onProgress: (p) => {
        if (p.phase === 'health_check') {
          process.stdout.write(
            `\rstorage health check: ${p.relaysHealthy}/${p.relaysChecked} healthy `,
          );
        }
      },
    });
    const session = newSession();
    const since = Math.floor(Date.now() / 1000);

    console.log(
      'Sending',
      FILE_SIZE,
      'random bytes through Nostr relays (single copy)...',
    );
    const sendDone = sendFileLive(
      data,
      {
        fileName: 'live-e2e.bin',
        mimeType: 'application/octet-stream',
        precompressed: false,
      },
      {
        pool: senderPool,
        session: session.sender,
        controlRelays,
        storageRelays,
        isCancelled: deadlineExceeded,
        onProgress: (p) => {
          if (p.phase === 'transfer') {
            process.stdout.write(
              `\rsender: uploaded ${p.chunksDone}/${p.chunksTotal}, receiver has ${p.receiverHave ?? 0}, re-sent ${p.resent ?? 0}, relays demoted ${p.relaysDemoted ?? 0}      `,
            );
          }
        },
      },
    );
    sendDone.catch(() => {});

    const receiveStarted = Date.now();
    const received = await receiveFileLive(session.receiver, controlRelays, {
      pool: receiverPool,
      isCancelled: deadlineExceeded,
      since,
      expiresAt: since + 3600,
      onProgress: () => {},
    });
    console.log(`\nReceiver done in ${Date.now() - receiveStarted}ms`);
    await sendDone;
    console.log(`Sender done in ${Date.now() - started}ms total`);
    await verify(data, received);
  } catch (err) {
    if (deadlineExceeded()) {
      throw new Error(
        `Timed out: the ${TIMEOUT_MS}ms deadline passed before the transfer completed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    throw err;
  } finally {
    sweepAbort.abort();
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
