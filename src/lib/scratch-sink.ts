/**
 * Scratch storage for in-flight transfers, dispatched on payload size:
 * payloads at or below `MEMORY_SINK_MAX_BYTES` are buffered in memory,
 * larger payloads stream through OPFS-backed scratch files.
 *
 * All received payloads arrive as ordered streams of unknown final size
 * (single files are deflated on the wire, ZIPs are generated while they are
 * sent), so the one sink shape is `AppendSink`: sequential writes sealed into
 * a Blob. `createInflatingAppendSink` layers the wire decompression for
 * deflated payloads on top of any append sink.
 *
 * OPFS (`FileSystemFileHandle.createWritable`, secure contexts only) is
 * required for over-threshold payloads. Every current major browser ships
 * it, but `createWritable` arrived later than the rest of OPFS on some
 * engines (Safari/iOS only in 26), so support is feature-detected and sink
 * creation rejects with a user-facing error where it is missing.
 *
 * Privacy note: a scratch file holds plaintext on disk for the lifetime of
 * the sink. Every path that abandons a transfer must call `discard()`, and
 * `sweepTransferScratch` removes files that crashed or closed sessions left
 * behind.
 */

import { MEMORY_SINK_MAX_BYTES } from './crypto/constants';

/** Sequential sink for received payloads of unknown final size. */
export interface AppendSink {
  /** Append bytes at the end of the payload. Rejects on storage failure. */
  append(bytes: Uint8Array): Promise<void>;
  /**
   * Flush everything and seal the payload. The returned Blob stays readable
   * until `discard()`. No writes are accepted afterwards.
   */
  finish(): Promise<Blob>;
  /**
   * Release all storage backing this sink, including a finished payload's
   * scratch file (a disk-backed Blob from `finish()` becomes unreadable; a
   * memory-backed one is immutable and stays readable). Safe to call at any
   * point and more than once.
   */
  discard(): Promise<void>;
}

// lib.dom does not yet declare FileSystemDirectoryHandle async iteration.
interface DirectoryHandleWithIteration extends FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
}

const SCRATCH_DIR_NAME = 'transfer-scratch';

/** Scratch files owned by a live sink in this session; the sweeper skips them. */
const activeScratchNames = new Set<string>();

function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

function requireOpfs(): void {
  if (!opfsSupported()) {
    throw new Error(
      'This browser cannot store transfers over 100MB on disk (no OPFS support). Update to a current version of Chrome, Edge, Firefox, or Safari.',
    );
  }
}

async function openScratchDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SCRATCH_DIR_NAME, { create: true });
}

/**
 * Best-effort removal of scratch files no live sink owns. Run on boot and
 * before each transfer so plaintext left behind by a crashed or closed
 * session never outlives the next visit.
 */
export async function sweepTransferScratch(): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const dir = (await openScratchDir()) as DirectoryHandleWithIteration;
    for await (const name of dir.keys()) {
      if (activeScratchNames.has(name)) continue;
      await dir.removeEntry(name).catch(() => {});
    }
  } catch {
    // Sweeping must never break transfers.
  }
}

interface ScratchFile {
  handle: FileSystemFileHandle;
  writable: FileSystemWritableFileStream;
  /** Remove the scratch entry and release its name. */
  remove(): Promise<void>;
}

