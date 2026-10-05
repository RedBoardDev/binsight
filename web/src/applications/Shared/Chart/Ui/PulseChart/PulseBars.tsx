import type { PulseBar } from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { useId } from 'react';

const BAR_CORNER_RADIUS_PX = 3;
const BAR_RESTING_OPACITY = 0.55;
const BAR_ACTIVE_OPACITY = 0.9;
const BAR_INACTIVE_OPACITY = 0.22;
const ESTIMATE_HATCH_SIZE_PX = 6;

const BAR_COLORS: Record<PulseBar['tone'], string> = {
  gain: 'var(--gain)',
  loss: 'var(--loss)',
  neutral: 'var(--muted)',
};

interface PulseBarsProps {
  readonly bars: readonly PulseBar[];
  readonly activeIndex: number | null;
}

export const PulseBars = ({ bars, activeIndex }: PulseBarsProps) => {
  const patternId = useId();
  return (
    <g>
      <defs>
        <pattern
          id={patternId}
          width={ESTIMATE_HATCH_SIZE_PX}
          height={ESTIMATE_HATCH_SIZE_PX}
          patternUnits="userSpaceOnUse"
        >
          <path d="M-1,1L1,-1M0,6L6,0M5,7L7,5" stroke="var(--background)" strokeWidth={1.5} />
        </pattern>
      </defs>
      {bars.map((bar) => (
        <g
          key={bar.index}
          opacity={
            activeIndex === null
              ? BAR_RESTING_OPACITY
              : activeIndex === bar.index
                ? BAR_ACTIVE_OPACITY
                : BAR_INACTIVE_OPACITY
          }
        >
          <rect
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={Math.min(BAR_CORNER_RADIUS_PX, bar.width / 3)}
            fill={BAR_COLORS[bar.tone]}
          />
          {bar.isEstimated && (
            <rect
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              fill={`url(#${patternId})`}
            />
          )}
        </g>
      ))}
    </g>
  );
};
