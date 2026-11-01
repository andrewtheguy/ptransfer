import { createContext, useCallback, useContext } from 'react';
import { type NavigateOptions, type To, useNavigate } from 'react-router-dom';
import {
  DEFAULT_LOCALE,
  type Locale,
  type Localized,
  localizePath,
} from '@/lib/i18n';

export const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** The locale the page is in, from its URL. */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/**
 * `t` for a component: the same call as `t` from `@/lib/i18n`, bound to the
 * page's locale, so a component re-renders in the new language when the URL
 * changes it.
 */
export function useT(): <T>(messages: Localized<T>) => T {
  const locale = useLocale();
  return useCallback(<T>(messages: Localized<T>) => messages[locale], [locale]);
}

/**
 * An app path, such as `/send`, localized to the page's locale. Routes are
 * declared on the unprefixed path, so every absolute link and navigation in
 * the app goes through this to stay in the language it was opened in.
 */
export function useLocalePath(): (path: string) => string {
  const locale = useLocale();
  return useCallback((path: string) => localizePath(path, locale), [locale]);
}

export function localizeTo(to: To, locale: Locale): To {
  if (typeof to === 'string') {
    return to.startsWith('/') ? localizePath(to, locale) : to;
  }
  return to.pathname?.startsWith('/')
    ? { ...to, pathname: localizePath(to.pathname, locale) }
    : to;
}

/** `useNavigate`, with absolute paths kept in the page's locale. */
export function useLocaleNavigate(): (
  to: To,
  options?: NavigateOptions,
) => void {
  const navigate = useNavigate();
  const locale = useLocale();
  return useCallback(
    (to: To, options?: NavigateOptions) => {
      void navigate(localizeTo(to, locale), options);
    },
    [navigate, locale],
  );
}
