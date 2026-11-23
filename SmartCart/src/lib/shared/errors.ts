/** Application errors carry an HTTP status and a stable code for clients. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, { status = 500, code = 'INTERNAL_ERROR', cause }: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', ...options });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'No valid shopping session. Start a new session.') {
    super(message, { status: 401, code: 'NO_SESSION' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'This request is not allowed.') {
    super(message, { status: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'The cart changed in the meantime. Reload it and try again.') {
    super(message, { status: 409, code: 'CART_CONFLICT' });
  }
}

export class RateLimitError extends AppError {
  constructor(message: string) {
    super(message, { status: 429, code: 'RATE_LIMITED' });
  }
}

export class DatabaseUnavailableError extends AppError {
  constructor(message = 'The SmartCart database is unavailable.', options: { cause?: unknown } = {}) {
    super(message, { status: 503, code: 'DATABASE_UNAVAILABLE', ...options });
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, { status: 500, code: 'CONFIGURATION_ERROR' });
  }
}

export class ModelError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { status: 502, code: 'MODEL_ERROR', ...options });
  }
}

export class TimeoutError extends AppError {
  constructor(message: string) {
    super(message, { status: 504, code: 'TIMEOUT' });
  }
}

/** Remove credentials from any text that might reach logs, tools or clients. */
export function redactSecrets(text: string): string {
  let result = text
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/giu, '$1<redacted>@')
    .replace(/([?&](?:key|api_key|apikey)=)[^&\s"']+/giu, '$1[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/gu, '[redacted]');
  for (const name of ['GEMINI_API_KEY', 'MONGODB_URI']) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) result = result.split(secret).join('[redacted]');
  }
  return result;
}

export function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export interface PublicError {
  status: number;
  code: string;
  message: string;
}

/** Convert any thrown value into a safe client-facing error. */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: redactSecrets(error.message) };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' };
}
