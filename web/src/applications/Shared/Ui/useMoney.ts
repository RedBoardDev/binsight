'use client';

import { useSolUsd } from '@app/applications/Shared/Api/useSolUsd.api';
import {
  fmtPct,
  fmtSol,
  fmtSolHero,
  fmtSolSigned,
} from '@app/applications/Shared/Domain/formatters';
import { AMOUNT_MASK, fmtUsd } from '@app/applications/Shared/Domain/money';
import { usePrefs } from '@app/core/stores/prefsStore';

export interface Money {
  hide: boolean;
  usd: boolean;
  /** Render the ◎ unit mark only in SOL mode — in USD the "$" is already in the string. */
  showGlyph: boolean;
  sol: (value: number, options?: { signed?: boolean; decimals?: number }) => string;
  /** A position's NATIVE quote. A non-SOL quote is never run through the SOL⇄USD preference. */
  quote: (
    value: number,
    symbol: string,
    options?: { signed?: boolean; decimals?: number },
  ) => string;
  hero: (value: number) => string;
  pct: (value: number) => string;
}

/**
 * The reactive money-formatting seam. Every on-screen money value renders through this so the
 * "hide amounts" privacy toggle and the SOL⇄USD switch apply everywhere at once.
 */
export function useMoney(): Money {
  const hide = usePrefs((s) => s.hideAmounts);
  const currency = usePrefs((s) => s.currency);
  const rate = useSolUsd();
  const usd = currency === 'USD' && rate != null;
  const factor = rate ?? 0;

  const sol: Money['sol'] = (value, options) =>
    hide
      ? AMOUNT_MASK
      : usd
        ? fmtUsd(value * factor, { signed: options?.signed })
        : options?.signed
          ? fmtSolSigned(value, options.decimals)
          : fmtSol(value, options?.decimals);

  return {
    hide,
    usd,
    showGlyph: currency === 'SOL',
    sol,
    quote: (value, symbol, options) => {
      // Only SOL follows the currency switch: there is no USDC⇄USD rate to apply, and converting a
      // USDC amount with the SOL rate would be flatly wrong.
      if (symbol === 'SOL') return sol(value, options);
      if (hide) return AMOUNT_MASK;
      const abs = Math.abs(value);
      const digits = options?.decimals ?? (abs >= 1000 ? 2 : abs >= 1 ? 4 : 6);
      const body = abs.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      });
      const sign = value < 0 ? '-' : options?.signed && value > 0 ? '+' : '';
      return `${sign}${body} ${symbol}`;
    },
    hero: (value) => (hide ? AMOUNT_MASK : usd ? fmtUsd(value * factor) : fmtSolHero(value)),
    pct: (value) => (hide ? AMOUNT_MASK : fmtPct(value)),
  };
}
