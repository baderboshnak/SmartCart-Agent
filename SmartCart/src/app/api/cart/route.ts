import { getOrCreateCart } from '@/lib/db/carts.repository';
import { getDb } from '@/lib/db/mongodb';
import { assertSameOrigin, errorResponse, json, readJson } from '@/lib/server/http';
import { getMatcher } from '@/lib/server/services';
import { requireSession } from '@/lib/server/session-cookie';
import { createTerminalTrace } from '@/lib/server/terminal-trace';
import { applyUiCartEdit, UiCartPatchSchema } from '@/lib/shopping/cart-service';
import { toCartView } from '@/lib/shopping/cart-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const trace = createTerminalTrace('cart');
  trace('read.started');
  try {
    const db = await getDb();
    const session = await requireSession(db, request);
    const cart = toCartView(await getOrCreateCart(db, session._id));
    trace('read.completed', { revision: cart.revision, itemCount: cart.items.length, status: cart.status });
    return json({ cart });
  } catch (error) {
    return errorResponse(error, trace);
  }
}

/** Apply one cart edit from the UI. Sends 409 when expectedRevision is outdated. */
export async function PATCH(request: Request): Promise<Response> {
  const trace = createTerminalTrace('cart');
  trace('edit.started');
  try {
    assertSameOrigin(request);
    const db = await getDb();
    trace('database.ready');
    const session = await requireSession(db, request);
    trace('session.validated');
    const body = UiCartPatchSchema.parse(await readJson(request));
    trace('edit.validated', { operation: body.operation.op, expectedRevision: body.expectedRevision });
    const { cart, recalculationError } = await applyUiCartEdit(db, session._id, body, {
      matcher: getMatcher(request.signal, trace),
      signal: request.signal,
      trace
    });
    const view = toCartView(cart);
    trace('edit.completed', { revision: view.revision, itemCount: view.items.length, status: view.status });
    return json({ cart: view, recalculationError });
  } catch (error) {
    return errorResponse(error, trace);
  }
}
