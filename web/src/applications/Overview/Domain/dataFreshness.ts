// When the figures on screen date from. The server reads them now ("as_of"); a wallet that lags
// behind the chain makes them as old as its lag, so that is the instant to show, and the live
// figures are dimmed until it catches up.

interface Freshness {
  readonly as_of: string;
  readonly state: 'live' | 'importing' | 'lagging' | 'error';
  readonly lag_seconds?: number | null;
}

const MILLISECONDS_PER_SECOND = 1000;

export const isCatchingUp = (freshness: Freshness): boolean => freshness.state === 'lagging';

// The instant the data dates from, as RFC 3339; the reading instant when nothing lags.
export const dataTimestamp = (freshness: Freshness): string => {
  const lag = freshness.lag_seconds ?? 0;
  if (!isCatchingUp(freshness) || lag === 0) return freshness.as_of;
  const readAt = Date.parse(freshness.as_of);
  return Number.isNaN(readAt)
    ? freshness.as_of
    : new Date(readAt - lag * MILLISECONDS_PER_SECOND).toISOString();
};
