import { type ZipEntry, zipWireUpperBound } from './folder-utils';
import { deflateUpperBound } from './transfer-source';

/**
 * The tab's half of a multiple file/folder selection: what its file picker
 * returns, as the ZIP entries `folder-utils` builds an archive from. The CLI
 * walks the disk for its entries instead, so nothing here is shared with it.
 */

/**
 * Check if folder selection is supported by the browser
 */
export const supportsFolderSelection =
  typeof HTMLInputElement !== 'undefined' &&
  'webkitdirectory' in HTMLInputElement.prototype;

/**
 * Picked files as ZIP entries. `webkitRelativePath` is set for a folder
 * selection ("folderName/subfolder/file.txt") and becomes the entry path, so
 * the folder structure survives; a loose file is stored under its name.
 */
export function pickedZipEntries(files: readonly File[]): ZipEntry[] {
  return files.map((file) => ({
    path: file.webkitRelativePath || file.name,
    size: file.size,
    lastModified: file.lastModified,
    stream: () => file.stream(),
  }));
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
  if (willZip) return zipWireUpperBound(pickedZipEntries(files));
  return files[0] ? deflateUpperBound(files[0].size) : 0;
}
