import type { Event } from 'nostr-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOSTR_FILE_MAX_BYTES } from './constants';
import { downloadFileFromNostr } from './download';
import { isValidNostrFileManifest } from './manifest';
import type { NostrFilePool } from './pool';
import { type UploadProgress, uploadFileToNostr } from './upload';

interface MockPool extends NostrFilePool {
  store: Map<string, Event[]>;
}

// crypto.getRandomValues caps at 65536 bytes per call
function randomBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(data.subarray(offset, offset + 65536));
  }
  return data;
}

function createMockPool(failRelays: Set<string> = new Set()): MockPool {
  const store = new Map<string, Event[]>();
  return {
    store,
    publish(relays, event) {
      return relays.map(async (relay) => {
        if (failRelays.has(relay)) throw new Error('relay down');
        const list = store.get(relay) ?? [];
        // Copy: each relay holds its own instance, like the real network.
        list.push({ ...event, tags: event.tags.map((t) => [...t]) });
        store.set(relay, list);
        return 'ok';
      });
    },
    async querySync(relays, filter) {
      const out: Event[] = [];
      for (const relay of relays) {
        for (const ev of store.get(relay) ?? []) {
          if (filter.kinds && !filter.kinds.includes(ev.kind)) continue;
          if (filter.authors && !filter.authors.includes(ev.pubkey)) continue;
          const dTags = filter['#d'];
          if (dTags) {
            const d = ev.tags.find((t) => t[0] === 'd')?.[1];
            if (!d || !dTags.includes(d)) continue;
          }
          out.push(ev);
        }
      }
      return out;
    },
  };
}

const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example'];
const META = {
  fileName: 'test.bin',
  mimeType: 'application/octet-stream',
};
const noProgress = () => {};
const never = () => false;

afterEach(() => {
  vi.useRealTimers();
});

// Advance fake timers until the promise settles (backoff timers are only
// scheduled after async crypto work, so a single runAllTimersAsync can race).
async function settleWithFakeTimers<T>(promise: Promise<T>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await vi.advanceTimersByTimeAsync(1000);
  }
}

