import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from 'mongodb';
import { collections } from '@/lib/db/mongodb';
import { RateLimitError, UnauthorizedError } from '@/lib/shared/errors';
import type { ChatMessage, ShoppingSession } from '@/lib/shared/types';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STORED_MESSAGES = 200;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/gu, '')}`;
}

/** Create an anonymous session. The secret token is returned once and only its hash is stored. */
export async function createSession(db: Db): Promise<{ session: ShoppingSession; token: string }> {
  const now = new Date();
  const token = randomBytes(32).toString('base64url');
  const session: ShoppingSession = {
    _id: randomUUID(),
    tokenHash: hashToken(token),
    messages: [],
    intent: null,
    pendingClarification: null,
    activeRun: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS)
  };
  await collections.sessions(db).insertOne(session);
  return { session, token };
}

export async function getSession(db: Db, sessionId: string): Promise<ShoppingSession | null> {
  return collections.sessions(db).findOne({ _id: sessionId });
}

/** Load a session only when the caller presents its secret token. */
export async function authenticateSession(db: Db, sessionId: string, token: string): Promise<ShoppingSession> {
  const session = await getSession(db, sessionId);
  if (!session) throw new UnauthorizedError();
  const expected = Buffer.from(session.tokenHash, 'hex');
  const actual = Buffer.from(hashToken(token), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new UnauthorizedError();
  return session;
}

export async function appendMessages(db: Db, sessionId: string, messages: ChatMessage[]): Promise<void> {
  if (!messages.length) return;
  const now = new Date();
  await collections.sessions(db).updateOne(
    { _id: sessionId },
    {
      $push: { messages: { $each: messages, $slice: -MAX_STORED_MESSAGES } },
      $set: { updatedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) }
    }
  );
}

export async function updateSessionState(
  db: Db,
  sessionId: string,
  patch: Partial<Pick<ShoppingSession, 'intent' | 'pendingClarification'>>
): Promise<void> {
  const now = new Date();
  await collections.sessions(db).updateOne(
    { _id: sessionId },
    { $set: { ...patch, updatedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } }
  );
}

/** Allow one agent run per session at a time. The lock expires if a server dies mid-run. */
export async function acquireRunLock(db: Db, sessionId: string, runId: string, ttlMs: number): Promise<void> {
  const now = new Date();
  const result = await collections.sessions(db).findOneAndUpdate(
    { _id: sessionId, $or: [{ activeRun: null }, { 'activeRun.expiresAt': { $lt: now } }] },
    { $set: { activeRun: { runId, expiresAt: new Date(now.getTime() + ttlMs) } } }
  );
  if (!result) throw new RateLimitError('SmartCart is still working on your previous message. Wait for it to finish.');
}

export async function releaseRunLock(db: Db, sessionId: string, runId: string): Promise<void> {
  await collections.sessions(db).updateOne({ _id: sessionId, 'activeRun.runId': runId }, { $set: { activeRun: null } });
}
