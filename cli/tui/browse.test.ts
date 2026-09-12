import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('parentOf', () => {
  it('climbs one directory', () => {
    expect(parentOf('/home/user/codes')).toBe('/home/user');
  });

  it('stops at the root', () => {
    expect(parentOf('/')).toBeNull();
  });
});

describe('shortenPath', () => {
  it('writes the home directory as a tilde', () => {
    expect(shortenPath('/home/user/codes', '/home/user')).toBe('~/codes');
    expect(shortenPath('/home/user', '/home/user')).toBe('~');
    expect(shortenPath('/etc', '/home/user')).toBe('/etc');
    expect(shortenPath('/home/userdata', '/home/user')).toBe('/home/userdata');
  });
});
