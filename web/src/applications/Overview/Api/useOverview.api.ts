import type { Overview, OverviewRequest } from '@app/applications/Overview/Api/getOverview';
import { overviewQuery } from '@app/applications/Overview/Api/overviewQuery';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

export const useOverview = (request: OverviewRequest): UseQueryResult<Overview> =>
  useQuery(overviewQuery(request));
