import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installOpfsMock, type OpfsMock } from '../test/opfs-mock';
import { MEMORY_SINK_MAX_BYTES } from './crypto/constants';
import {
  createAppendSink,
  createInflatingAppendSink,
  sweepTransferScratch,
} from './scratch-sink';

/** Smallest payload size that dispatches to the OPFS backend. */
const OPFS_SIZE = MEMORY_SINK_MAX_BYTES + 1;

let opfs: OpfsMock;

beforeAll(() => {
  opfs = installOpfsMock();
});

afterAll(() => {
  opfs.uninstall();
});

async function scratchDirNames(): Promise<string[]> {
  const dir = await opfs.root.getDirectoryHandle('transfer-scratch', {
    create: true,
  });
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  return names;
}

async function withoutOpfs<T>(run: () => Promise<T>): Promise<T> {
  opfs.uninstall();
  try {
    return await run();
  } finally {
    opfs = installOpfsMock();
  }
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

describe('createAppendSink (memory, at or below threshold)', () => {
  it('concatenates appended chunks into the payload', async () => {
    const sink = await createAppendSink(5);
    await sink.append(new Uint8Array([1, 2, 3]));
    await sink.append(new Uint8Array([4, 5]));
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    await sink.discard();
  });

  it('does not retain a reference to the caller buffer', async () => {
    const sink = await createAppendSink(2);
    const chunk = new Uint8Array([9, 9]);
    await sink.append(chunk);
    chunk.fill(0);
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([9, 9]),
    );
    await sink.discard();
  });

  it('rejects appends and finish after discard', async () => {
    const sink = await createAppendSink(4);
    await sink.discard();
    await expect(sink.append(new Uint8Array([1]))).rejects.toThrow();
    await expect(sink.finish()).rejects.toThrow();
  });

  it('never touches OPFS', async () => {
    await withoutOpfs(async () => {
      const sink = await createAppendSink(MEMORY_SINK_MAX_BYTES);
      await sink.append(new Uint8Array([1, 2]));
      const blob = await sink.finish();
      expect(blob.size).toBe(2);
      await sink.discard();
    });
    const sink = await createAppendSink(4);
    expect(await scratchDirNames()).toHaveLength(0);
    await sink.discard();
  });
});

describe('createAppendSink (OPFS, over threshold)', () => {
  it('concatenates appended chunks into a disk-backed payload', async () => {
    const sink = await createAppendSink(OPFS_SIZE);
    expect(await scratchDirNames()).toHaveLength(1);
    await sink.append(new Uint8Array([1, 2, 3]));
    await sink.append(new Uint8Array([4, 5]));
    const blob = await sink.finish();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    await sink.discard();
    expect(await scratchDirNames()).toHaveLength(0);
  });

  it('tolerates repeated discard calls and removes the scratch entry', async () => {
    const sink = await createAppendSink(OPFS_SIZE);
    expect(await scratchDirNames()).toHaveLength(1);
    await sink.discard();
    await expect(sink.discard()).resolves.toBeUndefined();
    expect(await scratchDirNames()).toHaveLength(0);
  });

  it('rejects when OPFS is unavailable', async () => {
    await withoutOpfs(async () => {
      await expect(createAppendSink(OPFS_SIZE)).rejects.toThrow('OPFS');
    });
  });
});

describe('createInflatingAppendSink', () => {
  it('inflates appended raw-deflate bytes into the inner sink', async () => {
    const original = new Uint8Array(100_000);
    for (let i = 0; i < original.length; i++) original[i] = (i * 13 + 5) % 251;
    const deflated = await deflateRaw(original);

    const inner = await createAppendSink(original.length);
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
    const inner = await createAppendSink(1024);
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
    const inner = await createAppendSink(1024);
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
    const inner = await createAppendSink(50_000);
    const sink = createInflatingAppendSink(inner, 50_000);

    await sink.append(deflated.subarray(0, deflated.length - 4));
    await expect(sink.finish()).rejects.toThrow();
    await sink.discard();
  });
});

describe('sweepTransferScratch', () => {
  it('removes entries no live sink owns and keeps owned ones', async () => {
    const sink = await createAppendSink(OPFS_SIZE);
    const dir = await opfs.root.getDirectoryHandle('transfer-scratch', {
      create: true,
    });
    await dir.getFileHandle('stale-from-crashed-session.part', {
      create: true,
    });

    await sweepTransferScratch();

    const names = await scratchDirNames();
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe('stale-from-crashed-session.part');
    await sink.discard();
  });
});
