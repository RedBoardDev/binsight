export interface ChartDomain {
  readonly minimum: number;
  readonly maximum: number;
}

export interface LinearScale {
  readonly project: (value: number) => number;
  readonly invert: (pixel: number) => number;
}

export const assertChartDomain = (domain: ChartDomain): void => {
  if (
    !Number.isFinite(domain.minimum) ||
    !Number.isFinite(domain.maximum) ||
    domain.minimum > domain.maximum ||
    !Number.isFinite(domain.maximum - domain.minimum)
  )
    throw new RangeError('A chart domain must have finite ordered bounds and span');
};

export const linearScale = (domain: ChartDomain, pixels: ChartDomain): LinearScale => {
  assertChartDomain(domain);
  if (!Number.isFinite(pixels.minimum) || !Number.isFinite(pixels.maximum)) {
    throw new RangeError('A chart scale must have finite pixel bounds');
  }
  const span = domain.maximum - domain.minimum;
  const pixelSpan = pixels.maximum - pixels.minimum;
  if (!Number.isFinite(pixelSpan)) throw new RangeError('A chart pixel span must be finite');
  return {
    project: (value) =>
      span === 0
        ? pixels.minimum + pixelSpan / 2
        : pixels.minimum + ((value - domain.minimum) / span) * pixelSpan,
    invert: (pixel) =>
      pixelSpan === 0 || span === 0
        ? domain.minimum
        : domain.minimum + ((pixel - pixels.minimum) / pixelSpan) * span,
  };
};
