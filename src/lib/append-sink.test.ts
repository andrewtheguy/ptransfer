import { describe, expect, it } from 'vitest';
import { type AppendSink, createInflatingAppendSink } from './append-sink';

/** The simplest sink there is: everything appended, sealed as one Blob. */
function memorySink(): AppendSink {
  let chunks: Uint8Array[] | null = [];
  return {
    append(bytes) {
      if (!chunks) return Promise.reject(new Error('discarded'));
      chunks.push(bytes.slice());
      return Promise.resolve();
    },
    finish() {
      if (!chunks) return Promise.reject(new Error('discarded'));
      const blob = new Blob(chunks as BlobPart[]);
      chunks = null;
      return Promise.resolve(blob);
    },
    discard() {
      chunks = null;
      return Promise.resolve();
    },
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const compressor = new CompressionStream('deflate-raw');
  const writer = compressor.writable.getWriter();
  void writer.write(data.slice()).catch(() => {});
  void writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = compressor.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe('createInflatingAppendSink', () => {
  it('inflates appended raw-deflate bytes into the inner sink', async () => {
    const original = new Uint8Array(100_000);
    for (let i = 0; i < original.length; i++) original[i] = (i * 13 + 5) % 251;
    const deflated = await deflateRaw(original);

    const inner = memorySink();
    const sink = createInflatingAppendSink(inner, original.length);
    // Feed in small pieces so inflation spans many appends.
    for (let offset = 0; offset < deflated.length; offset += 4096) {
      await sink.append(deflated.subarray(offset, offset + 4096));
    }
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);
    await sink.discard();
  });

  it('rejects inflated output beyond the size cap (decompression bomb)', async () => {
    const bomb = await deflateRaw(new Uint8Array(1_000_000));
    const inner = memorySink();
    const sink = createInflatingAppendSink(inner, 1024);

    await expect(
      (async () => {
        await sink.append(bomb);
        await sink.finish();
      })(),
    ).rejects.toThrow('exceeds the size limit');
    await sink.discard();
  });

  it('rejects data that is not a raw-deflate stream', async () => {
    const inner = memorySink();
    const sink = createInflatingAppendSink(inner, 1024);

    await expect(
      (async () => {
        await sink.append(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        await sink.finish();
      })(),
    ).rejects.toThrow();
    await sink.discard();
  });

  it('rejects a truncated deflate stream at finish', async () => {
    const deflated = await deflateRaw(new Uint8Array(50_000).fill(7));
    const inner = memorySink();
    const sink = createInflatingAppendSink(inner, 50_000);

    await sink.append(deflated.subarray(0, deflated.length - 4));
    await expect(sink.finish()).rejects.toThrow();
    await sink.discard();
  });
});
