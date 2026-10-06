import { ApiError } from '@app/lib/api/apiError';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { apiClient } from '@app/lib/api/client';
import type { operations } from '@app/lib/api/generated/openapi';

export type Overview = ApiSchema<'Overview'>;
export type OverviewRequest = Required<
  NonNullable<operations['getOverview']['parameters']['query']>
>;

export const getOverview = async (
  request: OverviewRequest,
  signal?: AbortSignal,
): Promise<Overview> => {
  const { data, error, response } = await apiClient.GET('/api/v1/overview', {
    params: { query: request },
    ...(signal === undefined ? {} : { signal }),
  });
  if (data !== undefined) return data;
  throw new ApiError(response, error);
};
