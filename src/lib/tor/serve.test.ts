import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferMetadata } from '@/lib/nostr';
import { createFileTransferSource } from '@/lib/transfer-source';
import { TorFramedStream } from './framing';
import { runTorClientHandshake, sendReady } from './handshake';
import { createOnionStreamPair } from './mock-stream';
import { serveUntilSent, TOR_WAIT_TIMEOUT_MS } from './serve';
import { receiveFileOverTor } from './transfer';
import type { OnionService, OnionStream } from './webtor';

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

function sourceOf(
  bytes: Uint8Array,
): ReturnType<typeof createFileTransferSource> {
  return createFileTransferSource(
    new File([bytes as BlobPart], 'slow.bin', {
      type: 'application/octet-stream',
    }),
  );
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
   * A regression test with a specific history: on the CLI side the deadline
   * once raced the whole accept loop, so an authenticated transfer still
   * moving bytes was cancelled 30 minutes after the *wait* began. The clock
   * crosses that deadline here after the receiver has sent `ready`, which is
   * the shape that used to fail.
   */
  it('lets an authenticated transfer outlive the wait deadline', async () => {
    // Several 128 KiB chunks, and compressible, so the deflate-raw wire
    // encoding is exercised rather than skipped.
    const payload = new Uint8Array(400_000).map((_, i) => i % 251);
    const [serviceSide, clientSide] = createOnionStreamPair();
    const source = sourceOf(payload);

    const metadata: TransferMetadata = {
      contentType: 'file',
      fileName: source.name,
      fileSize: source.estimatedSize,
      contentEncoding: 'deflate-raw',
      mimeType: source.type,
    };

    const received = (async () => {
      const client = new TorFramedStream(clientSide);
      const { keys } = await runTorClientHandshake(client, PASSWORD, ONION);
      await sendReady(client);

      // Authenticated. From here the peer is the receiver, and the wait
      // deadline is no longer anything it has to race — so cross it.
      await vi.advanceTimersByTimeAsync(TOR_WAIT_TIMEOUT_MS * 2);

      return receiveFileOverTor(client, keys.contentKey, 'deflate-raw', {
        estimatedBytes: metadata.fileSize,
      });
    })();

    await expect(
      serveUntilSent({
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
      }),
    ).resolves.toBeUndefined();

    const blob = await received;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(payload);
  });
});
