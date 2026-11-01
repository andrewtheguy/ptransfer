import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type Localized,
  localizePath,
} from '../lib/i18n';

/**
 * The pages a search engine should index, in every language, with the title
 * and description each is listed under.
 *
 * The build (`vite.config.ts`) writes a copy of `index.html` per page and
 * locale with these in its head — `es/about.html` is served at `/es/about` —
 * and a sitemap of them; the app (`use-document-head.ts`) sets the same head
 * while it runs, for a page reached by navigating rather than by loading it.
 *
 * Relative imports only: `vite.config.ts` loads this module, without the `@/`
 * alias.
 */

/** Where the site is published: canonical and alternate links are absolute. */
export const SITE_ORIGIN = 'https://ptransfer.app';

interface PageHead {
  title: Localized;
  description: Localized;
}

const DEFAULT_HEAD: PageHead = {
  title: {
    en: 'pTransfer — private, end-to-end encrypted file transfer',
    es: 'pTransfer — transferencia de archivos privada y cifrada de extremo a extremo',
  },
  description: {
    en: 'Share files and folders securely with end-to-end encryption',
    es: 'Comparte archivos y carpetas de forma segura con cifrado de extremo a extremo',
  },
};

export const INDEXED_PAGES: Record<string, PageHead> = {
  '/': DEFAULT_HEAD,
  '/send': {
    title: {
      en: 'Send files — pTransfer',
      es: 'Enviar archivos — pTransfer',
    },
    description: {
      en: 'Send files and folders straight from your device, end-to-end encrypted, by PIN, connection code, or a Tor onion service.',
      es: 'Envía archivos y carpetas directamente desde tu dispositivo, cifrados de extremo a extremo, con un PIN, un código de conexión o un servicio onion de Tor.',
    },
  },
  '/receive': {
    title: {
      en: 'Receive files — pTransfer',
      es: 'Recibir archivos — pTransfer',
    },
    description: {
      en: 'Receive files and folders a sender shares with you, end-to-end encrypted, with no account and no central file server.',
      es: 'Recibe los archivos y carpetas que alguien comparte contigo, cifrados de extremo a extremo, sin cuenta y sin servidor central de archivos.',
    },
  },
  '/cli': {
    title: {
      en: 'Command line app — pTransfer',
      es: 'Aplicación de línea de comandos — pTransfer',
    },
    description: {
      en: 'The pTransfer command line app for Linux, macOS and Windows: send and receive files with the browser tab or another terminal.',
      es: 'La aplicación de línea de comandos de pTransfer para Linux, macOS y Windows: envía y recibe archivos con la pestaña del navegador u otra terminal.',
    },
  },
  '/about': {
    title: {
      en: 'About — pTransfer',
      es: 'Acerca de — pTransfer',
    },
    description: {
      en: 'How pTransfer keeps a transfer private: end-to-end encryption, direct WebRTC, Code Exchange, Nostr relays and Tor onion services.',
      es: 'Cómo pTransfer mantiene privada una transferencia: cifrado de extremo a extremo, WebRTC directo, intercambio por código, relays de Nostr y servicios onion de Tor.',
    },
  },
};

/**
 * The `lang` value and the `hreflang` of each locale. The two coincide today;
 * a regional variant would differ from its locale key here.
 */
export const HTML_LANG: Localized = { en: 'en', es: 'es' };

export interface HeadContent {
  lang: string;
  title: string;
  description: string;
  /** Absent for a page that is not indexed, which carries no canonical link. */
  canonical?: string;
  alternates: { hreflang: string; href: string }[];
}

/** The head of the page at app path `path` in `locale`. */
export function headFor(path: string, locale: Locale): HeadContent {
  const page = INDEXED_PAGES[path];
  const head = page ?? DEFAULT_HEAD;
  return {
    lang: HTML_LANG[locale],
    title: head.title[locale],
    description: head.description[locale],
    canonical: page ? `${SITE_ORIGIN}${localizePath(path, locale)}` : undefined,
    alternates: page
      ? [
          ...LOCALES.map((other) => ({
            hreflang: HTML_LANG[other],
            href: `${SITE_ORIGIN}${localizePath(path, other)}`,
          })),
          {
            hreflang: 'x-default',
            href: `${SITE_ORIGIN}${localizePath(path, DEFAULT_LOCALE)}`,
          },
        ]
      : [],
  };
}

/**
 * The PWA manifest a page in `locale` links to. Each language is an app of its
 * own — its description, `lang`, and `start_url` on its own home — so one
 * installed from a Spanish page opens in Spanish. They sit side by side at the
 * root, where the icons they name relatively are.
 */
export function manifestHref(locale: Locale): string {
  return locale === DEFAULT_LOCALE
    ? '/manifest.webmanifest'
    : `/manifest.${locale}.webmanifest`;
}

/**
 * The file a page is written to, relative to the build output: `index.html`
 * for the English home, `es/index.html` for the Spanish one (served at
 * `/es/`), and `about.html`, `es/about.html` for the rest (served at `/about`
 * and `/es/about`, the paths the app links to).
 */
export function pageFileName(path: string, locale: Locale): string {
  const localized = localizePath(path, locale);
  return localized.endsWith('/')
    ? `${localized.slice(1)}index.html`
    : `${localized.slice(1)}.html`;
}
