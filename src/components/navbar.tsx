import { Download, Home, Info, Menu, Send, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Logo } from '@/components/logo';
import { ModeToggle } from '@/components/mode-toggle';

const linkBase =
  'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `${linkBase} ${
    isActive
      ? 'bg-primary text-primary-foreground shadow-sm'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

const NAV_LINKS = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/send', label: 'Send', icon: Send, end: false },
  { to: '/receive', label: 'Receive', icon: Download, end: false },
  { to: '/about', label: 'About', icon: Info, end: false },
] as const;

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  const closeMobileMenu = () => {
    setMobileOpen(false);
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/70 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
        <Link to="/" className="inline-flex items-center gap-3">
          <Logo className="h-10 w-10" />
          <span className="font-semibold text-lg">pTransfer</span>
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {NAV_LINKS.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={navClass}>
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ModeToggle />
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-foreground shadow-sm transition-colors hover:bg-muted md:hidden"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>
      {mobileOpen && (
        <div className="border-t bg-background md:hidden">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-6 py-4 text-sm">
            {NAV_LINKS.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={closeMobileMenu}
                className={navClass}
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
