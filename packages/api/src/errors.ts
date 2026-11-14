/** Error shape of the operator API: `{ error: { code, message } }` (contracts/operator-api.md). */
export const ERROR_STATUS = {
  AUTH_REQUIRED: 401,
  NOT_OPERATOR: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID: 422,
  STOPPED: 423,
  NOT_IMPLEMENTED: 501,
  UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
  toBody() {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

export const notImplemented = (what: string) => new ApiError("NOT_IMPLEMENTED", `${what} is not implemented yet`);
