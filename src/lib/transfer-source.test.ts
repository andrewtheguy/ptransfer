import { describe, expect, it } from 'vitest';
import {
  deflateUpperBound,
  projectedWireBytesFor,
  zipWireUpperBound,
} from './transfer-source';

function fileOf(name: string, size: number, path?: string): File {
  const file = new File([new Uint8Array(size)], name);
  if (path) {
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
  }
  return file;
}

describe('deflateUpperBound', () => {
  it('bounds input above its own size, because deflate can grow it', () => {
    // Incompressible input comes out larger, so a bound at `size` would be
    // wrong exactly when the wire ceiling matters.
    expect(deflateUpperBound(0)).toBeGreaterThan(0);
    expect(deflateUpperBound(1_000_000)).toBeGreaterThan(1_000_000);
  });
});

describe('zipWireUpperBound', () => {
  it('charges every entry for its headers and its path, twice', () => {
    // 500 one-byte files are 500 bytes of input and orders of magnitude more
    // on the wire — the case an input-size check cannot see.
    const files = Array.from({ length: 500 }, (_, i) =>
      fileOf(`entry-${i}.txt`, 1),
    );
    const inputBytes = files.reduce((total, f) => total + f.size, 0);

    expect(inputBytes).toBe(500);
    expect(zipWireUpperBound(files)).toBeGreaterThan(100 * inputBytes);
  });

  it('counts the entry path, so nesting costs more than a flat name', () => {
    const flat = [fileOf('a.txt', 10)];
    const nested = [fileOf('a.txt', 10, 'deeply/nested/folder/path/a.txt')];

    expect(zipWireUpperBound(nested)).toBeGreaterThan(zipWireUpperBound(flat));
  });
});

describe('projectedWireBytesFor', () => {
  it('follows the flow: one loose file deflates, anything else zips', () => {
    const one = [fileOf('a.bin', 1000)];
    expect(projectedWireBytesFor(one, false)).toBe(deflateUpperBound(1000));
    expect(projectedWireBytesFor(one, true)).toBe(zipWireUpperBound(one));
  });

  it('is zero for an empty selection rather than throwing', () => {
    expect(projectedWireBytesFor([], false)).toBe(0);
  });
});
