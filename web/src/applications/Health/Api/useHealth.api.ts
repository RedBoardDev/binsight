import type { Health } from '@app/applications/Health/Api/getHealth';
import { healthQuery } from '@app/applications/Health/Api/healthQuery';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

export function useHealth(): UseQueryResult<Health> {
  return useQuery(healthQuery);
}
