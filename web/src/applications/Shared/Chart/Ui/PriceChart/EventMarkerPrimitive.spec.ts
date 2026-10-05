import { readPriceChartTheme } from '@app/applications/Shared/Chart/Ui/PriceChart/chartTheme';
import { EventMarkerPrimitive } from '@app/applications/Shared/Chart/Ui/PriceChart/EventMarkerPrimitive';
import type { IPrimitivePaneRenderer, SeriesAttachedParameter, Time } from 'lightweight-charts';
import { describe, expect, it, vi } from 'vitest';

describe('EventMarkerPrimitive', () => {
  it('draws neutral lettered circles at supplied price coordinates and identifies the hovered timeline event', () => {
    const theme = readPriceChartTheme(document.documentElement);
    const primitive = new EventMarkerPrimitive(theme);
    primitive.attached({
      chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) },
      series: { priceToCoordinate: (price: number) => price * 10 },
      requestUpdate: vi.fn(),
    } as unknown as SeriesAttachedParameter<Time>);
    primitive.update(
      [
        { id: 'open', time: 30, price: 4, letter: 'O' },
        { id: 'claim', time: 60, price: null, letter: 'C' },
      ],
      theme,
      'open',
    );
    primitive.updateAllViews();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      font: '',
      fillStyle: '',
      strokeStyle: '',
    };
    const target = {
      useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context }),
    };
    primitive.draw(target as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]);
    expect(context.arc.mock.calls).toEqual([
      [30, 40, 8, 0, Math.PI * 2],
      [60, 22, 6, 0, Math.PI * 2],
    ]);
    expect(context.fillText.mock.calls).toEqual([
      ['O', 30, 40],
      ['C', 60, 22],
    ]);
    expect(context.font).toBe(`600 9px ${theme.fontFamily}`);
    expect(context.fillStyle).toBe(theme.foreground);
    expect(context.strokeStyle).toBe(theme.foreground);
    expect(primitive.hitTest(32, 42)).toMatchObject({ externalId: 'open', cursorStyle: 'pointer' });
    expect(primitive.hitTest(500, 500)).toBeNull();
  });
});
