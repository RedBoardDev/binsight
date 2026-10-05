import type { BinChartSource } from '@app/applications/Shared/Chart/Domain/binBars';
import { BinStrip } from '@app/applications/Shared/Chart/Ui/BinStrip';
import { renderWithProviders } from '@test/renderWithProviders';
import { describe, expect, it } from 'vitest';

const CHART: BinChartSource = {
  active_bin_id: 15,
  lower_bin_id: 0,
  upper_bin_id: 29,
  bars: [
    { bin_id: 0, base: '0', quote: '1', height: '0.5' },
    { bin_id: 10, base: '2', quote: '1', height: '1' },
    { bin_id: 20, base: '2', quote: '0', height: '0.8' },
  ],
};

describe('BinStrip', () => {
  it('leaves speech to the adjacent range text and identifies mixed sides with decorative equal halves', () => {
    const { container } = renderWithProviders(<BinStrip chart={CHART} />);
    const svg = container.querySelector('svg[focusable="false"]');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveStyle({ height: '20px' });
    const bars = container.querySelectorAll('rect');
    expect(bars[0]).toHaveAttribute('fill', 'var(--bin-y)');
    expect(bars[2]).toHaveAttribute('fill', 'var(--bin-x)');
    expect(bars[1]).toHaveAttribute('opacity', '1');
    expect(
      Array.from(container.querySelectorAll('svg[focusable="false"] stop'), (stop) =>
        stop.getAttribute('offset'),
      ),
    ).toEqual(['50%', '50%']);
  });

  it('draws a quiet out-of-range range cell with warning bars at 35 percent and a right marker', () => {
    const { container } = renderWithProviders(<BinStrip chart={{ ...CHART, active_bin_id: 30 }} />);
    for (const bar of container.querySelectorAll('rect')) {
      expect(bar).toHaveAttribute('fill', 'var(--warning)');
      expect(bar).toHaveAttribute('opacity', '0.35');
    }
    expect(container.querySelector('line:last-child')).toHaveAttribute('x1', '100');
  });

  it('keeps both token sides at 40 percent in an out-of-range histogram with a warning marker', () => {
    const { container } = renderWithProviders(
      <BinStrip chart={{ ...CHART, active_bin_id: 30 }} emphasis="normal" />,
    );
    const svg = container.querySelector('svg[focusable="false"]');
    const bars = svg?.querySelectorAll('rect');
    expect(bars?.[0]).toHaveAttribute('fill', 'var(--bin-y)');
    expect(bars?.[1]).toHaveAttribute('fill', expect.stringContaining('url('));
    expect(bars?.[2]).toHaveAttribute('fill', 'var(--bin-x)');
    for (const bar of bars ?? []) expect(bar).toHaveAttribute('opacity', '0.4');
    expect(svg?.querySelector('line:last-child')).toHaveAttribute('stroke', 'var(--warning)');
  });

  it('draws a baseline without a marker or invented zero bar when no liquidity is provided', () => {
    const { container } = renderWithProviders(
      <BinStrip chart={{ ...CHART, bars: [] }} height={72} />,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(container.querySelectorAll('line')).toHaveLength(1);
    expect(container.querySelector('svg[focusable="false"]')).toHaveStyle({ height: '72px' });
  });
});
