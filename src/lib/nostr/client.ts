import { type Event, type Filter, mergeFilters, SimplePool } from 'nostr-tools';
import { DEFAULT_RELAYS, normalizeRelayUrl } from './relays';

export class NostrClient {
  private pool: SimplePool;
  private relays: string[];
  private subscriptions: Map<string, { close: () => void }>;
  private connectionReady: Promise<void>;

  constructor(relays: string[] = [...DEFAULT_RELAYS]) {
    this.pool = new SimplePool();
    // Normalize and dedupe relay URLs
    this.relays = [
      ...new Set(
        relays
          .map(normalizeRelayUrl)
          .filter((url): url is string => url !== null),
      ),
    ];
    this.subscriptions = new Map();

    // Pre-connect to all relays and wait for at least one to be ready
    this.connectionReady = this.ensureConnected();
  }

  /**
   * Wait for at least one relay to be connected
   * Call this before subscribe() if immediate connectivity is needed
   */
  async waitForConnection(): Promise<void> {
    await this.connectionReady;
  }

  /**
   * Ensure at least one relay is connected
   */
  private ensureConnected(): Promise<void> {
    // Give relays time to connect by doing a dummy subscription
    // This triggers connection establishment in SimplePool
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 3000); // Max 3s wait

      // Subscribe to a filter that won't match anything, just to trigger connection
      const sub = this.pool.subscribeMany(
        this.relays,
        { kinds: [99999], limit: 1 },
        {
          oneose: () => {
            clearTimeout(timeout);
            sub.close();
            resolve();
          },
        },
      );
    });
  }

  /**
   * Publish an event to all connected relays with retry
   */
  async publish(event: Event, maxRetries: number = 3): Promise<void> {
    // Wait for connections to be established
    await this.connectionReady;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await Promise.any(this.pool.publish(this.relays, event));
        return; // Success
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries - 1) {
          // Wait before retry (exponential backoff: 500ms, 1000ms, 2000ms)
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          );
        }
      }
    }

    // All retries failed
    console.error(
      `Failed to publish to any relay after ${maxRetries} attempts:`,
      {
        relays: this.relays,
        eventKind: event.kind,
        error: lastError?.message,
      },
    );
    throw lastError;
  }

  /**
   * Subscribe to events matching filters
   * Returns a subscription ID that can be used to unsubscribe
   */
  subscribe(
    filters: Filter[],
    onEvent: (event: Event) => void,
    onEose?: () => void,
  ): string {
    const subId = crypto.randomUUID();
    if (filters.length === 0) {
      throw new Error('subscribe requires at least one filter');
    }
    const filter = filters.length === 1 ? filters[0] : mergeFilters(...filters);

    const sub = this.pool.subscribeMany(this.relays, filter, {
      onevent: onEvent,
      oneose: onEose,
    });

    this.subscriptions.set(subId, sub);
    return subId;
  }

  /**
   * Unsubscribe from a specific subscription
   */
  unsubscribe(subId: string): void {
    const sub = this.subscriptions.get(subId);
    if (sub) {
      sub.close();
      this.subscriptions.delete(subId);
    }
  }

  /**
   * Query for events (one-time fetch)
   */
  async query(filters: Filter[]): Promise<Event[]> {
    // Wait for connections to be established
    await this.connectionReady;

    const results: Event[] = [];
    for (const filter of filters) {
      const events = await this.pool.querySync(this.relays, filter);
      results.push(...events);
    }
    return results;
  }

  /**
   * Get a single event by filters
   */
  async get(filters: Filter[]): Promise<Event | null> {
    const events = await this.query(filters);
    return events[0] ?? null;
  }

  /**
   * Close all subscriptions and the pool
   */
  close(): void {
    for (const sub of this.subscriptions.values()) {
      sub.close();
    }
    this.subscriptions.clear();
    this.pool.close(this.relays);
  }

  /**
   * Get the list of relays being used
   */
  getRelays(): string[] {
    return [...this.relays];
  }

  /**
   * Add additional relays to the pool (for backup relay fallback)
   */
  async addRelays(newRelays: string[]): Promise<void> {
    const normalized = [
      ...new Set(
        newRelays
          .map(normalizeRelayUrl)
          .filter((url): url is string => url !== null),
      ),
    ];
    const toAdd = normalized.filter((url) => !this.relays.includes(url));

    if (toAdd.length === 0) return;

    this.relays.push(...toAdd);
    console.log(`Added ${toAdd.length} backup relays:`, toAdd);

    // Wait for new relay connections
    await this.ensureConnected();
  }
}

/**
 * Create and return a NostrClient instance
 */
export function createNostrClient(relays?: string[]): NostrClient {
  return new NostrClient(relays);
}
