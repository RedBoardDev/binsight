import { DEFAULT_PERIOD, periodSchema } from '@app/applications/Shared/Scope/Domain/period';
import { ALL_WALLETS, walletScopeSchema } from '@app/applications/Shared/Scope/Domain/walletScope';
import { z } from 'zod/mini';

export const scopeSearchSchema = z.object({
  wallet: z.catch(z._default(walletScopeSchema, ALL_WALLETS), ALL_WALLETS),
  period: z.catch(z._default(periodSchema, DEFAULT_PERIOD), DEFAULT_PERIOD),
});

export type ScopeSearch = z.infer<typeof scopeSearchSchema>;

export const SCOPE_SEARCH_DEFAULTS: ScopeSearch = { wallet: ALL_WALLETS, period: DEFAULT_PERIOD };

export const SCOPE_SEARCH_KEYS = [
  'wallet',
  'period',
] as const satisfies readonly (keyof ScopeSearch)[];
