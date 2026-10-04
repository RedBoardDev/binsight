import { ApiError, type ErrorCode } from '@app/lib/api/apiError';
import { apiClient } from '@app/lib/api/client';

export type LogoutFormError =
  | { readonly kind: 'network' }
  | { readonly kind: 'api'; readonly code: ErrorCode | null };

export type LogoutResult =
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly formError: LogoutFormError };

const sendLogout = async (): Promise<LogoutResult> => {
  const { error, response } = await apiClient.POST('/api/v1/auth/logout');
  if (response.ok) {
    return { status: 'success' };
  }
  return { status: 'error', formError: { kind: 'api', code: new ApiError(response, error).code } };
};

export const logout = async (): Promise<LogoutResult> => {
  try {
    return await sendLogout();
  } catch (error) {
    // fetch rejects with a TypeError when the server cannot be reached; anything else is a bug
    // the owner can only retry, so it is reported like an unknown API error.
    return error instanceof TypeError
      ? { status: 'error', formError: { kind: 'network' } }
      : { status: 'error', formError: { kind: 'api', code: null } };
  }
};
