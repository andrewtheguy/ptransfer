import { type FileHandle, open } from 'node:fs/promises';

/**
 * An exclusive advisory lock on a file, for a read-modify-write that other
 * processes on this machine must not interleave with.
 *
 * It is `flock(2)`, which neither Bun nor Node exposes, called through
 * `bun:ffi`. flock rather than a lock file created with O_EXCL because the
 * kernel owns it: a process that dies holding it — Ctrl-C mid-write, a crash
 * — releases it as it goes, so there is never a stale lock to detect and
 * break. Linux and macOS number the operations alike.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** How often a lock someone else holds is tried again. */
const RETRY_MS = 10;

type Flock = (fd: number, operation: number) => number;

let loaded: Promise<Flock> | undefined;

function loadFlock(): Promise<Flock> {
  loaded ??= (async () => {
    const { dlopen, FFIType } = await import('bun:ffi');
    const libc = dlopen(
      process.platform === 'darwin'
        ? '/usr/lib/libSystem.B.dylib'
        : 'libc.so.6',
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
    );
    return libc.symbols.flock;
  })();
  return loaded;
}

/** Run `critical`, and anything it awaits, while holding a lock. */
export type FileLock = <T>(critical: () => Promise<T>) => Promise<T>;

/**
 * The lock on `path`, created if it does not exist. Taking it waits up to
 * `waitMs` for another holder — a holder keeps it for one read-modify-write,
 * milliseconds — and rejects after that, as it does where flock cannot be
 * loaded at all.
 */
export function fileLock(path: string, waitMs = 5000): FileLock {
  return async (critical) => {
    const flock = await loadFlock();
    const handle: FileHandle = await open(path, 'a');
    try {
      const deadline = Date.now() + waitMs;
      // Non-blocking and polled: a blocking flock would stop the event loop,
      // and with it every transfer this process is running.
      while (flock(handle.fd, LOCK_EX | LOCK_NB) !== 0) {
        if (Date.now() > deadline) {
          throw new Error(`${path} stayed locked for ${waitMs / 1000}s`);
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
      try {
        return await critical();
      } finally {
        flock(handle.fd, LOCK_UN);
      }
    } finally {
      // Closing the descriptor would release the lock by itself.
      await handle.close();
    }
  };
}
