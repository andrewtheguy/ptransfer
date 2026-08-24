import type { Event, Filter } from 'nostr-tools';
import type { NostrFilePool } from './pool';

/**
 * In-memory relay network for tests: per-relay event stores, query/filter
 * matching, and live subscriptions fed on publish (deduplicated per
 * subscription, like SimplePool). Not used in production code.
 */
export interface MockPool extends NostrFilePool {
  store: Map<string, Event[]>;
  /** Relays passed to close(), in call order (duplicates included). */
  closedRelays: string[];
}

export interface MockPoolOptions {
  /** Relays whose publishes are rejected. */
  failRelays?: Set<string>;
  /** Relays that acknowledge publishes but never store (or serve) them. */
  blackholeRelays?: Set<string>;
  /** Observe or delay every publish before the relay acts on it. */
  beforePublish?: (relay: string, event: Event) => Promise<void> | void;
}

function matches(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue;
    const wanted = (filter as Record<string, string[] | undefined>)[key];
    if (!wanted) continue;
    const tagName = key.slice(1);
    const values = event.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
    if (!values.some((v) => wanted.includes(v))) return false;
  }
  return true;
}

interface Subscription {
  relays: Set<string>;
  filter: Filter;
  onevent: (event: Event) => void;
  seen: Set<string>;
}

export function createMockPool(opts: MockPoolOptions = {}): MockPool {
  const failRelays = opts.failRelays ?? new Set<string>();
  const blackholeRelays = opts.blackholeRelays ?? new Set<string>();
  const store = new Map<string, Event[]>();
  const subscriptions = new Set<Subscription>();
  const closedRelays: string[] = [];

  const deliver = (relay: string, event: Event) => {
    for (const sub of subscriptions) {
      if (!sub.relays.has(relay) || sub.seen.has(event.id)) continue;
      if (!matches(event, sub.filter)) continue;
      sub.seen.add(event.id);
      // Relays deliver asynchronously.
      queueMicrotask(() => {
        if (subscriptions.has(sub)) sub.onevent(event);
      });
    }
  };

  return {
    store,
    closedRelays,
    close(relays) {
      // Connection teardown only — stored events stay, like a real relay.
      closedRelays.push(...relays);
    },
    publish(relays, event) {
      return relays.map(async (relay) => {
        await opts.beforePublish?.(relay, event);
        if (failRelays.has(relay)) throw new Error('relay down');
        if (blackholeRelays.has(relay)) return 'ok';
        const list = store.get(relay) ?? [];
        // Copy: each relay holds its own instance, like the real network.
        const copy = { ...event, tags: event.tags.map((t) => [...t]) };
        list.push(copy);
        store.set(relay, list);
        deliver(relay, copy);
        return 'ok';
      });
    },
    async querySync(relays, filter) {
      const out: Event[] = [];
      for (const relay of relays) {
        // Newest first, then `limit` — how a relay answers a filter, and what
        // makes `until` paging able to walk backwards through history.
        const hits = (store.get(relay) ?? [])
          .filter((ev) => matches(ev, filter))
          .sort((a, b) => b.created_at - a.created_at);
        out.push(
          ...(filter.limit === undefined ? hits : hits.slice(0, filter.limit)),
        );
      }
      return out;
    },
    subscribeMany(relays, filter, params) {
      const sub: Subscription = {
        relays: new Set(relays),
        filter,
        onevent: params.onevent,
        seen: new Set(),
      };
      subscriptions.add(sub);
      // Stored backlog first, then EOSE, then live events.
      for (const relay of relays) {
        for (const ev of store.get(relay) ?? []) deliver(relay, ev);
      }
      queueMicrotask(() => params.oneose?.());
      return {
        close: () => {
          subscriptions.delete(sub);
        },
      };
    },
  };
}
