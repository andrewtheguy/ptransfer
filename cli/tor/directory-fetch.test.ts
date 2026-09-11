import { describe, expect, it } from 'vitest';
import {
  collectDigests,
  consensusLifetime,
  parseRouterEntries,
  signingCertIds,
} from './directory-fetch';

/**
 * The shape of a microdesc consensus as far as the seed fetcher reads it: the
 * lifetime lines, router entries with their `m`, `s` and `w` lines, and the
 * signature footer. Everything the network would put around them is left
 * out, since the fetcher never looks at it — webtor does, when it installs
 * the seed.
 */
const CONSENSUS = [
  'network-status-version 3 microdesc',
  'valid-after 2026-09-10 15:00:00',
  'valid-until 2026-09-10 18:00:00',
  'r relayA AAAAAAAAAAAAAAAAAAAAAAAAAAA 2026-09-10 10:00:00 1.2.3.4 9001 0',
  'm digestA',
  's Fast Guard HSDir Running Stable V2Dir Valid',
  'w Bandwidth=1000',
  'r relayB BBBBBBBBBBBBBBBBBBBBBBBBBBB 2026-09-10 10:00:00 5.6.7.8 9001 0',
  'm digestB',
  's Fast Running Valid',
  'w Bandwidth=20 Unmeasured=1',
  'r relayC CCCCCCCCCCCCCCCCCCCCCCCCCCC 2026-09-10 10:00:00 9.9.9.9 9001 0',
  'm digestA',
  's Running',
  'directory-footer',
  'bandwidth-weights Wbd=0',
  'directory-signature sha256 27102BC123E7AF1D4741AE047E160C91ADC76B21 SK1',
  'directory-signature 27102BC123E7AF1D4741AE047E160C91ADC76B21 SK1',
  'directory-signature e8a9c45ede6d711294fadf8e7951f4de6ca56b58 SK2',
  'directory-signature 0000000000000000000000000000000000000000 SKX',
  '',
].join('\n');

describe('parseRouterEntries', () => {
  it('reads the digest, flags and bandwidth of every entry', () => {
    const entries = parseRouterEntries(CONSENSUS);
    expect(entries.map((entry) => entry.microdescDigest)).toEqual([
      'digestA',
      'digestB',
      'digestA',
    ]);
    expect(entries[0].flags.has('HSDir')).toBe(true);
    expect(entries[0].bandwidth).toBe(1000);
    expect(entries[1].bandwidth).toBe(20);
    // No `w` line at all reads as zero, not as a parse failure.
    expect(entries[2].bandwidth).toBe(0);
  });

  it('ignores an entry that never named a microdescriptor', () => {
    const entries = parseRouterEntries(
      ['r relayA x 2026-09-10 10:00:00 1.2.3.4 9001 0', 's Fast', ''].join(
        '\n',
      ),
    );
    expect(entries).toEqual([]);
  });
});

describe('signingCertIds', () => {
  it('names each pinned authority once, whatever the line format or case', () => {
    expect(signingCertIds(CONSENSUS)).toEqual([
      { id: '27102BC123E7AF1D4741AE047E160C91ADC76B21', sk: 'SK1' },
      { id: 'e8a9c45ede6d711294fadf8e7951f4de6ca56b58', sk: 'SK2' },
    ]);
  });
});

describe('consensusLifetime', () => {
  it('reads the validity window as written', () => {
    expect(consensusLifetime(CONSENSUS)).toEqual({
      after: '2026-09-10 15:00:00',
      until: '2026-09-10 18:00:00',
    });
  });
});

describe('collectDigests', () => {
  it('refuses a consensus with too few relays to build circuits from', () => {
    expect(() => collectDigests(parseRouterEntries(CONSENSUS))).toThrow(
      /too few usable relays/,
    );
  });

  it('asks for every distinct digest once', () => {
    const entries = Array.from({ length: 120 }, (_, index) => ({
      microdescDigest: `d${index % 100}`,
      flags: new Set(['Fast', 'Stable', 'V2Dir', 'HSDir']),
      bandwidth: 1,
    }));
    expect(collectDigests(entries)).toHaveLength(100);
  });
});
