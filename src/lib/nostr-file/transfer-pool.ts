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
export function createTransferPool(): AbstractSimplePool {
  const sockets = new Set<WebSocket>();
  let destroyed = false;

  class TrackedWebSocket extends WebSocket {
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
