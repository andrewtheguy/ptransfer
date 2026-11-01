import { DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/i18n';

/**
 * The language the CLI speaks: the one the environment's locale names, the
 * way a POSIX program reads it — `LC_ALL`, then `LC_MESSAGES`, then `LANG`,
 * the first one set — so `LANG=es_ES.UTF-8` is Spanish. Windows sets none of
 * them, and its user locale is what the runtime's `Intl` reports. A language
 * pTransfer does not speak, or the `C` and `POSIX` locales, is English.
 *
 * Only what a person reads changes: the `label: value` lines a script reads
 * from standard output keep their English labels in every language.
 */
export function detectLocale(
  env: Record<string, string | undefined>,
  systemLocale: string,
): Locale {
  const named = env.LC_ALL || env.LC_MESSAGES || env.LANG || systemLocale;
  // `es_ES.UTF-8`, `es-MX`, `es`: the language is what comes before the region.
  const language = named.split(/[_.@-]/, 1)[0]?.toLowerCase() ?? '';
  return isLocale(language) ? language : DEFAULT_LOCALE;
}

export function systemLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}
