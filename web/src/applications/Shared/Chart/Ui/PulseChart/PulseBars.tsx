import type { PulseBar } from '@app/applications/Shared/Chart/Domain/pulseGeometry';

const BAR_CORNER_RADIUS_PX = 3;
const BAR_RESTING_OPACITY = 0.55;
const BAR_ACTIVE_OPACITY = 0.9;
const BAR_INACTIVE_OPACITY = 0.22;

const BAR_COLORS: Record<PulseBar['tone'], string> = {
  gain: 'var(--gain)',
  loss: 'var(--loss)',
  neutral: 'var(--muted)',
};

interface PulseBarsProps {
  readonly bars: readonly PulseBar[];
  readonly activeIndex: number | null;
}

// Every bar is drawn solid: an estimated reading is told by the dashed curve and the readout's
// glyph, not by a texture on each bar, which made a whole estimated period noisy.
export const PulseBars = ({ bars, activeIndex }: PulseBarsProps) => (
  <g>
    {bars.map((bar) => (
      <rect
        key={bar.index}
        x={bar.x}
        y={bar.y}
        width={bar.width}
        height={bar.height}
        rx={Math.min(BAR_CORNER_RADIUS_PX, bar.width / 3)}
        fill={BAR_COLORS[bar.tone]}
        opacity={
          activeIndex === null
            ? BAR_RESTING_OPACITY
            : activeIndex === bar.index
              ? BAR_ACTIVE_OPACITY
              : BAR_INACTIVE_OPACITY
        }
      />
    ))}
  </g>
);
