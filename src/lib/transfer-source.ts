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
  /**
   * An upper bound on what this payload will occupy on the wire, which is not
   * `estimatedSize`: a single file is deflated (and incompressible input comes
   * out slightly *larger*), and a generated ZIP adds a header pair and the
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
   * True when the flow that produced this payload already compressed it (the
   * multiple file/folder flow ships a ZIP whose entries are deflated). Drives
   * the no-recompress rule: precompressed payloads travel as-is, everything
   * else is deflated on the wire.
   */
  precompressed: boolean;
  stream: () => ReadableStream<Uint8Array>;
}

/** How payload bytes travel on the wire between peers. */
export type WireEncoding = 'deflate-raw' | 'identity';

/**
 * The compression rule, flow-based rather than content-sniffed: a payload
 * from the multiple file/folder flow is already compressed and is never
 * recompressed ('identity'); every other payload — single-file transfers —
 * is deflated behind the scenes ('deflate-raw') and restored on receipt.
 */
export function wireEncodingFor(source: TransferSource): WireEncoding {
  return source.precompressed ? 'identity' : 'deflate-raw';
}

/**
 * The most raw DEFLATE can grow input it cannot compress: five bytes of block
 * header per 16 KiB stored block, plus a few for the final block. Deliberately
 * loose — the point is a bound that is never exceeded, not a tight estimate.
 */
export function deflateUpperBound(bytes: number): number {
  return bytes + Math.ceil(bytes / 16_383) * 5 + 64;
}

/**
 * What one ZIP entry costs beyond its own bytes: a local file header, a
 * streaming data descriptor, and a central directory record, plus zip64 extra
 * fields. The entry path is stored twice, so it is counted separately.
 */
const ZIP_PER_ENTRY_BYTES = 160;
/** End-of-central-directory, plus the zip64 records that may precede it. */
const ZIP_TRAILER_BYTES = 128;

/**
 * An upper bound on the archive a selection will produce. Every entry is
 * deflated individually, so each contributes its own deflate bound as well as
 * its share of the ZIP's bookkeeping — which is what makes a selection of many
 * tiny files cost far more on the wire than the sum of its file sizes.
 */
export function zipWireUpperBound(files: readonly File[]): number {
  let total = ZIP_TRAILER_BYTES;
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    total +=
      deflateUpperBound(file.size) +
      ZIP_PER_ENTRY_BYTES +
      2 * new TextEncoder().encode(path).length;
  }
  return total;
}

/**
 * The wire bound for a selection, before it has been turned into a source:
 * a lone loose file is deflated, anything else becomes a ZIP. Lets a picker
 * refuse a selection without building the source first.
 */
export function projectedWireBytesFor(
  files: readonly File[],
  willZip: boolean,
): number {
  if (willZip) return zipWireUpperBound(files);
  return files[0] ? deflateUpperBound(files[0].size) : 0;
}

/** Wrap a picker-provided file in the shared lazy transfer abstraction. */
export function createFileTransferSource(file: File): TransferSource {
  return {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    estimatedSize: file.size,
    projectedWireBytes: deflateUpperBound(file.size),
    precompressed: false,
    stream: () => file.stream(),
  };
}
