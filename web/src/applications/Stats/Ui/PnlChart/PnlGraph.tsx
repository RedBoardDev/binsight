'use client';

import { fmtDate, fmtDateFull, fmtSolSigned } from '@app/applications/Shared/Domain/formatters';
import { AMOUNT_MASK } from '@app/applications/Shared/Domain/money';
import { type Tone, toneOf, toneTextClass } from '@app/applications/Shared/Domain/tone';
import { type Point, scale, smoothLinePath } from '@app/applications/Stats/Domain/chartScale';
import { usePrefs } from '@app/core/stores/prefsStore';
import type { ProfitBucket } from '@binsight/shared';
import { cn, Surface } from '@heroui/react';
import { type Ref, useState } from 'react';

/** Which view the graph draws:
 *  • networth  = the wallet VALUE (on-chain cash + open positions; ≥0, never negative).
 *  • pnl       = the REAL PnL = performance net of apports (deposits/withdrawals); CAN be negative.
 *  • positions = per-position close PnL (Meteora, LPAgent-style). */
export type ChartSource = 'networth' | 'pnl' | 'positions';

const W = 1000;
const H = 300;
const PAD = { top: 16, right: 12, bottom: 18, left: 48 };

function fmtTick(t: number): string {
  const a = Math.abs(t);
  if (a === 0) return '0';
  if (a >= 100) return t.toFixed(0);
  if (a >= 1) return (Math.round(t * 10) / 10).toString();
  return t.toFixed(2);
}

/** ~`count` human-friendly tick values spanning [min,max] (1 / 2 / 5 ×10ⁿ steps). */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const n = step0 / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) {
    ticks.push(Math.abs(t) < step * 1e-6 ? 0 : t);
  }
  return ticks;
}

interface PnlGraphProps {
  buckets: ProfitBucket[];
  netWorth: number;
  showBars: boolean;
  mode: ChartSource;
  svgRef: Ref<SVGSVGElement>;
}

