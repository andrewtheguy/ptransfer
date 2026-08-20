import type { Event, Filter } from 'nostr-tools';

/**
 * The subset of nostr-tools' SimplePool the file relay flows use. Kept
 * minimal so tests can inject a trivial mock.
 */
export interface NostrFilePool {
  publish(relays: string[], event: Event): Promise<string>[];
  querySync(
    relays: string[],
    filter: Filter,
    params?: { maxWait?: number },
  ): Promise<Event[]>;
}
