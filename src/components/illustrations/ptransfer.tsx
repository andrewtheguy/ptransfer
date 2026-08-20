/**
 * Original flat-style illustration authored for pTransfer (no external assets).
 * Free to use/modify — released by the project under its own license.
 * Colors are driven by theme tokens (fill-primary, fill-secondary, ...) so the
 * artwork tints to the palette and adapts to dark mode automatically. Offline-safe.
 */
interface IllustrationProps {
  className?: string;
}

export function PTransferIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 480 340"
      className={className}
      role="img"
      aria-label="Two devices exchanging an encrypted, locked file directly"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Soft background blobs */}
      <ellipse cx="240" cy="186" rx="214" ry="142" className="fill-primary/5" />
      <ellipse
        cx="240"
        cy="150"
        rx="120"
        ry="96"
        className="fill-secondary/10"
      />

      {/* Dotted peer-to-peer connection arc */}
      <path
        d="M150 150 Q240 70 330 150"
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="0.5 14"
        className="stroke-primary/60"
      />

      {/* Left device (sender) */}
      <g>
        <rect
          x="44"
          y="104"
          width="120"
          height="200"
          rx="20"
          className="fill-card stroke-border"
          strokeWidth="2.5"
        />
        <rect
          x="58"
          y="126"
          width="92"
          height="156"
          rx="10"
          className="fill-muted/50"
        />
        <rect
          x="92"
          y="112"
          width="24"
          height="5"
          rx="2.5"
          className="fill-muted-foreground/30"
        />
        {/* content lines */}
        <rect
          x="70"
          y="142"
          width="68"
          height="7"
          rx="3.5"
          className="fill-muted-foreground/25"
        />
        <rect
          x="70"
          y="158"
          width="48"
          height="7"
          rx="3.5"
          className="fill-muted-foreground/25"
        />
        {/* send action badge */}
        <circle cx="104" cy="232" r="26" className="fill-primary" />
        <path
          d="M104 220 L104 244 M104 220 L94 230 M104 220 L114 230"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-primary-foreground"
        />
      </g>

      {/* Right device (receiver) */}
      <g>
        <rect
          x="316"
          y="104"
          width="120"
          height="200"
          rx="20"
          className="fill-card stroke-border"
          strokeWidth="2.5"
        />
        <rect
          x="330"
          y="126"
          width="92"
          height="156"
          rx="10"
          className="fill-muted/50"
        />
        <rect
          x="364"
          y="112"
          width="24"
          height="5"
          rx="2.5"
          className="fill-muted-foreground/30"
        />
        <rect
          x="342"
          y="142"
          width="68"
          height="7"
          rx="3.5"
          className="fill-muted-foreground/25"
        />
        <rect
          x="342"
          y="158"
          width="48"
          height="7"
          rx="3.5"
          className="fill-muted-foreground/25"
        />
        {/* receive action badge */}
        <circle cx="376" cy="232" r="26" className="fill-secondary" />
        <path
          d="M376 220 L376 244 M376 244 L366 234 M376 244 L386 234"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-secondary-foreground"
        />
      </g>

      {/* Center shield with padlock (encrypted file in transit) */}
      <g>
        <path
          d="M240 80 L274 94 V124 C274 152 258 170 240 180 C222 170 206 152 206 124 V94 Z"
          className="fill-primary"
        />
        <path
          d="M240 80 L274 94 V124 C274 152 258 170 240 180 C222 170 206 152 206 124 V94 Z"
          fill="none"
          strokeWidth="3"
          className="stroke-primary/40"
        />
        {/* padlock */}
        <path
          d="M232 124 V117 C232 112.6 235.6 109 240 109 C244.4 109 248 112.6 248 117 V124"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          className="stroke-primary-foreground"
        />
        <rect
          x="227"
          y="124"
          width="26"
          height="22"
          rx="4"
          className="fill-primary-foreground"
        />
        <circle cx="240" cy="133" r="3.5" className="fill-primary" />
        <rect
          x="238.5"
          y="134"
          width="3"
          height="7"
          rx="1.5"
          className="fill-primary"
        />
      </g>

      {/* Floating accents */}
      <circle cx="150" cy="62" r="6" className="fill-secondary/70" />
      <circle cx="338" cy="58" r="8" className="fill-accent/60" />
      <circle cx="300" cy="96" r="4" className="fill-primary/50" />
      <circle cx="182" cy="92" r="4" className="fill-primary/50" />
      <path
        d="M398 120 l4 4 m0 -4 l-4 4"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-accent/70"
      />
      <path
        d="M78 70 l5 5 m0 -5 l-5 5"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-secondary/70"
      />
    </svg>
  );
}
