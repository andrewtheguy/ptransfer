import { describe, expect, it } from 'vitest';
import { BROWSER_MAX_TRANSFER_BYTES, MAX_TRANSFER_BYTES } from '@/lib/crypto';
import { ZIP_MAX_BYTES } from '@/lib/folder-utils';
import type { TransferSource } from '@/lib/transfer-source';
import { describeSendSource } from './source';

const GiB = 1024 * 1024 * 1024;

/** A selection of `size` bytes: one file, or a ZIP generated from several. */
function selectionOf(size: number, zip = false): TransferSource {
  return {
    name: zip ? 'files.zip' : 'movie.mkv',
    type: zip ? 'application/zip' : 'video/x-matroska',
    size: zip ? null : size,
    estimatedSize: size,
    projectedWireBytes: size,
    maxWireBytes: zip ? ZIP_MAX_BYTES : Number.POSITIVE_INFINITY,
    precompressed: zip,
    stream: () => new ReadableStream<Uint8Array>(),
  };
}

describe('describeSendSource', () => {
  it("holds a file to the host's ceiling it is given", () => {
    const file = selectionOf(3 * GiB);

    expect(describeSendSource(file, BROWSER_MAX_TRANSFER_BYTES)).toEqual({
      error: expect.stringContaining('exceeds'),
    });
    expect(describeSendSource(file, MAX_TRANSFER_BYTES)).toEqual({
      metadata: expect.objectContaining({ fileSize: 3 * GiB }),
    });
    expect(
      describeSendSource(selectionOf(MAX_TRANSFER_BYTES), MAX_TRANSFER_BYTES),
    ).toHaveProperty('metadata');
    expect(
      describeSendSource(
        selectionOf(MAX_TRANSFER_BYTES + 1),
        MAX_TRANSFER_BYTES,
      ),
    ).toHaveProperty('error');
  });

  it('holds a generated ZIP to what the archive can address', () => {
    expect(
      describeSendSource(selectionOf(3 * GiB, true), MAX_TRANSFER_BYTES),
    ).toHaveProperty('metadata');
    expect(
      describeSendSource(selectionOf(5 * GiB, true), MAX_TRANSFER_BYTES),
    ).toEqual({ error: expect.stringContaining('ZIP') });
  });
});
