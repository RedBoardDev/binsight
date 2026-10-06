import type { ReactNode } from 'react';

const TOOLTIP_WIDTH_PX = 220;
const TOOLTIP_OFFSET_PX = 14;
const TOOLTIP_EDGE_PADDING_PX = 4;

interface PulseTooltipProps {
  readonly x: number;
  readonly width: number;
  readonly children: ReactNode;
}

export const PulseTooltip = ({ x, width, children }: PulseTooltipProps) => {
  const preferredLeft =
    x + TOOLTIP_OFFSET_PX + TOOLTIP_WIDTH_PX <= width
      ? x + TOOLTIP_OFFSET_PX
      : x - TOOLTIP_WIDTH_PX - TOOLTIP_OFFSET_PX;
  const left = Math.max(
    TOOLTIP_EDGE_PADDING_PX,
    Math.min(width - TOOLTIP_WIDTH_PX - TOOLTIP_EDGE_PADDING_PX, preferredLeft),
  );
  return (
    <div
      className="pointer-events-none absolute top-4 z-10 rounded-xl border border-border-subtle bg-overlay p-3 shadow-md"
      style={{ left, width: TOOLTIP_WIDTH_PX }}
    >
      {children}
    </div>
  );
};