describe('uploadFileToNostr', () => {
  it('uploads every chunk to every relay and returns a valid manifest', async () => {
    const pool = createMockPool();
    const data = randomBytes(100_000); // 4 chunks
    const progress: UploadProgress[] = [];
    const { manifest, keyBytes } = await uploadFileToNostr(data, META, {
      onProgress: (p) => progress.push(p),
      isCancelled: never,
      pool,
      relayOverride: RELAYS,
    });

    expect(isValidNostrFileManifest(manifest)).toBe(true);
    expect(manifest.totalChunks).toBe(4);
    expect(manifest.fileSize).toBe(data.length);
    expect(new Set(manifest.relays)).toEqual(new Set(RELAYS));
    expect(keyBytes.length).toBe(32);
    for (const relay of RELAYS) {
      expect(pool.store.get(relay)?.length).toBe(4);
    }
    const last = progress.at(-1);
    expect(last).toEqual({ phase: 'uploading', chunksDone: 4, chunksTotal: 4 });
  });

  it('tolerates a minority of dead relays', async () => {
    const pool = createMockPool(new Set(['wss://r3.example']));
    const data = randomBytes(1000);
    vi.useFakeTimers();
    const promise = uploadFileToNostr(data, META, {
      onProgress: noProgress,
      isCancelled: never,
      pool,
      relayOverride: RELAYS,
    });
    // Drive the retry backoff timers of the dead relay.
    await settleWithFakeTimers(promise);
    const { manifest } = await promise;
    // Best-accepting relays sort first; the dead relay sorts last.
    expect(manifest.relays.at(-1)).toBe('wss://r3.example');
    expect(pool.store.get('wss://r3.example')).toBeUndefined();
  });

  it('aborts the whole upload when a chunk cannot reach enough relays', async () => {
    const pool = createMockPool(
      new Set(['wss://r2.example', 'wss://r3.example']),
    );
    const data = randomBytes(1000);
    vi.useFakeTimers();
    const promise = uploadFileToNostr(data, META, {
      onProgress: noProgress,
      isCancelled: never,
      pool,
      relayOverride: RELAYS,
    });
    await settleWithFakeTimers(promise);
    await expect(promise).rejects.toThrow(
      /could not be saved to enough relays/,
    );
  });

  it('rejects oversized and empty inputs up front', async () => {
    const pool = createMockPool();
    const opts = {
      onProgress: noProgress,
      isCancelled: never,
      pool,
      relayOverride: RELAYS,
    };
    await expect(
      uploadFileToNostr(new Uint8Array(0), META, opts),
    ).rejects.toThrow(/empty/);
    await expect(
      uploadFileToNostr(new Uint8Array(NOSTR_FILE_MAX_BYTES + 1), META, opts),
    ).rejects.toThrow(/too large/);
    expect(pool.store.size).toBe(0);
  });

  it('honors cancellation', async () => {
    const pool = createMockPool();
    const data = randomBytes(1000);
    await expect(
      uploadFileToNostr(data, META, {
        onProgress: noProgress,
        isCancelled: () => true,
        pool,
        relayOverride: RELAYS,
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe('downloadFileFromNostr', () => {
  async function uploadedFixture(size = 100_000) {
    const pool = createMockPool();
    const data = randomBytes(size);
    const { manifest, keyBytes } = await uploadFileToNostr(data, META, {
      onProgress: noProgress,
      isCancelled: never,
      pool,
      relayOverride: RELAYS,
    });
    return { pool, data, manifest, keyBytes };
  }

  it('round-trips an upload', async () => {
    const { pool, data, manifest, keyBytes } = await uploadedFixture();
    const downloaded = await downloadFileFromNostr(manifest, keyBytes, {
      onProgress: noProgress,
      isCancelled: never,
      pool,
    });
    expect(downloaded).toEqual(data);
  });

  it('recovers a chunk corrupted on one relay from another relay', async () => {
    const { pool, data, manifest, keyBytes } = await uploadedFixture();
    // Corrupt every copy on the first relay the download will try.
    const firstRelay = manifest.relays[0];
    const events = pool.store.get(firstRelay);
    if (!events) throw new Error('fixture missing relay events');
    for (const ev of events) {
      const tail = ev.content.endsWith('00') ? '11' : '00';
      ev.content = `${ev.content.slice(0, -2)}${tail}`;
    }
    const downloaded = await downloadFileFromNostr(manifest, keyBytes, {
      onProgress: noProgress,
      isCancelled: never,
      pool,
    });
    expect(downloaded).toEqual(data);
  });

  it('fails clearly when chunks are gone from every relay', async () => {
    const { pool, manifest, keyBytes } = await uploadedFixture();
    // Drop chunk 0 everywhere (as an expiring relay would).
    for (const [relay, events] of pool.store) {
      pool.store.set(
        relay,
        events.filter(
          (ev) =>
            ev.tags.find((t) => t[0] === 'd')?.[1] !==
            `${manifest.transferId}:0`,
        ),
      );
    }
    await expect(
      downloadFileFromNostr(manifest, keyBytes, {
        onProgress: noProgress,
        isCancelled: never,
        pool,
      }),
    ).rejects.toThrow(/could not be retrieved/);
  });

  it('rejects an expired manifest without touching the network', async () => {
    const { pool, manifest, keyBytes } = await uploadedFixture(1000);
    const expired = {
      ...manifest,
      createdAt: manifest.createdAt - 100_000,
      expiresAt: manifest.expiresAt - 100_000,
    };
    const querySpy = vi.spyOn(pool, 'querySync');
    await expect(
      downloadFileFromNostr(expired, keyBytes, {
        onProgress: noProgress,
        isCancelled: never,
        pool,
      }),
    ).rejects.toThrow(/expired/);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('rejects a mismatched whole-file hash', async () => {
    const { pool, manifest, keyBytes } = await uploadedFixture(1000);
    const tampered = {
      ...manifest,
      fileHash: `${'A'.repeat(43)}=`,
    };
    await expect(
      downloadFileFromNostr(tampered, keyBytes, {
        onProgress: noProgress,
        isCancelled: never,
        pool,
      }),
    ).rejects.toThrow(/integrity/);
  });
});
