'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import {
  type ClosedPositionsQuery,
  closedPositionsCsvHref,
  useClosedPositions,
} from '@app/applications/Position/Api/usePositions.api';
import { ClosedPositionEntity } from '@app/applications/Position/Domain/position';
import { SEARCH_DEBOUNCE_MS } from '@app/applications/Shared/Domain/timings';
import { useUi } from '@app/core/stores/uiStore';
import { useEffect, useState } from 'react';

const CLOSED_PAGE_SIZE = 10;

export const CLOSED_RESULTS: { label: string; value: ClosedPositionsQuery['result'] }[] = [
  { label: 'All', value: 'all' },
  { label: 'Wins', value: 'win' },
  { label: 'Losses', value: 'loss' },
];

export const CLOSED_SORTS: { label: string; value: ClosedPositionsQuery['sort'] }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'PnL', value: 'pnl' },
  { label: 'Fees', value: 'fees' },
  { label: 'Held', value: 'duration' },
];

export interface ClosedPositionsQueryState {
  scope: string;
  hasData: boolean;
  qInput: string;
  setQInput: (value: string) => void;
  q: string;
  result: ClosedPositionsQuery['result'];
  setResult: (value: ClosedPositionsQuery['result']) => void;
  sort: ClosedPositionsQuery['sort'];
  setSort: (value: ClosedPositionsQuery['sort']) => void;
  dir: ClosedPositionsQuery['dir'];
  setDir: (value: ClosedPositionsQuery['dir']) => void;
  page: number;
  setPage: (page: number) => void;
  rows: ClosedPositionEntity[];
  total: number;
  pages: number;
  loading: boolean;
  /** Previous page still on screen while a new one loads — dim it instead of blanking. */
  stale: boolean;
  error: boolean;
  refetch: () => void;
  exportCsv: () => void;
}

/**
 * Headless closed-positions query — owns scope/page/search (debounced)/result/sort/dir, the fetch,
 * the derived rows/total/pages and the CSV export of the current filter. Shared verbatim by the
 * desktop history table and the mobile history view so the filtering logic lives in one place.
 */
export function useClosedPositionsQuery(): ClosedPositionsQueryState {
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  const historyQuery = useUi((s) => s.historyQuery);
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [result, setResult] = useState<ClosedPositionsQuery['result']>('all');
  const [sort, setSort] = useState<ClosedPositionsQuery['sort']>('recent');
  const [dir, setDir] = useState<ClosedPositionsQuery['dir']>('desc');

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput]);

  // An external token filter (clicking a Stats pair → filterByToken) drives the search box.
  useEffect(() => {
    if (historyQuery) setQInput(historyQuery);
  }, [historyQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset to page 1 on scope/filter change.
  useEffect(() => setPage(1), [scope, q, result, sort, dir]);

  const query = { q, result, sort, dir };
  const closedPage = useClosedPositions(scope, page, CLOSED_PAGE_SIZE, query, closedVersion);

  const rows = (closedPage.data?.rows ?? []).map((row) => new ClosedPositionEntity(row));
  const total = closedPage.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CLOSED_PAGE_SIZE));

  // CSV of the CURRENT filter (cookie-authed download, so a plain <a> carries the session).
  const exportCsv = () => {
    const anchor = document.createElement('a');
    anchor.href = closedPositionsCsvHref(scope, query);
    anchor.download = 'meteora-closed-positions.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return {
    scope,
    hasData: closedPage.data != null,
    qInput,
    setQInput,
    q,
    result,
    setResult,
    sort,
    setSort,
    dir,
    setDir,
    page,
    setPage,
    rows,
    total,
    pages,
    loading: closedPage.isPending,
    stale: closedPage.isPlaceholderData || (closedPage.isFetching && !closedPage.isPending),
    error: closedPage.isError,
    refetch: () => void closedPage.refetch(),
    exportCsv,
  };
}
