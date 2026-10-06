import type { RealPnlPulse } from '@app/applications/Overview/Ui/OverviewPage/useRealPnlPulse';
import { SectionError } from '@app/applications/Shared/Layout/Ui/SectionError';
import { SkeletonBlock } from '@app/applications/Shared/Layout/Ui/SkeletonBlock';
import { PeriodPills } from '@app/applications/Shared/Scope/Ui/PeriodPills';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

interface RealPnlPulseFrameProps {
  readonly pulse: RealPnlPulse;
  // The chart's height while it loads, as a size class, so nothing moves when it arrives.
  readonly skeletonClassName: string;
  readonly children: (series: ApiSchema<'StatsSeries'>) => ReactNode;
}

// What the chart section shows around the chart itself, on a desktop and a phone alike: the period
// pills and a placeholder while it loads, an error with its retry, a note when a refresh failed.
export const RealPnlPulseFrame = ({
  pulse,
  skeletonClassName,
  children,
}: RealPnlPulseFrameProps) => {
  const { t } = useLingui();
  const { series } = pulse;
  return (
    <section aria-label={t`Real PnL`} className="min-w-0">
      {series.data === undefined && (
        <div className="flex min-h-7 items-center justify-end">
          <PeriodPills />
        </div>
      )}
      {series.isError && (
        <SectionError message={pulse.errorMessage} onRetry={() => void series.refetch()} />
      )}
      {series.isRefetchError && series.data !== undefined && (
        <p className="text-muted text-small">{t`Showing previous readings.`}</p>
      )}
      {series.isPending && (
        <div role="status" aria-label={t`Loading real PnL`}>
          <SkeletonBlock className={`mt-2 w-full ${skeletonClassName}`} />
        </div>
      )}
      {series.data !== undefined && children(series.data)}
    </section>
  );
};
