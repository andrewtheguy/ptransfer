import { execFileSync } from 'node:child_process';
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Take `access` to `path` away from this process, for a test of what the CLI
 * does without it, and give back a function that restores it.
 *
 * Unix reads the mode bits, so they are cleared. Windows does not — `chmod`
 * there only sets the read-only attribute, which a folder ignores — so the
 * ACL gets a deny entry for Everyone, and restoring removes it.
 */
export async function denyAccess(
  path: string,
  access: 'read' | 'write',
): Promise<() => Promise<void>> {
  if (process.platform === 'win32') {
    // S-1-1-0 is Everyone, named by SID so a localized Windows takes it.
    const right = access === 'read' ? '(R)' : '(W)';
    execFileSync('icacls', [path, '/deny', `*S-1-1-0:${right}`], {
      stdio: 'ignore',
    });
    return () => {
      execFileSync('icacls', [path, '/remove:d', '*S-1-1-0'], {
        stdio: 'ignore',
      });
      return Promise.resolve();
    };
  }
  const isFolder = access === 'write';
  await chmod(path, access === 'read' ? 0o000 : 0o500);
  return async () => {
    await chmod(path, isFolder ? 0o700 : 0o600);
  };
}

/**
 * Whether this process gets through `denyAccess` regardless, found by trying
 * what the CLI does: `open`, for writing in a denied folder and for reading a
 * denied file. Root does on Unix. On Windows an elevated token with the
 * backup and restore privileges enabled does — an ssh login as an
 * administrator has them — since Bun's `open`, through libuv, asks for
 * backup semantics; its `writeFile` does not, which is why the probe is an
 * `open`. A test of what the CLI does without access skips there: the CLI
 * has it.
 */
export const ACCESS_CHECKS_BYPASSED = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ptransfer-access-'));
  const folder = join(dir, 'denied');
  const file = join(dir, 'denied.txt');
  await mkdir(folder);
  await writeFile(file, 'x');
  const gotThrough = async (attempt: () => Promise<FileHandle>) => {
    try {
      await (await attempt()).close();
      return true;
    } catch {
      return false;
    }
  };
  const restoreFolder = await denyAccess(folder, 'write');
  const restoreFile = await denyAccess(file, 'read');
  try {
    return (
      (await gotThrough(() => open(join(folder, 'probe'), 'wx'))) ||
      (await gotThrough(() => open(file, 'r')))
    );
  } finally {
    await restoreFolder();
    await restoreFile();
    await rm(dir, { recursive: true, force: true });
  }
})();
