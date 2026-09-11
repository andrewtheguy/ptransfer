import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installOpfsMock, type OpfsMock } from '../test/opfs-mock';
import { MEMORY_SINK_MAX_BYTES } from './crypto/constants';
import { createAppendSink, sweepTransferScratch } from './scratch-sink';

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
