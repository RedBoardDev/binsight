import type { ApiSchema } from '@app/lib/api/apiSchema';

type Health = ApiSchema<'Health'>;

// A server whose every component answers; override what a test is about.
export const healthyServer = (overrides: Partial<Health> = {}): Health => ({
  status: 'ok',
  version: '0.1.0',
  database: 'ok',
  engine: 'running',
  rpc: 'unknown',
  stream: 'idle',
  data_source: 'chain',
  credits: {
    today_used: 0,
    daily_allowance: 100_000,
    cycle_used: 0,
    quota: 1_000_000,
    hard_limit_reached: false,
  },
  ...overrides,
});
