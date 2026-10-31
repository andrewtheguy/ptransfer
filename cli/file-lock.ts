import { createHash } from 'node:crypto';
import { type FileHandle, open } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * An exclusive lock named by a file, for a read-modify-write that other
 * processes on this machine must not interleave with.
 *
 * The kernel owns it on every system, so a process that dies holding it —
 * Ctrl-C mid-write, a crash — releases it as it goes, and there is never a
 * stale lock to detect and break. Neither Bun nor Node exposes such a lock, so
 * it is called through `bun:ffi`:
 *
 * - On Linux and macOS, `flock(2)` on the file itself, which the two number
 *   alike.
 * - On Windows, a named mutex. Windows has no advisory lock on a file
 *   descriptor Bun hands out, and a mutex abandoned by a dead holder goes to
 *   the next waiter. Its name is a hash of the file's absolute path, so
 *   processes agree on it without the file being opened at all.
 *
 * A Windows mutex is re-entered by the thread that holds it, and every lock
 * in this process is taken on one thread, so two holders in one process
 * would both get it. Locks on one path are therefore also queued in process,
 * which `flock` on two separate opens of the file did on its own.
 */

/** How often a lock someone else holds is tried again. */
const RETRY_MS = 10;

/** Try to take the lock; true once it is held. */
type Acquire = () => boolean;

interface Held {
  tryAcquire: Acquire;
  release(): void;
  close(): Promise<void> | void;
}

type Platform = (path: string) => Promise<Held> | Held;

let platform: Promise<Platform> | undefined;

function loadPlatform(): Promise<Platform> {
  platform ??= (async () => {
    const ffi = await import('bun:ffi');
    return process.platform === 'win32' ? windowsMutex(ffi) : unixFlock(ffi);
  })();
  return platform;
}

type Ffi = typeof import('bun:ffi');

function unixFlock({ dlopen, FFIType }: Ffi): Platform {
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  const LOCK_UN = 8;
  const { flock } = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
  ).symbols;
  return async (path) => {
    const handle: FileHandle = await open(path, 'a');
    return {
      tryAcquire: () => flock(handle.fd, LOCK_EX | LOCK_NB) === 0,
      release: () => {
        flock(handle.fd, LOCK_UN);
      },
      // Closing the descriptor would release the lock by itself.
      close: () => handle.close(),
    };
  };
}

function windowsMutex({ dlopen, FFIType, ptr }: Ffi): Platform {
  const WAIT_OBJECT_0 = 0;
  const WAIT_ABANDONED = 0x80;
  const { CreateMutexW, WaitForSingleObject, ReleaseMutex, CloseHandle } =
    dlopen('kernel32.dll', {
      CreateMutexW: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
        returns: FFIType.ptr,
      },
      WaitForSingleObject: {
        args: [FFIType.ptr, FFIType.u32],
        returns: FFIType.u32,
      },
      ReleaseMutex: { args: [FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
  return (path) => {
    // Windows paths are case-insensitive, so the name is too. `Global\` so a
    // process in another session — an ssh login beside a desktop one — sees
    // the same mutex.
    const digest = createHash('sha256')
      .update(resolve(path).toLowerCase())
      .digest('hex');
    const name = Buffer.from(`Global\\ptransfer-${digest}\0`, 'utf16le');
    const mutex = CreateMutexW(null, 0, ptr(name));
    if (!mutex) throw new Error(`Cannot create the lock for ${path}`);
    return {
      tryAcquire: () => {
        const status = WaitForSingleObject(mutex, 0);
        // An abandoned mutex is held all the same: its holder died, which is
        // exactly what the kernel owning it is for.
        return status === WAIT_OBJECT_0 || status === WAIT_ABANDONED;
      },
      release: () => {
        ReleaseMutex(mutex);
      },
      close: () => {
        CloseHandle(mutex);
      },
    };
  };
}

/** Run `critical`, and anything it awaits, while holding a lock. */
export type FileLock = <T>(critical: () => Promise<T>) => Promise<T>;

/** The tail of each path's in-process queue. */
const queues = new Map<string, Promise<unknown>>();

/**
 * The lock on `path`, created if it does not exist. Taking it waits up to
 * `waitMs` for another holder — a holder keeps it for one read-modify-write,
 * milliseconds — and rejects after that, as it does where the lock cannot be
 * loaded at all. The wait covers the in-process queue and the kernel lock
 * together, from the moment the lock is asked for.
 */
export function fileLock(path: string, waitMs = 5000): FileLock {
  const key = resolve(path);
  return (critical) => {
    const deadline = Date.now() + waitMs;
    const previous = queues.get(key) ?? Promise.resolve();
    const run = (async () => {
      await turn(previous, deadline, path, waitMs);
      return locked(path, deadline, waitMs, critical);
    })();
    // The next in line waits for the holder ahead too, not only for this
    // caller: one that gave up waiting must not let it in while that holder
    // still runs, which on Windows the re-entrant mutex would not stop.
    const tail = Promise.all([previous, run.catch(() => undefined)]);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  };
}

function stayedLocked(path: string, waitMs: number): Error {
  return new Error(`${path} stayed locked for ${waitMs / 1000}s`);
}

/** Wait for the holder ahead in this process, until `deadline`. */
async function turn(
  previous: Promise<unknown>,
  deadline: number,
  path: string,
  waitMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(stayedLocked(path, waitMs)),
      Math.max(deadline - Date.now(), 0),
    );
  });
  try {
    await Promise.race([previous, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function locked<T>(
  path: string,
  deadline: number,
  waitMs: number,
  critical: () => Promise<T>,
): Promise<T> {
  const held = await (await loadPlatform())(path);
  try {
    // Non-blocking and polled: a blocking wait would stop the event loop,
    // and with it every transfer this process is running.
    while (!held.tryAcquire()) {
      if (Date.now() > deadline) throw stayedLocked(path, waitMs);
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
    try {
      return await critical();
    } finally {
      held.release();
    }
  } finally {
    await held.close();
  }
}
