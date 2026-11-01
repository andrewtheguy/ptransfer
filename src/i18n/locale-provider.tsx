import type { ReactNode } from 'react';
import { LocaleContext } from '@/i18n/locale-context';
import { type Locale, setLocale } from '@/lib/i18n';

/**
 * The page's locale, for components through `useT`, and for the protocol
 * code through `@/lib/i18n`'s `t`, which reports statuses and errors from
 * outside any component.
 *
 * The module-wide locale is set while rendering, not in an effect: a child's
 * effects run before this component's would, and a transfer that starts on
 * mount must already report in the page's language.
 */
export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  setLocale(locale);
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  );
}
