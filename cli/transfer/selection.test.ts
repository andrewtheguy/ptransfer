import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSelection } from './selection';

/** Runs after each folder the walk lists, to change the tree under it. */
const afterListing = vi.hoisted(() => ({
  hook: null as ((folder: string) => Promise<void>) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = actual.readdir as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readdir: async (...args: unknown[]) => {
      const listed = await readdir(...args);
      await afterListing.hook?.(String(args[0]));
      return listed;
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ptransfer-cli-selection-'));
});

afterEach(async () => {
  afterListing.hook = null;
  await rm(dir, { recursive: true, force: true });
});

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

async function unpack(paths: string[]): Promise<Record<string, string>> {
  const { source } = await openSelection(paths);
  const entries = unzipSync(await readAll(source.stream()));
  return Object.fromEntries(
    Object.entries(entries).map(([name, bytes]) => [
      name,
      new TextDecoder().decode(bytes),
    ]),
  );
}

/** A folder `photos` with a nested folder, and a loose `notes.txt`. */
async function tree(): Promise<{ photos: string; notes: string }> {
  const photos = join(dir, 'photos');
  await mkdir(join(photos, '2026'), { recursive: true });
  await writeFile(join(photos, 'b.jpg'), 'bee');
  await writeFile(join(photos, '2026', 'a.jpg'), 'ay');
  const notes = join(dir, 'notes.txt');
  await writeFile(notes, 'notes');
  return { photos, notes };
}

describe('openSelection', () => {
  it('sends one file as itself', async () => {
    const { notes } = await tree();
    const { source, fileCount } = await openSelection([notes]);
    expect(source.name).toBe('notes.txt');
    expect(source.precompressed).toBe(false);
    expect(fileCount).toBe(1);
  });

  it('zips a folder under its own name, keeping its structure', async () => {
    const { photos } = await tree();
    const { source, fileCount } = await openSelection([photos]);
    expect(source.name).toMatch(/^photos_\d{14}\.zip$/);
    expect(source.type).toBe('application/zip');
    expect(source.precompressed).toBe(true);
    expect(source.estimatedSize).toBe(5);
    expect(fileCount).toBe(2);
    expect(await unpack([photos])).toEqual({
      'photos/2026/a.jpg': 'ay',
      'photos/b.jpg': 'bee',
    });
  });

  it('zips several paths side by side as files_<stamp>.zip', async () => {
    const { photos, notes } = await tree();
    const { source, fileCount } = await openSelection([notes, photos]);
    expect(source.name).toMatch(/^files_\d{14}\.zip$/);
    expect(fileCount).toBe(3);
    expect(await unpack([notes, photos])).toEqual({
      'notes.txt': 'notes',
      'photos/2026/a.jpg': 'ay',
      'photos/b.jpg': 'bee',
    });
  });

  it('names a folder given as . or with a trailing slash by its own name', async () => {
    const { photos } = await tree();
    expect(Object.keys(await unpack([`${photos}/`]))).toContain('photos/b.jpg');
    expect(Object.keys(await unpack([`${photos}/.`]))).toContain(
      'photos/b.jpg',
    );
  });

  it('streams the archive afresh for each receiver', async () => {
    const { photos } = await tree();
    const { source } = await openSelection([photos]);
    const first = await readAll(source.stream());
    expect(await readAll(source.stream())).toEqual(first);
  });

  it('stores a file dated 1970, before any ZIP date', async () => {
    const { photos } = await tree();
    await utimes(join(photos, 'b.jpg'), 1, 1);
    expect((await unpack([photos]))['photos/b.jpg']).toBe('bee');
  });

  it('leaves out a symbolic link inside a folder, and says so', async () => {
    const { photos, notes } = await tree();
    // A link back up the tree would walk forever if it were followed.
    await symlink(dir, join(photos, 'loop'));
    await symlink(notes, join(photos, 'notes-link'));
    const { fileCount, skipped } = await openSelection([photos]);
    expect(fileCount).toBe(2);
    expect(skipped.sort()).toEqual([
      join(photos, 'loop'),
      join(photos, 'notes-link'),
    ]);
  });

  it('follows a symbolic link named on the command line', async () => {
    const { photos } = await tree();
    const link = join(dir, 'album');
    await symlink(photos, link);
    expect(Object.keys(await unpack([link])).sort()).toEqual([
      'album/2026/a.jpg',
      'album/b.jpg',
    ]);
  });

  /**
   * Once the walk has listed `listed`, `photos/2026` becomes a link to a
   * folder outside `photos` holding an `a.jpg` of its own.
   */
  async function swapAfterListing(photos: string, listed: string) {
    const outside = join(dir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'a.jpg'), 'secret');
    afterListing.hook = async (folder) => {
      if (folder !== listed) return;
      afterListing.hook = null;
      await rename(join(photos, '2026'), join(dir, 'moved'));
      await symlink(outside, join(photos, '2026'));
    };
  }

  it('refuses a folder swapped for a link after its parent was listed', async () => {
    const { photos } = await tree();
    await swapAfterListing(photos, photos);
    await expect(openSelection([photos])).rejects.toThrow(
      `${join(photos, '2026')} changed while its folder was read`,
    );
  });

  it('refuses a file reached through a folder swapped for a link', async () => {
    const { photos } = await tree();
    await swapAfterListing(photos, join(photos, '2026'));
    await expect(openSelection([photos])).rejects.toThrow(
      `${join(photos, '2026', 'a.jpg')} changed while its folder was read`,
    );
  });

  it('refuses two paths that would share a name in the archive', async () => {
    const { notes } = await tree();
    const other = join(dir, 'elsewhere');
    await mkdir(other);
    await writeFile(join(other, 'notes.txt'), 'other notes');
    await expect(
      openSelection([notes, join(other, 'notes.txt')]),
    ).rejects.toThrow('would both be notes.txt in the archive');
  });

  it('refuses a missing path, and a selection with no files in it', async () => {
    await expect(openSelection([join(dir, 'missing')])).rejects.toThrow(
      'No such file or folder',
    );
    const empty = join(dir, 'empty');
    await mkdir(join(empty, 'nested'), { recursive: true });
    await expect(openSelection([empty])).rejects.toThrow('Nothing to send');
  });

  it('refuses a file replaced, grown or turned into a link after it was chosen', async () => {
    const { photos, notes } = await tree();
    const b = join(photos, 'b.jpg');
    const changed = `${b} changed after it was chosen`;

    // Written beside it first, so the replacement cannot reuse its inode.
    let { source } = await openSelection([photos]);
    await writeFile(join(dir, 'other.jpg'), 'bee');
    await rename(join(dir, 'other.jpg'), b);
    await expect(readAll(source.stream())).rejects.toThrow(changed);

    ({ source } = await openSelection([photos]));
    await writeFile(b, 'bumblebee');
    await expect(readAll(source.stream())).rejects.toThrow(changed);

    ({ source } = await openSelection([photos]));
    await rm(b);
    await symlink(notes, b);
    await expect(readAll(source.stream())).rejects.toThrow(changed);
  });

  it('refuses a file name Windows would unpack outside the folder', async () => {
    const { photos } = await tree();
    await writeFile(join(photos, '..\\escape.txt'), 'out');
    await expect(openSelection([photos])).rejects.toThrow(
      'Cannot put photos/..\\escape.txt in a ZIP',
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses an unreadable file before anything is sent',
    async () => {
      const { photos } = await tree();
      await chmod(join(photos, 'b.jpg'), 0o000);
      await expect(openSelection([photos])).rejects.toThrow(
        `Cannot read ${join(photos, 'b.jpg')}`,
      );
    },
  );
});
