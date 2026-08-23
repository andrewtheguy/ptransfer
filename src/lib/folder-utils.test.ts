import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { archiveTimestamp, createZipTransferSource } from './folder-utils';

interface CentralEntry {
  crc: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readCentralEntries(archive: Uint8Array): Map<string, CentralEntry> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  let eocdOffset = archive.length - 22;
  while (eocdOffset >= 0 && view.getUint32(eocdOffset, true) !== 0x06054b50) {
    eocdOffset--;
  }
  if (eocdOffset < 0) throw new Error('ZIP end record not found');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  const entries = new Map<string, CentralEntry>();
  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory');
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(
      archive.subarray(offset + 46, offset + 46 + nameLength),
    );
    entries.set(name, {
      method: view.getUint16(offset + 10, true),
      crc: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const decompressor = new DecompressionStream('deflate-raw');
  const writer = decompressor.writable.getWriter();
  void writer.write(data.slice()).catch(() => {});
  void writer.close().catch(() => {});
  return readAll(decompressor.readable);
}

/**
 * Strict validation equivalent to what macOS Archive Utility performs:
 * every entry must be deflated, inflate cleanly with an implementation
 * independent of the compressor's caller (the platform inflater here,
 * fflate's in unzipSync round-trips), and match the recorded CRC and sizes.
 */
async function expectDeflatedEntriesWithValidCrc(
  archive: Uint8Array,
  expected: Record<string, Uint8Array>,
): Promise<void> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const centralEntries = readCentralEntries(archive);
  expect(centralEntries.size).toBe(Object.keys(expected).length);

  for (const [name, bytes] of Object.entries(expected)) {
    const entry = centralEntries.get(name);
    expect(entry, `missing central entry for ${name}`).toBeDefined();
    expect(entry?.method, `compression method for ${name}`).toBe(8);
    expect(entry?.uncompressedSize).toBe(bytes.length);
    expect(entry?.crc, `central CRC for ${name}`).toBe(crc32(bytes));

    const localOffset = entry!.localOffset;
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const nameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + nameLength + extraLength;
    const compressed = archive.subarray(
      dataOffset,
      dataOffset + entry!.compressedSize,
    );
    const inflated = await inflateRaw(compressed);
    expect(inflated, `inflated bytes for ${name}`).toEqual(bytes);
    expect(entry?.crc, `CRC of inflated bytes for ${name}`).toBe(
      crc32(inflated),
    );
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe('createZipTransferSource', () => {
  it('streams files into a valid ZIP that round-trips', async () => {
    // Large enough to span multiple stream chunks.
    const big = new Uint8Array(300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) % 256;
    const files = [
      new File(['hello world'], 'hello.txt', { type: 'text/plain' }),
      new File([big as BlobPart], 'big.bin'),
    ];

    const source = createZipTransferSource(files, 'bundle');
    expect(source.name).toBe('bundle.zip');
    expect(source.type).toBe('application/zip');
    expect(source.size).toBeNull();
    expect(source.estimatedSize).toBe(11 + big.length);
    // Entries are already deflated; the transfer pipeline must not
    // recompress this payload.
    expect(source.precompressed).toBe(true);

    const entries = unzipSync(await readAll(source.stream()));
    expect(Object.keys(entries).sort()).toEqual(['big.bin', 'hello.txt']);
    expect(new TextDecoder().decode(entries['hello.txt'])).toBe('hello world');
    expect(entries['big.bin']).toEqual(big);
  });

  it('emits ZIP bytes before later file data is available', async () => {
    const first = new File(['first'], 'first.txt');
    const second = new File(['second'], 'second.txt');
    let provideSecond!: () => void;
    const secondCanBeRead = new Promise<void>((resolve) => {
      provideSecond = resolve;
    });
    let secondReadStarted = false;
    Object.defineProperty(second, 'stream', {
      value: () =>
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            secondReadStarted = true;
            await secondCanBeRead;
            controller.enqueue(new TextEncoder().encode('second'));
            controller.close();
          },
        }),
    });

    const reader = createZipTransferSource([first, second], 'bundle')
      .stream()
      .getReader();
    const firstOutput = await reader.read();

    expect(firstOutput.done).toBe(false);
    expect(firstOutput.value?.length).toBeGreaterThan(0);
    expect(secondReadStarted).toBe(false);
    provideSecond();
    await reader.cancel();
  });

  it('keeps entry output intact when the consumer is backpressured', async () => {
    const expected: Record<string, Uint8Array> = {};
    const files = Array.from({ length: 80 }, (_, index) => {
      // Small, highly compressible entries exercise the final-output path that
      // runs immediately before the next entry is added.
      const data = new Uint8Array(4096 + (index % 17) * 37).fill(index & 0xff);
      const name = `small-${index}.bin`;
      expected[name] = data;
      return new File([data as BlobPart], name);
    });

    const reader = createZipTransferSource(files, 'many-small-files')
      .stream()
      .getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      // Keep the writer backpressured across fflate callback turns.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const archive = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.length;
    }
    const entries = unzipSync(archive);
    for (const [name, data] of Object.entries(expected)) {
      expect(entries[name]).toEqual(data);
    }
    await expectDeflatedEntriesWithValidCrc(archive, expected);
  });

