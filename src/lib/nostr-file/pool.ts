import type { Event, Filter } from 'nostr-tools';

export interface PoolSubscription {
  close: () => void;
}

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
  subscribeMany(
    relays: string[],
    filter: Filter,
    params: {
      onevent: (event: Event) => void;
      oneose?: () => void;
      onclose?: (reasons: string[]) => void;
    },
  ): PoolSubscription;
  /**
   * Drop the connections to these relays and stop their reconnect loops.
   * With `enableReconnect` a dead relay retries forever, so every relay a
   * probe rejected or a selection passed over must be closed — otherwise
   * dozens of useless sockets keep reconnecting for the whole transfer.
   * A closed relay reconnects transparently if it is ever used again.
   */
  close?(relays: string[]): void;
}
