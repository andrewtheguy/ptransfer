import { DEFAULT_LOCALE, isLocale, type Locale } from './i18n';

/**
 * The sender's language, carried in a link it hands to the receiver, as
 * specified in `docs/INTEROP_PROTOCOL.md` §1.4.
 *
 * A PIN link, an onion link and a multi-QR chunk link all point at an
 * unprefixed page and keep their value in the fragment; a sender reading
 * Spanish appends `&l=es` to that fragment — `/receive#p=<pin>&l=es`,
 * `/r#<chunk>&l=es` — and the page it opens switches to the `/es/` path of the
 * same page before it renders. English, the default, adds nothing, so an
 * English sender's links are exactly what they were.
 *
 * `&` is outside every value's alphabet — a PIN's, an onion address's,
 * base64url's — so a value always ends where the first `&` is.
 */
const LOCALE_PARAM = 'l';

/** `url` with `locale` appended to its fragment, unless it is the default. */
export function withLinkLocale(url: string, locale: Locale): string {
  return locale === DEFAULT_LOCALE ? url : `${url}&${LOCALE_PARAM}=${locale}`;
}

/** The fragment's value: what comes after `#` and before any `&`. */
export function fragmentValue(hash: string): string {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const end = fragment.indexOf('&');
  return end === -1 ? fragment : fragment.slice(0, end);
}

/** The language a link's fragment names, if it names one pTransfer speaks. */
export function linkLocale(hash: string): Locale | undefined {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of fragment.split('&').slice(1)) {
    const [name, value] = part.split('=', 2);
    if (name === LOCALE_PARAM && value !== undefined && isLocale(value)) {
      return value;
    }
  }
  return undefined;
}
