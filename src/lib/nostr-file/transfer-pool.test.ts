import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransferPool } from './transfer-pool';

/**
 * Stand-in for the browser WebSocket: never connects, records close calls.
 * Exercises exactly the case nostr-tools leaks — a socket still CONNECTING
 * when the pool is closed or destroyed.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  addEventListener(): void {}
  send(): void {}
  close(): void {
    this.closeCalls++;
    this.readyState = FakeWebSocket.CLOSING;
  }
}

function socketFor(url: string): FakeWebSocket | undefined {
  return FakeWebSocket.instances.find((ws) => ws.url.startsWith(url));
}

describe('createTransferPool', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('close(relays) aborts a socket still mid-handshake', () => {
    const pool = createTransferPool();
    pool.ensureRelay('wss://x.example').catch(() => {});
    pool.ensureRelay('wss://y.example').catch(() => {});
    expect(FakeWebSocket.instances).toHaveLength(2);

    pool.close(['wss://x.example']);
    expect(socketFor('wss://x.example')?.closeCalls).toBe(1);
    expect(socketFor('wss://y.example')?.closeCalls).toBe(0);
    pool.destroy();
  });

  it('destroy() closes every socket, connecting ones included', () => {
    const pool = createTransferPool();
    pool.ensureRelay('wss://x.example').catch(() => {});
    pool.ensureRelay('wss://y.example').catch(() => {});

    pool.destroy();
    for (const ws of FakeWebSocket.instances) {
      expect(ws.closeCalls).toBeGreaterThanOrEqual(1);
    }
  });

  it('opens a supplied implementation instead of the global, and still tracks it', () => {
    // What Code Exchange's anonymous relay passes: the onion-only adapter,
    // which is not the platform WebSocket and must not be bypassed for one.
    class OnionSocket extends FakeWebSocket {
      static onionInstances = 0;
      constructor(url: string | URL) {
        super(url);
        OnionSocket.onionInstances++;
      }
    }
    const pool = createTransferPool({
      websocketImplementation: OnionSocket as unknown as typeof WebSocket,
    });
    pool.ensureRelay('ws://a.onion').catch(() => {});
    expect(OnionSocket.onionInstances).toBe(1);

    // Tracking and teardown are the whole point of this pool; a socket still
    // building its onion circuit is exactly the case it exists for.
    pool.destroy();
    expect(socketFor('ws://a.onion')?.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('refuses to open new sockets after destroy()', async () => {
    const pool = createTransferPool();
    pool.destroy();
    // An orphaned reconnect loop (or a straggling publish) trying to dial
    // out after teardown must die instead of opening an untracked socket.
    await expect(pool.ensureRelay('wss://z.example')).rejects.toThrow(
      'Transfer pool destroyed',
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
