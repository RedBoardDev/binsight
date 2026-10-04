// The Solana mark, defined once for the whole page: a coin in the official gradient (violet at the
// bottom left, green at the top right) holding the three bars of the official logomark. Every
// SolanaMark is a <use> of it, so a table of a hundred amounts repeats neither paths nor gradient
// ids. Not display:none: a gradient inside a hidden SVG does not paint through <use> in Chromium.
export const SOLANA_MARK_ID = 'solana-mark';

const GRADIENT_ID = 'solana-mark-gradient';

// The official logomark (397.7 × 311.7), scaled to 52 % of the coin and centred on it.
const LOGOMARK_TRANSFORM = 'translate(4.8 5.9245) scale(0.02615)';
const LOGOMARK_PATHS = [
  'M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z',
  'M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z',
  'M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z',
];

export const SolanaMarkDefs = () => (
  <svg aria-hidden width="0" height="0" className="absolute">
    <defs>
      <linearGradient id={GRADIENT_ID} x1="0" y1="20" x2="20" y2="0" gradientUnits="userSpaceOnUse">
        <stop style={{ stopColor: 'var(--solana-violet)' }} />
        <stop offset="1" style={{ stopColor: 'var(--solana-green)' }} />
      </linearGradient>
      <symbol id={SOLANA_MARK_ID} viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="10" fill={`url(#${GRADIENT_ID})`} />
        <g transform={LOGOMARK_TRANSFORM} style={{ fill: 'var(--solana-ink)', fillOpacity: 0.88 }}>
          {LOGOMARK_PATHS.map((path) => (
            <path key={path} d={path} />
          ))}
        </g>
      </symbol>
    </defs>
  </svg>
);
