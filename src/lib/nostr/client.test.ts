import { describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => ({
  init: vi.fn(async () => undefined),
  create: vi.fn(async () => {
    throw new Error('Tor bootstrap failed');
  }),
}));

vi.mock('./tor-directory-cache', () => ({
  loadTorDirectoryCache: vi.fn(async () => undefined),
  saveTorDirectoryCache: vi.fn(async () => undefined),
}));

vi.mock('@andrewtheguy/anonymous-signaling-wasm', () => ({
  default: wasmMocks.init,
  AnonymousSignalingClient: { create: wasmMocks.create },
}));

import { createNostrClient } from './client';

/**
 * Just enough of Node's process to watch for unhandled rejections. The app
 * tsconfig deliberately exposes only vite/client, so the Node globals are not
 * typed here and widening `types` for one test would leak them into app code.
 */
interface RejectionEmitter {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}

const nodeProcess = (globalThis as unknown as { process: RejectionEmitter })
  .process;

/** Yield past the microtask queue, where an unhandled rejection is reported. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('NostrClient', () => {
  it('surfaces a failed anonymous bootstrap without an unhandled rejection', async () => {
    // The constructor starts connecting eagerly, but nothing awaits that
    // promise until the first publish/query. A bootstrap failure in between
    // must still reach the eventual awaiter, and must not be reported as an
    // unhandled rejection on the way.
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    nodeProcess.on('unhandledRejection', collect);

    try {
      const client = createNostrClient(
        ['ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion'],
        {
          anonymousSignaling: { enabled: true, webSocketBridge: false },
        },
      );

      // Let the rejection settle and any unhandledRejection fire before the
      // first awaiter attaches, which is the ordering that produced the noise.
      await nextMacrotask();
      expect(unhandled).toEqual([]);

      await expect(client.waitForConnection()).rejects.toThrow(
        'Tor bootstrap failed',
      );
      await expect(client.waitForAnonymousTransport()).rejects.toThrow(
        'Tor bootstrap failed',
      );

      client.close();
      await nextMacrotask();
      expect(unhandled).toEqual([]);
    } finally {
      nodeProcess.off('unhandledRejection', collect);
    }
  });
});
