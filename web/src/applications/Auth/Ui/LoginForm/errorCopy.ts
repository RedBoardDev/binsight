import { LOGIN_FORM_ISSUES, type LoginFormIssue } from '@app/applications/Auth/Domain/loginForm';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

type PasswordError = LoginFormIssue | 'invalid_credentials';

const PASSWORD_ERROR_MESSAGES: Record<PasswordError, MessageDescriptor> = {
  password_required: msg`Enter the password.`,
  password_too_long: msg`This password is too long.`,
  invalid_credentials: msg`Incorrect password.`,
};

const isPasswordError = (value: string): value is PasswordError =>
  value === 'invalid_credentials' || (LOGIN_FORM_ISSUES as readonly string[]).includes(value);

// react-hook-form carries the error as a plain string: the zod issue or the server's code.
export const passwordErrorMessage = (error: string | undefined): MessageDescriptor | null =>
  error !== undefined && isPasswordError(error) ? PASSWORD_ERROR_MESSAGES[error] : null;
