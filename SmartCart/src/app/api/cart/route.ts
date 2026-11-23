import { getOrCreateCart } from '@/lib/db/carts.repository';
import { getDb } from '@/lib/db/mongodb';
import { assertSameOrigin, errorResponse, json, readJson } from '@/lib/server/http';
import { getMatcher } from '@/lib/server/services';
import { requireSession } from '@/lib/server/session-cookie';
import { applyUiCartEdit, UiCartPatchSchema } from '@/lib/shopping/cart-service';
import { toCartView } from '@/lib/shopping/cart-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  try {
    const db = await getDb();
    const session = await requireSession(db, request);
    return json({ cart: toCartView(await getOrCreateCart(db, session._id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Apply one cart edit from the UI. Sends 409 when expectedRevision is outdated. */
export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const db = await getDb();
    const session = await requireSession(db, request);
    const body = UiCartPatchSchema.parse(await readJson(request));
    const { cart, recalculationError } = await applyUiCartEdit(db, session._id, body, {
      matcher: getMatcher(request.signal),
      signal: request.signal
    });
    return json({ cart: toCartView(cart), recalculationError });
  } catch (error) {
    return errorResponse(error);
  }
}
