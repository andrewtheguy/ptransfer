import { describe, expect, test } from 'vitest';
import { extractChunkParam } from './chunk-utils';
import { generatePin, PIN_CHARSET, PIN_LENGTH } from './crypto';
import {
  buildOnionUrl,
  buildPinUrl,
  extractOnionFromUrl,
  extractPinFromUrl,
} from './receive-link';
import { TOR_DEFAULT_PORT } from './tor/onion-address';

const ORIGIN = 'https://ptransfer.example';
/** A real address printed by ptransfer-cli, so the checksum is genuine. */
const ONION = 'zrmxlosp6cvmkhxwhx7267wkvqyztsrmloqw76eu4fhn2gsbg5zk4kad.onion';

/** Swap one character for a different one from the charset. */
function corrupt(pin: string): string {
  const replacement =
    PIN_CHARSET[(PIN_CHARSET.indexOf(pin[0]) + 1) % PIN_CHARSET.length];
  return replacement + pin.slice(1);
}

describe('PIN links', () => {
  test('round-trips a generated PIN', () => {
    const pin = generatePin();
    expect(extractPinFromUrl(buildPinUrl(ORIGIN, pin))).toBe(pin);
  });

  test('lands on the consolidated receive screen', () => {
    const url = new URL(buildPinUrl(ORIGIN, generatePin()));
    expect(url.pathname).toBe('/receive');
  });

  test('a trailing slash on the origin does not double up', () => {
    const pin = generatePin();
    expect(buildPinUrl(`${ORIGIN}/`, pin)).toBe(buildPinUrl(ORIGIN, pin));
  });

  test('rejects a PIN whose checksum does not hold', () => {
    const pin = generatePin();
    expect(extractPinFromUrl(buildPinUrl(ORIGIN, corrupt(pin)))).toBeNull();
  });

  test('rejects a truncated PIN rather than returning part of one', () => {
    const pin = generatePin();
    expect(
      extractPinFromUrl(`${ORIGIN}/receive#p=${pin.slice(0, 6)}`),
    ).toBeNull();
  });

  test('rejects other fragment shapes', () => {
    const pin = generatePin();
    expect(extractPinFromUrl(`${ORIGIN}/receive#${pin}`)).toBeNull();
    expect(extractPinFromUrl(`${ORIGIN}/receive?p=${pin}`)).toBeNull();
    expect(extractPinFromUrl(`${ORIGIN}/receive`)).toBeNull();
  });

  test('rejects input that is not a URL', () => {
    expect(extractPinFromUrl(generatePin())).toBeNull();
    expect(extractPinFromUrl('')).toBeNull();
    expect(extractPinFromUrl('not a url at all')).toBeNull();
  });

  // The `=` separator is what keeps the two QR vocabularies apart: a PIN link
  // must never look like an offer chunk to the Code Exchange parser.
  test('a PIN link is not a chunk URL', () => {
    expect(extractChunkParam(buildPinUrl(ORIGIN, generatePin()))).toBeNull();
  });

  test('a bare PIN would have collided without the separator', () => {
    const pin = generatePin();
    expect(pin).toHaveLength(PIN_LENGTH);
    expect(extractChunkParam(`${ORIGIN}/receive#${pin}`)).toBe(pin);
  });
});

describe('Tor address links', () => {
  test('round-trips an address', () => {
    expect(extractOnionFromUrl(buildOnionUrl(ORIGIN, ONION))).toBe(ONION);
  });

  test('lands on the same receive screen a PIN link does', () => {
    const url = new URL(buildOnionUrl(ORIGIN, ONION));
    expect(url.pathname).toBe(
      new URL(buildPinUrl(ORIGIN, generatePin())).pathname,
    );
  });

  test('carries a non-default port through', () => {
    expect(extractOnionFromUrl(buildOnionUrl(ORIGIN, `${ONION}:1234`))).toBe(
      `${ONION}:1234`,
    );
  });

  test('comes back in the canonical spelling both peers bind to', () => {
    // Upper case and a redundant default port are both things a hand-built
    // link can carry; the handshake only ever sees one form of either.
    expect(
      extractOnionFromUrl(buildOnionUrl(ORIGIN, ONION.toUpperCase())),
    ).toBe(ONION);
    expect(
      extractOnionFromUrl(
        buildOnionUrl(ORIGIN, `${ONION}:${TOR_DEFAULT_PORT}`),
      ),
    ).toBe(ONION);
  });

  test('rejects an address whose checksum does not hold', () => {
    const corrupted = `a${ONION.slice(1)}`;
    expect(extractOnionFromUrl(buildOnionUrl(ORIGIN, corrupted))).toBeNull();
  });

  test('rejects other fragment shapes and non-URLs', () => {
    expect(extractOnionFromUrl(`${ORIGIN}/receive#${ONION}`)).toBeNull();
    expect(extractOnionFromUrl(`${ORIGIN}/receive?o=${ONION}`)).toBeNull();
    expect(extractOnionFromUrl(ONION)).toBeNull();
    expect(extractOnionFromUrl('not a url at all')).toBeNull();
  });

  // The two prefixes share one fragment namespace, so neither parser may
  // answer for the other's link, and neither may look like an offer chunk.
  test('does not collide with the PIN link or a chunk URL', () => {
    const onionLink = buildOnionUrl(ORIGIN, ONION);
    expect(extractPinFromUrl(onionLink)).toBeNull();
    expect(extractChunkParam(onionLink)).toBeNull();
    expect(extractOnionFromUrl(buildPinUrl(ORIGIN, generatePin()))).toBeNull();
  });
});
