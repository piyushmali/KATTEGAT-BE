/**
 * KATTEGAT error model.
 *
 * Every failure the API returns is shaped as `{ error: { code, message,
 * details?, requestId } }`. `code` is a stable machine-readable token the
 * frontend switches on for UX; `message` is safe to show a user. Anything that
 * could carry provider internals, credentials or SQL stays out of both and is
 * logged server-side instead.
 */

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_PAYMENT_REQUIRED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_PAYMENT_REQUIRED: 502,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;
  /**
   * True when the message is safe to surface verbatim to an end user. Errors we
   * did not raise deliberately are reported as a generic message instead.
   */
  readonly expose = true;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('BAD_REQUEST', message, details);

export const notFound = (message: string, details?: unknown): AppError =>
  new AppError('NOT_FOUND', message, details);

/**
 * A third-party dependency (RPC endpoint, IPFS gateway, Explorer API) failed.
 * Distinct from INTERNAL_ERROR so the UI can offer "retry" rather than
 * presenting the marketplace as broken.
 */
export const upstreamUnavailable = (message: string, details?: unknown): AppError =>
  new AppError('UPSTREAM_UNAVAILABLE', message, details);

/**
 * The ERC-8004 Explorer API answered 402: the request needs an x402
 * micropayment we are not configured to sign. Called out separately because the
 * operator fix is "fund the signer", not "debug the code".
 */
export const upstreamPaymentRequired = (message: string, details?: unknown): AppError =>
  new AppError('UPSTREAM_PAYMENT_REQUIRED', message, details);

export const internalError = (message: string, details?: unknown): AppError =>
  new AppError('INTERNAL_ERROR', message, details);

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
