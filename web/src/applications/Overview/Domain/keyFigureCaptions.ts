import type { Exactness } from '@app/applications/Shared/Figure/Domain/figure';

// What the line under a key figure says. A count of zero is a fact only when the server says the
// figure itself is complete: while history imports, zero closes or zero positions prove nothing.

interface FigureWithExactness {
  readonly exactness: Exactness;
}

export type TodayCaption = 'closes' | 'nothing-closed' | 'reasons';

export const todayCaption = (totals: {
  readonly count: number;
  readonly pnl: FigureWithExactness;
}): TodayCaption => {
  if (totals.count > 0) return 'closes';
  return totals.pnl.exactness === 'complete' ? 'nothing-closed' : 'reasons';
};

export const hasNoOpenPositions = (open: {
  readonly count: number;
  readonly pnl: FigureWithExactness;
}): boolean => open.count === 0 && open.pnl.exactness === 'complete';

interface ReasonCodes {
  readonly exactness: Exactness;
  readonly reasons?: readonly { readonly code: string }[];
}

// The wallets whose import keeps the gain unavailable, to name them under it; none otherwise.
export const gainImports = <Import>(
  gain: ReasonCodes,
  importing: readonly Import[],
): readonly Import[] =>
  gain.exactness === 'unavailable' &&
  (gain.reasons ?? []).some((reason) => reason.code === 'history_incomplete')
    ? importing
    : [];
