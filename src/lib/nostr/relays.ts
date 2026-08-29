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

// A v3 onion address: 56 base32 characters (the service key, checksum and
// version byte) followed by `.onion`. v2 addresses are gone from the network.
const ONION_V3_HOST = /^[a-z2-7]{56}\.onion$/;

/**
 * Canonical onion-service relay URL for anonymous signaling: the mirror image
 * of `normalizeRelayUrl`. Only `ws://<v3 address>.onion` is accepted.
 *
 * `wss://` is refused along with every clearnet host, and that is not an
 * oversight. An onion circuit is already encrypted and authenticated end to
 * end by the key the address commits to, so TLS on top would add nothing the
 * WASM client could meaningfully verify. Refusing clearnet is the stronger
 * half: it is what guarantees an anonymous-signaling socket can never be
 * opened to a host that would see this device's IP address.
 */
export function normalizeOnionRelayUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:') return null;
  if (!ONION_V3_HOST.test(url.hostname)) return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `ws://${url.hostname}${url.port ? `:${url.port}` : ''}${path}${url.search}`;
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
  normalize: (raw: string) => string | null = normalizeRelayUrl,
): readonly string[] {
  const canonical = urls.map((url) => {
    const normalized = normalize(url);
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

// Relays used for signaling when the sender turns on Anonymous signaling,
// reached as v3 onion services through the browser Tor client. This pool is
// disjoint from DEFAULT_RELAYS on purpose: a sender and a receiver find each
// other only on a shared relay, so the PIN's length deciding the pool is what
// makes the mode agree end to end without a flag in the protocol for either
// side to lie about — and neither side's IP reaches a relay the other side's
// clearnet socket would have exposed anyway.
//
// Candidates come from 0xtrr/onion-service-nostr-relays. Answering a REQ is
// not enough: signaling has to write — the sender's kind-4243 rendezvous and
// both sides' kind-24243 handshakes — under a throwaway key, and most onion
// relays that serve reads refuse exactly that (paid admission, whitelists) or
// answer OK and then silently drop the event. These are the ones that
// accepted both kinds from a fresh key and served the rendezvous back. The
// list is community-maintained and tracks no uptime, so this is a set of
// candidates that passed on a given day, not a monitored pool. Each relay
// costs its own rendezvous circuit, so it is kept small.
export const ANONYMOUS_SIGNALING_RELAYS = canonicalRelayPool(
  [
    'ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion', // nostr.oxtr.dev
    'ws://gnostr2jnapk72mnagq3cuykfon73temzp77hcbncn4silgt77boruid.onion', // nostr.girino.org
  ],
  'ANONYMOUS_SIGNALING_RELAYS',
  normalizeOnionRelayUrl,
);
