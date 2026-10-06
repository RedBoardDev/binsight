import {
  getStatsSeries,
  type StatsSeries,
  type StatsSeriesRequest,
} from '@app/applications/Stats/Api/getStatsSeries';
import { queryOptions, type UseQueryOptions } from '@tanstack/react-query';

export const statsSeriesQuery = (request: StatsSeriesRequest): UseQueryOptions<StatsSeries> =>
  queryOptions<StatsSeries>({
    queryKey: ['Stats', 'series', request],
    queryFn: ({ signal }) => getStatsSeries(request, signal),
    meta: { entities: ['Stats'] },
  });
