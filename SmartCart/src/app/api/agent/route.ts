import { z } from 'zod';
import { MAX_MESSAGE_CHARS, runShoppingAgent } from '@/lib/agent/agent';
import { encodeSse, type AgentEvent } from '@/lib/agent/events';
import { getDb } from '@/lib/db/mongodb';
import { LANGUAGES } from '@/lib/i18n/language';
import { assertSameOrigin, errorResponse, readJson } from '@/lib/server/http';
import { getAgentModel, getMatcher } from '@/lib/server/services';
import { requireSession } from '@/lib/server/session-cookie';
import { createTerminalTrace, traceAgentEvent } from '@/lib/server/terminal-trace';
import { toPublicError } from '@/lib/shared/errors';
import { normalizeSpokenRequest } from '@/lib/voice/normalize-speech';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const AgentRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  via: z.literal('voice').optional(),
  voiceId: z.uuid().optional(),
  /** Reply language from the voice model or a suggestion button. Typed messages are detected from their words. */
  language: z.enum(LANGUAGES).optional()
});

/**
 * Run the agent for one customer message and stream real progress as Server-Sent
 * Events: agent.started, tool.started/progress/completed, cart.updated,
 * clarification.required, agent.completed or agent.failed.
 */
export async function POST(request: Request): Promise<Response> {
  const trace = createTerminalTrace('agent');
  trace('request.received');
  // Stop the run (including Gemini calls) when the client disconnects or cancels the stream.
  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  let prepared;
  try {
    assertSameOrigin(request);
    trace('database.opening');
    const db = await getDb();
    const session = await requireSession(db, request);
    trace('session.authenticated');
    const body = AgentRequestSchema.parse(await readJson(request, 16_000));
    // Spoken requests spell numbers out; the agent's checks need digits and %.
    const message = body.via === 'voice' ? normalizeSpokenRequest(body.message) : body.message;
    trace('request.validated', {
      via: body.via ?? 'text', messageChars: message.length,
      ...(body.via === 'voice' && body.voiceId ? { voiceId: body.voiceId.slice(0, 12) } : {})
    });
    if (body.via === 'voice') {
      trace.detail('request from Gemini Live', {
        request: body.message,
        ...(message !== body.message ? { numbersConverted: message } : {}),
        language: body.language ?? 'not given'
      });
    }
    prepared = { db, session, message, via: body.via, language: body.language, model: getAgentModel(trace), matcher: getMatcher(signal, trace) };
  } catch (error) {
    return errorResponse(error, trace);
  }

  const { db, session, message, via, language, model, matcher } = prepared;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      trace('stream.cancelled');
      cancel.abort();
    },
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
        }
      };
      const send = (event: AgentEvent) => {
        traceAgentEvent(trace, event);
        write(encodeSse(event));
      };
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);
      try {
        await runShoppingAgent({ db, sessionId: session._id, message, via, language, model, matcher, emit: send, signal, trace });
      } catch (error) {
        // Failures inside a run are handled by the run; these stopped it from starting.
        const publicError = toPublicError(error);
        trace.detail('the run could not start', error, publicError.status >= 500 ? 'error' : 'warn');
        send({ type: 'agent.failed', runId: '', error: { code: publicError.code, message: publicError.message } });
      } finally {
        clearInterval(heartbeat);
        open = false;
        trace('stream.finished', { aborted: signal.aborted });
        try {
          controller.close();
        } catch {
          // The client already disconnected.
        }
      }
    }
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