async function createScratchFile(): Promise<ScratchFile> {
  const dir = await openScratchDir();
  const name = `${crypto.randomUUID()}.part`;
  // Claim the name before the file exists so a concurrent sweep never deletes it.
  activeScratchNames.add(name);
  const remove = async () => {
    await dir.removeEntry(name).catch(() => {});
    activeScratchNames.delete(name);
  };
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return { handle, writable, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

type OpQueue = <T>(op: () => Promise<T>) => Promise<T>;

// FileSystemWritableFileStream handles one operation at a time; serialize
// all access so concurrent callers cannot interleave stream calls.
function createOpQueue(): OpQueue {
  let chain: Promise<unknown> = Promise.resolve();
  return (op) => {
    const run = chain.then(op);
    chain = run.catch(() => {});
    return run;
  };
}

function scratchLifecycle(scratch: ScratchFile, enqueue: OpQueue) {
  let discarded = false;
  return {
    finish(): Promise<Blob> {
      return enqueue(async () => {
        await scratch.writable.close();
        return scratch.handle.getFile();
      });
    },
    async discard(): Promise<void> {
      if (discarded) return;
      discarded = true;
      // abort() rejects once the stream is already closed (after finish);
      // either way the scratch entry itself is removed below.
      await enqueue(() => scratch.writable.abort()).catch(() => {});
      await scratch.remove();
    },
  };
}

function createMemoryAppendSink(): AppendSink {
  let chunks: Uint8Array[] | null = [];
  return {
    append(bytes) {
      if (!chunks) return Promise.reject(new Error('Scratch sink discarded'));
      chunks.push(bytes.slice());
      return Promise.resolve();
    },
    finish() {
      if (!chunks) return Promise.reject(new Error('Scratch sink discarded'));
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

/**
 * Create the sequential sink for output of unknown final size.
 * `expectedInputBytes` is a heuristic for the output size, used only to pick
 * the backend: at or below
 * `MEMORY_SINK_MAX_BYTES` output is buffered in memory, above it the sink is
 * OPFS-backed and rejects when OPFS is unsupported or fails. It is not a
 * limit — a memory sink accepts output that exceeds the estimate. Untrusted or
 * genuinely uncertain sizes should use `createAdaptiveAppendSink` instead.
 */
export async function createAppendSink(
  expectedInputBytes: number,
): Promise<AppendSink> {
  if (expectedInputBytes <= MEMORY_SINK_MAX_BYTES) {
    return createMemoryAppendSink();
  }
  requireOpfs();
  void sweepTransferScratch();
  const scratch = await createScratchFile();
  const enqueue = createOpQueue();
  return {
    append(bytes) {
      // Copy before queueing: the write may run after the producer has moved
      // on, and the sink must not depend on the caller's buffer staying put.
      const data = bytes.slice();
      return enqueue(() => scratch.writable.write(data as BufferSource));
    },
    ...scratchLifecycle(scratch, enqueue),
  };
}

/**
 * Create an append sink that can safely receive a payload whose final size is
 * unknown. It starts in memory when the estimate fits, then migrates all
 * accumulated chunks to OPFS before crossing `MEMORY_SINK_MAX_BYTES`.
 *
 * Unlike `createAppendSink`, the estimate is never trusted as a backend
 * decision for the lifetime of the sink. This matters on the receiving side,
 * where metadata came from the peer and the streamed payload can differ from
 * its input-size estimate.
 */
export async function createAdaptiveAppendSink(
  estimatedBytes: number,
): Promise<AppendSink> {
  if (estimatedBytes > MEMORY_SINK_MAX_BYTES) {
    return createAppendSink(estimatedBytes);
  }

  let chunks: Uint8Array[] | null = [];
  let accumulatedBytes = 0;
  let diskSink: AppendSink | null = null;
  let finished = false;
  let discardRequested = false;
  const enqueue = createOpQueue();

  const ensureWritable = () => {
    if (discardRequested) throw new Error('Scratch sink discarded');
    if (finished) throw new Error('Scratch sink already finished');
  };

  return {
    append(bytes) {
      if (discardRequested) {
        return Promise.reject(new Error('Scratch sink discarded'));
      }
      const data = bytes.slice();
      return enqueue(async () => {
        ensureWritable();
        const nextSize = accumulatedBytes + data.length;
        if (!diskSink && nextSize > MEMORY_SINK_MAX_BYTES) {
          // Passing an over-threshold estimate selects OPFS immediately.
          diskSink = await createAppendSink(MEMORY_SINK_MAX_BYTES + 1);
          for (const chunk of chunks ?? []) await diskSink.append(chunk);
          chunks = null;
        }

        if (diskSink) await diskSink.append(data);
        else chunks?.push(data);
        accumulatedBytes = nextSize;
      });
    },
    finish() {
      if (discardRequested) {
        return Promise.reject(new Error('Scratch sink discarded'));
      }
      return enqueue(async () => {
        ensureWritable();
        finished = true;
        if (diskSink) return diskSink.finish();
        const payload = new Blob((chunks ?? []) as BlobPart[]);
        chunks = null;
        return payload;
      });
    },
    discard() {
      if (discardRequested) return Promise.resolve();
      discardRequested = true;
      return enqueue(async () => {
        chunks = null;
        if (diskSink) await diskSink.discard();
        diskSink = null;
      });
    },
  };
}

/**
 * Wrap an append sink so appended raw-deflate bytes land in the inner sink
 * inflated: the sealed Blob is the original payload. `finish()` flushes the
 * decompressor before sealing, so truncated or malformed deflate data rejects
 * the transfer, and inflated output beyond `maxOutputBytes` rejects too — the
 * size cap is what stops a decompression bomb from a malicious peer, since
 * the in-band byte counts only cover the compressed bytes.
 */
export function createInflatingAppendSink(
  inner: AppendSink,
  maxOutputBytes: number,
): AppendSink {
  const decompressor = new DecompressionStream('deflate-raw');
  const writer = decompressor.writable.getWriter();
  let outputBytes = 0;

  const pumped = (async () => {
    const reader = decompressor.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      outputBytes += value.length;
      if (outputBytes > maxOutputBytes) {
        throw new Error('Decompressed transfer exceeds the size limit');
      }
      await inner.append(value);
    }
  })();
  // A pump failure resurfaces on the next append()/finish() await; this only
  // keeps it from reporting as unhandled meanwhile and unblocks a writer
  // waiting on decompressor backpressure that will never drain.
  pumped.catch(() => {
    void writer.abort().catch(() => {});
  });

  return {
    async append(bytes) {
      // Race the pump so its failures (size cap, inner-sink errors) surface
      // here instead of deadlocking a write the pump no longer drains;
      // malformed deflate data rejects the write itself.
      await Promise.race([writer.write(bytes.slice() as BufferSource), pumped]);
    },
    async finish() {
      // Race here too: after a pump failure the decompressor is no longer
      // drained, so close() alone would wait forever on its output queue.
      await Promise.race([writer.close(), pumped]);
      await pumped;
      return inner.finish();
    },
    discard() {
      void writer.abort().catch(() => {});
      return inner.discard();
    },
  };
}
