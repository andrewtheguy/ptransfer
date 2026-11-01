import { describe, expect, it } from 'vitest';
import { detectLocale, takeLangFlag } from './locale';
import { UsageError } from './usage';

describe('detectLocale', () => {
  it('reads the language from LANG', () => {
    expect(detectLocale({ LANG: 'es_ES.UTF-8' }, 'en-US')).toBe('es');
    expect(detectLocale({ LANG: 'en_GB.UTF-8' }, 'es-ES')).toBe('en');
  });

  it('prefers LC_ALL, then LC_MESSAGES, over LANG', () => {
    expect(detectLocale({ LC_ALL: 'es_MX', LANG: 'en_US' }, 'en')).toBe('es');
    expect(
      detectLocale({ LC_MESSAGES: 'es_AR.UTF-8', LANG: 'en_US' }, 'en'),
    ).toBe('es');
    expect(detectLocale({ LC_ALL: 'C', LANG: 'es_ES' }, 'es')).toBe('en');
  });

  it('falls back to the system locale when no variable is set', () => {
    expect(detectLocale({}, 'es-419')).toBe('es');
    expect(detectLocale({ LANG: '' }, 'es-ES')).toBe('es');
    expect(detectLocale({}, 'en-US')).toBe('en');
  });

  it('is English for a language it does not speak', () => {
    expect(detectLocale({ LANG: 'fr_FR.UTF-8' }, 'es')).toBe('en');
    expect(detectLocale({ LANG: 'POSIX' }, 'es')).toBe('en');
  });
});

describe('takeLangFlag', () => {
  it('leaves argv alone without the flag', () => {
    expect(takeLangFlag(['send', '--pin', 'a.txt'])).toEqual({
      argv: ['send', '--pin', 'a.txt'],
    });
  });

  it('takes the flag out wherever it is', () => {
    expect(takeLangFlag(['--lang', 'es'])).toEqual({ locale: 'es', argv: [] });
    expect(takeLangFlag(['--lang', 'es', 'send', '--pin', 'a'])).toEqual({
      locale: 'es',
      argv: ['send', '--pin', 'a'],
    });
    expect(takeLangFlag(['receive', '--pin', '--lang=EN'])).toEqual({
      locale: 'en',
      argv: ['receive', '--pin'],
    });
  });

  it('lets the last one win', () => {
    expect(takeLangFlag(['--lang', 'en', '--lang=es']).locale).toBe('es');
  });

  it('stops at --', () => {
    expect(takeLangFlag(['send', '--', '--lang', 'es'])).toEqual({
      argv: ['send', '--', '--lang', 'es'],
    });
  });

  it('refuses a missing or unknown language', () => {
    expect(() => takeLangFlag(['--lang'])).toThrow(UsageError);
    expect(() => takeLangFlag(['--lang', '--pin'])).toThrow(UsageError);
    expect(() => takeLangFlag(['--lang', 'fr'])).toThrow(UsageError);
    expect(() => takeLangFlag(['--lang='])).toThrow(UsageError);
  });
});
