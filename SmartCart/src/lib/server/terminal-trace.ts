import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@/lib/agent/events';
import { debugMode, type DebugMode } from '@/lib/server/debug-mode';
import { appendTraceLine } from '@/lib/server/trace-files';
import { redactSecrets } from '@/lib/shared/errors';

export { debugMode, type DebugMode };

type TraceDetails = Record<string, string | number | boolean | null | undefined>;
type TraceLevel = 'info' | 'warn' | 'error';

export interface TerminalTrace {
  /** Operational metadata. User text, prompts and provider payloads stay out of these lines. */
  (step: string, details?: TraceDetails, level?: TraceLevel): void;
  /**
   * Shown and saved in debug mode (SMARTCART_DEBUG): a labeled block of content, such as what the customer
   * said, Gemini's reply, tool arguments and results, or Gemini's error text. Otherwise a no-op.
   */
  detail(step: string, content: unknown, level?: TraceLevel): void;
  readonly mode: DebugMode;
}

/** Terminal previews are bounded so the next step stays visible. */
export const DETAIL_MAX_CHARS = 2_000;
const TERMINAL_DETAIL_LINES = 10;
const INLINE_MAX_CHARS = 160;
const LINE_WIDTH = 100;
const STACK_FRAMES = 5;

/** "850 ms" or "12.4 s". */
export function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

/**
 * An error with its HTTP status and causes. Errors without a status or code are usually bugs,
 * so they also show where they were thrown.
 */
export function describeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return error;
  const { status, code } = error as { status?: unknown; code?: unknown };
  const where = status === undefined && code === undefined && error.stack
    ? error.stack.split('\n').slice(1, 1 + STACK_FRAMES).map(line => line.trim())
    : null;
  return {
    error: `${error.name}: ${error.message}`,
    ...(status !== undefined ? { status } : {}),
    ...(where?.length ? { where } : {}),
    ...(error.cause !== undefined && depth < 4 ? { cause: describeError(error.cause, depth + 1) } : {})
  };
}

