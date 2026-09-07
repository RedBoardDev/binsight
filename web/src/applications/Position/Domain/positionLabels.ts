import { rangeLabel as rangeLabelOfStatus } from '@app/applications/Shared/Domain/formatters';
import type { RangeStatus, StrategyFamily } from '@binsight/shared';

/** The shared formatter narrowed to the position domain's own status union. */
export const rangeLabel = (status: RangeStatus): string => rangeLabelOfStatus(status);

/** The compact badge form used where a full label would not fit (mobile cards, dense rows). */
export const rangeShortLabel = (status: RangeStatus): string => (status === 'in' ? 'IN' : 'OUT');

export type RangeChipColor = 'success' | 'warning';

export const rangeChipColor = (status: RangeStatus): RangeChipColor =>
  status === 'in' ? 'success' : 'warning';

const STRATEGY_LABEL: Record<StrategyFamily, string> = {
  Spot: 'Spot',
  Curve: 'Curve',
  BidAsk: 'Bid/Ask',
};

export const strategyLabel = (strategy: StrategyFamily | null): string | null =>
  strategy == null ? null : STRATEGY_LABEL[strategy];
