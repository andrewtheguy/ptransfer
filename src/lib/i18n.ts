/**
 * The languages pTransfer speaks, and the one it is speaking now.
 *
 * Every string a person reads is written at the place it is used, once per
 * language, as a `Localized` record: `t({ en: 'Sending...', es: 'Enviando...' })`.
 * A record must name every locale, so adding one to `LOCALES` makes the type
 * checker list every string that still needs it.
 *
 * Both hosts run this module. The current locale is process-wide state each
 * host sets once it knows it — the browser tab from the URL's `/es/` prefix
 * (`src/i18n/locale-provider.tsx`), the CLI from the environment's locale
 * (`cli/locale.ts`) — so protocol code that reports a status or throws an error
 * says it in the person's language without being handed one.
 *
 * What travels to the peer is not written here: a reason sent on the wire is
 * read by someone whose language this side does not know, so it stays in
 * English, as the protocol documents in `docs/` specify it.
 *
 * No platform API here: the CLI imports it.
 */

export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the language of the unprefixed site and of the CLI by default. */
export const DEFAULT_LOCALE: Locale = 'en';

/** One value per locale: a string, or anything a host renders, such as JSX. */
export type Localized<T = string> = Record<Locale, T>;

/** The language's own name, which is how a language picker lists it. */
export const LOCALE_NAMES: Localized = {
  en: 'English',
  es: 'Español',
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

let current: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
}

/** The current locale's value of `messages`. */
export function t<T>(messages: Localized<T>): T {
  return messages[current];
}

/**
 * The locale a URL path is in, and the path with its locale prefix removed:
 * `/es/send` is `/send` in Spanish, `/es` and `/es/` are `/`, and a path with
 * no prefix is English. The app routes on the stripped path, so each page is
 * declared once for every language.
 */
export function splitLocalePath(pathname: string): {
  locale: Locale;
  path: string;
} {
  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const prefix = `/${locale}`;
    if (pathname === prefix) return { locale, path: '/' };
    if (pathname.startsWith(`${prefix}/`)) {
      return { locale, path: pathname.slice(prefix.length) };
    }
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}

/**
 * `path`, an app path such as `/send`, as it is addressed in `locale`:
 * unchanged in English, under `/es/` in Spanish. The Spanish home is `/es/`,
 * with the slash, since that is the directory its page is served from.
 */
export function localizePath(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return path;
  return path === '/' ? `/${locale}/` : `/${locale}${path}`;
}
