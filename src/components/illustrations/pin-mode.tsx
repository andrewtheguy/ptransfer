/**
 * Original flat-style spot illustration authored for pTransfer (no external assets).
 * Free to use/modify — released by the project under its own license.
 * Colors are driven by theme tokens (fill-primary, fill-secondary, ...) so the
 * artwork tints to the palette and adapts to dark mode automatically. Offline-safe.
 *
 * Concept: a PIN/keypad chip coordinating two endpoints through a relay arc.
 */
interface IllustrationProps {
  className?: string;
}

export function PinModeIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 200 140"
      className={className}
      role="img"
      aria-label="A shared PIN coordinating two devices through a relay"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Soft backdrop */}
      <ellipse cx="100" cy="78" rx="92" ry="56" className="fill-primary/5" />

      {/* Relay arc between the two endpoints (signaling, not file data) */}
      <path
        d="M44 70 Q100 22 156 70"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="0.5 11"
        className="stroke-primary/60"
      />

      {/* Left endpoint */}
      <circle cx="44" cy="70" r="11" className="fill-secondary" />
      <circle
        cx="44"
        cy="70"
        r="11"
        fill="none"
        strokeWidth="2.5"
        className="stroke-secondary/40"
      />

      {/* Right endpoint */}
      <circle cx="156" cy="70" r="11" className="fill-secondary" />
      <circle
        cx="156"
        cy="70"
        r="11"
        fill="none"
        strokeWidth="2.5"
        className="stroke-secondary/40"
      />

      {/* Relay node at the apex */}
      <rect
        x="90"
        y="20"
        width="20"
        height="16"
        rx="4"
        className="fill-muted"
      />
      <rect
        x="90"
        y="20"
        width="20"
        height="16"
        rx="4"
        fill="none"
        strokeWidth="2"
        className="stroke-border"
      />
      <circle cx="100" cy="28" r="2.5" className="fill-muted-foreground/50" />

      {/* Center PIN pad card */}
      <rect
        x="64"
        y="62"
        width="72"
        height="60"
        rx="12"
        className="fill-card stroke-border"
        strokeWidth="2.5"
      />
      {/* PIN dots row */}
      <circle cx="80" cy="78" r="4" className="fill-primary" />
      <circle cx="94" cy="78" r="4" className="fill-primary" />
      <circle cx="108" cy="78" r="4" className="fill-primary/30" />
      <circle cx="122" cy="78" r="4" className="fill-primary/30" />
      {/* keypad blocks */}
      <rect
        x="74"
        y="92"
        width="14"
        height="9"
        rx="3"
        className="fill-muted-foreground/20"
      />
      <rect
        x="93"
        y="92"
        width="14"
        height="9"
        rx="3"
        className="fill-muted-foreground/20"
      />
      <rect
        x="112"
        y="92"
        width="14"
        height="9"
        rx="3"
        className="fill-muted-foreground/20"
      />
      <rect
        x="74"
        y="105"
        width="14"
        height="9"
        rx="3"
        className="fill-muted-foreground/20"
      />
      <rect
        x="93"
        y="105"
        width="14"
        height="9"
        rx="3"
        className="fill-primary/70"
      />
      <rect
        x="112"
        y="105"
        width="14"
        height="9"
        rx="3"
        className="fill-muted-foreground/20"
      />

      {/* Floating accents */}
      <circle cx="36" cy="40" r="3.5" className="fill-accent/60" />
      <circle cx="166" cy="44" r="3" className="fill-primary/50" />
    </svg>
  );
}
