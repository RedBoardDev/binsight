import { sparklineGeometry } from '@app/applications/Shared/Chart/Domain/sparklineGeometry';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';

const SPARKLINE_HEIGHT_PX = 22;
const SPARKLINE_STROKE_PX = 1.25;

interface SparklineProps {
  readonly values: readonly Figure[];
  readonly height?: number;
  readonly className?: string;
}

export const Sparkline = ({ values, height = SPARKLINE_HEIGHT_PX, className }: SparklineProps) => {
  const geometry = sparklineGeometry(values, height);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={`block w-full ${className ?? ''}`}
      style={{ height }}
    >
      {geometry.strokes.map((stroke) => (
        <path
          key={stroke.path}
          d={stroke.path}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={SPARKLINE_STROKE_PX}
          strokeDasharray={stroke.style === 'dashed' ? '4 4' : undefined}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      ))}
      {geometry.lastPoint !== null && (
        <circle
          cx={geometry.lastPoint.x}
          cy={geometry.lastPoint.y}
          r={1.5}
          fill="var(--foreground)"
        />
      )}
    </svg>
  );
};
