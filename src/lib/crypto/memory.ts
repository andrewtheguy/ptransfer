/**
 * Best-effort overwrite of a mutable JavaScript BufferSource.
 *
 * This only clears the provided view/backing ArrayBuffer. JavaScript engines,
 * browser APIs, and Web Crypto implementations may have internal copies that
 * cannot be reached from application code.
 */
export function wipeBufferSource(
  bufferSource: ArrayBufferView | ArrayBufferLike,
): void {
  try {
    if (ArrayBuffer.isView(bufferSource)) {
      new Uint8Array(
        bufferSource.buffer,
        bufferSource.byteOffset,
        bufferSource.byteLength,
      ).fill(0);
      return;
    }

    new Uint8Array(bufferSource).fill(0);
  } catch {
    // Best-effort cleanup must not change the caller's control flow.
  }
}
