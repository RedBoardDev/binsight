interface SolMarkProps {
  size?: number;
  className?: string;
}

/** The Solana brand mark in its official teal→purple gradient — a small unit glyph next to SOL
 *  amounts, kept neutral so it never competes with the theme accent. */
export const SolMark = ({ size = 14, className }: SolMarkProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 398 312"
    className={className}
    role="img"
    aria-label="SOL"
  >
    <defs>
      <linearGradient
        id="sol-mark"
        x1="360"
        y1="-37"
        x2="141"
        y2="383"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#00FFA3" />
        <stop offset="1" stopColor="#DC1FFF" />
      </linearGradient>
    </defs>
    <g fill="url(#sol-mark)">
      <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
      <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
      <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
    </g>
  </svg>
);
