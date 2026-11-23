import { getDb } from '@/lib/db/mongodb';
import { assertSameOrigin, errorResponse, json } from '@/lib/server/http';
import { requireSession } from '@/lib/server/session-cookie';
import { checkVoiceRateLimit, createVoiceToken } from '@/lib/voice/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A short-lived, single-use Gemini Live token for the browser's voice session. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const db = await getDb();
    const session = await requireSession(db, request);
    checkVoiceRateLimit(session._id);
    return json(await createVoiceToken(session.messages));
  } catch (error) {
    return errorResponse(error);
  }
}
