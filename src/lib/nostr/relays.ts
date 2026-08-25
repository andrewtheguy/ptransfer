// Names RFC 2606/6761 reserve, so a listed "relay" there is placeholder junk.
// RESERVED_DOMAINS do resolve — IANA runs them for documentation — but they
// will never host a relay. RESERVED_TLDS are the ones guaranteed not to
// resolve. `.example` (TLD) stays usable: it is this codebase's own
// test-fixture convention and never appears in the wild.
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['.test', '.invalid'];

/**
 * Canonical public Nostr relay URL used for identity, deduplication, cache
 * keys, exclusions, and connections throughout the application.
 */
export function normalizeRelayUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:') return null;
  const host = url.hostname;
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.onion') ||
    host.endsWith('.local') ||
    RESERVED_TLDS.some((tld) => host.endsWith(tld)) ||
    RESERVED_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  ) {
    return null;
  }
  // Drop IP literals (typically private/test relays not reachable for peers).
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `wss://${host}${url.port ? `:${url.port}` : ''}${path}${url.search}`;
}

/**
 * A hardcoded relay pool, canonicalized and deduplicated at module load.
 *
 * Relay lists that arrive at runtime — from an offer, the candidate cache,
 * NIP-66 discovery — are all put through `normalizeRelayUrl` before use, so a
 * pool written into the source is the one relay list that could otherwise
 * reach the network in a form nothing else compares equal to. Canonicalizing
 * here means a stray trailing slash or `:443` can never produce a URL that
 * fails to match its own exclusion set, cache key, or open socket.
 *
 * An entry that is not a usable relay URL at all (wrong scheme, reserved
 * name, IP literal, embedded credentials) is a broken constant, not a
 * degraded one: dropping it would silently shrink the pool, so it throws.
 */
export function canonicalRelayPool(
  urls: readonly string[],
  label: string,
): readonly string[] {
  const canonical = urls.map((url) => {
    const normalized = normalizeRelayUrl(url);
    if (normalized === null) {
      throw new Error(`${label} contains an unusable relay URL: ${url}`);
    }
    return normalized;
  });
  return Object.freeze([...new Set(canonical)]);
}

// Relays used for signaling (both sender and receiver must use the same
// list). Write entries in canonical form (no trailing slash, no default port)
// — `relays.test.ts` enforces that the source reads exactly as it is used, and
// `canonicalRelayPool` guarantees it at runtime either way.
export const DEFAULT_RELAYS = canonicalRelayPool(
  [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://nostr.rocks',
    'wss://relay.nostr.pub',
    'wss://relay.snort.social',
  ],
  'DEFAULT_RELAYS',
);
