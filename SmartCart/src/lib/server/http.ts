import { ZodError } from 'zod';
import { ForbiddenError, toPublicError, ValidationError } from '@/lib/shared/errors';

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  const normalized = error instanceof ZodError
    ? new ValidationError(error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '))
    : error;
  const publicError = toPublicError(normalized);
  if (publicError.status >= 500) console.error('[smartcart]', normalized instanceof Error ? normalized.message : normalized);
  return json({ error: { code: publicError.code, message: publicError.message } }, { status: publicError.status });
}

/** Browsers always send Origin on cross-site POST/PATCH; reject other origins. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError('Invalid request origin.');
  }
  if (!host || originHost !== host) throw new ForbiddenError('Cross-site requests are not allowed.');
}

export async function readJson(request: Request, maxBytes = 64_000): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxBytes) throw new ValidationError('Request body is too large.');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
}
