import { PulseCaptionReadout } from '@app/applications/Overview/Ui/OverviewPage/OverviewMobile/PulseCaptionReadout';
import { RealPnlPulseFrame } from '@app/applications/Overview/Ui/OverviewPage/RealPnlPulseFrame';
import { useRealPnlPulse } from '@app/applications/Overview/Ui/OverviewPage/useRealPnlPulse';
import { PulseChart } from '@app/applications/Shared/Chart/Ui/PulseChart';
import { PeriodPills } from '@app/applications/Shared/Scope/Ui/PeriodPills';
import { useLingui } from '@lingui/react/macro';

const PULSE_HEIGHT_PX = 132;

// The chart under the key figures: while a finger reads a day, its reading takes the place of the
// legend and the period pills, then the legend comes back. Nothing else on the page moves.
export const RealPnlPulseMobile = () => {
  const { t } = useLingui();
  const pulse = useRealPnlPulse();
  return (
    <RealPnlPulseFrame pulse={pulse} skeletonClassName="h-33">
      {(series) => (
        <PulseChart
          points={series.points}
          label={t`Real PnL`}
          summary={pulse.summary}
          height={PULSE_HEIGHT_PX}
          timeZone={series.window.timezone}
          headerEnd={<PeriodPills />}
          readoutPlacement="caption"
          activeIndex={pulse.activeIndex}
          onScrub={pulse.select}
          describePoint={pulse.describePoint}
          renderReadout={(index) => {
            const point = series.points[index];
            return point === undefined ? null : (
              <PulseCaptionReadout point={point} timeZone={series.window.timezone} />
            );
          }}
        />
      )}
    </RealPnlPulseFrame>
  );
};
