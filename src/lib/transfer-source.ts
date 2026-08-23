/**
 * A repeatable, lazily-opened payload for the P2P transfer pipeline.
 *
 * `size` is null when the source does not determine its final length up front
 * (for example, a ZIP compressed while it is being sent). `estimatedSize` is
 * only a progress/storage hint; the transfer protocol validates the actual
 * byte count at end of stream.
 */
export interface TransferSource {
  name: string;
  type: string;
  size: number | null;
  estimatedSize: number;
  stream: () => ReadableStream<Uint8Array>;
}

/** Wrap a picker-provided file in the shared lazy transfer abstraction. */
export function createFileTransferSource(file: File): TransferSource {
  return {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    estimatedSize: file.size,
    stream: () => file.stream(),
  };
}
