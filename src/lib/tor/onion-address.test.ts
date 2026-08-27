import { describe, expect, it } from 'vitest';
import {
  formatOnionAddress,
  isOnionHost,
  parseOnionAddress,
  TOR_DEFAULT_PORT,
} from './onion-address';

/** A real address printed by ptransfer-cli, so the checksum is genuine. */
const ONION = 'zrmxlosp6cvmkhxwhx7267wkvqyztsrmloqw76eu4fhn2gsbg5zk4kad.onion';
/** The Tor Project's own v3 address, as a second independent vector. */
const OTHER = 'vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion';

describe('parseOnionAddress', () => {
  it('gives a bare address the default port', () => {
    expect(parseOnionAddress(ONION)).toEqual({
      host: ONION,
      port: TOR_DEFAULT_PORT,
      onion: `${ONION}:${TOR_DEFAULT_PORT}`,
      display: ONION,
    });
  });

  it('lets a port in the address win', () => {
    expect(parseOnionAddress(`${ONION}:1234`)?.port).toBe(1234);
    expect(parseOnionAddress(`${ONION}:1234`)?.onion).toBe(`${ONION}:1234`);
  });

  it('drops only the default port from what a person is shown', () => {
    // The handshake binding always carries the port; the display never does
    // unless the port is one the receiver could not have assumed.
    expect(parseOnionAddress(`${ONION}:${TOR_DEFAULT_PORT}`)?.display).toBe(
      ONION,
    );
    expect(parseOnionAddress(`${ONION}:1234`)?.display).toBe(`${ONION}:1234`);
  });

  it('round-trips the displayed address back to the same binding', () => {
    // What the sender copies is re-parsed by the receiver, so the two forms
    // have to land on one `<host>:<port>` or the SPAKE2 roots diverge.
    for (const address of [ONION, `${ONION}:1234`, ONION.toUpperCase()]) {
      const parsed = parseOnionAddress(address);
      expect(parseOnionAddress(parsed?.display ?? '')?.onion).toBe(
        parsed?.onion,
      );
    }
  });

  it('canonicalizes the case', () => {
    // Both peers bind their handshake to this string, so an address typed in a
    // different case must not produce a different binding.
    expect(parseOnionAddress(ONION.toUpperCase())?.onion).toBe(
      `${ONION}:${TOR_DEFAULT_PORT}`,
    );
  });

  it('trims surrounding whitespace from a pasted address', () => {
    expect(parseOnionAddress(`  ${ONION}\n`)?.host).toBe(ONION);
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(parseOnionAddress(`${ONION}:`)).toBeNull();
    expect(parseOnionAddress(`${ONION}:http`)).toBeNull();
    expect(parseOnionAddress(`${ONION}:0`)).toBeNull();
    expect(parseOnionAddress(`${ONION}:70000`)).toBeNull();
  });

  it('rejects a host that is not an onion address', () => {
    // Without this a typo that drops the suffix would leave the onion network.
    expect(parseOnionAddress('example.com')).toBeNull();
    expect(parseOnionAddress('example.com:80')).toBeNull();
    expect(parseOnionAddress('127.0.0.1:9735')).toBeNull();
    expect(parseOnionAddress('')).toBeNull();
  });

  it('rejects a malformed or mistyped onion host', () => {
    // Too short to be v3, a bad checksum, a subdomain, and a character outside
    // the base32 alphabet.
    expect(parseOnionAddress('abc.onion')).toBeNull();
    expect(parseOnionAddress(`a${ONION.slice(1)}`)).toBeNull();
    expect(parseOnionAddress(`www.${ONION}`)).toBeNull();
    expect(parseOnionAddress(`1${ONION.slice(1)}`)).toBeNull();
  });

  it('rejects an address whose version byte is not 3', () => {
    // The last base32 character carries the low bits of the version byte;
    // every other spelling of it fails either the version or the checksum.
    const label = ONION.slice(0, -'.onion'.length);
    for (const last of 'abcdefghijklmnopqrstuvwxyz234567') {
      if (last === label[label.length - 1]) continue;
      expect(
        parseOnionAddress(`${label.slice(0, -1)}${last}.onion`),
      ).toBeNull();
    }
  });
});

describe('isOnionHost', () => {
  it('accepts genuine v3 addresses and nothing else', () => {
    expect(isOnionHost(ONION)).toBe(true);
    expect(isOnionHost(OTHER)).toBe(true);
    // A port belongs to parseOnionAddress, not here.
    expect(isOnionHost(`${ONION}:9735`)).toBe(false);
    expect(isOnionHost('example.onion')).toBe(false);
  });
});

describe('formatOnionAddress', () => {
  it('leaves the default port implicit and keeps any other', () => {
    expect(formatOnionAddress(ONION, TOR_DEFAULT_PORT)).toBe(ONION);
    expect(formatOnionAddress(OTHER, 1234)).toBe(`${OTHER}:1234`);
  });
});
