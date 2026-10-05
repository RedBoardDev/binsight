import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';

// This approximation is for drawing only. Labels and readouts must use the server's string,
// never this number: otherwise rounding here would silently change the displayed amount.
export const plotValue = (value: string): number | null => {
  if (parseDecimalString(value) === null) return null;
  const plotted = Number(value);
  return Number.isFinite(plotted) && (plotted !== 0 || value === '0') ? plotted : null;
};
