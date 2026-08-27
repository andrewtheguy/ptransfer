import { describe, expect, it } from 'vitest';
import type { TransferMetadata } from '@/lib/nostr';
import { createFileTransferSource } from '@/lib/transfer-source';
import { TorFramedStream } from './framing';
import {
  type ClientHandshake,
  runTorClientHandshake,
  runTorServiceHandshake,
  type ServiceHandshake,
  sendCancel,
  sendReady,
} from './handshake';
import { createOnionStreamPair } from './mock-stream';
import { receiveFileOverTor, sendFileOverTor } from './transfer';

const ONION =
  'zrmxlosp6cvmkhxwhx7267wkvqyztsrmloqw76eu4fhn2gsbg5zk4kad.onion:9735';
const OTHER =
  'vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion:9735';
const PASSWORD = 'ABCDEFGHJKLA';

function metadata(): TransferMetadata {
  return {
    contentType: 'file',
    fileName: 'report.pdf',
    fileSize: 4096,
    contentEncoding: 'deflate-raw',
    mimeType: 'application/octet-stream',
  };
}

function pair(): [TorFramedStream, TorFramedStream] {
  const [a, b] = createOnionStreamPair();
  return [new TorFramedStream(a), new TorFramedStream(b)];
}

/** Run both sides against each other over an in-memory stream pair. */
async function exchange(
  servicePassword: string,
  clientPassword: string,
  serviceOnion: string,
  clientOnion: string,
): Promise<{
  served: PromiseSettledResult<ServiceHandshake>;
  received: PromiseSettledResult<ClientHandshake>;
}> {
  const [service, client] = pair();

  // The real sender closes the stream when a connection ends, however it
  // ended; a client whose claim could not be opened learns of the refusal that
  // way and no other.
  const serving = runTorServiceHandshake(
    service,
    servicePassword,
    serviceOnion,
    metadata(),
  ).finally(() => void service.close());
  const receiving = (async () => {
    const handshake = await runTorClientHandshake(
      client,
      clientPassword,
      clientOnion,
    );
    await sendReady(client);
    return handshake;
  })();

  const [served, received] = await Promise.allSettled([serving, receiving]);
  return { served, received };
}

describe('the Tor handshake', () => {
  it('agrees on keys and metadata under the matching password', async () => {
    const { served, received } = await exchange(
      PASSWORD,
      PASSWORD,
      ONION,
      ONION,
    );

    expect(served.status).toBe('fulfilled');
    expect(received.status).toBe('fulfilled');
    if (served.status !== 'fulfilled' || received.status !== 'fulfilled')
      return;
    if (served.value.outcome !== 'ready') throw new Error('expected ready');

    // The two content keys are non-extractable, so agreement is shown by one
    // side's ciphertext opening under the other's key.
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      served.value.keys.contentKey,
      new TextEncoder().encode('same session'),
    );
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      received.value.keys.contentKey,
      sealed,
    );
    expect(new TextDecoder().decode(opened)).toBe('same session');

    expect(received.value.metadata.fileName).toBe('report.pdf');
    expect(received.value.metadata.contentEncoding).toBe('deflate-raw');
  });

  it('authenticates neither side under a wrong password', async () => {
    const { served, received } = await exchange(
      PASSWORD,
      'ABCDEFGHJKLZ',
      ONION,
      ONION,
    );

    // The service refuses at the claim, and the client never sees a confirm.
    expect(served.status).toBe('rejected');
    expect(received.status).toBe('rejected');
  });

  it('binds the address into the session', async () => {
    // Same password, but the client believes it reached a different service —
    // which is what a proxied handshake would look like.
    const { served, received } = await exchange(
      PASSWORD,
      PASSWORD,
      ONION,
      OTHER,
    );

    expect(served.status).toBe('rejected');
    expect(received.status).toBe('rejected');
  });

  it('lets the receiver decline after seeing the metadata', async () => {
    const [service, client] = pair();

    const serving = runTorServiceHandshake(
      service,
      PASSWORD,
      ONION,
      metadata(),
    );
    await runTorClientHandshake(client, PASSWORD, ONION);
    await sendCancel(client);

    expect((await serving).outcome).toBe('cancelled');
  });
});

describe('a Tor transfer end to end', () => {
  it('carries a deflated file from the service to the client', async () => {
    // Compressible and several chunks long, so the wire encoding and the
    // chunk sequencing are both exercised.
    const data = new TextEncoder().encode(
      'the same line of text, over and over\n'.repeat(8_000),
    );
    const file = new File([data as BlobPart], 'notes.txt', {
      type: 'text/plain',
    });
    const source = createFileTransferSource(file);

    const [service, client] = pair();
    const serviceMetadata: TransferMetadata = {
      contentType: 'file',
      fileName: source.name,
      fileSize: source.estimatedSize,
      contentEncoding: 'deflate-raw',
      mimeType: source.type,
    };

    const serving = (async () => {
      const handshake = await runTorServiceHandshake(
        service,
        PASSWORD,
        ONION,
        serviceMetadata,
      );
      if (handshake.outcome !== 'ready') throw new Error('expected ready');
      return sendFileOverTor(service, handshake.keys.contentKey, source);
    })();

    const receiving = (async () => {
      const handshake = await runTorClientHandshake(client, PASSWORD, ONION);
      await sendReady(client);
      return receiveFileOverTor(
        client,
        handshake.keys.contentKey,
        handshake.metadata.contentEncoding,
        { estimatedBytes: handshake.metadata.fileSize },
      );
    })();

    const [wireBytes, payload] = await Promise.all([serving, receiving]);

    // Deflated on the wire, restored on receipt.
    expect(wireBytes).toBeLessThan(data.length / 10);
    expect(payload.size).toBe(data.length);
    expect(new Uint8Array(await payload.arrayBuffer())).toEqual(data);
  });
});
