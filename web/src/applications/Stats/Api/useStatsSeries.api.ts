import type { StatsSeries, StatsSeriesRequest } from '@app/applications/Stats/Api/getStatsSeries';
import { statsSeriesQuery } from '@app/applications/Stats/Api/statsSeriesQuery';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

export const useStatsSeries = (request: StatsSeriesRequest): UseQueryResult<StatsSeries> =>
  useQuery(statsSeriesQuery(request));
