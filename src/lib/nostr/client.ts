import {
  type Event,
  type Filter,
  mergeFilters,
  verifyEvent,
} from 'nostr-tools';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { TorBridge } from '@/lib/tor/client';
import { AnonymousSignalingTransport } from './anonymous-transport';
import { normalizeOnionRelayUrl, normalizeRelayUrl } from './relays';

/**
 * How long a relay socket may take to open.
 *
 * A clearnet socket that has not connected in ten seconds is not going to. An
 * onion one is a whole rendezvous — an HSDir descriptor fetch, an introduction
 * circuit, and a rendezvous circuit — which is minutes on a bad day and still
 * the fastest path available, so it gets its own budget rather than being
 * declared dead on the clearnet clock.
 */
const DIRECT_RELAY_CONNECTION_TIMEOUT_MS = 10_000;
const ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS = 180_000;

/**
 * A pool that applies one connection timeout to every relay it opens.
 *
 * `AbstractSimplePool` takes the timeout per `ensureRelay` call and most of
 * its callers (publish, subscribe, query) never pass one, so the only place a
 * pool-wide value can be applied is here.
 */
class SignalingPool extends AbstractSimplePool {
  private readonly connectionTimeoutMs: number;

  constructor(
    websocketImplementation: typeof WebSocket | undefined,
    connectionTimeoutMs: number,
  ) {
    super({ verifyEvent, websocketImplementation });
    this.connectionTimeoutMs = connectionTimeoutMs;
  }

  override ensureRelay(url: string, params?: { connectionTimeout?: number }) {
    return super.ensureRelay(url, {
      ...params,
      connectionTimeout: Math.max(
        params?.connectionTimeout ?? 0,
        this.connectionTimeoutMs,
      ),
    });
  }
}

/** Anonymous signaling: carry this client's relay sockets through Tor. */
export interface AnonymousSignalingOptions {
  /** Which Snowflake bridge this tab reaches the Tor network through. */
  bridge: TorBridge;
  /** Progress while Tor bootstraps, which is the slow part of a cold start. */
  onStatus?: (message: string) => void;
}

export interface NostrClientOptions {
  /**
   * Present when this client's relays are onion services reached through the
   * browser Tor client. Absent for ordinary clearnet signaling.
   */
  anonymous?: AnonymousSignalingOptions;
}

export class NostrClient {
  private pool: AbstractSimplePool;
  private relays: string[];
  private subscriptions: Map<string, { close: () => void }>;
  private connectionReady: Promise<void>;
  private anonymousTransport: AnonymousSignalingTransport | null;
  /**
   * The two modes accept disjoint relay URLs: ordinary signaling only clearnet
   * `wss://`, anonymous signaling only `ws://` onion services. A URL from the
   * wrong pool is dropped here rather than handed to a socket that would
   * refuse it — which is also what makes it impossible for a relay list
   * arriving at runtime to pull an anonymous session onto a clearnet socket.
   */
  private readonly normalizeRelay: (raw: string) => string | null;

  constructor(relays: string[], options: NostrClientOptions = {}) {
    const anonymous = options.anonymous;
    this.anonymousTransport = anonymous
      ? new AnonymousSignalingTransport(anonymous)
      : null;
    this.normalizeRelay = anonymous
      ? normalizeOnionRelayUrl
      : normalizeRelayUrl;
    this.pool = new SignalingPool(
      this.anonymousTransport?.websocketImplementation,
      anonymous
        ? ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS
        : DIRECT_RELAY_CONNECTION_TIMEOUT_MS,
    );
    // Normalize and dedupe relay URLs
    this.relays = [
      ...new Set(
        relays
          .map(this.normalizeRelay)
          .filter((url): url is string => url !== null),
      ),
    ];
    this.subscriptions = new Map();

    // Pre-connect to all relays and wait for at least one to be ready
    this.connectionReady = this.ensureConnected();
    // Nothing awaits connectionReady until the first publish or query, so a
    // failure before then — an anonymous transport that never finishes
    // bootstrapping, most of all — surfaces as an unhandled rejection and
    // buries the real error in console noise. Marking it handled costs real
    // awaiters nothing: they await this same promise and still see the error.
    void this.connectionReady.catch(() => {});
  }

  /**
   * Wait for at least one relay to be connected
   * Call this before subscribe() if immediate connectivity is needed
   */
  async waitForConnection(): Promise<void> {
    await this.connectionReady;
  }

  /**
   * Wait until Tor is bootstrapped, without waiting for a relay socket.
   *
   * Only anonymous signaling has anything to wait for here, and it is worth
   * separating because the two halves fail for unrelated reasons and take
   * wildly different amounts of time: the bootstrap is the multi-minute step,
   * and once it is done, a relay that will not answer is the relay's problem.
   * No-op otherwise.
   */
  async waitForAnonymousTransport(): Promise<void> {
    await this.anonymousTransport?.waitUntilReady();
  }

  /**
   * Ensure at least one relay is connected.
   *
   * Connecting for real, rather than giving sockets a fixed head start:
   * anonymous signaling needs minutes for its first rendezvous, so a fixed
   * wait would hand every publish to a pool with nothing open, and the
   * failure would surface as a publish error naming no cause.
   */
  private async ensureConnected(relays = this.relays): Promise<void> {
    await this.anonymousTransport?.waitUntilReady();
    try {
      await Promise.any(relays.map((relay) => this.pool.ensureRelay(relay)));
    } catch {
      throw new Error(
        this.anonymousTransport
          ? 'Tor is running, but no Nostr onion relay could be reached through it'
          : 'Could not connect to any Nostr relay',
      );
    }
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
    this.anonymousTransport?.close();
    this.anonymousTransport = null;
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
          .map(this.normalizeRelay)
          .filter((url): url is string => url !== null),
      ),
    ];
    const toAdd = normalized.filter((url) => !this.relays.includes(url));

    if (toAdd.length === 0) return;

    this.relays.push(...toAdd);
    console.log(`Added ${toAdd.length} backup relays:`, toAdd);

    // Wait for new relay connections
    await this.ensureConnected(toAdd);
  }
}

/**
 * Create and return a NostrClient instance
 */
export function createNostrClient(
  relays: string[],
  options: NostrClientOptions = {},
): NostrClient {
  return new NostrClient(relays, options);
}
