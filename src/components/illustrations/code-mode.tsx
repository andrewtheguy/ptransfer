/**
 * Original flat-style spot illustration authored for pTransfer (no external assets).
 * Free to use/modify — released by the project under its own license.
 * Colors are driven by theme tokens (fill-primary, fill-secondary, ...) so the
 * artwork tints to the palette and adapts to dark mode automatically. Offline-safe.
 *
 * Concept: two devices beginning Code Exchange by sharing QR codes.
 */
interface IllustrationProps {
  className?: string;
}

export function CodeModeIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 200 140"
      className={className}
      role="img"
      aria-label="Two devices beginning Code Exchange with QR codes"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Soft backdrop */}
      <ellipse cx="100" cy="78" rx="92" ry="56" className="fill-primary/5" />

      {/* Direct exchange arrows between the devices */}
      <path
        d="M78 60 H122"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-primary/60"
      />
      <path
        d="M116 54 L122 60 L116 66"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary/60"
      />
      <path
        d="M122 80 H78"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-secondary/70"
      />
      <path
        d="M84 74 L78 80 L84 86"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-secondary/70"
      />

      {/* Left device */}
      <rect
        x="24"
        y="40"
        width="54"
        height="60"
        rx="12"
        className="fill-card stroke-border"
        strokeWidth="2.5"
      />
      <QrGlyph x={34} y={50} />

      {/* Right device */}
      <rect
        x="122"
        y="40"
        width="54"
        height="60"
        rx="12"
        className="fill-card stroke-border"
        strokeWidth="2.5"
      />
      <QrGlyph x={132} y={50} accent />

      {/* Floating accents */}
      <circle cx="100" cy="26" r="3.5" className="fill-accent/60" />
      <circle cx="46" cy="116" r="3" className="fill-secondary/60" />
      <circle cx="154" cy="116" r="3" className="fill-primary/50" />
    </svg>
  );
}

/** A compact stylized QR glyph (finder squares + a few data cells). */
function QrGlyph({ x, y, accent }: { x: number; y: number; accent?: boolean }) {
  const fill = accent ? 'fill-secondary' : 'fill-primary';
  return (
    <g transform={`translate(${x} ${y})`}>
      {/* finder squares */}
      <rect width="11" height="11" rx="2" className={fill} />
      <rect x="3" y="3" width="5" height="5" rx="1" className="fill-card" />
      <rect x="23" width="11" height="11" rx="2" className={fill} />
      <rect x="26" y="3" width="5" height="5" rx="1" className="fill-card" />
      <rect y="23" width="11" height="11" rx="2" className={fill} />
      <rect x="3" y="26" width="5" height="5" rx="1" className="fill-card" />
      {/* data cells */}
      <rect
        x="16"
        y="2"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
      <rect
        x="16"
        y="9"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
      <rect
        x="23"
        y="16"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
      <rect
        x="30"
        y="16"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
      <rect
        x="16"
        y="16"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
      <rect
        x="16"
        y="23"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
      <rect
        x="23"
        y="30"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
      <rect
        x="30"
        y="30"
        width="4"
        height="4"
        rx="1"
        className={`${fill} opacity-70`}
      />
    </g>
  );
}
