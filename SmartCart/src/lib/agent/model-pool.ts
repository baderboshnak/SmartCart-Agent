import type { Content, Part } from '@google/genai';
import type { CallModel } from '@engine/smartcart-matcher.mjs';
import type { AgentModel, AgentModelRequest, ModelTurn } from '@/lib/agent/gemini';
import { raceAbort, timeoutSignal } from '@/lib/agent/loop';
import { formatDuration, type TerminalTrace } from '@/lib/server/terminal-trace';
import { errorMessage, ModelError } from '@/lib/shared/errors';

/**
 * Several Gemini models share the work. A model that is overloaded, rate limited, too
 * slow or missing rests for a while and the call moves to the next model at once.
 */

/** Gemini accepts this in place of a thought signature produced by another model. */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

export const REST_AFTER_BUSY_MS = 60_000;
export const REST_AFTER_MISSING_MS = 30 * 60_000;

/** Which models are resting. One instance is shared by the whole server. */
export class ModelHealth {
  private readonly restingUntil = new Map<string, number>();
  private readonly answered = new Map<string, number>();
  private readonly failed = new Map<string, number>();
  private readonly lastErrors = new Map<string, string>();
  constructor(private readonly now: () => number = Date.now) {}

  recordAnswer(model: string): void {
    this.answered.set(model, (this.answered.get(model) ?? 0) + 1);
  }

  recordFailure(model: string, error?: unknown): void {
    this.failed.set(model, (this.failed.get(model) ?? 0) + 1);
    if (error !== undefined) {
      const cause = (error as { cause?: unknown })?.cause ?? error;
      const status = (cause as { status?: unknown })?.status ?? (error as { status?: unknown })?.status;
      this.lastErrors.set(model, `${status ? `${String(status)} ` : ''}${errorMessage(error).slice(0, 120)}`);
    }
  }

  /** Answers and failures per model since the server started. */
  usage(): Record<string, { answered: number; failed: number; resting: boolean; lastError?: string }> {
    const models = new Set([...this.answered.keys(), ...this.failed.keys(), ...this.restingUntil.keys()]);
    return Object.fromEntries([...models].sort().map(model => [model, {
      answered: this.answered.get(model) ?? 0, failed: this.failed.get(model) ?? 0, resting: this.isResting(model),
      ...(this.lastErrors.has(model) ? { lastError: this.lastErrors.get(model) } : {})
    }]));
  }

  rest(model: string, milliseconds: number): void {
    this.restingUntil.set(model, Math.max(this.restingUntil.get(model) ?? 0, this.now() + milliseconds));
  }

  isResting(model: string): boolean {
    return (this.restingUntil.get(model) ?? 0) > this.now();
  }

  /** Models in the given order with resting ones moved last, soonest to recover first. */
  order(models: string[]): string[] {
    const resting = models.filter(model => this.isResting(model))
      .sort((a, b) => this.restingUntil.get(a)! - this.restingUntil.get(b)!);
    return [...models.filter(model => !this.isResting(model)), ...resting];
  }
}

const globalStore = globalThis as typeof globalThis & { __smartcartModelHealth?: ModelHealth };
export function serverModelHealth(): ModelHealth {
  return (globalStore.__smartcartModelHealth ??= new ModelHealth());
}

function providerStatus(error: unknown): number {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  return Number((cause as { status?: unknown })?.status ?? (error as { status?: unknown })?.status);
}

/** "503 The model is overloaded..." with Gemini's own words, for the debug log. */
export function failureSummary(error: unknown, maxChars = 300): string {
  const status = providerStatus(error);
  const cause = (error as { cause?: unknown })?.cause;
  const raw = errorMessage(cause instanceof Error ? cause : error);
  const detail = /"message"\s*:\s*"([^"]+)"/u.exec(raw)?.[1] ?? raw;
  return `${status ? `${status} ` : ''}${detail}`.slice(0, maxChars);
}

/**
 * How long to rest a model after this failure, or null when the request itself is the
 * problem and another model would fail the same way.
 */
