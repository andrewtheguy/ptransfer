import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_REPLICATION, NOSTR_FILE_MAX_BYTES } from './constants';
import { type DownloadProgress, downloadFileFromNostr } from './download';
import { isValidNostrFileManifest, stripeRelays } from './manifest';
import { createMockPool as createNetwork, type MockPool } from './mock-pool';
import { type UploadProgress, uploadFileToNostr } from './upload';

// crypto.getRandomValues caps at 65536 bytes per call
function randomBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(data.subarray(offset, offset + 65536));
  }
  return data;
}

function createMockPool(failRelays: Set<string> = new Set()): MockPool {
  return createNetwork({ failRelays });
}

const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example'];
const SIX_RELAYS = Array.from(
  { length: 6 },
  (_, i) => `wss://r${i + 1}.example`,
);
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

// Map of chunk index -> relays holding a copy.
function placements(pool: MockPool): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const [relay, events] of pool.store) {
    for (const ev of events) {
      const index = Number(ev.tags.find((t) => t[0] === 'chunk')?.[1]);
      const set = out.get(index) ?? new Set<string>();
      set.add(relay);
      out.set(index, set);
    }
  }
  return out;
}

describe('uploadFileToNostr', () => {
  it('stripes each chunk onto its placement relays and returns a valid manifest', async () => {
    const pool = createMockPool();
    const data = randomBytes(100_000); // 4 chunks
    const progress: UploadProgress[] = [];
    const { manifest, keyBytes } = await uploadFileToNostr(data, META, {
      onProgress: (p) => progress.push(p),
      isCancelled: never,
      pool,
      relayOverride: SIX_RELAYS,
    });

    expect(isValidNostrFileManifest(manifest)).toBe(true);
    expect(manifest.totalChunks).toBe(4);
    expect(manifest.fileSize).toBe(data.length);
    // Relay order is the placement ring and must be preserved verbatim.
    expect(manifest.relays).toEqual(SIX_RELAYS);
    expect(manifest.replication).toBe(CHUNK_REPLICATION);
    expect(keyBytes.length).toBe(32);

    const placed = placements(pool);
    for (let i = 0; i < 4; i++) {
      expect([...(placed.get(i) ?? [])].sort()).toEqual(
        stripeRelays(SIX_RELAYS, CHUNK_REPLICATION, i).sort(),
      );
    }
    let totalEvents = 0;
    for (const events of pool.store.values()) totalEvents += events.length;
    expect(totalEvents).toBe(4 * CHUNK_REPLICATION);
    const last = progress.at(-1);
    expect(last).toMatchObject({
      phase: 'uploading',
      chunksDone: 4,
      chunksTotal: 4,
    });

    // Detailed stats: every publish accepted first try, two copies per chunk.
    const stats = last?.stats;
    expect(stats).toMatchObject({
      role: 'sender',
      variant: 'stored',
      fileBytes: data.length,
      chunksTotal: 4,
      eventsPublished: 4 * CHUNK_REPLICATION,
      publishAttempts: 4 * CHUNK_REPLICATION,
      publishesFailed: 0,
      fallbackPublishes: 0,
    });
    // Z85 over deflate+GCM: encoded output exceeds the (incompressible) raw
    // size, and the published volume is replication × the encoded size.
    expect(stats!.encodedBytes).toBeGreaterThan(data.length);
    expect(stats!.bytesPublished).toBe(stats!.encodedBytes * CHUNK_REPLICATION);
    expect(stats!.relays.map((r) => r.url)).toEqual(SIX_RELAYS);
    const perRelayAccepted = stats!.relays.reduce(
      (sum, r) => sum + r.eventsAccepted,
      0,
    );
    expect(perRelayAccepted).toBe(4 * CHUNK_REPLICATION);
  });

  it('falls back to the next ring relay when a placed relay is dead', async () => {
    const pool = createMockPool(new Set(['wss://r3.example']));
    const data = randomBytes(100_000); // 4 chunks
    vi.useFakeTimers();
    const uploadProgress: UploadProgress[] = [];
    const promise = uploadFileToNostr(data, META, {
      onProgress: (p) => uploadProgress.push(p),
      isCancelled: never,
      pool,
      relayOverride: RELAYS,
    });
    // Drive the retry backoff timers of the dead relay.
    await settleWithFakeTimers(promise);
    const { manifest, keyBytes } = await promise;
    expect(manifest.relays).toEqual(RELAYS);
    expect(pool.store.get('wss://r3.example')).toBeUndefined();
    // Every chunk still has two copies, on the two live relays.
    const placed = placements(pool);
    for (let i = 0; i < 4; i++) {
      expect([...(placed.get(i) ?? [])].sort()).toEqual([
        'wss://r1.example',
        'wss://r2.example',
      ]);
    }
    // Chunks 1 and 2 had the dead relay in their stripe: each records one
    // failed publish (after retries) and one accepted fallback copy.
    const uploadStats = uploadProgress.at(-1)?.stats;
    expect(uploadStats).toMatchObject({
      eventsPublished: 4 * CHUNK_REPLICATION,
      publishesFailed: 2,
      fallbackPublishes: 2,
    });
    const dead = uploadStats!.relays.find((r) => r.url === 'wss://r3.example')!;
    expect(dead.eventsAccepted).toBe(0);
    expect(dead.publishesFailed).toBe(2);
    expect(dead.publishAttempts).toBeGreaterThan(2); // retries counted

    // The sweep pass finds the fallback copies that are off their stripe.
    const downloadProgress: DownloadProgress[] = [];
    const download = downloadFileFromNostr(manifest, keyBytes, {
      onProgress: (p) => downloadProgress.push(p),
      isCancelled: never,
      pool,
    });
    await settleWithFakeTimers(download);
    expect(await download).toEqual(data);
    const downloadStats = downloadProgress.at(-1)?.stats;
    expect(downloadStats).toMatchObject({
      role: 'receiver',
      variant: 'stored',
      chunksTotal: 4,
      corruptEvents: 0,
    });
    // Each chunk kept one on-stripe copy, so the placement pass finds
    // everything and no sweep is needed.
    expect(downloadStats!.sweepPasses).toBe(0);
    const supplied = downloadStats!.relays.reduce(
      (sum, r) => sum + r.chunksSupplied,
      0,
    );
    expect(supplied).toBe(4);
    expect(downloadStats!.bytesReceived).toBeGreaterThan(data.length);
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
    // Corrupt every copy on the first relay.
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

  it('reads only each relay stripe in the placement pass', async () => {
    const pool = createMockPool();
    const data = randomBytes(100_000); // 4 chunks
    const { manifest, keyBytes } = await uploadFileToNostr(data, META, {
      onProgress: noProgress,
      isCancelled: never,
      pool,
      relayOverride: SIX_RELAYS,
    });
    const asked = new Map<string, string[]>();
    const originalQuery = pool.querySync.bind(pool);
    pool.querySync = async (relays, filter, params) => {
      const list = asked.get(relays[0]) ?? [];
      list.push(...(filter['#d'] ?? []));
      asked.set(relays[0], list);
      return originalQuery(relays, filter, params);
    };
    const downloaded = await downloadFileFromNostr(manifest, keyBytes, {
      onProgress: noProgress,
      isCancelled: never,
      pool,
    });
    expect(downloaded).toEqual(data);
    // Everything arrived in the placement pass, so each relay was asked for
    // exactly its stripe and nothing else.
    for (let pos = 0; pos < SIX_RELAYS.length; pos++) {
      const expected: string[] = [];
      for (let i = 0; i < 4; i++) {
        if (
          stripeRelays(SIX_RELAYS, CHUNK_REPLICATION, i).includes(
            SIX_RELAYS[pos],
          )
        ) {
          expected.push(`${manifest.transferId}:${i}`);
        }
      }
      expect((asked.get(SIX_RELAYS[pos]) ?? []).sort()).toEqual(
        expected.sort(),
      );
    }
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
