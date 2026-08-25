// Relays used for signaling (both sender and receiver must use the same list)
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.rocks',
  'wss://relay.nostr.pub',
  'wss://relay.snort.social',
] as const;

// RFC 2606/6761 names that never resolve on the public internet — a listed
// "relay" there is placeholder junk. `.example` (TLD) stays usable: it is
// this codebase's own test-fixture convention and never appears in the wild.
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
