import type { ReactNode } from 'react';
import { theme } from './theme';

/**
 * The frame every screen is drawn in: a titled border, the screen's own body,
 * and a line of key hints along the bottom.
 *
 * The hints are the only documentation a terminal UI gets, so every screen
 * carries them rather than assuming a key is obvious.
 */
export function Screen({
  title,
  hints,
  children,
}: {
  title: string;
  hints: string[];
  children: ReactNode;
}) {
  return (
    <box
      style={{
        border: true,
        borderColor: theme.border,
        flexGrow: 1,
        flexDirection: 'column',
        paddingLeft: 1,
        paddingRight: 1,
      }}
      title={` pTransfer · ${title} `}
      titleColor={theme.accent}
    >
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>{children}</box>
      <text fg={theme.muted}>{hints.join('  ·  ')}</text>
    </box>
  );
}

/** A line of explanation under a heading. */
export function Note({ children }: { children: ReactNode }) {
  return <text fg={theme.muted}>{children}</text>;
}

/** A failure, or a refusal of something just typed. */
export function Problem({ children }: { children: ReactNode }) {
  return <text fg={theme.bad}>{children}</text>;
}

/** A blank line, which a terminal UI needs often enough to name. */
export function Gap() {
  return <text> </text>;
}
