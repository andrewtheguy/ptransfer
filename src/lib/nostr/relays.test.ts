import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_SIGNALING_RELAYS,
  canonicalRelayPool,
  DEFAULT_RELAYS,
  normalizeOnionRelayUrl,
  normalizeRelayUrl,
} from './relays';

const ONION = 'oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion';

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

describe('ANONYMOUS_SIGNALING_RELAYS', () => {
  it('is written in canonical onion form', () => {
    for (const url of ANONYMOUS_SIGNALING_RELAYS) {
      expect(normalizeOnionRelayUrl(url)).toBe(url);
    }
  });

  it('shares no relay with DEFAULT_RELAYS, so one-sided opt-in never pairs', () => {
    // The requirement that both sides enable anonymous signaling is enforced
    // by the pools being disjoint, not by a flag either side could forget.
    for (const url of ANONYMOUS_SIGNALING_RELAYS) {
      expect(normalizeRelayUrl(url)).toBeNull();
      expect(DEFAULT_RELAYS).not.toContain(url);
    }
    for (const url of DEFAULT_RELAYS) {
      expect(normalizeOnionRelayUrl(url)).toBeNull();
    }
  });

  it('is frozen and has no duplicates', () => {
    expect(Object.isFrozen(ANONYMOUS_SIGNALING_RELAYS)).toBe(true);
    expect(new Set(ANONYMOUS_SIGNALING_RELAYS).size).toBe(
      ANONYMOUS_SIGNALING_RELAYS.length,
    );
  });
});

describe('normalizeOnionRelayUrl', () => {
  it('accepts only ws:// to a v3 onion address', () => {
    expect(normalizeOnionRelayUrl(`ws://${ONION}`)).toBe(`ws://${ONION}`);
    expect(normalizeOnionRelayUrl(` WS://${ONION.toUpperCase()}/ `)).toBe(
      `ws://${ONION}`,
    );
    expect(normalizeOnionRelayUrl(`ws://${ONION}:8080/nostr/`)).toBe(
      `ws://${ONION}:8080/nostr`,
    );
  });

  it('is the mirror image of normalizeRelayUrl', () => {
    for (const bad of [
      `wss://${ONION}`,
      'ws://relay.example',
      'wss://relay.damus.io',
      'ws://abcdefghijklmnop.onion', // v2 length
      `ws://user:pw@${ONION}`,
      `http://${ONION}`,
      'not a url',
    ]) {
      expect(normalizeOnionRelayUrl(bad)).toBeNull();
    }
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

  it('builds an onion pool with the onion normalizer', () => {
    expect(
      canonicalRelayPool([`ws://${ONION}/`], 'onion', normalizeOnionRelayUrl),
    ).toEqual([`ws://${ONION}`]);
    expect(() =>
      canonicalRelayPool(
        ['wss://relay.damus.io'],
        'onion',
        normalizeOnionRelayUrl,
      ),
    ).toThrow(/onion contains an unusable relay URL/);
  });
});
