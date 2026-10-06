import { ALL_WALLETS, type WalletScope } from '@app/applications/Shared/Scope/Domain/walletScope';
import type { ApiSchema } from '@app/lib/api/apiSchema';

interface TodayHistoryTarget {
  readonly window: ApiSchema<'Overview'>['today']['window'];
  readonly wallet: WalletScope;
}

export const buildTodayHistoryHref = ({ window, wallet }: TodayHistoryTarget): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: window.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(window.start));
  const part = (kind: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((item) => item.type === kind)?.value;
    if (value === undefined) throw new RangeError(`Missing calendar part: ${kind}`);
    return value;
  };
  const day = window.day ?? `${part('year')}-${part('month')}-${part('day')}`;
  const params = new URLSearchParams({ day });
  if (wallet !== ALL_WALLETS) params.set('wallet', wallet);
  return `/history?${params}`;
};
