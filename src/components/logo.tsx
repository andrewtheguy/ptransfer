interface LogoProps {
  className?: string;
}

export function Logo({ className = 'h-10 w-10' }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-label="pTransfer logo"
    >
      {/* Folder */}
      <path
        className="fill-[#7a8a9a] dark:fill-current dark:opacity-60"
        d="M4 3.3C2.89543 3.3 2 4.1 2 5.2V18.8C2 19.9 2.89543 20.7 4 20.7H20C21.1046 20.7 22 19.9 22 18.8V7.2C22 6.1 21.1046 5.3 20 5.3H13.1C12.84 5.3 12.59 5.2 12.4 5L11.3 3.9C10.93 3.5 10.42 3.3 9.89 3.2L4 3.3Z"
      />
      {/* Lock shackle */}
      <path
        className="stroke-[#3a4958] dark:stroke-current"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M9.3 12.9V11.5C9.3 9.8 10.5 8.9 12 8.9C13.5 8.9 14.7 9.8 14.7 11.5V12.9"
      />
      {/* Lock body */}
      <rect
        className="fill-[#3a4958] dark:fill-current"
        x="8.7"
        y="12.9"
        width="6.6"
        height="4.3"
        rx="0.7"
      />
    </svg>
  );
}
