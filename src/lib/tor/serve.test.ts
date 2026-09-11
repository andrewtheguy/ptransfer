import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENCRYPTION_CHUNK_SIZE } from '@/lib/crypto';
import type { TransferMetadata } from '@/lib/nostr';
import type { TransferSource } from '@/lib/transfer-source';
import { TorFramedStream } from './framing';
import { runTorClientHandshake, sendReady } from './handshake';
import { createOnionStreamPair } from './mock-stream';
import { serveUntilSent, TOR_WAIT_TIMEOUT_MS } from './serve';
import { receiveFileOverTor } from './transfer';
import type { OnionService, OnionStream } from './webtor';

// Captured before the fake timers go in: the crypto under the handshake and
// every chunk resolves on real time, and the test has to wait for it.
const realSetTimeout = globalThis.setTimeout;
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 20));

const ONION =
  'zrmxlosp6cvmkhxwhx7267wkvqyztsrmloqw76eu4fhn2gsbg5zk4kad.onion:9735';
const PASSWORD = 'ABCDEFGHJKLA';

/**
 * One stream, then nothing: enough to drive the accept loop once without a Tor
 * client behind it. `OnionService` is an interface precisely so this is possible.
 */
function oneStreamService(stream: OnionStream): OnionService {
  let handed = false;
  return {
    onionAddress: ONION.split(':')[0],
    accept: () => {
      if (handed) return new Promise<never>(() => {});
      handed = true;
      return Promise.resolve(stream);
    },
    close: () => Promise.resolve(undefined),
  };
}

describe('serveUntilSent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The wait deadline bounds the wait, never a transfer.
   *
   * A regression test with a specific history: in an earlier implementation the deadline
   * once raced the whole accept loop, so an authenticated transfer still
   * moving bytes was cancelled 30 minutes after the *wait* began. Here the
   * transfer itself runs past that deadline — its source yields a chunk every
   * 50 seconds, inside the stall window both sides keep, for longer than the
   * deadline in all — which is the shape that used to fail.
   */
  it('lets an authenticated transfer outlive the wait deadline', async () => {
    const GAP_MS = 50_000;
    const pieces = Math.ceil(TOR_WAIT_TIMEOUT_MS / GAP_MS) + 2;
    const piece = new Uint8Array(ENCRYPTION_CHUNK_SIZE).map((_, i) => i % 251);
    const total = pieces * piece.length;
    let produced = 0;
    const source: TransferSource = {
      name: 'slow.zip',
      type: 'application/zip',
      size: total,
      estimatedSize: total,
      projectedWireBytes: total,
      precompressed: true,
      stream: () =>
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (produced === pieces) {
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, GAP_MS));
            produced += 1;
            controller.enqueue(piece.slice());
          },
        }),
    };
    const [serviceSide, clientSide] = createOnionStreamPair();

    const metadata: TransferMetadata = {
      contentType: 'file',
      fileName: source.name,
      fileSize: total,
      contentEncoding: 'identity',
      mimeType: source.type,
    };

    let authenticated!: () => void;
    const handshakeDone = new Promise<void>((resolve) => {
      authenticated = resolve;
    });
    const received = (async () => {
      const client = new TorFramedStream(clientSide);
      const { keys } = await runTorClientHandshake(client, PASSWORD, ONION);
      await sendReady(client);
      authenticated();
      return receiveFileOverTor(client, keys.contentKey, 'identity', {
        estimatedBytes: total,
      });
    })();

    const serving = serveUntilSent({
      service: oneStreamService(serviceSide),
      onion: ONION,
      password: PASSWORD,
      metadata,
      content: source,
      fileMetadata: {
        fileName: metadata.fileName,
        fileSize: metadata.fileSize,
        mimeType: metadata.mimeType,
      },
      isCancelled: () => false,
      setState: () => {},
    });

    // Drive the clock gap by gap, well past the wait deadline, letting each
    // chunk's crypto finish in real time before the next gap.
    await handshakeDone;
    await settle();
    for (let i = 0; i <= pieces; i++) {
      await vi.advanceTimersByTimeAsync(GAP_MS);
      await settle();
    }

    await expect(serving).resolves.toBeUndefined();
    const blob = await received;
    expect(blob.size).toBe(total);
    expect(produced * GAP_MS).toBeGreaterThan(TOR_WAIT_TIMEOUT_MS);
  });
});
