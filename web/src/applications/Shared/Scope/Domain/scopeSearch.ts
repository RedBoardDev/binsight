import { DEFAULT_PERIOD, periodSchema } from '@app/applications/Shared/Scope/Domain/period';
import { ALL_WALLETS, walletScopeSchema } from '@app/applications/Shared/Scope/Domain/walletScope';
import { z } from 'zod';

export const scopeSearchSchema = z.object({
  wallet: walletScopeSchema.default(ALL_WALLETS).catch(ALL_WALLETS),
  period: periodSchema.default(DEFAULT_PERIOD).catch(DEFAULT_PERIOD),
});

export type ScopeSearch = z.infer<typeof scopeSearchSchema>;

export const SCOPE_SEARCH_DEFAULTS: ScopeSearch = { wallet: ALL_WALLETS, period: DEFAULT_PERIOD };

export const SCOPE_SEARCH_KEYS = [
  'wallet',
  'period',
] as const satisfies readonly (keyof ScopeSearch)[];