export function restAfter(error: unknown, timedOut = false): number | null {
  if (timedOut) return REST_AFTER_BUSY_MS;
  const status = providerStatus(error);
  if (status === 404 || status === 403) return REST_AFTER_MISSING_MS;
  if ([408, 429, 500, 502, 503, 504].includes(status)) return REST_AFTER_BUSY_MS;
  if (/overloaded|high demand|unavailable|rate limit|resource[ _]exhausted|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/iu.test(errorMessage(error))) {
    return REST_AFTER_BUSY_MS;
  }
  return null;
}

/**
 * Thrown when every model tried was busy. "overloaded" lets the agent loop retry it and
 * "temporarily unavailable" lets the engine matcher retry it.
 */
export function allBusy(lastError: unknown): ModelError {
  return new ModelError('All available Gemini models are overloaded or temporarily unavailable. Please try again in a minute.', { cause: lastError });
}

interface ModelAttempt {
  role: 'agent' | 'matcher';
  model: string;
  modelCall: number;
  attempt: number;
  fallback: boolean;
}

/** One attempt on one model, with its own time limit inside the caller's signal. */
async function attempt<T>(details: ModelAttempt, run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, outer?: AbortSignal, trace?: TerminalTrace) {
  const started = Date.now();
  trace?.('model.attempt.started', { ...details, timeoutMs });
  const timeout = timeoutSignal(timeoutMs, `${details.model} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
  const signal = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;
  try {
    const value = await raceAbort(run(signal), signal);
    trace?.('model.attempt.succeeded', { ...details, durationMs: Date.now() - started });
    return { ok: true as const, value };
  } catch (error) {
    const durationMs = Date.now() - started;
    if (outer?.aborted) {
      const reason = outer.reason instanceof Error && outer.reason.name === 'TimeoutError' ? 'deadline' : 'signal_aborted';
      trace?.('model.attempt.cancelled', { ...details, reason, durationMs }, 'warn');
      throw error;
    }
    const timedOut = timeout.signal.aborted;
    const failure = timedOut ? timeout.signal.reason : error;
    const restMs = restAfter(failure, timedOut);
    const reason = timedOut ? 'timeout'
      : restMs === REST_AFTER_MISSING_MS ? 'model_unavailable'
      : restMs === REST_AFTER_BUSY_MS ? 'temporarily_unavailable'
      : 'request_failed';
    trace?.('model.attempt.failed', {
      ...details, reason, providerStatus: timedOut ? undefined : providerStatus(failure) || undefined, restMs, durationMs
    }, 'warn');
    trace?.detail(`Gemini ${details.role === 'agent' ? 'agent' : 'product-check'} call to ${details.model} failed (${reason}) after ${formatDuration(durationMs)}`, failure, 'warn');
    return { ok: false as const, error: failure, restMs };
  } finally {
    timeout.clear();
  }
}

/**
 * Earlier turns from a different model carry thought signatures the next model cannot
 * check. Replace them with the documented skip value and drop the other model's thoughts.
 */
export function neutralizeSignatures(contents: Content[]): Content[] {
  return contents.map(content => content.role !== 'model' ? content : {
    ...content,
    parts: (content.parts ?? []).filter(part => !part.thought).map(part => {
      const { thoughtSignature: _signature, ...rest } = part;
      return (part.functionCall ? { ...rest, thoughtSignature: SKIP_SIGNATURE } : rest) as Part;
    })
  });
}

export interface PooledAgentModel extends AgentModel {
  /** The model that produced each successful turn, in order. */
  readonly turnsBy: string[];
}

/**
 * The agent model with backups. Each turn goes to the first model that is not resting
 * (the main model unless it is busy). One run usually stays on one model.
 */
export function createPooledAgentModel(options: {
  models: string[];
  health: ModelHealth;
  generate: (model: string, request: AgentModelRequest) => Promise<ModelTurn>;
  attemptTimeoutMs?: number;
  maxModelsPerTurn?: number;
  trace?: TerminalTrace;
}): PooledAgentModel {
  if (!options.models.length) throw new RangeError('The agent needs at least one model.');
  const turnsBy: string[] = [];
  const [main, ...backups] = options.models;
  let modelCalls = 0;
  return {
    name: backups.length ? `${main} (+${backups.length} backups)` : main!,
    turnsBy,
    async generate(request) {
      const modelCall = ++modelCalls;
      const order = options.health.order(options.models).slice(0, options.maxModelsPerTurn ?? 3);
      let lastError: unknown = null;
      const failures: Record<string, string> = {};
      for (const [index, model] of order.entries()) {
        request.signal.throwIfAborted();
        const otherProducers = turnsBy.some(producer => producer !== model);
        const contents = otherProducers ? neutralizeSignatures(request.contents) : request.contents;
        const result = await attempt({ role: 'agent', model, modelCall, attempt: index + 1, fallback: index > 0 || model !== main },
          signal => options.generate(model, { ...request, contents, signal }), options.attemptTimeoutMs ?? 30_000, request.signal, options.trace);
        if (result.ok) {
          turnsBy.push(model);
          options.health.recordAnswer(model);
          return { ...result.value, model };
        }
        options.health.recordFailure(model, result.error);
        failures[model] = failureSummary(result.error);
        if (result.restMs === null) throw result.error;
        options.health.rest(model, result.restMs);
        lastError = result.error;
      }
      options.trace?.('model.pool.exhausted', { role: 'agent', modelCall, attempts: order.length }, 'warn');
      options.trace?.detail('no Gemini model could answer this agent turn', failures, 'error');
      throw allBusy(lastError);
    }
  };
}

/**
 * The product matcher spread across models: calls rotate over the main checking models
 * that are not resting; backups take over only when those are busy.
 */
export function createPooledMatcher(options: {
  models: string[];
  backups: string[];
  health: ModelHealth;
  call: (model: string) => CallModel;
  attemptTimeoutMs?: number;
  maxModelsPerCall?: number;
  signal?: AbortSignal;
  trace?: TerminalTrace;
  /** Called with the model that answered each call. */
  onAnswered?: (model: string) => void;
}): CallModel {
  if (!options.models.length) throw new RangeError('The matcher needs at least one model.');
  const calls = new Map<string, CallModel>();
  const callFor = (model: string) => {
    let call = calls.get(model);
    if (!call) calls.set(model, call = options.call(model));
    return call;
  };
  let next = 0;
  let modelCalls = 0;
  return async args => {
    const modelCall = ++modelCalls;
    const ready = options.models.filter(model => !options.health.isResting(model));
    const start = ready.length ? next++ % ready.length : 0;
    const rotated = [...ready.slice(start), ...ready.slice(0, start)];
    const all = [...new Set([...options.models, ...options.backups])];
    const order = [...new Set([
      ...rotated,
      ...options.backups.filter(model => !options.health.isResting(model)),
      ...options.health.order(all)
    ])].slice(0, options.maxModelsPerCall ?? 4);
    let lastError: unknown = null;
    const failures: Record<string, string> = {};
    for (const [index, model] of order.entries()) {
      options.signal?.throwIfAborted();
      const result = await attempt({ role: 'matcher', model, modelCall, attempt: index + 1, fallback: index > 0 || !options.models.includes(model) },
        () => callFor(model)(args), options.attemptTimeoutMs ?? 60_000, options.signal, options.trace);
      if (result.ok) {
        options.health.recordAnswer(model);
        options.onAnswered?.(model);
        return result.value;
      }
      options.health.recordFailure(model, result.error);
      failures[model] = failureSummary(result.error);
      if (result.restMs === null) throw result.error;
      options.health.rest(model, result.restMs);
      lastError = result.error;
    }
    options.trace?.('model.pool.exhausted', { role: 'matcher', modelCall, attempts: order.length }, 'warn');
    options.trace?.detail('no Gemini model could check this batch of products', failures, 'error');
    throw allBusy(lastError);
  };
}
