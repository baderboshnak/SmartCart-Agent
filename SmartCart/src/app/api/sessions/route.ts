import { getOrCreateCart } from '@/lib/db/carts.repository';
import { getDb } from '@/lib/db/mongodb';
import { createSession } from '@/lib/db/sessions.repository';
import { assertSameOrigin, errorResponse, json } from '@/lib/server/http';
import { requireSession, sessionCookieHeader } from '@/lib/server/session-cookie';
import { createTerminalTrace } from '@/lib/server/terminal-trace';
import type { ShoppingSession } from '@/lib/shared/types';
import { toCartView } from '@/lib/shopping/cart-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function publicSession(session: ShoppingSession) {
  return {
    messages: session.messages.map(({ id, role, content, kind, options, via, createdAt }) => ({
      id, role, content, kind, ...(options?.length ? { options } : {}), ...(via ? { via } : {}), createdAt
    })),
    pendingClarification: session.pendingClarification
  };
}

/** The current session (from the secret cookie) with its conversation and cart. */
export async function GET(request: Request): Promise<Response> {
  const trace = createTerminalTrace('session');
  trace('restore.started');
  try {
    const db = await getDb();
    trace('database.ready');
    const session = await requireSession(db, request);
    trace('session.validated');
    const cart = await getOrCreateCart(db, session._id);
    trace('restore.completed', { messageCount: session.messages.length, cartRevision: cart.revision, itemCount: cart.items.length });
    return json({ session: publicSession(session), cart: toCartView(cart) });
  } catch (error) {
    return errorResponse(error, trace);
  }
}

/** Start a new anonymous session. The cookie carries the only copy of its secret token. */
export async function POST(request: Request): Promise<Response> {
  const trace = createTerminalTrace('session');
  trace('create.started');
  try {
    assertSameOrigin(request);
    const db = await getDb();
    trace('database.ready');
    const { session, token } = await createSession(db);
    trace('session.saved');
    const cart = await getOrCreateCart(db, session._id);
    trace('create.completed', { cartRevision: cart.revision, itemCount: cart.items.length });
    return json(
      { session: publicSession(session), cart: toCartView(cart) },
      { status: 201, headers: { 'Set-Cookie': sessionCookieHeader(session._id, token, request) } }
    );
  } catch (error) {
    return errorResponse(error, trace);
  }
}
