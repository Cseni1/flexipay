// API errors are JSON { code, message } with HTTP 400, 401, 404, 409 or 422 (ARCHITECTURE §10).
export type ApiStatus = 400 | 401 | 404 | 409 | 422 | 500 | 502;

export class ApiError extends Error {
  readonly status: ApiStatus;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: ApiStatus, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
