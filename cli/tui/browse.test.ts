import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRIVES,
  driveEntries,
  listDirectory,
  parentOf,
  shortenPath,
} from './browse';

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ptransfer-browse-'));
  await mkdir(join(root, 'zeta'));
  await mkdir(join(root, 'Alpha'));
  await writeFile(join(root, 'b.txt'), 'bb');
  await writeFile(join(root, 'A.txt'), 'aaaa');
  await writeFile(join(root, '.hidden'), 'x');
  await symlink(join(root, 'b.txt'), join(root, 'link.txt'));
  return root;
}

describe('listDirectory', () => {
  it('puts directories first and sorts each half by name, case aside', async () => {
    const root = await tree();
    const entries = await listDirectory(root, false);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Alpha',
      'zeta',
      'A.txt',
      'b.txt',
    ]);
  });

  it('gives files their size and directories none', async () => {
    const root = await tree();
    const entries = await listDirectory(root, false);
    expect(entries.find((entry) => entry.name === 'A.txt')?.size).toBe(4);
    expect(entries.find((entry) => entry.name === 'Alpha')?.size).toBeNull();
  });

  it('leaves out dot files unless they are asked for', async () => {
    const root = await tree();
    const shown = await listDirectory(root, true);
    expect(shown.map((entry) => entry.name)).toContain('.hidden');
  });

  it.skipIf(process.platform !== 'win32')(
    'leaves out what has the hidden attribute on Windows unless asked for',
    async () => {
      const root = await tree();
      execFileSync('attrib', ['+h', join(root, 'zeta')]);
      const names = (entries: { name: string }[]) =>
        entries.map((entry) => entry.name);
      expect(names(await listDirectory(root, false))).not.toContain('zeta');
      expect(names(await listDirectory(root, true))).toContain('zeta');
    },
  );

  it('leaves out a symbolic link, which a transfer would not carry', async () => {
    const root = await tree();
    const entries = await listDirectory(root, true);
    expect(entries.map((entry) => entry.name)).not.toContain('link.txt');
  });
});

describe('parentOf on Linux and macOS', () => {
  it('climbs one directory', () => {
    expect(parentOf('/home/user/codes', false)).toBe('/home/user');
  });

  it('stops at the root', () => {
    expect(parentOf('/', false)).toBeNull();
  });
});

describe('parentOf on Windows', () => {
  it('climbs one directory', () => {
    expect(parentOf('C:\\Users\\user', true)).toBe('C:\\Users');
  });

  it('climbs from a drive root to the drives, and stops there', () => {
    expect(parentOf('C:\\', true)).toBe(DRIVES);
    expect(parentOf(DRIVES, true)).toBeNull();
  });

  it('climbs from a network share to the drives', () => {
    expect(parentOf('\\\\server\\share\\docs', true)).toBe(
      '\\\\server\\share\\',
    );
    expect(parentOf('\\\\server\\share\\', true)).toBe(DRIVES);
  });
});

describe('driveEntries', () => {
  it('lists each mounted letter as its root', () => {
    // A, C and Z.
    const mask = (1 << 0) | (1 << 2) | (1 << 25);
    expect(driveEntries(mask, ['C:\\Users'])).toEqual([
      { name: 'A:', path: 'A:\\', directory: true, size: null },
      { name: 'C:', path: 'C:\\', directory: true, size: null },
      { name: 'Z:', path: 'Z:\\', directory: true, size: null },
    ]);
  });

  it('adds the network share the picker was opened on', () => {
    expect(driveEntries(1 << 2, ['\\\\server\\share\\docs'])).toEqual([
      { name: 'C:', path: 'C:\\', directory: true, size: null },
      {
        name: '\\\\server\\share',
        path: '\\\\server\\share\\',
        directory: true,
        size: null,
      },
    ]);
  });
});

describe('shortenPath', () => {
  // The system's own root and separator: `/` here, `C:\\` and `\\` on Windows.
  const ROOT = resolve('/');
  const HOME = join(ROOT, 'home', 'user');

  it('writes the home directory as a tilde', () => {
    expect(shortenPath(join(HOME, 'codes'), HOME)).toBe(`~${sep}codes`);
    expect(shortenPath(HOME, HOME)).toBe('~');
    const elsewhere = join(ROOT, 'etc');
    expect(shortenPath(elsewhere, HOME)).toBe(elsewhere);
    const sibling = join(ROOT, 'home', 'userdata');
    expect(shortenPath(sibling, HOME)).toBe(sibling);
  });
});
