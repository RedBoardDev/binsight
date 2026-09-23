'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import type { ClosedPositionsQueryState } from '@app/applications/Position/Ui/useClosedPositionsQuery';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { History, Layers } from 'lucide-react';
import type { ReactNode } from 'react';

interface OpenPositionsStateProps {
  /** The layout's own placeholder, shaped like what it renders once the feed lands. */
  skeleton: ReactNode;
  children: ReactNode;
}

/** Error / loading / empty around the live open-positions list, so the desktop table and the mobile
 *  cards can never disagree about which one to show. `children` renders once there are rows. */
export const OpenPositionsState = ({ skeleton, children }: OpenPositionsStateProps) => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const feedError = usePortfolioFeed((s) => s.error);
  const retryFeed = usePortfolioFeed((s) => s.retry);

  if (portfolio == null) {
    if (!feedError) return skeleton;
    return (
      <StateMessage
        variant="error"
        title="Couldn't load positions"
        hint="The wallet feed is unreachable."
        onRetry={retryFeed}
      />
    );
  }
  if (portfolio.open.length === 0) {
    return (
      <StateMessage
        icon={<Layers size={18} />}
        title="No open positions"
        hint="Active Meteora LP positions appear here live."
      />
    );
  }
  return children;
};

interface ClosedPositionsStateProps extends OpenPositionsStateProps {
  closed: ClosedPositionsQueryState;
}

/** Error / loading / empty around the closed-positions history, shared the same way. A page already
 *  on screen stays there through a refetch or a failed one — only a first load shows these. */
export const ClosedPositionsState = ({ closed, skeleton, children }: ClosedPositionsStateProps) => {
  if (!closed.hasData && closed.error) {
    return (
      <StateMessage
        variant="error"
        title="Couldn't load history"
        hint="Check the connection and try again."
        onRetry={closed.refetch}
      />
    );
  }
  if (!closed.hasData && closed.loading) return skeleton;
  if (closed.rows.length === 0) {
    const isFiltered = closed.q !== '' || closed.result !== 'all';
    return (
      <StateMessage
        icon={<History size={18} />}
        title={isFiltered ? 'No matching trades' : 'No closed positions'}
        hint={isFiltered ? 'Try clearing the filters.' : 'Closed positions land here.'}
      />
    );
  }
  return children;
};
