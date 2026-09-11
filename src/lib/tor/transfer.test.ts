import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installOpfsMock, type OpfsMock } from '../../test/opfs-mock';
import { ENCRYPTION_CHUNK_SIZE } from '../crypto';
import { P2PConnectionError } from '../errors';
import type { TransferSource } from '../transfer-source';
import { TorFramedStream } from './framing';
import { createOnionStreamPair } from './mock-stream';
import { createTorLink, receiveFileOverTor, sendFileOverTor } from './transfer';

let opfs: OpfsMock;

beforeAll(() => {
  opfs = installOpfsMock();
});

afterAll(() => {
  opfs.uninstall();
});

function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function zipOf(data: Uint8Array): TransferSource {
  return {
    name: 'bundle.zip',
    type: 'application/zip',
    size: data.length,
    estimatedSize: data.length,
    projectedWireBytes: data.length,
    precompressed: true,
    stream: () => new Blob([data as BlobPart]).stream(),
  };
}

function pair(): [TorFramedStream, TorFramedStream] {
  const [a, b] = createOnionStreamPair();
  return [new TorFramedStream(a), new TorFramedStream(b)];
}

describe('createTorLink', () => {
  it('delivers frames both ways at once', async () => {
    const [a, b] = pair();
    const linkA = createTorLink(a);
    const linkB = createTorLink(b);
    const atA: unknown[] = [];
    const atB: unknown[] = [];
    linkA.subscribe((m) => atA.push(m));
    linkB.subscribe((m) => atB.push(m));

    await Promise.all([
      linkA.sendBinary(new Uint8Array([1, 2, 3])),
      linkB.sendText('from b'),
      linkA.sendText('from a'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(atA).toEqual(['from b']);
    expect(atB).toHaveLength(2);
    expect(Array.from(new Uint8Array(atB[0] as ArrayBuffer))).toEqual([
      1, 2, 3,
    ]);
    expect(atB[1]).toBe('from a');
  });

  it('reports the peer hanging up, and refuses sends after it', async () => {
    const [a, b] = pair();
    const link = createTorLink(a);
    const ended: string[] = [];
    link.onEnd((reason) => ended.push(reason));

    await b.close();
    await link.waitForPeerClose(1_000);

    expect(ended).toEqual(['closed']);
    await expect(link.sendText('late')).rejects.toThrow('closed');
  });
});

describe('Tor transfer', () => {
  it('carries a multi-chunk payload one way, and the sender waits for the receiver to hang up', async () => {
    const contentKey = await key();
    const data = new Uint8Array(ENCRYPTION_CHUNK_SIZE * 3 + 99).map(
      (_, i) => i % 251,
    );
    const [service, client] = pair();

    let receiverHungUp = false;
    const sending = sendFileOverTor(service, contentKey, zipOf(data)).then(
      async (wireBytes) => {
        expect(receiverHungUp).toBe(true);
        await service.close();
        return wireBytes;
      },
    );
    // As the hooks do: the file is whole, so the stream goes.
    const receiving = receiveFileOverTor(client, contentKey, 'identity', {
      estimatedBytes: data.length,
    }).then(async (payload) => {
      await client.close();
      receiverHungUp = true;
      return payload;
    });

    const [wireBytes, payload] = await Promise.all([sending, receiving]);
    expect(wireBytes).toBe(data.length);
    expect(new Uint8Array(await payload.arrayBuffer())).toEqual(data);
  });

  it('ends the sender when a cancelled receiver hangs up', async () => {
    const contentKey = await key();
    const [service, client] = pair();
    let cancelled = false;
    // One chunk, then a source still working on the next: the sender is
    // waiting on its own input when the receiver gives up.
    const source: TransferSource = {
      ...zipOf(new Uint8Array(ENCRYPTION_CHUNK_SIZE * 2)),
      size: null,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(ENCRYPTION_CHUNK_SIZE));
          },
          pull: () => new Promise<void>(() => {}),
        }),
    };

    const sending = sendFileOverTor(service, contentKey, source);
    const receiving = receiveFileOverTor(client, contentKey, 'identity', {
      onProgress: () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });

    await expect(receiving).rejects.toThrow('Cancelled');
    // Nothing travels back: the close is what the sender learns from.
    await client.close();
    const error = await sending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(P2PConnectionError);
    expect((error as Error).message).toMatch(/closed before the file/);
  });
});
