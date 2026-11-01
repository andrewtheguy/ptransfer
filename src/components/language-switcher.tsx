import { Check, Globe } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLocale, useT } from '@/i18n/locale-context';
import {
  LOCALE_NAMES,
  LOCALES,
  localizePath,
  splitLocalePath,
} from '@/lib/i18n';

/**
 * The same page in another language. Each choice is a link to that page's
 * own URL, so the route tree — and a transfer in progress on it — stays
 * mounted, and only the words change.
 */
export function LanguageSwitcher() {
  const t = useT();
  const locale = useLocale();
  const location = useLocation();
  const { path } = splitLocalePath(location.pathname);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-1.5 px-2.5">
          <Globe className="h-[1.2rem] w-[1.2rem]" />
          <span aria-hidden="true" className="text-xs font-semibold uppercase">
            {locale}
          </span>
          <span className="sr-only">
            {t({
              en: `Change language (now ${LOCALE_NAMES[locale]})`,
              es: `Cambiar idioma (ahora ${LOCALE_NAMES[locale]})`,
            })}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((other) => (
          <DropdownMenuItem key={other} asChild>
            <Link
              to={{
                pathname: localizePath(path, other),
                search: location.search,
                hash: location.hash,
              }}
              lang={other}
              hrefLang={other}
              className="flex items-center justify-between gap-4"
            >
              {LOCALE_NAMES[other]}
              {other === locale && <Check className="h-4 w-4" />}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
