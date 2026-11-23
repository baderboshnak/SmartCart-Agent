import { z } from 'zod';
import { MAX_MESSAGE_CHARS, runShoppingAgent } from '@/lib/agent/agent';
import { encodeSse, type AgentEvent } from '@/lib/agent/events';
import { getDb } from '@/lib/db/mongodb';
import { assertSameOrigin, errorResponse, readJson } from '@/lib/server/http';
import { getAgentModel, getMatcher } from '@/lib/server/services';
import { requireSession } from '@/lib/server/session-cookie';
import { toPublicError } from '@/lib/shared/errors';
import { normalizeSpokenRequest } from '@/lib/voice/normalize-speech';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const AgentRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  via: z.literal('voice').optional()
});

/**
 * Run the agent for one customer message and stream real progress as Server-Sent
 * Events: agent.started, tool.started/progress/completed, cart.updated,
 * clarification.required, agent.completed or agent.failed.
 */
export async function POST(request: Request): Promise<Response> {
  // Stop the run (including Gemini calls) when the client disconnects or cancels the stream.
  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  let prepared;
  try {
    assertSameOrigin(request);
    const db = await getDb();
    const session = await requireSession(db, request);
    const body = AgentRequestSchema.parse(await readJson(request, 16_000));
    // Spoken requests spell numbers out; the agent's checks need digits and %.
    const message = body.via === 'voice' ? normalizeSpokenRequest(body.message) : body.message;
    prepared = { db, session, message, via: body.via, model: getAgentModel(), matcher: getMatcher(signal) };
  } catch (error) {
    return errorResponse(error);
  }

  const { db, session, message, via, model, matcher } = prepared;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
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
      const send = (event: AgentEvent) => write(encodeSse(event));
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);
      try {
        await runShoppingAgent({ db, sessionId: session._id, message, via, model, matcher, emit: send, signal });
      } catch (error) {
        const publicError = toPublicError(error);
        send({ type: 'agent.failed', runId: '', error: { code: publicError.code, message: publicError.message } });
      } finally {
        clearInterval(heartbeat);
        open = false;
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
