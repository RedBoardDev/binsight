import type { ErrorCode } from '@app/lib/api/apiError';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

// A Record over every code: a code added to the contract fails the typecheck until it has a
// message here.
const API_ERROR_MESSAGES: Record<ErrorCode, MessageDescriptor> = {
  invalid_request: msg`The request was not valid. Reload the app and try again.`,
  unauthenticated: msg`Your session has ended. Sign in again.`,
  invalid_credentials: msg`Incorrect password.`,
  forbidden_cross_origin: msg`The request was refused because it did not come from binsight itself.`,
  not_found: msg`This item no longer exists.`,
  method_not_allowed: msg`The server refused this action. Reload the app and try again.`,
  wallet_not_found: msg`This wallet is no longer tracked.`,
  request_timeout: msg`The server took too long to answer. Try again.`,
  payload_too_large: msg`The request was too large for the server.`,
  too_many_attempts: msg`Too many attempts. Wait a moment and try again.`,
  data_not_ready: msg`binsight is still preparing your figures. Try again in a moment.`,
  internal: msg`The server ran into a problem. Try again later.`,
};

const UNKNOWN_ERROR_MESSAGE = msg`Something went wrong. Try again.`;

export const NETWORK_ERROR_MESSAGE = msg`binsight cannot be reached. Check your connection and try again.`;

export const apiErrorMessage = (code: ErrorCode | null): MessageDescriptor =>
  code === null ? UNKNOWN_ERROR_MESSAGE : API_ERROR_MESSAGES[code];
