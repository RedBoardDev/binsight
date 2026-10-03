import type { SessionInfo } from '@app/applications/Auth/Api/getSession';
import type { LoginFormValues } from '@app/applications/Auth/Domain/loginForm';
import { ApiError, type ErrorCode } from '@app/lib/api/apiError';
import { apiClient } from '@app/lib/api/client';

export type LoginFormError =
  | { readonly kind: 'too_many_attempts'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'network' }
  | { readonly kind: 'api'; readonly code: ErrorCode | null };

export type LoginResult =
  | { readonly status: 'success'; readonly session: SessionInfo }
  | { readonly status: 'error'; readonly fieldErrors: { readonly password: 'invalid_credentials' } }
  | { readonly status: 'error'; readonly formError: LoginFormError };

const readRetryAfterSeconds = (response: Response): number | null => {
  const seconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
};

const sendLogin = async (values: LoginFormValues): Promise<LoginResult> => {
  const { data, error, response } = await apiClient.POST('/api/v1/auth/login', { body: values });
  if (data !== undefined) {
    return { status: 'success', session: data };
  }
  const { code } = new ApiError(response, error);
  if (code === 'invalid_credentials') {
    return { status: 'error', fieldErrors: { password: 'invalid_credentials' } };
  }
  if (code === 'too_many_attempts') {
    const retryAfterSeconds = readRetryAfterSeconds(response);
    return { status: 'error', formError: { kind: 'too_many_attempts', retryAfterSeconds } };
  }
  return { status: 'error', formError: { kind: 'api', code } };
};

export const login = async (values: LoginFormValues): Promise<LoginResult> => {
  try {
    return await sendLogin(values);
  } catch (error) {
    if (error instanceof TypeError) {
      return { status: 'error', formError: { kind: 'network' } };
    }
    throw error;
  }
};
