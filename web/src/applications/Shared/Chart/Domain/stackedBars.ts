import { axisLabels } from '@app/applications/Shared/Chart/Domain/axisLabels';
import { linearScale } from '@app/applications/Shared/Chart/Domain/linearScale';

const MILLISECONDS_PER_DAY = 86_400_000;
const TOP_PADDING_PX = 10;
const BOTTOM_PADDING_PX = 22;
const MAXIMUM_BAR_WIDTH_PX = 20;
const BAR_WIDTH_RATIO = 0.6;
const COMPACT_CHART_WIDTH_PX = 520;
export const CREDIT_DATE_EDGE_PADDING_PX = 24;
const MINIMUM_DATE_LABEL_SPACING_PX = 64;

export interface CreditDay {
  readonly day: string;
  readonly used: number;
  readonly segments?: readonly number[];
}

export interface CreditCycle {
  readonly start: string;
  readonly end: string;
}

interface CreditSegment {
  readonly index: number;
  readonly y: number;
  readonly height: number;
}

interface CreditBar {
  readonly index: number;
  readonly x: number;
  readonly width: number;
  readonly y: number;
  readonly height: number;
  readonly segments: readonly CreditSegment[];
}

interface StackedGeometry {
  readonly bars: readonly CreditBar[];
  readonly positions: readonly number[];
  readonly labels: readonly number[];
  readonly bottom: number;
  readonly budgetY: number;
}

interface StackOptions {
  readonly cycle: CreditCycle;
  readonly dailyBudget: number;
  readonly width: number;
  readonly height: number;
}

const count = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('A credit count must be a nonnegative safe integer');
  return value;
};

const utcDay = (day: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError('A credit day must be a LocalDate');
  const at = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== day)
    throw new RangeError('A credit day must exist in the UTC calendar');
  return at.getTime() / MILLISECONDS_PER_DAY;
};

const cycleDay = (at: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?(?:Z|\+00:00)$/.test(at))
    throw new RangeError('A credit cycle boundary must be UTC midnight');
  return utcDay(at.slice(0, 10));
};

const segmentsFor = (day: CreditDay): readonly number[] => {
  const segments = day.segments ?? [day.used];
  const total = segments.reduce((sum, segment) => {
    const next = count(segment);
    if (sum > Number.MAX_SAFE_INTEGER - next)
      throw new RangeError('Credit segments exceed safe integer precision');
    return sum + next;
  }, 0);
  if (total !== count(day.used))
    throw new RangeError('Credit segments must match the server total');
  return segments;
};

export const stackedBars = (days: readonly CreditDay[], options: StackOptions): StackedGeometry => {
  const { cycle, dailyBudget, width, height } = options;
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= TOP_PADDING_PX + BOTTOM_PADDING_PX
  )
    throw new RangeError('Credit bars need positive width and room for their plot');
  const start = cycleDay(cycle.start);
  const end = cycleDay(cycle.end);
  if (end <= start) throw new RangeError('A credit cycle must have increasing server boundaries');
  const dates = days.map((day, index) => {
    const date = utcDay(day.day);
    const previous = days[index - 1];
    if (date < start || date >= end || (previous !== undefined && day.day <= previous.day))
      throw new RangeError('Credit days must be ordered, unique and inside the server cycle');
    return date;
  });
  const segments = days.map(segmentsFor);
  const maximum = days.reduce(
    (highest, day) => Math.max(highest, day.used),
    Math.max(1, count(dailyBudget)),
  );
  const bottom = height - BOTTOM_PADDING_PX;
  const scale = linearScale({ minimum: 0, maximum }, { minimum: bottom, maximum: TOP_PADDING_PX });
  const step = width / (end - start);
  const positions = dates.map((day) => (day - start + 0.5) * step);
  const barWidth = Math.min(MAXIMUM_BAR_WIDTH_PX, step * BAR_WIDTH_RATIO);
  const bars = days.map((day, index): CreditBar => {
    let used = 0;
    const stack = (segments[index] ?? []).map((segment, segmentIndex) => {
      const base = scale.project(used);
      used += segment;
      const y = scale.project(used);
      return { index: segmentIndex, y, height: base - y };
    });
    const y = scale.project(day.used);
    return {
      index,
      x: (positions[index] ?? 0) - barWidth / 2,
      width: barWidth,
      y,
      height: bottom - y,
      segments: stack,
    };
  });
  return {
    bars,
    positions,
    bottom,
    budgetY: scale.project(dailyBudget),
    labels: axisLabels(days.length, width < COMPACT_CHART_WIDTH_PX ? 3 : 5, {
      positions: positions.map((x) =>
        Math.max(CREDIT_DATE_EDGE_PADDING_PX, Math.min(width - CREDIT_DATE_EDGE_PADDING_PX, x)),
      ),
      minimumSpacing: MINIMUM_DATE_LABEL_SPACING_PX,
    }),
  };
};
