import {
  getOverview,
  type Overview,
  type OverviewRequest,
} from '@app/applications/Overview/Api/getOverview';
import { queryOptions, type UseQueryOptions } from '@tanstack/react-query';

export const overviewQuery = (request: OverviewRequest): UseQueryOptions<Overview> =>
  queryOptions<Overview>({
    queryKey: ['Overview', 'get', request],
    queryFn: ({ signal }) => getOverview(request, signal),
    meta: { entities: ['Overview'] },
  });
