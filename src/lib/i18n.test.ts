import { afterEach, describe, expect, it } from 'vitest';
import { headFor, pageFileName } from '@/i18n/pages';
import {
  getLocale,
  localizePath,
  setLocale,
  splitLocalePath,
  t,
} from '@/lib/i18n';

afterEach(() => {
  setLocale('en');
});

describe('t', () => {
  it('picks the current locale', () => {
    expect(t({ en: 'Send', es: 'Enviar' })).toBe('Send');
    setLocale('es');
    expect(getLocale()).toBe('es');
    expect(t({ en: 'Send', es: 'Enviar' })).toBe('Enviar');
  });
});

describe('splitLocalePath', () => {
  it('reads an unprefixed path as English', () => {
    expect(splitLocalePath('/')).toEqual({ locale: 'en', path: '/' });
    expect(splitLocalePath('/send/transfer')).toEqual({
      locale: 'en',
      path: '/send/transfer',
    });
  });

  it('strips the Spanish prefix', () => {
    expect(splitLocalePath('/es')).toEqual({ locale: 'es', path: '/' });
    expect(splitLocalePath('/es/')).toEqual({ locale: 'es', path: '/' });
    expect(splitLocalePath('/es/send')).toEqual({
      locale: 'es',
      path: '/send',
    });
  });

  it('does not take a path that only starts with the letters', () => {
    expect(splitLocalePath('/escape')).toEqual({
      locale: 'en',
      path: '/escape',
    });
  });
});

describe('localizePath', () => {
  it('round-trips with splitLocalePath', () => {
    for (const path of ['/', '/send', '/send/transfer', '/about']) {
      for (const locale of ['en', 'es'] as const) {
        expect(splitLocalePath(localizePath(path, locale))).toEqual({
          locale,
          path,
        });
      }
    }
  });

  it('puts the Spanish home at /es/', () => {
    expect(localizePath('/', 'es')).toBe('/es/');
    expect(localizePath('/', 'en')).toBe('/');
  });
});

describe('page heads', () => {
  it('links an indexed page to itself and its other language', () => {
    const head = headFor('/about', 'es');
    expect(head.lang).toBe('es');
    expect(head.canonical).toBe('https://ptransfer.app/es/about');
    expect(head.alternates).toEqual([
      { hreflang: 'en', href: 'https://ptransfer.app/about' },
      { hreflang: 'es', href: 'https://ptransfer.app/es/about' },
      { hreflang: 'x-default', href: 'https://ptransfer.app/about' },
    ]);
  });

  it('gives a page that is not indexed no canonical link', () => {
    const head = headFor('/send/transfer', 'es');
    expect(head.canonical).toBeUndefined();
    expect(head.alternates).toEqual([]);
    expect(head.lang).toBe('es');
  });

  it('writes each page where the host serves its path', () => {
    expect(pageFileName('/', 'en')).toBe('index.html');
    expect(pageFileName('/', 'es')).toBe('es/index.html');
    expect(pageFileName('/about', 'en')).toBe('about.html');
    expect(pageFileName('/about', 'es')).toBe('es/about.html');
  });
});
