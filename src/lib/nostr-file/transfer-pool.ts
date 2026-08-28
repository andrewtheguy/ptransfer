import { verifyEvent } from 'nostr-tools';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { normalizeRelayUrl } from '../nostr/relays';

/**
 * Relay pool for a live transfer, with teardown that actually tears down.
 *
 * nostr-tools only closes a socket whose readyState is OPEN. One still mid
 * handshake when `close()`/`destroy()` runs survives the teardown, finishes
 * connecting later, and then idles on the page for good — keepalive traffic
 * to relays long after the transfer ended. And a relay whose connect attempt
 * timed out keeps the half-open socket around with its handlers attached;
 * when that orphan finally drops, the reconnect machinery starts a loop that
 * nothing references and nothing can stop.
 *
 * This pool tracks every WebSocket it ever opens and force-closes them —
 * mid-handshake included — when a relay is closed or the pool is destroyed.
 * After `destroy()` it refuses to open sockets at all, which also kills any
 * orphaned reconnect loop for good.
 */
export interface TransferPoolOptions {
  /**
   * What to open relay connections with. Defaults to the platform's
   * `WebSocket`; Code Exchange's anonymous relay passes the onion-only
   * adapter from `AnonymousSignalingTransport`, which is the whole of what
   * moves that transfer's control channel into Tor. Tracking and teardown are
   * unchanged either way — the adapter answers to the same interface, and a
   * socket still building its onion circuit is exactly the mid-handshake case
   * this pool exists to force-close.
   */
  websocketImplementation?: typeof WebSocket;
  /**
   * How long a socket may take to connect. `AbstractSimplePool` takes this per
   * `ensureRelay` call and most of its callers (publish, subscribe) never pass
   * one, so a pool-wide value can only be applied by wrapping the method.
   * Left alone by default, which is right for clearnet relays; an onion socket
   * is a whole rendezvous and needs its own budget.
   */
  connectionTimeoutMs?: number;
}

export function createTransferPool(
  options: TransferPoolOptions = {},
): AbstractSimplePool {
  const sockets = new Set<WebSocket>();
  let destroyed = false;
  const Base = options.websocketImplementation ?? WebSocket;

  class TrackedWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (destroyed) throw new Error('Transfer pool destroyed');
      super(url, protocols);
      sockets.add(this);
      this.addEventListener('close', () => sockets.delete(this));
    }
  }

  const pool = new AbstractSimplePool({
    verifyEvent,
    websocketImplementation: TrackedWebSocket,
    // Reconnect dropped sockets: the control channel subscription has to
    // outlive transient relay hiccups.
    enableReconnect: true,
  });

  const baseClose = pool.close.bind(pool);
  const baseDestroy = pool.destroy.bind(pool);
  const baseEnsureRelay = pool.ensureRelay.bind(pool);

  const connectionTimeout = options.connectionTimeoutMs;
  if (connectionTimeout !== undefined) {
    pool.ensureRelay = (url, params) =>
      baseEnsureRelay(url, {
        ...params,
        connectionTimeout: Math.max(
          params?.connectionTimeout ?? 0,
          connectionTimeout,
        ),
      });
  }

  pool.close = (relays) => {
    baseClose(relays);
    const targets = new Set(relays.map((url) => normalizeRelayUrl(url) ?? url));
    for (const ws of [...sockets]) {
      if (targets.has(normalizeRelayUrl(ws.url) ?? ws.url)) ws.close();
    }
  };

  pool.destroy = () => {
    destroyed = true;
    baseDestroy();
    for (const ws of [...sockets]) ws.close();
    sockets.clear();
  };

  return pool;
}
