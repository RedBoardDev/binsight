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

  return {
    hide,
    usd,
    showGlyph: currency === 'SOL',
    sol: (value, options) =>
      hide
        ? AMOUNT_MASK
        : usd
          ? fmtUsd(value * factor, { signed: options?.signed })
          : options?.signed
            ? fmtSolSigned(value, options.decimals)
            : fmtSol(value, options?.decimals),
    hero: (value) => (hide ? AMOUNT_MASK : usd ? fmtUsd(value * factor) : fmtSolHero(value)),
    pct: (value) => (hide ? AMOUNT_MASK : fmtPct(value)),
  };
}
