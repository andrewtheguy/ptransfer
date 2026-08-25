import { describe, expect, it } from 'vitest';
import {
  canonicalRelayPool,
  DEFAULT_RELAYS,
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
