import { Info, Lock, Shield, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/i18n/locale-context';
import { GIT_COMMIT_HASH } from '@/lib/build-commit';
import { PROTOCOL_VERSION } from '@/lib/protocol-version';

interface FooterLabelProps {
  shortLabel: string;
  fullLabel: string;
}

function FooterLabel({ shortLabel, fullLabel }: FooterLabelProps) {
  return (
    <>
      <span className="hidden sm:inline">{fullLabel}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="sm:hidden rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={fullLabel}
          >
            {shortLabel}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="center"
          className="sm:hidden max-w-[220px] p-2 text-xs leading-relaxed"
        >
          {fullLabel}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function Footer() {
  const t = useT();
  return (
    <footer className="w-full border-t bg-background/80 backdrop-blur mt-auto">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center gap-6 px-6 py-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-accent" />
          <FooterLabel
            shortLabel="E2E"
            fullLabel={t({
              en: 'End-to-end encrypted',
              es: 'Cifrado de extremo a extremo',
            })}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-secondary" />
          <FooterLabel
            shortLabel="P2P/Tor"
            fullLabel={t({ en: 'Direct P2P or Tor', es: 'P2P directo o Tor' })}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-primary" />
          <FooterLabel
            shortLabel={t({ en: 'No sign-up', es: 'Sin registro' })}
            fullLabel={t({
              en: 'No sign-up required',
              es: 'No hace falta registrarse',
            })}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-sm px-0.5 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t({
                en: 'Version compatibility notice',
                es: 'Aviso de compatibilidad de versiones',
              })}
            >
              <span>
                {t({
                  en: `Protocol ${PROTOCOL_VERSION}`,
                  es: `Protocolo ${PROTOCOL_VERSION}`,
                })}
              </span>
              <Info className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="center"
            className="max-w-[280px] p-2 text-xs leading-relaxed"
          >
            {t({
              en: 'Sender and receiver need the same protocol version. Apps and CLIs of different releases work together when it matches.',
              es: 'El emisor y el receptor necesitan la misma versión del protocolo. Las aplicaciones y las CLI de distintas versiones funcionan juntas cuando coincide.',
            })}
            <div className="mt-1 text-muted-foreground">
              {t({
                en: `Build ${GIT_COMMIT_HASH}`,
                es: `Compilación ${GIT_COMMIT_HASH}`,
              })}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </footer>
  );
}
