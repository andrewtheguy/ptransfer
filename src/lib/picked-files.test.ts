import { describe, expect, it } from 'vitest';
import { zipWireUpperBound } from './folder-utils';
import { pickedZipEntries, projectedWireBytesFor } from './picked-files';
import { deflateUpperBound } from './transfer-source';

function fileOf(name: string, size: number, path?: string): File {
  const file = new File([new Uint8Array(size)], name, { lastModified: 1234 });
  if (path) {
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
  }
  return file;
}

describe('pickedZipEntries', () => {
  it('stores a folder selection under its relative path', () => {
    const [entry] = pickedZipEntries([fileOf('a.txt', 5, 'folder/sub/a.txt')]);
    expect(entry.path).toBe('folder/sub/a.txt');
    expect(entry.size).toBe(5);
    expect(entry.lastModified).toBe(1234);
  });

  it('stores a loose file under its name', () => {
    const [entry] = pickedZipEntries([fileOf('a.txt', 5)]);
    expect(entry.path).toBe('a.txt');
  });
});

describe('projectedWireBytesFor', () => {
  it('follows the flow: one loose file deflates, anything else zips', () => {
    const one = [fileOf('a.bin', 1000)];
    expect(projectedWireBytesFor(one, false)).toBe(deflateUpperBound(1000));
    expect(projectedWireBytesFor(one, true)).toBe(
      zipWireUpperBound(pickedZipEntries(one)),
    );
  });

  it('is zero for an empty selection rather than throwing', () => {
    expect(projectedWireBytesFor([], false)).toBe(0);
  });
});
