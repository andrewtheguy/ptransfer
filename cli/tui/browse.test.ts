import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirectory, parentOf, shortenPath } from './browse';

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

  it('leaves out a symbolic link, which a transfer would not carry', async () => {
    const root = await tree();
    const entries = await listDirectory(root, true);
    expect(entries.map((entry) => entry.name)).not.toContain('link.txt');
  });
});

// The system's own root and separator: `/` here, `C:\\` and `\\` on Windows.
const ROOT = resolve('/');
const HOME = join(ROOT, 'home', 'user');

describe('parentOf', () => {
  it('climbs one directory', () => {
    expect(parentOf(join(HOME, 'codes'))).toBe(HOME);
  });

  it('stops at the root', () => {
    expect(parentOf(ROOT)).toBeNull();
  });
});

describe('shortenPath', () => {
  it('writes the home directory as a tilde', () => {
    expect(shortenPath(join(HOME, 'codes'), HOME)).toBe(`~${sep}codes`);
    expect(shortenPath(HOME, HOME)).toBe('~');
    const elsewhere = join(ROOT, 'etc');
    expect(shortenPath(elsewhere, HOME)).toBe(elsewhere);
    const sibling = join(ROOT, 'home', 'userdata');
    expect(shortenPath(sibling, HOME)).toBe(sibling);
  });
});
