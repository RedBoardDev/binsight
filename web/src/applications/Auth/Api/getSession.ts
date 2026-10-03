import { ApiError } from '@app/lib/api/apiError';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { apiClient } from '@app/lib/api/client';

export type SessionInfo = ApiSchema<'SessionInfo'>;

export const getSession = async (): Promise<SessionInfo | null> => {
  const { data, error, response } = await apiClient.GET('/api/v1/auth/session');
  if (data !== undefined) {
    return data;
  }
  if (response.status === 401) {
    return null;
  }
  throw new ApiError(response, error);
};
