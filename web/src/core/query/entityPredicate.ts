import type { EntityName } from '@app/applications/Shared/Domain/entityName';
import type { Query, QueryClient } from '@tanstack/react-query';

// A query without entity tags is invalidated by every invalidation: refetching too much is safe,
// keeping data that a change made stale is not.
export const touchesEntities = (query: Query, entities: readonly EntityName[]): boolean => {
  const tags = query.meta?.entities;
  return tags === undefined || tags.some((tag) => entities.includes(tag));
};

export const invalidateEntities = (
  queryClient: QueryClient,
  entities: readonly EntityName[],
): Promise<void> =>
  queryClient.invalidateQueries({ predicate: (query) => touchesEntities(query, entities) });
