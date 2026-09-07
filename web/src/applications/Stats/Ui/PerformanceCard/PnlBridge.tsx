'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import {
  type Tone,
  toneDotClass,
  toneOf,
  toneTextClass,
} from '@app/applications/Shared/Domain/tone';
import { SolMark } from '@app/applications/Shared/Ui/SolMark';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { useNetworthCurve, useWalletPnlCurve } from '@app/applications/Stats/Api/useStats.api';
import { periodDays } from '@app/applications/Stats/Domain/period';
import { periodLabel, realPnlGain } from '@app/applications/Stats/Domain/realPnl';
import { useUi } from '@app/core/stores/uiStore';
import { cn, Skeleton, Tooltip } from '@heroui/react';
import { Info } from 'lucide-react';

const GAIN_EXPLAINER =
  'Your REAL PnL over the period: realPnl(now) − realPnl(start), where real PnL = your wallet value NET of apports (deposits/withdrawals). It can be negative (you injected more than your current value). Verified on-chain.';

interface PnlBridgeProps {
  positionsPnl: number;
  /** The clock the whole tab shares — frozen per (scope, period, closed set) so the query keys hold. */
  now: number;
}

/**
 * The PnL reconciliation band — the headline that resolves the app's most confusing duality. The HERO
 * is the wallet's REAL PnL gain over the selected period (performance NET of apports = deposits/with-
 * drawals, end − start), which CAN be negative; beside it, two stat cells reconcile the per-position
 * story — `marked at close` (mark-at-close / LPAgent parity) and `trading cash-flow` (the on-chain
 * realized SOL over the same window, which books post-close bleed the per-position view never sees). It
 * shares the metric grid's columns so it reads as one coherent header, not a separate box.
 */
export const PnlBridge = ({ positionsPnl, now }: PnlBridgeProps) => {
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  const walletTotal = usePortfolioFeed((s) => s.portfolio?.totals.walletTotalSol ?? null);
  const period = useUi((s) => s.period);
  const days = periodDays(period, now);
  const networth = useNetworthCurve(scope, days, closedVersion);
  const walletPnl = useWalletPnlCurve(scope, days, closedVersion);

  const money = useMoney();
  if (networth.isError && !networth.data) {
    return (
      <StateMessage
        variant="error"
        title="Couldn't load the real PnL"
        hint="The net-worth curve didn't answer."
        onRetry={() => void networth.refetch()}
        className="min-h-[88px] py-4"
      />
    );
  }
  if (!networth.data) return <Skeleton.Root className="h-[88px] w-full rounded-lg" />;

  const gain = realPnlGain(networth.data.points, period, now, walletTotal);
  const trading = walletPnl.data?.totalTradingSol ?? null;
  const gainTone = gain != null ? toneOf(gain) : 'neutral';

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
      <div className="col-span-2 sm:col-span-3 lg:col-span-2">
        <div className="flex items-center gap-2 font-medium text-faint text-xs uppercase tracking-wide">
          <span>
            Real PnL ({periodLabel(period)})
            {walletPnl.data && !walletPnl.data.complete && ' · indexing…'}
          </span>
          <Tooltip.Root>
            <Tooltip.Trigger
              aria-label="How the real PnL gain is computed"
              className="grid size-4 cursor-help place-items-center rounded-full border border-border text-faint"
            >
              <Info size={10} />
            </Tooltip.Trigger>
            <Tooltip.Content className="max-w-xs text-xs leading-relaxed">
              {GAIN_EXPLAINER}
            </Tooltip.Content>
          </Tooltip.Root>
        </div>
        <span
          className={cn(
            'tabular mt-1.5 flex items-center gap-1.5 font-semibold text-3xl leading-none md:text-4xl',
            toneTextClass[gainTone],
          )}
        >
          {gain != null ? money.sol(gain, { signed: true }) : '—'}
          {money.showGlyph && gain != null && <SolMark size={20} />}
        </span>
      </div>

      <Leg label="Marked at close" value={positionsPnl} />
      <Leg label="Trading cash-flow" value={trading} />
    </div>
  );
};

interface LegProps {
  label: string;
  value: number | null;
}

/** A reconciliation leg, styled to match the metric cells: a tone dot + label, then the signed SOL
 *  value (no glyph — the hero carries the only one, keeping the row calm). */
const Leg = ({ label, value }: LegProps) => {
  const money = useMoney();
  const tone: Tone = value != null ? toneOf(value) : 'neutral';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1.5 font-medium text-faint text-xs uppercase tracking-wide">
        <span
          className={cn('size-1.5 shrink-0 rounded-full', toneDotClass[tone])}
          aria-hidden="true"
        />
        <span className="truncate">{label}</span>
      </span>
      <span
        className={cn(
          'tabular font-semibold text-xl leading-none md:text-2xl',
          toneTextClass[tone],
        )}
      >
        {value != null ? money.sol(value, { signed: true }) : '—'}
      </span>
    </div>
  );
};
