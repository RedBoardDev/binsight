import { PulseTooltipReadout } from '@app/applications/Overview/Ui/OverviewPage/OverviewDesktop/PulseTooltipReadout';
import { RealPnlPulseFrame } from '@app/applications/Overview/Ui/OverviewPage/RealPnlPulseFrame';
import { useRealPnlPulse } from '@app/applications/Overview/Ui/OverviewPage/useRealPnlPulse';
import { PulseChart } from '@app/applications/Shared/Chart/Ui/PulseChart';
import { PeriodPills } from '@app/applications/Shared/Scope/Ui/PeriodPills';
import { useLingui } from '@lingui/react/macro';

const PULSE_HEIGHT_PX = 236;

// The chart beside the key figures: the reading of a day follows the pointer as a tooltip.
export const RealPnlPulseDesktop = () => {
  const { t } = useLingui();
  const pulse = useRealPnlPulse();
  return (
    <RealPnlPulseFrame pulse={pulse} skeletonClassName="h-59">
      {(series) => (
        <PulseChart
          points={series.points}
          label={t`Real PnL`}
          summary={pulse.summary}
          height={PULSE_HEIGHT_PX}
          timeZone={series.window.timezone}
          headerEnd={<PeriodPills />}
          readoutPlacement="tooltip"
          activeIndex={pulse.activeIndex}
          onScrub={pulse.select}
          describePoint={pulse.describePoint}
          renderReadout={(index) => {
            const point = series.points[index];
            return point === undefined ? null : (
              <PulseTooltipReadout point={point} timeZone={series.window.timezone} />
            );
          }}
        />
      )}
    </RealPnlPulseFrame>
  );
};
