import { ApiError } from '@app/lib/api/apiError';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { apiClient } from '@app/lib/api/client';

export type Health = ApiSchema<'Health'>;

const isJsonResponse = (response: Response): boolean =>
  response.headers.get('content-type')?.startsWith('application/json') ?? false;

export const getHealth = async (): Promise<Health> => {
  const { data, error, response } = await apiClient.GET('/api/v1/health');
  if (data !== undefined) {
    return data;
  }
  // A 503 from binsight is still a report: the server answers, its database does not. A 503
  // from a reverse proxy in front of it is not, and has no JSON body.
  if (response.status === 503 && error !== undefined && isJsonResponse(response)) {
    return error;
  }
  throw new ApiError(response, error);
};
