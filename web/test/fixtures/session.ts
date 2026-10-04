import type { ApiSchema } from '@app/lib/api/apiSchema';

// The session of a signed-in owner.
export const activeSession = (): ApiSchema<'SessionInfo'> => ({
  authenticated: true,
  expires_at: '2026-11-02T12:00:00Z',
});
