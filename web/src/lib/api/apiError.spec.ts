import { ApiError, isErrorCode } from '@app/lib/api/apiError';
import { describe, expect, it } from 'vitest';

const errorBody = (code: string, requestId: string): unknown => ({
  error: { code, message: 'for debugging only', request_id: requestId },
});

describe('ApiError', () => {
  it('reads the code and the request id from the error body', () => {
    const error = new ApiError(
      new Response(null, { status: 429 }),
      errorBody('too_many_attempts', 'req-1'),
    );

    expect(error.status).toBe(429);
    expect(error.code).toBe('too_many_attempts');
    expect(error.requestId).toBe('req-1');
  });

  it('has no code when the body is not an API error body', () => {
    const response = new Response(null, { status: 502, headers: { 'x-request-id': 'req-2' } });

    const error = new ApiError(response, '<html>Bad gateway</html>');

    expect(error.code).toBeNull();
    expect(error.requestId).toBe('req-2');
  });

  it('has no code when the server sends a code the contract does not know', () => {
    const error = new ApiError(
      new Response(null, { status: 400 }),
      errorBody('brand_new', 'req-3'),
    );

    expect(error.code).toBeNull();
  });
});

describe('isErrorCode', () => {
  it('accepts only the codes of the contract', () => {
    expect(isErrorCode('invalid_credentials')).toBe(true);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode(401)).toBe(false);
  });
});
