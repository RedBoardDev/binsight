import { getHealth } from '@app/applications/Health/Api/getHealth';
import { queryOptions } from '@tanstack/react-query';

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: getHealth,
  meta: { entities: ['Health'] },
});
