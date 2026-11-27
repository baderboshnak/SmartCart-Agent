import { z } from 'zod';
import { getDb } from '@/lib/db/mongodb';
import { debugMode } from '@/lib/server/debug-mode';
import { assertSameOrigin } from '@/lib/server/http';
import { readSessionCookie, requireSession } from '@/lib/server/session-cookie';
import { traceVoiceEvent } from '@/lib/server/terminal-trace';
import { redactSecrets } from '@/lib/shared/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 48 * 1024;
const MAX_BATCH_EVENTS = 32;
const TRACE_WINDOW_MS = 60_000;
const MAX_EVENTS_PER_SESSION = 240;
const MAX_SESSIONS_PER_WINDOW = 1_024;

const text = z.string().max(4_000).nullish();
const duration = z.number().int().min(0).max(86_400_000);
const TraceData = z.strictObject({
  exchange: z.number().int().min(1).max(10_000).nullish(),
  durationMs: duration.nullish(),
  sinceStartMs: duration.nullish(),
  totalMs: duration.nullish(),
  agentMs: duration.nullish(),
  model: text,
  heard: text,
  heardAs: text,
  said: text,
  usedShoppingAgent: z.boolean().nullish(),
  message: text,
  code: z.number().int().min(0).max(65_535).nullish(),
  reason: text,
  byYou: z.boolean().nullish(),
  timeLeft: text,
  name: text,
  request: text,
  language: text,
  answer: text,
  results: z.number().int().min(0).max(32).nullish(),
  error: text
});

const TraceBatch = z.strictObject({
  voiceId: z.uuid(),
  events: z.array(z.strictObject({
    event: z.enum([
      'voice session starting',
      'microphone access requested',
      'microphone access granted',
      'voice token requested',
      'voice token received',
      'connecting to Gemini Live',
      'connected to Gemini Live',
      'microphone capture started',
      'voice session stopping',
      'voice session stopped',
      'connection error',
      'connection closed',
      'voice stopped because of an error',
      'you interrupted, so playback stopped',
      'Gemini Live will close the connection soon',
      'Gemini Live started speaking',
      'exchange finished',
      'Gemini Live asked for an unknown tool',
      'Gemini Live asked the shopping agent',
      'shopping agent returned an answer',
      'shopping agent results sent to Gemini Live',
      'the shopping agent failed'
    ]),
    elapsedMs: duration,
    data: TraceData.optional()
  })).min(1).max(MAX_BATCH_EVENTS)
});

let rateWindow = 0;
const eventCounts = new Map<string, number>();

function acceptEvents(sessionId: string, events: number): boolean {
  const window = Math.floor(Date.now() / TRACE_WINDOW_MS);
  if (rateWindow !== window) {
    rateWindow = window;
    eventCounts.clear();
  }
  const previous = eventCounts.get(sessionId);
  if (previous === undefined && eventCounts.size >= MAX_SESSIONS_PER_WINDOW) return false;
  const next = (previous ?? 0) + events;
  if (next > MAX_EVENTS_PER_SESSION) return false;
  eventCounts.set(sessionId, next);
  return true;
}

/** The request body is bounded even when the sender omits Content-Length. */
async function readBatch(request: Request): Promise<z.infer<typeof TraceBatch> | undefined> {
  if (!request.body || Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return undefined;
  const stream = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const chunk = await stream.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void stream.cancel().catch(() => {});
        return undefined;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    stream.releaseLock();
  }
  const parsed = TraceBatch.safeParse(JSON.parse(body + decoder.decode()));
  return parsed.success ? parsed.data : undefined;
}

function cleanData(data?: z.infer<typeof TraceData>): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      safe[key] = redactSecrets(value.replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, ' '))
        .replace(/\bauth_tokens\/[A-Za-z0-9._~+%/-]+/giu, '[redacted]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
    } else if (value !== undefined) {
      safe[key] = value;
    }
  }
  return safe;
}

/** Accept debug-only browser observations without extending the voice request's critical path. */
export async function POST(request: Request): Promise<Response> {
  const mode = debugMode();
  const done = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  if (mode === 'off') return done();
  try {
    assertSameOrigin(request);
    if (!readSessionCookie(request)) return done();
    const batch = await readBatch(request);
    if (!batch) return done();
    const session = await requireSession(await getDb(), request);
    if (!acceptEvents(session._id, batch.events.length)) return done();
    for (const value of batch.events) {
      traceVoiceEvent(batch.voiceId, value.event, value.elapsedMs, cleanData(value.data), mode);
    }
  } catch {
    // Best-effort telemetry can be dropped without writing a follow-up trace or affecting voice.
  }
  return done();
}
