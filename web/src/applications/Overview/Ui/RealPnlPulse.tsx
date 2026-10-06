import { PulseChart } from '@app/applications/Shared/Chart/Ui/PulseChart';
import { SectionError } from '@app/applications/Shared/Layout/Ui/SectionError';
import { SkeletonBlock } from '@app/applications/Shared/Layout/Ui/SkeletonBlock';
import { useDisplayPreferences } from '@app/applications/Shared/Preference/Ui/useDisplayPreferences';
import { PeriodPills } from '@app/applications/Shared/Scope/Ui/PeriodPills';
import { useScope } from '@app/applications/Shared/Scope/Ui/useScope';
import {
  apiErrorMessage,
  NETWORK_ERROR_MESSAGE,
} from '@app/applications/Shared/Ui/apiErrorMessages';
import { useStatsSeries } from '@app/applications/Stats/Api/useStatsSeries.api';
import { ApiError } from '@app/lib/api/apiError';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { PulseCaptionReadout } from './RealPnlPulse/PulseCaptionReadout';
import { PulseReadout } from './RealPnlPulse/PulseReadout';
import { usePulseReadings } from './RealPnlPulse/usePulseReadings';

// The plot with its dates: beside the key figures on a desktop, under them on a phone.
const PULSE_HEIGHT_PX = { desktop: 236, mobile: 132 } as const;
const PULSE_SKELETON_CLASSES = { desktop: 'h-59', mobile: 'h-33' } as const;

interface RealPnlPulseProps {
  readonly layout: 'desktop' | 'mobile';
}

export const RealPnlPulse = ({ layout }: RealPnlPulseProps) => {
  const { t, i18n } = useLingui();
  const { wallet, period } = useScope();
  const { currency } = useDisplayPreferences();
  const series = useStatsSeries({ wallet, period, currency, series: 'real_pnl', bucket: 'day' });
  const scope = `${wallet}/${period}/${currency}`;
  const [selection, setSelection] = useState<{ scope: string; index: number | null }>({
    scope,
    index: null,
  });
  const activeIndex = selection.scope === scope ? selection.index : null;
  const { summary, describePoint } = usePulseReadings(series.data);
  const message =
    series.error instanceof ApiError
      ? i18n._(apiErrorMessage(series.error.code))
      : series.error instanceof TypeError
        ? i18n._(NETWORK_ERROR_MESSAGE)
        : i18n._(apiErrorMessage(null));
  const snapshot = series.data;
  const controls = <PeriodPills />;
  return (
    <section aria-label={t`Real PnL`} className="min-w-0">
      {(series.isPending || series.data === undefined) && (
        <div className="flex min-h-7 items-center justify-end">{controls}</div>
      )}
      {series.isError && <SectionError message={message} onRetry={() => void series.refetch()} />}
      {series.isRefetchError && snapshot !== undefined && (
        <p className="text-small text-muted">{t`Showing previous readings.`}</p>
      )}
      {series.isPending && (
        <div role="status" aria-label={t`Loading real PnL`}>
          <SkeletonBlock className={`mt-2 w-full ${PULSE_SKELETON_CLASSES[layout]}`} />
        </div>
      )}
      {snapshot !== undefined && (
        <PulseChart
          points={snapshot.points}
          label={t`Real PnL`}
          summary={summary}
          height={PULSE_HEIGHT_PX[layout]}
          timeZone={snapshot.window.timezone}
          headerEnd={controls}
          readoutPlacement={layout === 'desktop' ? 'tooltip' : 'caption'}
          activeIndex={activeIndex}
          onScrub={(index) => setSelection({ scope, index })}
          describePoint={describePoint}
          renderReadout={(index) => {
            const point = snapshot.points[index];
            if (point === undefined) return null;
            return layout === 'desktop' ? (
              <PulseReadout point={point} timeZone={snapshot.window.timezone} />
            ) : (
              <PulseCaptionReadout point={point} timeZone={snapshot.window.timezone} />
            );
          }}
        />
      )}
    </section>
  );
};
