import {
  Link,
  type LinkProps,
  NavLink,
  type NavLinkProps,
} from 'react-router-dom';
import { localizeTo, useLocale } from '@/i18n/locale-context';

/** `Link`, with an absolute `to` kept in the page's locale. */
export function LocaleLink({ to, ...props }: LinkProps) {
  const locale = useLocale();
  return <Link to={localizeTo(to, locale)} {...props} />;
}

/** `NavLink`, with an absolute `to` kept in the page's locale. */
export function LocaleNavLink({ to, ...props }: NavLinkProps) {
  const locale = useLocale();
  return <NavLink to={localizeTo(to, locale)} {...props} />;
}
