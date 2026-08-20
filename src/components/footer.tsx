import { Info, Lock, Shield, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { APP_VERSION, GIT_COMMIT_HASH } from '@/lib/app-version';

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
  return (
    <footer className="w-full border-t bg-background/80 backdrop-blur mt-auto">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center gap-6 px-6 py-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-accent" />
          <FooterLabel shortLabel="E2E" fullLabel="End-to-end encrypted" />
        </div>
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-secondary" />
          <FooterLabel shortLabel="P2P" fullLabel="Direct P2P transfer" />
        </div>
        <div className="flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-primary" />
          <FooterLabel
            shortLabel="No sign-up"
            fullLabel="No sign-up required"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-sm px-0.5 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Version compatibility notice"
            >
              <span>{`v${APP_VERSION}`}</span>
              <Info className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="center"
            className="max-w-[280px] p-2 text-xs leading-relaxed"
          >
            Compatibility is not guaranteed across pTransfer versions. Sender
            and receiver should use the same app version.
            <div className="mt-1 text-muted-foreground">{`v${APP_VERSION} (${GIT_COMMIT_HASH})`}</div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </footer>
  );
}
