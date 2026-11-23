import type { Db } from 'mongodb';
import { authenticateSession, SESSION_TTL_MS } from '@/lib/db/sessions.repository';
import { UnauthorizedError } from '@/lib/shared/errors';
import type { ShoppingSession } from '@/lib/shared/types';

export const SESSION_COOKIE = 'smartcart_session';

export function readSessionCookie(request: Request): { sessionId: string; token: string } | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== SESSION_COOKIE) continue;
    const value = decodeURIComponent(rest.join('='));
    const [sessionId, token] = value.split('.');
    if (sessionId && token && /^[0-9a-f-]{36}$/u.test(sessionId) && /^[A-Za-z0-9_-]{20,100}$/u.test(token)) return { sessionId, token };
  }
  return null;
}

export function sessionCookieHeader(sessionId: string, token: string, request: Request): string {
  // Secure follows the real protocol, including HTTPS terminated at a proxy.
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const secure = new URL(request.url).protocol === 'https:' || forwarded === 'https';
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(`${sessionId}.${token}`)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}

/** Every session-scoped API call proves ownership with the secret cookie token. */
export async function requireSession(db: Db, request: Request): Promise<ShoppingSession> {
  const cookie = readSessionCookie(request);
  if (!cookie) throw new UnauthorizedError();
  return authenticateSession(db, cookie.sessionId, cookie.token);
}
