import type { EntityName } from '@app/applications/Shared/Domain/entityName';
import { invalidateEntities } from '@app/core/query/entityPredicate';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

const buildQuery = (queryClient: QueryClient, name: string, entities?: readonly EntityName[]) =>
  queryClient.getQueryCache().build(queryClient, {
    queryKey: [name],
    ...(entities === undefined ? {} : { meta: { entities } }),
  });

describe('invalidateEntities', () => {
  it('invalidates the queries tagged with one of the entities', async () => {
    const queryClient = new QueryClient();
    const health = buildQuery(queryClient, 'health', ['Health']);
    const session = buildQuery(queryClient, 'session', ['Session']);

    await invalidateEntities(queryClient, ['Health']);

    expect(health.state.isInvalidated).toBe(true);
    expect(session.state.isInvalidated).toBe(false);
  });

  it('invalidates a query without tags, whatever the entities', async () => {
    const queryClient = new QueryClient();
    const untagged = buildQuery(queryClient, 'untagged');

    await invalidateEntities(queryClient, ['Session']);

    expect(untagged.state.isInvalidated).toBe(true);
  });
});
