import { getSession } from '@app/applications/Auth/Api/getSession';
import { queryOptions } from '@tanstack/react-query';

const SESSION_STALE_TIME_MS = 60_000;

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: getSession,
  meta: { entities: ['Session'] },
  staleTime: SESSION_STALE_TIME_MS,
});