/** JSON that keeps small objects and lists on one line, so each step stays short. */
function layout(value: unknown, indent: string): string {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== 'object' || indent.length + flat.length <= LINE_WIDTH) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map(item => `${inner}${layout(item, inner)}`).join(',\n')}\n${indent}]`;
  const entries = Object.entries(value).map(([key, item]) => `${inner}${JSON.stringify(key)}: ${layout(item, inner)}`);
  return `{\n${entries.join(',\n')}\n${indent}}`;
}

/** Readable text for any value: JSON with errors spelled out (JSON.stringify drops their message). */
function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  const seen = new WeakSet<object>();
  const json = JSON.stringify(content instanceof Error ? describeError(content) : content, (_key, value: unknown) => {
    if (value instanceof Error) return describeError(value);
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[shown above]';
      seen.add(value);
    }
    return value;
  });
  return json === undefined ? String(content) : layout(JSON.parse(json), '');
}

/** One debug entry: short one-line content stays on the heading line, the rest is indented below it. */
export function formatDetail(heading: string, content: unknown, full: boolean): string {
  return detailBlock(cleanTraceText(heading).replaceAll('\n', ' '), cleanTraceText(toText(content)), full);
}

function cleanTraceText(value: string): string {
  // Preserve line breaks in transcripts without letting content control the terminal.
  return redactSecrets(value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, ''));
}

function detailBlock(heading: string, content: string, full: boolean): string {
  let text = content || '(empty)';
  if (!full) {
    const preview = text.slice(0, DETAIL_MAX_CHARS).split('\n').slice(0, TERMINAL_DETAIL_LINES).join('\n');
    if (preview.length < text.length) text = `${preview}\n… ${text.length - preview.length} more characters in logs/smartcart.log`;
  }
  if (!text.includes('\n') && text.length <= INLINE_MAX_CHARS) return `${heading}: ${text}`;
  return `${heading}\n${text.split('\n').map(line => `    │ ${line}`).join('\n')}`;
}

function readableWords(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replaceAll('_', ' ');
}

const stepTitles: Record<string, string | undefined> = {
  'agent.context.ready': 'Conversation context ready',
  'agent.model.turn.started': 'Gemini turn started',
  'agent.model.turn.completed': 'Gemini turn completed',
  'agent.loop.finished': 'Agent finished using tools',
  'agent.timing': 'Time spent on the request',
  'tool.started': 'Tool started',
  'tool.completed': 'Tool finished',
  'pipeline.search.completed': 'Catalog search completed',
  'pipeline.match.completed': 'Product matching completed',
  'pipeline.price.completed': 'Package pricing completed',
  'pipeline.optimize.completed': 'Store comparison completed',
  'pipeline.verify.completed': 'Basket verification completed',
  'cart.updated': 'Cart saved'
};

function terminalStep(step: string, data: TraceDetails | undefined, full: boolean, summary?: string): string {
  const title = summary ?? stepTitles[step] ?? step.split('.').map(part => readableWords(part)).join(' › ');
  if (!full && step.startsWith('model.attempt.') && data) {
    const action = data.role === 'matcher' ? 'Gemini product check' : 'Gemini agent call';
    const outcome = step.slice('model.attempt.'.length);
    const model = `${data.model}${data.fallback === true ? ' (backup)' : ''}`;
    const clock = data.durationMs ?? data.timeoutMs;
    return cleanTraceText([
      `${action} ${data.modelCall}, attempt ${data.attempt}: ${outcome}`, model,
      typeof clock === 'number' ? `${data.durationMs === undefined ? 'timeout ' : ''}${formatDuration(clock)}` : '',
      data.providerStatus ? `HTTP ${data.providerStatus}` : '', data.reason ? readableWords(String(data.reason)) : ''
    ].filter(Boolean).join(' · ')).replaceAll('\n', ' ');
  }
  const fields = Object.entries(data ?? {}).flatMap(([key, value]) => {
    if (value === undefined) return [];
    const duration = typeof value === 'number' && key.endsWith('Ms');
    const name = readableWords(duration ? key.slice(0, -2) : key);
    return [`${name}=${duration ? formatDuration(value) : String(value)}`];
  });
  return cleanTraceText([title.charAt(0).toUpperCase() + title.slice(1), ...fields].join(' · ')).replaceAll('\n', ' ');
}

function showTerminalStep(scope: string, step: string, data: TraceDetails | undefined, mode: DebugMode): boolean {
  if (mode === 'full') return true;
  if (scope === 'session') return false;
  if (step === 'pipeline.match.progress' || step === 'model.matcher.queued') return false;
  return step !== 'model.attempt.started' || data?.role !== 'matcher' || data.fallback === true;
}

function taggedDetail(prefix: string, timestamp: string, elapsedMs: number, step: string, content: unknown, mode: DebugMode, level: TraceLevel) {
  const title = cleanTraceText(step).replaceAll('\n', ' ');
  let text: string;
  try {
    text = cleanTraceText(toText(content));
  } catch {
    text = '(details could not be formatted)';
  }
  const severity = level === 'info' ? '' : ` ${level.toUpperCase()}`;
  appendTraceLine('detail', detailBlock(`${timestamp} ${prefix}${severity} » ${title} +${elapsedMs}ms`, text, true));
  console[level](detailBlock(`${prefix} +${formatDuration(elapsedMs)} ${title}`, text, mode === 'full'));
}

/** Browser events carry elapsed voice-session time even if the batch arrives after an agent event. */
export function traceVoiceEvent(voiceId: string, event: string, elapsedMs: number, data: TraceDetails | undefined, mode: DebugMode): void {
  if (mode === 'off') return;
  const prefix = `[smartcart live ${voiceId.slice(0, 12)}]`;
  const title = cleanTraceText(event).replaceAll('\n', ' ');
  const timestamp = new Date().toISOString();
  const level = /\b(?:error|failed)\b/u.test(title) ? 'warn' : 'info';
  if (data && Object.keys(data).length) {
    const fields = Object.entries(data).map(([key, value]) => {
      const timed = typeof value === 'number' && key.endsWith('Ms');
      const name = readableWords(timed ? key.slice(0, -2) : key);
      return `${name.charAt(0).toUpperCase()}${name.slice(1)}: ${timed ? formatDuration(value) : String(value)}`;
    });
    taggedDetail(prefix, timestamp, elapsedMs, title, fields.join('\n'), mode, level);
    return;
  }
  appendTraceLine('detail', `${timestamp} ${prefix} » ${title} +${elapsedMs}ms`);
  console[level](`${prefix} +${formatDuration(elapsedMs)} ${title}`);
}

const phases: Record<string, string | undefined> = {
  'agent.model.turn.started': 'Planning with Gemini',
  'agent.model.retryScheduled': 'Retrying Gemini',
  'catalog.query.started': 'Searching the catalog',
  'pipeline.search.started': 'Searching the catalog',
  'pipeline.match.started': 'Checking product matches',
  'pipeline.price.started': 'Calculating package prices',
  'pipeline.optimize.started': 'Comparing stores',
  'pipeline.verify.started': 'Verifying basket prices',
  'cart.calculation.saving': 'Saving the basket',
  'recalculation.saving': 'Saving the basket'
};

const toolPhases: Record<string, string | undefined> = {
  updateCart: 'Updating the cart',
  addItems: 'Updating the cart',
  addRecipe: 'Updating the cart',
  removeItems: 'Updating the cart',
  setQuantity: 'Updating the cart',
  setConstraints: 'Updating the cart',
  setSearchTerms: 'Updating the cart',
  setShoppingMode: 'Updating the cart',
  setBudget: 'Updating the cart',
  selectStore: 'Updating the cart',
  clearCart: 'Updating the cart',
  compareStores: 'Comparing stores',
  explainRecommendation: 'Explaining the recommendation'
};

const cartStatuses: Record<string, string | undefined> = {
  EMPTY: 'cart is empty',
  NEEDS_CALCULATION: 'prices pending',
  COMPLETE: 'verified basket',
  NO_COMPLETE_BASKET: 'no store has a complete basket',
  VERIFICATION_FAILED: 'price verification failed'
};

function describeCart(state: TraceDetails | undefined): string[] {
  const count = state?.items ?? state?.itemCount;
  const status = cartStatuses[String(state?.status)];
  return [typeof count === 'number' ? `${count} cart item${count === 1 ? '' : 's'}` : '', status]
    .filter((value): value is string => Boolean(value));
}

/** Keep one line per major phase, even when several items or model batches enter that phase. */
function summarizeRequest(scope: string) {
  const shown = new Set<string>();
  let candidatesFound: number | undefined;
  let candidatesChecked = 0;
  let toolFailures = 0;
  let cart: TraceDetails | undefined;
  let priceError: string | undefined;
  let cancelled = false;
  let finished = false;

  return (step: string, data: TraceDetails, elapsedMs: number): string | undefined => {
    if (finished) return;
    const code = typeof data.code === 'string' ? data.code : undefined;
    const finish = (outcome: string, details: string[] = []) => {
      finished = true;
      return [`${outcome} in ${formatDuration(elapsedMs)}`, ...details].join(' · ');
    };

    let phase = phases[step];
    switch (step) {
      case 'request.validated':
        phase = data.via === 'voice' ? 'Voice request received' : 'Chat request received';
        break;
      case 'edit.validated':
        phase = data.operation === 'recalculate' ? 'Refreshing cart prices' : `Editing the cart (${String(data.operation).replaceAll('_', ' ')})`;
        break;
      case 'tool.started':
        phase = toolPhases[String(data.tool)];
        break;
      case 'tool.completed':
        if (data.status === 'error') toolFailures++;
        break;
      case 'model.attempt.started':
        if (data.role === 'agent' && data.fallback === true) phase = 'Trying a backup Gemini model';
        break;
      case 'catalog.query.completed':
      case 'pipeline.search.completed':
        candidatesFound = (candidatesFound ?? 0) + Number(data.totalMatches ?? 0);
        break;
      case 'pipeline.match.completed':
        candidatesChecked += Number(data.matched ?? 0) + Number(data.rejected ?? 0) + Number(data.uncertain ?? 0);
        break;
      case 'cart.updated':
        cart = data;
        break;
      case 'recalculation.failed':
        priceError = code ? `price refresh failed (${code})` : 'price refresh failed';
        break;
      case 'agent.failure.recorded':
        cancelled = data.cancelled === true;
        break;
      case 'agent.completed': {
        const result = describeCart(cart);
        if (candidatesChecked) result.push(`${candidatesChecked} product candidates checked`);
        else if (candidatesFound !== undefined) result.push(`${candidatesFound} catalog matches found`);
        if (toolFailures) result.push(`${toolFailures} failed tool attempt${toolFailures === 1 ? '' : 's'}`);
        return finish(data.kind === 'clarification' ? 'Asked for clarification' : 'Answered', result);
      }
      case 'edit.completed':
        return finish('Cart request finished', [...describeCart(data), ...(priceError ? [priceError] : [])]);
      case 'token.issued':
        return finish('Voice token ready');
      case 'agent.failed':
        if (cancelled || code === 'CANCELLED') return finish('Cancelled');
        return finish('Agent failed', code ? [code] : []);
      case 'stream.cancelled':
        return finish('Cancelled');
      case 'request.failed':
        if (scope === 'session' && code === 'NO_SESSION') return;
        return finish('Request failed', code ? [code] : []);
    }
    if (!phase || shown.has(phase)) return;
    shown.add(phase);
    return phase;
  };
}

export function createTerminalTrace(scope: string, mode: DebugMode = debugMode(), correlationId?: string): TerminalTrace {
  const requestId = (correlationId ?? randomUUID()).slice(0, 12);
  const started = performance.now();
  const prefix = `[smartcart ${scope} ${requestId}]`;
  const summarize = summarizeRequest(scope);
  const elapsed = () => Math.round(performance.now() - started);
  const trace = (step: string, details?: TraceDetails, level: TraceLevel = 'info') => {
    const timestamp = new Date().toISOString();
    const elapsedMs = elapsed();
    const fields = details ? ` ${redactSecrets(JSON.stringify(details))}` : '';
    const severity = level === 'info' ? '' : ` ${level.toUpperCase()}`;
    appendTraceLine('detail', `${timestamp} ${prefix}${severity} ${step} +${elapsedMs}ms${fields}`);
    const summary = summarize(step, details ?? {}, elapsedMs);
    if (summary) {
      const message = `${prefix} ${summary}`;
      appendTraceLine('summary', `${timestamp} ${message}`);
      if (mode === 'off' || !showTerminalStep(scope, step, details, mode)) console[level](message);
    }
    if (mode !== 'off' && showTerminalStep(scope, step, details, mode)) {
      console[level](`${prefix} +${formatDuration(elapsedMs)} ${terminalStep(step, details, mode === 'full', summary)}`);
    }
  };
  return Object.assign(trace, {
    mode,
    detail(step: string, content: unknown, level: TraceLevel = 'info') {
      if (mode === 'off') return;
      taggedDetail(prefix, new Date().toISOString(), elapsed(), step, content, mode, level);
    }
  });
}

/** Mirror lifecycle events without copying the customer-facing event payloads (debug mode adds the answer). */
export function traceAgentEvent(trace: TerminalTrace, event: AgentEvent): void {
  switch (event.type) {
    case 'agent.started':
      trace(event.type, { runId: event.runId });
      break;
    case 'tool.started':
      trace(event.type, { tool: event.tool, callId: event.callId, label: event.label });
      break;
    case 'tool.completed':
      trace(event.type, { tool: event.tool, callId: event.callId, status: event.status, durationMs: event.durationMs }, event.status === 'error' ? 'warn' : 'info');
      break;
    case 'cart.updated':
      trace(event.type, { revision: event.cart.revision, items: event.cart.items.length, status: event.cart.status });
      break;
    case 'clarification.required':
      trace(event.type, { options: event.options.length });
      break;
    case 'agent.completed':
      trace(event.type, { kind: event.message.kind });
      trace.detail(event.message.kind === 'clarification' ? 'question for the customer' : 'answer for the customer',
        event.message.options?.length ? { text: event.message.content, options: event.message.options } : event.message.content);
      break;
    case 'agent.failed':
      trace(event.type, { code: event.error.code }, event.error.code === 'CANCELLED' ? 'info' : 'error');
      trace.detail('message shown to the customer', event.error.message, event.error.code === 'CANCELLED' ? 'info' : 'error');
      break;
    case 'tool.progress':
      // CartPipeline logs these stages directly, including the search and match counts.
      break;
  }
}
