import type { paths } from '@app/lib/api/generated/openapi';
import { createUnauthorizedMiddleware } from '@app/lib/api/unauthorizedMiddleware';
import createClient from 'openapi-fetch';
import { describe, expect, it, vi } from 'vitest';

const answerWith = (status: number) => {
  const onUnauthorized = vi.fn();
  const client = createClient<paths>({
    baseUrl: 'http://binsight.test',
    fetch: async () => new Response(null, { status }),
  });
  client.use(createUnauthorizedMiddleware(onUnauthorized));
  return { client, onUnauthorized };
};

describe('createUnauthorizedMiddleware', () => {
  it('reports a 401 from any API route', async () => {
    const { client, onUnauthorized } = answerWith(401);

    await client.GET('/api/v1/health');

    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('ignores the 401 of a wrong password and of a signed-out session check', async () => {
    const { client, onUnauthorized } = answerWith(401);

    await client.POST('/api/v1/auth/login', { body: { password: 'wrong' } });
    await client.GET('/api/v1/auth/session');

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('ignores every other status', async () => {
    const { client, onUnauthorized } = answerWith(403);

    await client.GET('/api/v1/health');

    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
