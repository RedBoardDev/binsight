import {
  assertChartDomain,
  type ChartDomain,
} from '@app/applications/Shared/Chart/Domain/linearScale';

export const ZERO_LINE_MAX_RATIO = 0.85;
export const ZERO_LINE_MIN_RATIO = 0.001;
const DOMAIN_HEADROOM_RATIO = 1.08;
const MINIMUM_DRAWING_SPAN = 1e-6;

const zeroBounds = (domain: ChartDomain): ChartDomain => {
  assertChartDomain(domain);
  return { minimum: Math.min(0, domain.minimum), maximum: Math.max(0, domain.maximum) };
};

const negativeFraction = (domain: ChartDomain): number => {
  const span = domain.maximum - domain.minimum;
  return span === 0 ? 0.5 : -domain.minimum / span;
};

const expandToFraction = (domain: ChartDomain, fraction: number): ChartDomain => {
  const span =
    Math.max(
      fraction === 0 ? 0 : -domain.minimum / fraction,
      fraction === 1 ? 0 : domain.maximum / (1 - fraction),
      MINIMUM_DRAWING_SPAN,
    ) * DOMAIN_HEADROOM_RATIO;
  const expanded = { minimum: -span * fraction || 0, maximum: span * (1 - fraction) };
  assertChartDomain(expanded);
  return expanded;
};

export const alignedDomains = (
  first: ChartDomain,
  second: ChartDomain,
): readonly [ChartDomain, ChartDomain] => {
  const left = zeroBounds(first);
  const right = zeroBounds(second);
  const fraction = Math.min(
    ZERO_LINE_MAX_RATIO,
    Math.max(ZERO_LINE_MIN_RATIO, negativeFraction(left), negativeFraction(right)),
  );
  return [expandToFraction(left, fraction), expandToFraction(right, fraction)];
};
