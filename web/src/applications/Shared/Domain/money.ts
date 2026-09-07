/** USD money string: "$45.20" / "-$45.20" / "+$45.20" / "$1,234" (no decimals for large). */
export function fmtUsd(value: number, options?: { signed?: boolean }): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : 2;
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = value < 0 ? '-' : options?.signed ? '+' : '';
  return `${sign}$${body}`;
}

/** The mask shown in place of a hidden money value. */
export const AMOUNT_MASK = '••••';
