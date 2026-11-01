import { describe, expect, it } from 'vitest';
import { detectLocale } from './locale';

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
