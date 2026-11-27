import { z } from 'zod';
import { getDb } from '@/lib/db/mongodb';
import { LANGUAGE_NAMES } from '@/lib/i18n/language';
import { assertSameOrigin, errorResponse, json } from '@/lib/server/http';
import { requireSession } from '@/lib/server/session-cookie';
import { createTerminalTrace } from '@/lib/server/terminal-trace';
import { liveHistory, unsureLanguage } from '@/lib/voice/live-config';
import { checkVoiceRateLimit, createVoiceToken } from '@/lib/voice/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A short-lived, single-use Gemini Live token for the browser's voice session. */
export async function POST(request: Request): Promise<Response> {
  const voiceId = z.uuid().safeParse(request.headers.get('x-smartcart-voice-id'));
  const trace = createTerminalTrace('live', undefined, voiceId.success ? voiceId.data : undefined);
  trace('token.requested');
  try {
    assertSameOrigin(request);
    const db = await getDb();
    trace('database.ready');
    const session = await requireSession(db, request);
    trace('session.validated');
    checkVoiceRateLimit(session._id);
    trace('token.issuing');
    const started = Date.now();
    const token = await createVoiceToken(session.messages);
    trace('token.issued', { model: token.model, durationMs: Date.now() - started });
    const unsure = unsureLanguage(session.messages);
    trace.detail('voice session settings', {
      model: token.model,
      chatMessagesGivenToLive: liveHistory(session.messages).length,
      languageWhenUnsure: `${LANGUAGE_NAMES[unsure.language]} (${unsure.fromChat ? 'from the chat' : 'default'})`
    });
    // In debug mode the browser reports Gemini Live events to the trace endpoint.
    return json({ ...token, debug: trace.mode !== 'off' });
  } catch (error) {
    return errorResponse(error, trace);
  }
}
