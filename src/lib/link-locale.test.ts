import { describe, expect, test } from 'vitest';
import { buildChunkUrl, extractChunkParam } from './chunk-utils';
import { generatePin } from './crypto';
import { fragmentValue, linkLocale, withLinkLocale } from './link-locale';
import {
  buildOnionUrl,
  buildPinUrl,
  extractOnionFromUrl,
  extractPinFromUrl,
} from './receive-link';

const ORIGIN = 'https://ptransfer.example';
const ONION = 'zrmxlosp6cvmkhxwhx7267wkvqyztsrmloqw76eu4fhn2gsbg5zk4kad.onion';

describe('link locale', () => {
  test('an English link is unchanged', () => {
    const pin = generatePin();
    expect(buildPinUrl(ORIGIN, pin, 'en')).toBe(`${ORIGIN}/receive#p=${pin}`);
    expect(withLinkLocale(`${ORIGIN}/r#abc`, 'en')).toBe(`${ORIGIN}/r#abc`);
  });

  test("a Spanish sender's links name Spanish after the value", () => {
    const pin = generatePin();
    const url = buildPinUrl(ORIGIN, pin, 'es');
    expect(url).toBe(`${ORIGIN}/receive#p=${pin}&l=es`);
    expect(linkLocale(new URL(url).hash)).toBe('es');
    expect(extractPinFromUrl(url)).toBe(pin);

    const onionUrl = buildOnionUrl(ORIGIN, ONION, 'es');
    expect(linkLocale(new URL(onionUrl).hash)).toBe('es');
    expect(extractOnionFromUrl(onionUrl)).toBe(ONION);

    const chunk = new Uint8Array([0, 1, 0, 0, 0, 0, 42]);
    const chunkUrl = buildChunkUrl(ORIGIN, chunk, 'es');
    expect(linkLocale(new URL(chunkUrl).hash)).toBe('es');
    expect(extractChunkParam(chunkUrl)).toBe(
      extractChunkParam(buildChunkUrl(ORIGIN, chunk)),
    );
  });

  test('names no language for a fragment without one', () => {
    expect(linkLocale('')).toBeUndefined();
    expect(linkLocale('#p=abc')).toBeUndefined();
    expect(linkLocale('#abc&l=fr')).toBeUndefined();
    expect(linkLocale('#abc&x=es')).toBeUndefined();
  });

  test('the value ends at the first &', () => {
    expect(fragmentValue('#p=abc&l=es')).toBe('p=abc');
    expect(fragmentValue('#abc')).toBe('abc');
    expect(fragmentValue('')).toBe('');
  });
});