  it('compresses input that breaks fflate streaming deflate (fflate#260)', async () => {
    // 234-byte EMF prefix from 101arrowz/fflate#260: fflate's streaming
    // ZipDeflate emits an invalid back-reference for this input at every
    // compression level, so the entry cannot be inflated even though its
    // recorded CRC is correct. Native CompressionStream must handle it.
    const emfPrefix = Uint8Array.from(
      atob(
        'AQAAAGwAAAAAAAAAAAAAAM0AAAAcAAAAAAAAAAAAAABqHAAA/gMAACBFTUYAAAEAAAsAADIAAAAH' +
          'AAAAAAAAAAAAAAAAAAAAAAUAAAAEAADEAQAAaQEAAAAAAAAAAAAAAAAAAOPjBgAcgwUARgAAAGQC' +
          'AABWAgAAR0RJQwEAAIAAAwAAfQ+OiAAAAAA+AgAAAQAJAAADHwEAAAYAKwAAAAAABAAAAAMBCAAF' +
          'AAAACwIAAAAABQAAAAwCHQDOAAMAAAAeAAcAAAD8AgAAaWlpAAAABAAAAC0BAAAJAAAAHQYhAPAA' +
          'HQABAAAA',
      ),
      (char) => char.charCodeAt(0),
    );
    const files = [new File([emfPrefix as BlobPart], 'image.emf')];

    const archive = await readAll(
      createZipTransferSource(files, 'emf').stream(),
    );
    await expectDeflatedEntriesWithValidCrc(archive, {
      'image.emf': emfPrefix,
    });
    expect(unzipSync(archive)['image.emf']).toEqual(emfPrefix);
  });

  it('uses webkitRelativePath as the entry path when present', async () => {
    const file = new File(['nested'], 'a.txt');
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'folder/sub/a.txt',
    });

    const source = createZipTransferSource([file], 'folder');
    const entries = unzipSync(await readAll(source.stream()));
    expect(Object.keys(entries)).toEqual(['folder/sub/a.txt']);
  });

  it('produces a valid empty archive for no files', async () => {
    const source = createZipTransferSource([], 'empty');
    const entries = unzipSync(await readAll(source.stream()));
    expect(Object.keys(entries)).toEqual([]);
  });
});

describe('archiveTimestamp', () => {
  it('formats a local-time yyyymmddhhmmss stamp', () => {
    const stamp = archiveTimestamp(new Date(2026, 6, 13, 9, 5, 7));
    expect(stamp).toBe('20260713090507');
  });

  it('is 14 digits for the current time', () => {
    expect(archiveTimestamp()).toMatch(/^\d{14}$/);
  });
});
