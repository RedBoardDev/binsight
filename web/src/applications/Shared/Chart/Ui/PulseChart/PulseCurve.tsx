import {
  PULSE_TOP_PADDING_PX,
  type PulseGeometry,
} from '@app/applications/Shared/Chart/Domain/pulseGeometry';

const CURVE_STROKE_WIDTH_PX = 1.5;
const CURVE_AREA_OPACITY = 0.06;
const CURVE_INACTIVE_OPACITY = 0.55;
const LAST_POINT_RADIUS_PX = 3;
const SELECTED_POINT_RADIUS_PX = 4;
const CURSOR_TOP_EXTENSION_PX = 4;

interface PulseCurveProps {
  readonly geometry: PulseGeometry;
  readonly activeIndex: number | null;
}

export const PulseCurve = ({ geometry, activeIndex }: PulseCurveProps) => {
  const pointIndex = activeIndex ?? geometry.linePoints.length - 1;
  const selected = geometry.linePoints[pointIndex];
  const cursorX = activeIndex === null ? undefined : geometry.positions[activeIndex];
  return (
    <g>
      <g fill="var(--accent)" opacity={CURVE_AREA_OPACITY}>
        {geometry.areas.map((path) => (
          <path key={path} d={path} />
        ))}
      </g>
      <g
        fill="none"
        stroke="var(--accent)"
        strokeWidth={CURVE_STROKE_WIDTH_PX}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={activeIndex === null ? 1 : CURVE_INACTIVE_OPACITY}
      >
        {geometry.strokes.map((stroke) => (
          <path
            key={stroke.path}
            d={stroke.path}
            strokeDasharray={stroke.style === 'dashed' ? '4 4' : undefined}
          />
        ))}
      </g>
      {cursorX !== undefined && (
        <line
          x1={cursorX}
          x2={cursorX}
          y1={PULSE_TOP_PADDING_PX - CURSOR_TOP_EXTENSION_PX}
          y2={geometry.bottom}
          stroke="var(--faint)"
          strokeOpacity={0.45}
        />
      )}
      {selected !== undefined && selected.exactness !== 'unavailable' && (
        <>
          <circle
            cx={selected.point.x}
            cy={selected.point.y}
            r={activeIndex === null ? LAST_POINT_RADIUS_PX : SELECTED_POINT_RADIUS_PX}
            fill="var(--accent)"
            stroke="var(--background)"
            strokeWidth={activeIndex === null ? 0 : 2}
          />
          {selected.exactness === 'partial' && (
            <text
              x={selected.point.x}
              y={selected.point.y - 10}
              textAnchor="middle"
              className="text-small"
              fill="var(--accent)"
            >
              ≥
            </text>
          )}
        </>
      )}
    </g>
  );
};
