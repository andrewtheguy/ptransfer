import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/*
 * A terminal is dark in either theme, so these draw on fixed zinc shades
 * rather than the theme tokens: in light mode the window reads as a terminal
 * rather than as one more card.
 */

interface TerminalWindowProps {
  /** Shown in the title bar, like a terminal tab's title. */
  title?: string;
  children: React.ReactNode;
  className?: string;
}

/** A terminal window frame for showing commands. */
export function TerminalWindow({
  title,
  children,
  className,
}: TerminalWindowProps) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-lg',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 rounded-full bg-zinc-700"
        />
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 rounded-full bg-zinc-700"
        />
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 rounded-full bg-zinc-700"
        />
        {title && (
          <span className="ml-2 truncate font-mono text-[11px] text-zinc-400">
            {title}
          </span>
        )}
      </div>
      <div className="space-y-1 p-4 font-mono text-xs leading-relaxed sm:text-[13px]">
        {children}
      </div>
    </div>
  );
}

/** One command typed at the prompt; wraps at spaces rather than being cut off. */
export function TerminalCommand({ children }: { children: React.ReactNode }) {
  return (
    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      <span aria-hidden="true" className="select-none text-emerald-400">
        ${' '}
      </span>
      {children}
    </div>
  );
}

/** A shell comment explaining the command above it; wraps on a narrow screen. */
export function TerminalComment({ children }: { children: React.ReactNode }) {
  return <div className="whitespace-pre-wrap text-zinc-400"># {children}</div>;
}

/** Vertical space between groups of commands. */
export function TerminalGap() {
  return <div aria-hidden="true" className="h-2" />;
}

interface CopyCommandProps {
  command: string;
  /** The shell prompt shown before it, not copied: `PS>` for PowerShell. */
  prompt?: string;
  className?: string;
}

/**
 * A command with a button that copies it. It wraps rather than scrolls, so a
 * long one is never cut off and two that differ only at the end look different.
 */
export function CopyCommand({
  command,
  prompt = '$',
  className,
}: CopyCommandProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  return (
    <div
      className={cn(
        'flex items-stretch overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-sm',
        className,
      )}
    >
      <code className="min-w-0 flex-1 px-3 py-2.5 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
        <span aria-hidden="true" className="select-none text-emerald-400">
          {prompt}{' '}
        </span>
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : 'Copy command'}
        className="flex shrink-0 items-center gap-1.5 border-l border-zinc-800 px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {copied ? (
          <Check className="h-4 w-4 text-emerald-400" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

/*
 * The terminal UI's own palette (`cli/tui/theme.ts`), so a mock of one of its
 * screens looks like the screen.
 */
export const TUI_COLORS = {
  accent: 'text-[#7aa2f7]',
  heading: 'text-[#c0caf5]',
  muted: 'text-[#8b93a7]',
  good: 'text-[#9ece6a]',
  border: 'border-[#565f89]',
} as const;

interface TuiScreenProps {
  /** The screen's title, after the `pTransfer · ` every screen starts with. */
  title: string;
  /** The key hints along the bottom, as the screen shows them. */
  hints: string[];
  children: React.ReactNode;
  className?: string;
}

/**
 * A mock of one terminal UI screen, framed as the TUI frames it: a titled
 * border with the key hints along the bottom (`cli/tui/screen.tsx`).
 */
export function TuiScreen({
  title,
  hints,
  children,
  className,
}: TuiScreenProps) {
  return (
    <TerminalWindow title="ptransfer" className={className}>
      <div
        className={cn(
          'relative mt-1 rounded-sm border px-3 pt-3 pb-2',
          TUI_COLORS.border,
        )}
      >
        <span
          className={cn(
            'absolute -top-2.5 left-2 bg-zinc-950 px-1',
            TUI_COLORS.accent,
          )}
        >
          pTransfer · {title}
        </span>
        <div className="space-y-1">{children}</div>
        <div className={cn('mt-3', TUI_COLORS.muted)}>
          {hints.join('  ·  ')}
        </div>
      </div>
    </TerminalWindow>
  );
}
