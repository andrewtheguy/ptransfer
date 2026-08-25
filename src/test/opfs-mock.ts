/**
 * Minimal in-memory OPFS mock for tests.
 *
 * Node has no origin-private file system, and the scratch sinks require one
 * for payloads over 100 MiB. This implements just the surface the
 * app touches — `navigator.storage.getDirectory`, directory/file handles,
 * async key iteration and `createWritable` with the real API's swap-file
 * semantics (writes are invisible until `close()` commits them).
 */

type WriteChunk =
  | BufferSource
  | { type: 'write'; position?: number; data: BufferSource };

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data.slice();
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer.slice(0),
      data.byteOffset,
      data.byteLength,
    ).slice();
  }
  return new Uint8Array(data.slice(0));
}

class MockWritableFileStream {
  private data = new Uint8Array(0);
  private size = 0;
  private cursor = 0;
  private state: 'open' | 'closed' | 'aborted' = 'open';
  private readonly commit: (data: Uint8Array) => void;

  constructor(commit: (data: Uint8Array) => void) {
    this.commit = commit;
  }

  private ensureOpen(): void {
    if (this.state !== 'open') {
      throw new Error(`Stream is ${this.state}`);
    }
  }

  private grow(minLength: number): void {
    if (minLength <= this.data.length) return;
    const next = new Uint8Array(Math.max(minLength, this.data.length * 2));
    next.set(this.data);
    this.data = next;
  }

  async write(chunk: WriteChunk): Promise<void> {
    this.ensureOpen();
    let position = this.cursor;
    let source: BufferSource;
    if ('type' in chunk && chunk.type === 'write') {
      position = chunk.position ?? this.cursor;
      source = chunk.data;
    } else {
      source = chunk as BufferSource;
    }
    const bytes = toBytes(source);
    this.grow(position + bytes.length);
    this.data.set(bytes, position);
    this.cursor = position + bytes.length;
    this.size = Math.max(this.size, this.cursor);
  }

  async truncate(newSize: number): Promise<void> {
    this.ensureOpen();
    this.grow(newSize);
    this.size = newSize;
    this.cursor = Math.min(this.cursor, newSize);
  }

  async close(): Promise<void> {
    this.ensureOpen();
    this.state = 'closed';
    this.commit(this.data.slice(0, this.size));
  }

  async abort(): Promise<void> {
    this.ensureOpen();
    this.state = 'aborted';
  }
}

class MockFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  private committed: Uint8Array = new Uint8Array(0);

  constructor(name: string) {
    this.name = name;
  }

  async createWritable(): Promise<MockWritableFileStream> {
    return new MockWritableFileStream((data) => {
      this.committed = data;
    });
  }

  async getFile(): Promise<File> {
    return new File([this.committed as BlobPart], this.name);
  }
}

export class MockDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly entries = new Map<string, MockFileHandle | MockDirectoryHandle>();

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<MockDirectoryHandle> {
    const existing = this.entries.get(name);
    if (existing instanceof MockDirectoryHandle) return existing;
    if (existing) throw new Error(`TypeMismatch: ${name} is a file`);
    if (!opts?.create) throw new Error(`NotFound: ${name}`);
    const dir = new MockDirectoryHandle(name);
    this.entries.set(name, dir);
    return dir;
  }

  async getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<MockFileHandle> {
    const existing = this.entries.get(name);
    if (existing instanceof MockFileHandle) return existing;
    if (existing) throw new Error(`TypeMismatch: ${name} is a directory`);
    if (!opts?.create) throw new Error(`NotFound: ${name}`);
    const file = new MockFileHandle(name);
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name)) throw new Error(`NotFound: ${name}`);
  }

  async *keys(): AsyncIterableIterator<string> {
    yield* [...this.entries.keys()];
  }
}

// Deliberately untyped view of globalThis: the mock overwrites lib.dom
// globals with incompatible test doubles.
type MutableGlobal = Record<string, unknown>;

export interface OpfsMock {
  /** The OPFS root; tests can inspect or seed entries through it. */
  root: MockDirectoryHandle;
  /** Remove the mock so OPFS reads as unsupported again. */
  uninstall: () => void;
}

/** Install the mock onto `globalThis`; returns a handle to the root. */
export function installOpfsMock(): OpfsMock {
  const g = globalThis as unknown as MutableGlobal;
  const root = new MockDirectoryHandle('');

  const previousFileHandle = g.FileSystemFileHandle;
  g.FileSystemFileHandle = MockFileHandle;

  if (typeof g.navigator === 'undefined') {
    Object.defineProperty(g, 'navigator', { value: {}, configurable: true });
  }
  const previousStorage = Object.getOwnPropertyDescriptor(
    g.navigator as object,
    'storage',
  );
  Object.defineProperty(g.navigator as object, 'storage', {
    value: { getDirectory: async () => root },
    configurable: true,
  });

  return {
    root,
    uninstall: () => {
      g.FileSystemFileHandle = previousFileHandle;
      if (previousStorage) {
        Object.defineProperty(
          g.navigator as object,
          'storage',
          previousStorage,
        );
      } else {
        delete (g.navigator as { storage?: unknown }).storage;
      }
    },
  };
}
