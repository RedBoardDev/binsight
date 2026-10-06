import { PERIOD_LABELS, type Period } from '@app/applications/Shared/Scope/Domain/period';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';
import { ImportHistoryLabel } from './PerformancePair/ImportHistoryLabel';
import { PerformanceFigure } from './PerformancePair/PerformanceFigure';

interface PerformancePairProps {
  readonly overview: Pick<ApiSchema<'OverviewV2'>, 'open' | 'gain' | 'sync'>;
  readonly period: Period;
  readonly layout: 'stocks' | 'compact';
}

export const PerformancePair = ({ overview, period, layout }: PerformancePairProps) => {
  const { i18n, t } = useLingui();
  const { open, gain, sync } = overview;
  const imports =
    gain.value.exactness === 'unavailable' &&
    gain.value.reasons.some((reason) => reason.code === 'history_incomplete')
      ? sync.importing
      : [];
  return (
    <div
      className={
        layout === 'stocks' ? 'flex flex-col' : 'col-span-2 grid min-w-0 grid-cols-2 gap-4'
      }
    >
      <PerformanceFigure
        label={t`Active PnL`}
        amount={open.pnl}
        percent={open.pnl_pct}
        layout={layout}
      >
        {open.count === 0 && open.pnl.exactness === 'complete' ? (
          <span>{t`No open positions`}</span>
        ) : null}
      </PerformanceFigure>
      <PerformanceFigure
        label={t`Gain · ${i18n._(PERIOD_LABELS[period])}`}
        amount={gain.value}
        percent={gain.pct}
        layout={layout}
      >
        <ImportHistoryLabel importing={imports} />
      </PerformanceFigure>
    </div>
  );
};
