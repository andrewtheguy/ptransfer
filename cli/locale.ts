import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale, t } from '@/lib/i18n';
import { UsageError } from './usage';

/**
 * The language the CLI speaks: the one the environment's locale names, the
 * way a POSIX program reads it — `LC_ALL`, then `LC_MESSAGES`, then `LANG`,
 * the first one set — so `LANG=es_ES.UTF-8` is Spanish. Windows sets none of
 * them, and its user locale is what the runtime's `Intl` reports. A language
 * pTransfer does not speak, or the `C` and `POSIX` locales, is English.
 *
 * `--lang` (`takeLangFlag`) overrides all of it.
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

/**
 * `--lang <locale>` or `--lang=<locale>`, wherever it appears before a `--`,
 * taken out of `argv` so that no command has to know it: it chooses the
 * language for the whole run, the terminal UI included. Given twice, the
 * last one wins, the way a repeated option usually does.
 */
export function takeLangFlag(argv: readonly string[]): {
  locale?: Locale;
  argv: string[];
} {
  const rest: string[] = [];
  let named: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === '--lang') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(
          t({
            en: `--lang needs a language: ${LOCALES.join(' or ')}`,
            es: `--lang necesita un idioma: ${LOCALES.join(' o ')}`,
          }),
        );
      }
      named = value;
      i++;
    } else if (arg.startsWith('--lang=')) {
      named = arg.slice('--lang='.length);
    } else {
      rest.push(arg);
    }
  }
  if (named === undefined) return { argv: rest };
  const locale = named.toLowerCase();
  if (!isLocale(locale)) {
    throw new UsageError(
      t({
        en: `Unknown language: ${named} (choose ${LOCALES.join(' or ')})`,
        es: `Idioma desconocido: ${named} (elige ${LOCALES.join(' o ')})`,
      }),
    );
  }
  return { locale, argv: rest };
}
