import { queryRetryDelay, shouldRetryQuery } from '@app/core/query/createQueryClient';
import { ApiError } from '@app/lib/api/apiError';
import { describe, expect, it } from 'vitest';

describe('shouldRetryQuery', () => {
  it('retries a request that got no answer, three times at most', () => {
    const networkFailure = new TypeError('Failed to fetch');

    expect(shouldRetryQuery(0, networkFailure)).toBe(true);
    expect(shouldRetryQuery(2, networkFailure)).toBe(true);
    expect(shouldRetryQuery(3, networkFailure)).toBe(false);
  });

  it('never retries an answer from the API', () => {
    const answer = new ApiError(new Response(null, { status: 500 }), null);

    expect(shouldRetryQuery(0, answer)).toBe(false);
  });

  it('never retries a programming error', () => {
    expect(shouldRetryQuery(0, new RangeError('bug'))).toBe(false);
  });
});

describe('queryRetryDelay', () => {
  it('doubles from one second and stops at eight', () => {
    expect([0, 1, 2, 3, 4].map(queryRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });
});
