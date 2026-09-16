'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { toneOf, toneTextClass } from '@app/applications/Shared/Domain/tone';
import { MoneyValue } from '@app/applications/Shared/Ui/MoneyValue';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { useStats } from '@app/applications/Stats/Api/useStats.api';
import { sinceMs } from '@app/applications/Stats/Domain/period';
import { useUi } from '@app/core/stores/uiStore';
import type { Stats } from '@binsight/shared';
import { Button, Card, cn, Skeleton } from '@heroui/react';

interface PairsCardProps {
  /** The clock the whole tab shares — frozen per (scope, period, closed set) so the query keys hold. */
  now: number;
}

/** Best & worst pairs — a standalone module placed under the chart. Clicking a pair filters History. */
/**
 * Best/worst is decided on each pair's NATIVE quote: a USDC pair reports zero in the SOL column, so
 * ranking on pnlSol would file every one of them as neither a win nor a loss.
 */
const pnlOf = (pair: Stats['byPair'][number]): number => pair.pnlQuote ?? pair.pnlSol;

export const PairsCard = ({ now }: PairsCardProps) => {
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  const period = useUi((s) => s.period);
  const stats = useStats(scope, closedVersion, sinceMs(period, now));
  const data = stats.data;

  if (!data && !stats.isError) return <PairsSkeleton />;
  if (data && data.byPair.length === 0) return null;

  const top = data ? data.byPair.filter((p) => pnlOf(p) > 0).slice(0, 5) : [];
  const worst = data
    ? data.byPair
        .filter((p) => pnlOf(p) < 0)
        .slice(-5)
        .reverse()
    : [];

  return (
    <Card.Root
      className={cn('transition-opacity', stats.isPlaceholderData && 'opacity-60')}
      aria-busy={stats.isPlaceholderData}
    >
      <Card.Header>
        <Card.Title>Best &amp; worst pairs</Card.Title>
      </Card.Header>
      <Card.Content>
        {!data ? (
          <StateMessage
            variant="error"
            title="Couldn't load your pairs"
            hint="The stats API didn't answer. Check the connection and try again."
            onRetry={() => void stats.refetch()}
          />
        ) : (
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            <PairColumn title="Top pairs" pairs={top} />
            <PairColumn title="Worst pairs" pairs={worst} />
          </div>
        )}
      </Card.Content>
    </Card.Root>
  );
};

interface PairColumnProps {
  title: string;
  pairs: Stats['byPair'];
}

const PairColumn = ({ title, pairs }: PairColumnProps) => {
  const filterByToken = useUi((s) => s.filterByToken);
  return (
    <div className="min-w-0">
      <SectionLabel className="mb-2">{title}</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {pairs.length === 0 && <p className="text-faint text-sm">—</p>}
        {pairs.map((pair) => {
          // "TOKEN/SOL" filters History by TOKEN; anything else falls back to the whole pair string.
          const [base = '', quote = ''] = pair.pair.split('/');
          const token = quote === 'SOL' ? base : pair.pair;
          return (
            <Button
              key={pair.pair}
              variant="ghost"
              size="sm"
              aria-label={`Filter history by ${token}`}
              onPress={() => filterByToken(token)}
              className="-mx-2 h-auto min-h-11 w-full justify-between gap-3 px-2 py-1.5 text-sm md:min-h-9"
            >
              <span className="flex min-w-0 items-center gap-2 text-foreground">
                <span className="truncate">{pair.pair}</span>
                <span className="tabular shrink-0 text-faint text-xs">×{pair.count}</span>
              </span>
              <span className={cn('tabular font-medium', toneTextClass[toneOf(pnlOf(pair))])}>
                <MoneyValue value={pnlOf(pair)} quoteSymbol={pair.quoteSymbol} signed />
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
};

/** Two columns of five rows — the card's real geometry, so the list doesn't jump when it lands. */
const PairsSkeleton = () => (
  <Card.Root>
    <Card.Header>
      <Card.Title>Best &amp; worst pairs</Card.Title>
    </Card.Header>
    <Card.Content>
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        {[0, 1].map((column) => (
          <div key={column} className="flex flex-col gap-2">
            <Skeleton.Root className="h-3 w-20 rounded" />
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton.Root key={row} className="h-7 w-full rounded" />
            ))}
          </div>
        ))}
      </div>
    </Card.Content>
  </Card.Root>
);
