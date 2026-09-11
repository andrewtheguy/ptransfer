import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CachedRelay } from '@/lib/nostr-file/relay-pool';
import type { FileLock } from '../file-lock';
import { openRelayStore } from './relay-store';

function relay(url: string, lastCheckedAt: number | null = null): CachedRelay {
  return {
    url,
    lastDiscoveredAt: 1,
    lastCheckedAt,
    lastSucceededAt: null,
    rttMs: null,
    consecutiveFailures: 0,
    supportsControl: false,
    supportsStorage: false,
  };
}

/** One lock for this process, standing in for flock under Node. */
function mutex(): FileLock {
  let chain: Promise<unknown> = Promise.resolve();
  return (critical) => {
    const run = chain.then(critical);
    chain = run.catch(() => undefined);
    return run;
  };
}

const cacheDir = () => mkdtemp(join(tmpdir(), 'ptransfer-relay-store-'));

describe('openRelayStore', () => {
  it('keeps what a change leaves, and reads it back', async () => {
    const dir = await cacheDir();
    const store = openRelayStore(dir, mutex());
    const result = await store.update((cache) => {
      cache.state = {
        candidates: ['wss://a.example'],
        discoveredAt: 5,
        cursor: 2,
      };
      cache.relays = [relay('wss://a.example')];
      return 'answered';
    });
    expect(result).toBe('answered');
    expect(await openRelayStore(dir, mutex()).read()).toEqual({
      state: { candidates: ['wss://a.example'], discoveredAt: 5, cursor: 2 },
      relays: [relay('wss://a.example')],
    });
    // Written by rename: no part file is left behind.
    expect(await readdir(dir)).toEqual(['relay-cache.json']);
  });

  it('applies changes to one another rather than over one another', async () => {
    const store = openRelayStore(await cacheDir(), mutex());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.update((cache) => {
          cache.relays = [...cache.relays, relay(`wss://r${i}.example`)];
        }),
      ),
    );
    expect((await store.read()).relays).toHaveLength(20);
  });

  it('reads anything but a cache of this version as an empty one', async () => {
    const dir = await cacheDir();
    const store = openRelayStore(dir, mutex());
    expect(await store.read()).toEqual({ state: null, relays: [] });
    await writeFile(join(dir, 'relay-cache.json'), 'not json');
    expect(await store.read()).toEqual({ state: null, relays: [] });
    await writeFile(
      join(dir, 'relay-cache.json'),
      JSON.stringify({
        version: 1,
        state: null,
        relays: [relay('wss://a.example')],
      }),
    );
    expect(await store.read()).toEqual({ state: null, relays: [] });
  });

  it('still answers a change it cannot keep', async () => {
    const dir = await cacheDir();
    const busy: FileLock = () => Promise.reject(new Error('locked'));
    const result = await openRelayStore(dir, busy).update((cache) => {
      cache.relays = [relay('wss://a.example')];
      return cache.relays.length;
    });
    expect(result).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('raises what a change throws, having run it once', async () => {
    const dir = await cacheDir();
    const failure = new Error('change failed');
    let calls = 0;
    await expect(
      openRelayStore(dir, mutex()).update(() => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    // Nothing was written: the cache is what it was.
    expect(await readdir(dir)).toEqual([]);
  });

  it('loses nothing to writers in other processes', async () => {
    // Real processes and the real flock: what two terminals sending at once
    // do to one cache.
    const dir = await cacheDir();
    const store = resolve(import.meta.dirname, 'relay-store.ts');
    const writer = (id: number) =>
      new Promise<void>((done, fail) => {
        const child = spawn(
          'bun',
          [
            '-e',
            `const { openRelayStore } = await import(${JSON.stringify(store)});
             const cache = openRelayStore(${JSON.stringify(dir)});
             for (let n = 0; n < 15; n++) {
               await cache.update((c) => {
                 c.relays = [...c.relays, {
                   url: 'wss://w${id}-' + n + '.example', lastDiscoveredAt: 1,
                   lastCheckedAt: null, lastSucceededAt: null, rttMs: null,
                   consecutiveFailures: 0, supportsControl: false,
                   supportsStorage: false,
                 }];
               });
             }`,
          ],
          { stdio: ['ignore', 'ignore', 'inherit'] },
        );
        child.once('error', fail);
        child.once('exit', (code) =>
          code === 0 ? done() : fail(new Error(`writer exited ${code}`)),
        );
      });
    await Promise.all([0, 1, 2, 3].map(writer));
    const file = JSON.parse(
      await readFile(join(dir, 'relay-cache.json'), 'utf8'),
    );
    expect(file.relays).toHaveLength(60);
  }, 30_000);
});
