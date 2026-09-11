/**
 * The sink a received payload is written into, and the wire decompression
 * that layers on top of any sink.
 *
 * All received payloads arrive as ordered streams of unknown final size
 * (single files are deflated on the wire, ZIPs are generated while they are
 * sent), so the one sink shape is `AppendSink`: sequential writes sealed into
 * a Blob. Where the bytes go is the host's business — the browser tab keeps
 * them in memory or in an OPFS scratch file (`scratch-sink.ts`), the CLI
 * writes them to the destination file — and nothing here touches a platform
 * API, so the transfer protocol in `p2p-transfer.ts` runs on either.
 */

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
  void (async () => {
    try {
      await pumped;
    } catch {
      await writer.abort().catch(() => {});
    }
  })();

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
    async discard() {
      void writer.abort().catch(() => {});
      await inner.discard();
    },
  };
}
