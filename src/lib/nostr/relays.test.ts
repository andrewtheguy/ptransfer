import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_SIGNALING_RELAYS,
  canonicalRelayPool,
  DEFAULT_RELAYS,
  normalizeOnionRelayUrl,
  normalizeRelayUrl,
} from './relays';

describe('DEFAULT_RELAYS', () => {
  // The signaling pool is compared against canonical URLs everywhere it is
  // used — exclusion sets, cache keys, and the socket-closing pass that must
  // spare the relay carrying the control channel. `canonicalRelayPool` makes
  // that true at runtime; this keeps the source honest, so what a reader
  // edits is exactly what the app connects to.
  it('is written in canonical form', () => {
    for (const url of DEFAULT_RELAYS) {
      expect(normalizeRelayUrl(url)).toBe(url);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(DEFAULT_RELAYS).size).toBe(DEFAULT_RELAYS.length);
  });

  it('is frozen, so no caller can push a raw URL into the pool', () => {
    expect(Object.isFrozen(DEFAULT_RELAYS)).toBe(true);
  });
});

describe('canonicalRelayPool', () => {
  it('canonicalizes entries a hand-edit left in another form', () => {
    expect(
      canonicalRelayPool(
        ['wss://a.example:443/', 'wss://B.EXAMPLE'],
        'test pool',
      ),
    ).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('collapses entries that differ only by form', () => {
    expect(
      canonicalRelayPool(['wss://a.example', 'wss://a.example/'], 'test pool'),
    ).toEqual(['wss://a.example']);
  });

  it('throws on an entry that is not a usable relay, naming the pool', () => {
    // A silently dropped entry would shrink the pool on the live site with
    // nothing to show for it.
    for (const bad of [
      'ws://a.example',
      'wss://192.168.1.10',
      'wss://relay.invalid',
      'wss://user:pw@a.example',
      'not a url',
    ]) {
      expect(() => canonicalRelayPool([bad], 'DEFAULT_RELAYS')).toThrow(
        /DEFAULT_RELAYS contains an unusable relay URL/,
      );
    }
  });
});

describe('ANONYMOUS_SIGNALING_RELAYS', () => {
  it('is written in canonical form', () => {
    for (const url of ANONYMOUS_SIGNALING_RELAYS) {
      expect(normalizeOnionRelayUrl(url)).toBe(url);
    }
  });

  // The disjointness is the whole enforcement mechanism: a PIN's length picks
  // a pool, and the two pools must have nothing in common for that choice to
  // mean anything. An overlap would let a clearnet socket serve an anonymous
  // transfer, which is the one outcome the mode exists to prevent.
  it('shares no relay with the clearnet pool', () => {
    const clearnet = new Set<string>(DEFAULT_RELAYS);
    for (const url of ANONYMOUS_SIGNALING_RELAYS) {
      expect(clearnet.has(url)).toBe(false);
      expect(normalizeRelayUrl(url)).toBeNull();
    }
    for (const url of DEFAULT_RELAYS) {
      expect(normalizeOnionRelayUrl(url)).toBeNull();
    }
  });

  it('is frozen, so no caller can push a raw URL into the pool', () => {
    expect(Object.isFrozen(ANONYMOUS_SIGNALING_RELAYS)).toBe(true);
  });
});

describe('normalizeOnionRelayUrl', () => {
  const RELAY =
    'ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion';

  it('canonicalizes a trailing slash away', () => {
    expect(normalizeOnionRelayUrl(`${RELAY}/`)).toBe(RELAY);
  });

  it('refuses anything that is not a plain v3 onion WebSocket', () => {
    for (const bad of [
      // TLS adds nothing an onion circuit does not already prove, and
      // accepting it would blur the line this function draws.
      RELAY.replace('ws://', 'wss://'),
      // A clearnet host is the failure that matters: it would carry this
      // device's IP address to a relay.
      'ws://relay.example',
      'wss://relay.damus.io',
      // A v2 address is 16 characters and long gone from the network.
      'ws://expyuzz4wqqyqhjn.onion',
      `ws://user:pw@${RELAY.slice('ws://'.length)}`,
      'not a url',
    ]) {
      expect(normalizeOnionRelayUrl(bad)).toBeNull();
    }
  });
});
