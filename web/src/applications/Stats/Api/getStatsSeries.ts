import { ApiError } from '@app/lib/api/apiError';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { apiClient } from '@app/lib/api/client';
import type { operations } from '@app/lib/api/generated/openapi';

export type StatsSeries = ApiSchema<'StatsSeries'>;
export type StatsSeriesRequest = Required<
  NonNullable<operations['getStatsSeries']['parameters']['query']>
>;

export const getStatsSeries = async (
  request: StatsSeriesRequest,
  signal?: AbortSignal,
): Promise<StatsSeries> => {
  const { data, error, response } = await apiClient.GET('/api/v1/stats/series', {
    params: { query: request },
    ...(signal === undefined ? {} : { signal }),
  });
  if (data !== undefined) return data;
  throw new ApiError(response, error);
};
