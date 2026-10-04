import type { ApiSchema } from '@app/lib/api/apiSchema';

export type ErrorCode = ApiSchema<'ErrorCode'>;

// `satisfies` keeps this list equal to the contract: a code added on the server fails the
// typecheck here until it is listed.
const ERROR_CODES = {
  invalid_request: true,
  unauthenticated: true,
  invalid_credentials: true,
  forbidden_cross_origin: true,
  not_found: true,
  method_not_allowed: true,
  wallet_not_found: true,
  position_not_found: true,
  request_timeout: true,
  payload_too_large: true,
  too_many_attempts: true,
  data_not_ready: true,
  internal: true,
} as const satisfies Record<ErrorCode, true>;

const REQUEST_ID_HEADER = 'x-request-id';

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);

interface ErrorDetail {
  readonly code: ErrorCode | null;
  readonly requestId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// A reverse proxy or a dead server answers with anything but our error body: such an error has
// no code, and the caller shows a generic message.
const readErrorDetail = (body: unknown): ErrorDetail => {
  const detail = isRecord(body) && isRecord(body.error) ? body.error : {};
  return {
    code: isErrorCode(detail.code) ? detail.code : null,
    requestId: typeof detail.request_id === 'string' ? detail.request_id : null,
  };
};

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: ErrorCode | null;
  readonly requestId: string | null;

  constructor(response: Response, body: unknown) {
    const { code, requestId } = readErrorDetail(body);
    super(`the API answered ${response.status} (${code ?? 'without an error code'})`);
    this.status = response.status;
    this.code = code;
    this.requestId = requestId ?? response.headers.get(REQUEST_ID_HEADER);
  }
}
