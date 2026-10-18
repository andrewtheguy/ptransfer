import { isCompressedFormat } from './compressed-formats';

/**
 * A repeatable, lazily-opened payload for the P2P transfer pipeline.
 *
 * `size` is null when the source does not determine its final length up front
 * (for example, a ZIP packaged while it is being sent). `estimatedSize` is
 * only a progress/storage hint; the transfer protocol validates the actual
 * byte count at end of stream.
 */
export interface TransferSource {
  name: string;
  type: string;
  size: number | null;
  estimatedSize: number;
  /**
   * An upper bound on what this payload will occupy on the wire, which is not
   * `estimatedSize`: a single file may be deflated (and incompressible input
   * comes out slightly *larger*), and a generated ZIP adds a header pair and the
   * entry path for every file it contains.
   *
   * The wire ceiling both peers enforce is a fixed constant, so a selection
   * whose bound exceeds it has to be refused while it is still a selection.
   * Discovering it while producing bytes means failing after a Tor bootstrap
   * and a handshake, and on a transport with no resume that is the whole
   * transfer.
   */
  projectedWireBytes: number;
  /**
   * True for a generated ZIP (the multiple file/folder flow). An archive does
   * its own compression, entry by entry, so the wire never deflates it (the
   * no-recompress rule).
   */
  archive: boolean;
  /**
   * Open the payload. `compressed` asks an archive to deflate its entries
   * rather than store them; a single file ignores it, since its compression
   * happens on the wire (see `wireEncodingFor`).
   */
  stream: (compressed: boolean) => ReadableStream<Uint8Array>;
}

/** How payload bytes travel on the wire between peers. */
export type WireEncoding = 'deflate-raw' | 'identity';

/**
 * The compression rule, decided by flow and file type rather than by
 * sniffing content. Whether to compress at all is the transport's call: a
 * direct WebRTC connection carries the payload as it is, since deflating
 * costs more time than a fast link saves, while a slow transport — Tor, or
 * the Nostr relay fallback — passes `compressed`. Compressed, a single file
 * is deflated on the wire ('deflate-raw') and restored on receipt, unless its
 * format is compressed already (`isCompressedFormat`: audio, video, and the
 * like), which deflate cannot shrink; an archive has already deflated its
 * entries as it was opened and travels as-is ('identity').
 */
export function wireEncodingFor(
  source: TransferSource,
  compressed: boolean,
): WireEncoding {
  return compressed &&
    !source.archive &&
    !isCompressedFormat(source.name, source.type)
    ? 'deflate-raw'
    : 'identity';
}

/**
 * The most raw DEFLATE can grow input it cannot compress: five bytes of block
 * header per 16 KiB stored block, plus a few for the final block. Deliberately
 * loose — the point is a bound that is never exceeded, not a tight estimate.
 */
export function deflateUpperBound(bytes: number): number {
  return bytes + Math.ceil(bytes / 16_383) * 5 + 64;
}

/** Wrap a picker-provided file in the shared lazy transfer abstraction. */
export function createFileTransferSource(file: File): TransferSource {
  return {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    estimatedSize: file.size,
    projectedWireBytes: deflateUpperBound(file.size),
    archive: false,
    stream: () => file.stream(),
  };
}
