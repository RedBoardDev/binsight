import type { ApiSchema } from '@app/lib/api/apiSchema';

type Health = ApiSchema<'Health'>;

// A server whose every component answers; override what a test is about.
export const healthyServer = (overrides: Partial<Health> = {}): Health => ({
  status: 'ok',
  version: '0.1.0',
  database: 'ok',
  engine: 'running',
  ...overrides,
});