export const PnlGraph = ({ buckets, netWorth, showBars, mode, svgRef }: PnlGraphProps) => {
  const [hover, setHover] = useState<number | null>(null);
  const hideAmounts = usePrefs((s) => s.hideAmounts);

  const realized = buckets.map((b) => b.realized);
  const cum = buckets.map((b) => b.cumulative);
  // Y domain spans the line (always) and the bars (only when shown — the wallet view hides the bars,
  // whose daily values are capital churn that would otherwise blow up the scale).
  const forDomain = showBars ? [...cum, ...realized] : cum;
  const lo = Math.min(0, ...forDomain);
  const hi = Math.max(0, ...forDomain);
  const x = scale(0, Math.max(1, buckets.length - 1), PAD.left, W - PAD.right);
  const y = scale(lo, hi, H - PAD.bottom, PAD.top);
  const zeroY = y(0);
  const ticks = niceTicks(lo, hi, 4);

  const points: Point[] = buckets.map((_, i) => [x(i), y(cum[i]!)]);
  const barW = Math.max(2, (W - PAD.left - PAD.right) / buckets.length - 3);
  const last = buckets.length - 1;
  const active = hover != null ? buckets[hover] : null;
  const xLabelIdx = [
    // De-dup: at length 3 the rounded ⅓/⅔ ticks both land on index 1 ([0,1,1,2]) — collapse so each
    // index (and thus each React key) is unique and no label is rendered twice.
    ...new Set(
      last < 1
        ? [0]
        : last === 1
          ? [0, 1]
          : [0, Math.round(last / 3), Math.round((2 * last) / 3), last],
    ),
  ];

  const pickAt = (clientX: number, rect: DOMRect) => {
    // Invert x(): map the cursor back to a bucket index, accounting for the axis padding.
    const unit = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round(((unit - PAD.left) / (W - PAD.left - PAD.right)) * last);
    setHover(Math.min(last, Math.max(0, i)));
  };
  // Tooltip x: anchor left near the left edge, right near the right edge, centred otherwise — so the
  // panel never clips the card.
  const hoverX = hover != null ? (x(hover) / W) * 100 : 0;
  const tipLeft = Math.min(98, Math.max(2, hoverX));
  const tipTx = hoverX < 24 ? '0%' : hoverX > 76 ? '-100%' : '-50%';
  const cumHover = hover != null ? cum[hover]! : 0;

  return (
    <div className="flex flex-col gap-2">
      {/* On a phone the readout is pinned above the chart instead of following the finger: a floating
          panel that narrow would sit under the thumb or overflow the viewport. It always shows a point
          — the scrubbed one, else the latest — so scrubbing never reflows the card, and which of the
          two readouts shows is a pure CSS breakpoint, so hydration doesn't move anything either. */}
      <div className="md:hidden">
        <ChartReadout
          bucket={active ?? buckets[last]!}
          cumulative={hover != null ? cumHover : (cum[last] ?? 0)}
          mode={mode}
          netWorth={netWorth}
          hideAmounts={hideAmounts}
          className="w-full"
        />
      </div>

      <div className="relative h-56 sm:h-72 md:h-80">
        {/* Y-axis labels (HTML overlay — SVG text distorts under preserveAspectRatio=none) */}
        {ticks.map((t) => (
          <div
            key={t}
            className="-translate-y-1/2 tabular absolute left-0 w-10 pr-2 text-right text-[10px] text-faint"
            style={{ top: `${(y(t) / H) * 100}%` }}
          >
            {hideAmounts ? '' : fmtTick(t)}
          </div>
        ))}

        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          role="img"
          aria-label="Cumulative realized PnL over time"
        >
          {/* horizontal gridlines + zero baseline */}
          {ticks.map((t) => (
            <line
              key={t}
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? 'var(--foreground)' : 'var(--border)'}
              strokeOpacity={t === 0 ? 0.24 : 1}
              strokeDasharray={t === 0 ? undefined : '2 5'}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* per-period realized bars (same axis as the line) — hidden for the wallet view */}
          {showBars &&
            buckets.map((b, i) => {
              const yr = y(b.realized);
              const up = b.realized >= 0;
              return (
                <rect
                  key={b.t}
                  x={x(i) - barW / 2}
                  y={up ? yr : zeroY}
                  width={barW}
                  height={Math.max(0.5, Math.abs(yr - zeroY))}
                  rx={Math.min(2, barW / 2)}
                  fill={up ? 'var(--success)' : 'var(--danger)'}
                  opacity={hover === i ? 1 : 0.55}
                />
              );
            })}

          {/* The accent line is the hero — smoothed, no heavy area fill. The spline is monotone
              cubic, so it never overshoots into a peak or dip the wallet never had. */}
          <path
            d={smoothLinePath(points)}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {hover != null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--foreground)"
              strokeOpacity={0.35}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* biome-ignore lint/a11y/noStaticElementInteractions: chart-hover crosshair; the same data is in the History table. */}
          <rect
            x="0"
            y="0"
            width={W}
            height={H}
            fill="transparent"
            onMouseMove={(e) => pickAt(e.clientX, e.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => setHover(null)}
            onTouchStart={(e) => {
              const t = e.touches[0];
              if (t) pickAt(t.clientX, e.currentTarget.getBoundingClientRect());
            }}
            onTouchMove={(e) => {
              const t = e.touches[0];
              if (t) pickAt(t.clientX, e.currentTarget.getBoundingClientRect());
            }}
            onTouchEnd={() => setHover(null)}
          />
        </svg>

        {active && hover != null && (
          // HTML scrubber dot (an SVG circle would distort under preserveAspectRatio=none).
          <div
            className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute size-2 rounded-full bg-accent ring-2 ring-background"
            style={{
              left: `${(x(hover) / W) * 100}%`,
              top: `${(y(cumHover) / H) * 100}%`,
            }}
          />
        )}

        {active && hover != null && (
          // Absolute wrapper so the readout panel is placed correctly; the clamp + translateX flip
          // keeps it inside the card.
          <div
            className="pointer-events-none absolute top-3 z-10 hidden md:block"
            style={{ left: `${tipLeft}%`, transform: `translateX(${tipTx})` }}
          >
            <ChartReadout
              bucket={active}
              cumulative={cumHover}
              mode={mode}
              netWorth={netWorth}
              hideAmounts={hideAmounts}
              className="min-w-40 whitespace-nowrap"
            />
          </div>
        )}
      </div>

      {/* X-axis date labels — evenly spaced; flex matches the linear data positions (0 / ⅓ / ⅔ / 1). */}
      <div
        className="tabular flex justify-between text-[10px] text-faint"
        style={{
          paddingLeft: `${(PAD.left / W) * 100}%`,
          paddingRight: `${(PAD.right / W) * 100}%`,
        }}
      >
        {xLabelIdx.map((i) => (
          <span key={buckets[i]!.t}>{fmtDate(buckets[i]!.t)}</span>
        ))}
      </div>
    </div>
  );
};

interface ChartReadoutProps {
  bucket: ProfitBucket;
  cumulative: number;
  mode: ChartSource;
  netWorth: number;
  hideAmounts: boolean;
  className?: string;
}

const ChartReadout = ({
  bucket,
  cumulative,
  mode,
  netWorth,
  hideAmounts,
  className,
}: ChartReadoutProps) => {
  const amount = (value: number) => (hideAmounts ? AMOUNT_MASK : fmtSolSigned(value));
  // Profit / cumulative as a percentage of the current net worth (LPAgent-style). Null if unknown.
  const nwPct = (value: number) =>
    netWorth > 0 ? `${((value / netWorth) * 100).toFixed(2)}%` : null;
  const realizedPct = nwPct(bucket.realized);
  const cumulativePct = nwPct(cumulative);

  return (
    <Surface.Root
      variant="secondary"
      className={cn('rounded-lg border border-border px-3 py-2 shadow-lg', className)}
    >
      <div className="mb-1.5 text-[11px] text-faint">{fmtDateFull(bucket.t)}</div>
      {mode !== 'positions' ? (
        <>
          <TipRow
            label={mode === 'networth' ? 'Net Worth' : 'Real PnL'}
            value={amount(cumulative)}
            tone={mode === 'networth' ? 'neutral' : toneOf(cumulative)}
          />
          <TipRow
            label="Day's change"
            value={amount(bucket.realized)}
            tone={toneOf(bucket.realized)}
          />
        </>
      ) : (
        // LPAgent-style: the period's Profit + its share of net worth, then the ABSOLUTE cumulative
        // (all-time) + its share. The %s are vs the CURRENT net worth (constant), and the cumulative
        // is all-time — so all four are invariant to the 1M/1Y range selection.
        <>
          <TipRow label="Profit" value={amount(bucket.realized)} tone={toneOf(bucket.realized)} />
          {realizedPct && (
            <TipRow
              label="Profit vs Net Worth"
              value={hideAmounts ? AMOUNT_MASK : realizedPct}
              tone={toneOf(bucket.realized)}
            />
          )}
          <TipRow label="Cumulative" value={amount(cumulative)} tone={toneOf(cumulative)} />
          {cumulativePct && (
            <TipRow
              label="Cumulative vs Net Worth"
              value={hideAmounts ? AMOUNT_MASK : cumulativePct}
              tone={toneOf(cumulative)}
            />
          )}
        </>
      )}
    </Surface.Root>
  );
};

interface TipRowProps {
  label: string;
  value: string;
  tone: Tone;
}

const TipRow = ({ label, value, tone }: TipRowProps) => (
  <div className="tabular flex items-center justify-between gap-6 text-xs">
    <span className="text-muted">{label}</span>
    <span className={cn('font-medium', toneTextClass[tone])}>{value}</span>
  </div>
);
