import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransferMetadata } from '@/lib/nostr/types';
import { TorFramedStream } from '@/lib/tor/framing';
import { runTorClientHandshake, sendReady } from '@/lib/tor/handshake';
import { createOnionStreamPair } from '@/lib/tor/mock-stream';
import { serveUntilSent } from '@/lib/tor/serve';
import { receiveFileOverTor } from '@/lib/tor/transfer';
import type { OnionService, OnionStream } from '@/lib/tor/webtor-api';
import { wireEncodingFor } from '@/lib/transfer-source';
import { createFileSink, openFileSource, safeFileName } from './files';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ptransfer-cli-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

describe('openFileSource', () => {
  it('describes the file and streams it, more than once', async () => {
    const path = join(dir, 'notes.txt');
    const data = new TextEncoder().encode('hello over Tor\n'.repeat(1000));
    await writeFile(path, data);

    const source = await openFileSource(path);
    expect(source.name).toBe('notes.txt');
    expect(source.size).toBe(data.length);
    expect(source.estimatedSize).toBe(data.length);
    expect(source.precompressed).toBe(false);
    expect(source.projectedWireBytes).toBeGreaterThan(data.length);
    expect(await readAll(source.stream())).toEqual(data);
    // A receiver that declined leaves the next one a fresh read.
    expect(await readAll(source.stream())).toEqual(data);
  });

  it('refuses what is not a regular file', async () => {
    await expect(openFileSource(join(dir, 'missing'))).rejects.toThrow(
      'No such file',
    );
    await expect(openFileSource(dir)).rejects.toThrow('Not a regular file');
  });
});

describe('safeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(safeFileName('report.pdf')).toBe('report.pdf');
  });

  it('keeps only the last path segment, whichever separator was used', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\a.txt')).toBe('a.txt');
  });

  it('strips control characters and refuses to name nothing', () => {
    expect(safeFileName('a\u0000b\n.txt')).toBe('ab.txt');
    expect(safeFileName('')).toBe('received');
    expect(safeFileName('..')).toBe('received');
    expect(safeFileName('/')).toBe('received');
  });
});

describe('createFileSink', () => {
  it('writes to a part file and renames it into place on finish', async () => {
    const destination = join(dir, 'out.bin');
    const sink = await createFileSink(destination);
    expect((await readdir(dir)).some((n) => n.endsWith('.part'))).toBe(true);

    await sink.append(new Uint8Array([1, 2, 3]));
    await sink.append(new Uint8Array([4, 5]));
    const blob = await sink.finish();

    expect(blob.size).toBe(5);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(new Uint8Array(await readFile(destination))).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(await readdir(dir)).toEqual(['out.bin']);
    // The finished file is the payload; discarding afterwards keeps it.
    await sink.discard();
    expect(await readdir(dir)).toEqual(['out.bin']);
  });

  it('does not depend on the caller keeping its buffer', async () => {
    const sink = await createFileSink(join(dir, 'out.bin'));
    const chunk = new Uint8Array([7, 7, 7]);
    await sink.append(chunk);
    chunk.fill(0);
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([7, 7, 7]),
    );
  });

  it('discarding before finish removes the part file and nothing else', async () => {
    const destination = join(dir, 'out.bin');
    const sink = await createFileSink(destination);
    await sink.append(new Uint8Array([1]));
    await sink.discard();
    expect(await readdir(dir)).toEqual([]);
    await expect(sink.append(new Uint8Array([2]))).rejects.toThrow('discarded');
  });

  it('never overwrites: an existing destination is refused at creation and at finish', async () => {
    const destination = join(dir, 'out.bin');
    await writeFile(destination, 'already here');
    await expect(createFileSink(destination)).rejects.toThrow('already exists');
    await rm(destination);

    const sink = await createFileSink(destination);
    await sink.append(new Uint8Array([1]));
    await writeFile(destination, 'arrived meanwhile');
    await expect(sink.finish()).rejects.toThrow('already exists');
    await sink.discard();
    expect(await readFile(destination, 'utf8')).toBe('arrived meanwhile');
    expect(await readdir(dir)).toEqual(['out.bin']);
  });
});

const ONION =
  'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion:9735';
const PASSWORD = 'ABCDEFGHJKMN';

function oneStreamService(stream: OnionStream): OnionService {
  let handed = false;
  return {
    onionAddress: ONION.split(':')[0],
    accept: () => {
      if (handed) return new Promise<null>(() => {});
      handed = true;
      return Promise.resolve(stream);
    },
    close: () => Promise.resolve(undefined),
  };
}

describe('a file on disk to a file on disk', () => {
  it('goes through the service loop, the handshake, and the framed stream', async () => {
    const sourcePath = join(dir, 'photo.bin');
    const data = new Uint8Array(300_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) % 251;
    await writeFile(sourcePath, data);
    const content = await openFileSource(sourcePath);
    const metadata: TransferMetadata = {
      contentType: 'file',
      fileName: content.name,
      fileSize: content.estimatedSize,
      contentEncoding: wireEncodingFor(content),
      mimeType: content.type,
    };
    const [serviceSide, clientSide] = createOnionStreamPair();

    const serving = serveUntilSent({
      service: oneStreamService(serviceSide),
      onion: ONION,
      password: PASSWORD,
      metadata,
      content,
      fileMetadata: {
        fileName: metadata.fileName,
        fileSize: metadata.fileSize,
        mimeType: metadata.mimeType,
      },
      isCancelled: () => false,
      setState: () => {},
    });

    const destination = join(dir, 'received', 'photo.bin');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'received'));
    const receiving = (async () => {
      const framed = new TorFramedStream(clientSide);
      const { keys, metadata: offered } = await runTorClientHandshake(
        framed,
        PASSWORD,
        ONION,
      );
      expect(offered.fileName).toBe('photo.bin');
      const sink = await createFileSink(destination);
      await sendReady(framed);
      const payload = await receiveFileOverTor(
        framed,
        keys.contentKey,
        offered.contentEncoding,
        sink,
        { estimatedBytes: offered.fileSize },
      );
      await framed.close();
      return payload;
    })();

    const [, payload] = await Promise.all([serving, receiving]);
    expect(payload.size).toBe(data.length);
    expect(new Uint8Array(await readFile(destination))).toEqual(data);
    expect(await readdir(join(dir, 'received'))).toEqual(['photo.bin']);
  });
});
