import {
  assertChartDomain,
  type ChartDomain,
} from '@app/applications/Shared/Chart/Domain/linearScale';

export interface ChartTicks {
  readonly domain: ChartDomain;
  readonly positions: readonly number[];
}

const TICK_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;
const DEFAULT_TICK_COUNT = 5;
const MAXIMUM_TICK_COUNT = 100;

export const niceTicks = (domain: ChartDomain, requestedCount = DEFAULT_TICK_COUNT): ChartTicks => {
  assertChartDomain(domain);
  if (
    !Number.isInteger(requestedCount) ||
    requestedCount < 2 ||
    requestedCount > MAXIMUM_TICK_COUNT
  ) {
    throw new RangeError('A chart needs between 2 and 100 requested ticks');
  }
  const span = domain.maximum - domain.minimum;
  if (span === 0) return { domain, positions: [domain.minimum] };
  const desiredStep = span / (requestedCount - 1);
  const magnitude = 10 ** Math.floor(Math.log10(desiredStep));
  const multiplier = TICK_MULTIPLIERS.find((value) => value >= desiredStep / magnitude) ?? 10;
  const step = multiplier * magnitude;
  if (step === 0 || !Number.isFinite(step))
    throw new RangeError('Chart ticks are not representable');
  const first = Math.floor(domain.minimum / step);
  const last = Math.ceil(domain.maximum / step);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
    throw new RangeError('Chart tick indices are not representable');
  }
  const positions = Array.from({ length: last - first + 1 }, (_, index) => {
    const tickIndex = first + index;
    return tickIndex === 0 ? 0 : tickIndex * step;
  });
  const minimum = positions[0] ?? domain.minimum;
  const maximum = positions.at(-1) ?? domain.maximum;
  const expanded = { minimum, maximum };
  assertChartDomain(expanded);
  return { domain: expanded, positions };
};
