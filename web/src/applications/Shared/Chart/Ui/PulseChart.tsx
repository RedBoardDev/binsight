import {
  type PulsePoint,
  pulseGeometry,
} from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { useElementWidth } from '@app/applications/Shared/Chart/Ui/useElementWidth';
import { useScrubIndex } from '@app/applications/Shared/Chart/Ui/useScrubIndex';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useId, useMemo, useRef } from 'react';
import { PulseBars } from './PulseChart/PulseBars';
import { PulseCurve } from './PulseChart/PulseCurve';
import { PulseLegend } from './PulseChart/PulseLegend';
import { PulseTable } from './PulseChart/PulseTable';
import { PulseTooltip } from './PulseChart/PulseTooltip';

const DEFAULT_PULSE_HEIGHT_PX = 236;
// A caption reading takes two lines (the day and its profit, then the cumulative profit, each with
// its share of net worth): their height is reserved, so nothing moves when a reading starts.
const CAPTION_HEIGHT_CLASSES = { caption: 'min-h-9', tooltip: 'min-h-7' } as const;
const DATE_LABEL_EDGE_PADDING_PX = 24;
const DATE_LABEL_BOTTOM_PADDING_PX = 6;

interface PulseChartProps {
  readonly points: readonly PulsePoint[];
  readonly label: string;
  readonly summary: string;
  readonly activeIndex: number | null;
  readonly onScrub: (index: number | null) => void;
  readonly renderReadout: (index: number) => ReactNode;
  readonly describePoint: (index: number) => string;
  readonly height?: number;
  readonly timeZone?: string;
  readonly headerEnd?: ReactNode;
  // "caption": the reading takes the place of the legend and the controls, on one line, while
  // the finger is down (a phone). "tooltip": it follows the pointer over the plot (a desktop).
  readonly readoutPlacement?: 'caption' | 'tooltip';
}

// The caller formats all four server figures, including hidden mode, in both callbacks.
// Only indices cross this boundary: a plotted float must never reach an amount readout.
export const PulseChart = ({
  points,
  label,
  summary,
  activeIndex,
  onScrub,
  renderReadout,
  describePoint,
  height = DEFAULT_PULSE_HEIGHT_PX,
  timeZone,
  headerEnd,
  readoutPlacement = 'caption',
}: PulseChartProps) => {
  const { t } = useLingui();
  const { ref, width } = useElementWidth();
  const { formatShortDate } = useDateFormatters(timeZone);
  const instructionsId = useId();
  const captionRef = useRef<HTMLElement>(null);
  const geometry = useMemo(() => pulseGeometry(points, { width, height }), [points, width, height]);
  const selectedIndex =
    activeIndex !== null && points[activeIndex] !== undefined ? activeIndex : null;
  const announcedIndex = selectedIndex ?? Math.max(0, points.length - 1);
  const events = useScrubIndex({
    positions: geometry.positions,
    width,
    activeIndex: selectedIndex,
    onScrub,
  });
  return (
    <figure
      className="flex w-full flex-col gap-2"
      aria-label={label}
      // Set once the plot has a width, so its bars and curve are drawn: what a screenshot waits for.
      data-ready={width > 0 ? 'true' : undefined}
    >
      <figcaption
        ref={captionRef}
        className={`flex items-center justify-between gap-x-3 ${CAPTION_HEIGHT_CLASSES[readoutPlacement]}`}
      >
        {selectedIndex !== null && readoutPlacement === 'caption' ? (
          renderReadout(selectedIndex)
        ) : (
          <>
            <PulseLegend curve={geometry.strokes.at(-1)?.style ?? 'solid'} />
            {headerEnd}
          </>
        )}
      </figcaption>
      <div ref={ref} className="relative w-full">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block select-none"
          role="img"
          aria-label={summary}
        >
          <line x1={0} x2={width} y1={geometry.zeroY} y2={geometry.zeroY} stroke="var(--border)" />
          <PulseBars bars={geometry.bars} activeIndex={selectedIndex} />
          <PulseCurve geometry={geometry} activeIndex={selectedIndex} />
          {geometry.labels.map((index) => {
            const point = points[index];
            const x = geometry.positions[index];
            return point === undefined || x === undefined ? null : (
              <text
                key={point.start}
                x={Math.max(
                  DATE_LABEL_EDGE_PADDING_PX,
                  Math.min(width - DATE_LABEL_EDGE_PADDING_PX, x),
                )}
                y={height - DATE_LABEL_BOTTOM_PADDING_PX}
                textAnchor="middle"
                className="text-label"
                fill="var(--faint)"
              >
                {formatShortDate(point.start)}
              </text>
            );
          })}
        </svg>
        <div
          {...events}
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              captionRef.current?.contains(event.relatedTarget)
            )
              return;
            events.onBlur(event);
          }}
          role="slider"
          tabIndex={points.length === 0 ? -1 : 0}
          aria-label={label}
          aria-describedby={instructionsId}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, points.length - 1)}
          aria-valuenow={announcedIndex}
          aria-valuetext={points.length === 0 ? t`No chart values` : describePoint(announcedIndex)}
          aria-disabled={points.length === 0}
          className="absolute inset-0 cursor-crosshair touch-pan-y"
        />
        {readoutPlacement === 'tooltip' && selectedIndex !== null && (
          <PulseTooltip x={geometry.positions[selectedIndex] ?? 0} width={width}>
            {renderReadout(selectedIndex)}
          </PulseTooltip>
        )}
      </div>
      <p
        id={instructionsId}
        className="sr-only"
      >{t`Use the arrow keys to explore the chart. Home and End select the first and last readings.`}</p>
      <PulseTable points={points} label={label} describePoint={describePoint} />
    </figure>
  );
};
