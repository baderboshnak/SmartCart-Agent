import { setTimeout as delay } from 'node:timers/promises';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import type { z } from 'zod';
import { AppError, errorMessage, TimeoutError, toPublicError, ValidationError } from '@/lib/shared/errors';
import type { AgentToolSummary } from '@/lib/shared/types';
import { providerRetryDelayMs } from '@engine/smartcart-matcher.mjs';
import { isOverloadError, isTransientModelError, type AgentModel, type ModelTurn, type TokenUsage } from '@/lib/agent/gemini';
import { toGeminiSchema } from '@/lib/agent/schemas';
import { formatDuration, type TerminalTrace } from '@/lib/server/terminal-trace';

export interface ToolExecutionContext {
  callId: string;
  signal: AbortSignal;
  progress: (message: string, processed?: number, total?: number) => void;
  /** The other function calls Gemini made in the same turn, such as a setBudget next to an addRecipe. */
  siblings?: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface ToolResult {
  /** JSON returned to the model. */
  data: unknown;
  /** Short, customer-safe summary for the activity feed. */
  summary: string;
  /** Ends the run with a question for the customer. */
  clarification?: { question: string; options: string[] };
}

export interface AgentTool {
  name: string;
  description: string;
  /** Activity label shown while the tool runs. */
  label: string;
  argsSchema: z.ZodType;
  /** Optional simpler schema shown to the model; argsSchema still validates. */
  declarationSchema?: z.ZodType;
  /** Accepted when called, but not offered to the model (kept for scripted and recorded calls). */
  hidden?: boolean;
  /** Valid arguments, shown to the model after it sends invalid ones. */
  example?: string;
  /** Guide the model after a validation rejection and give this tool one correction per run. */
  validationRecovery?: string;
  timeoutMs: number;
  execute: (args: never, context: ToolExecutionContext) => Promise<ToolResult>;
}

export interface LoopLimits {
  maxModelTurns: number;
  maxToolCalls: number;
  maxCallsPerTurn: number;
  modelTimeoutMs: number;
  runTimeoutMs: number;
  modelRetries: number;
  retryDelayMs: number;
  maxResultChars: number;
}

/** The longest provider-requested pause the agent waits through before retrying. */
const MAX_PROVIDER_DELAY_MS = 60_000;

export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  maxModelTurns: 10,
  maxToolCalls: 24,
  maxCallsPerTurn: 8,
  // Room for a busy model's backups to answer inside one turn (each model gets 30 s).
  modelTimeoutMs: 100_000,
  runTimeoutMs: 270_000,
  modelRetries: 3,
  retryDelayMs: 1_000,
  maxResultChars: 24_000
};

export interface LoopHooks {
  toolStarted?: (callId: string, tool: AgentTool) => void;
  toolProgress?: (callId: string, tool: AgentTool, message: string, processed?: number, total?: number) => void;
  toolCompleted?: (callId: string, tool: string, status: 'ok' | 'error', summary: string, durationMs: number) => void;
}

export type LoopStatus = 'completed' | 'clarification' | 'limit_reached' | 'cancelled' | 'failed';

export interface LoopOutcome {
  status: LoopStatus;
  text: string;
  clarification: { question: string; options: string[] } | null;
  modelTurns: number;
  /** Time spent waiting for Gemini, including retries and backup models. */
  modelMs: number;
  toolCalls: AgentToolSummary[];
  usage: TokenUsage;
  error: AppError | Error | null;
  contents: Content[];
  /** Replies Gemini sent as malformed function calls (each one was asked again). */
  malformedReplies: number;
}

/** A malformed function call is asked again this many times before the run gives up on it. */
const MAX_MALFORMED_RETRIES = 2;
const MAX_TOOL_VALIDATION_FAILURES = 2;

export function toFunctionDeclarations(tools: AgentTool[]): FunctionDeclaration[] {
  return tools.filter(tool => !tool.hidden).map(tool => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: toGeminiSchema(tool.declarationSchema ?? tool.argsSchema)
  }));
}

/**
 * A timeout signal backed by a regular (ref'd) timer that is always cleared.
 * AbortSignal.timeout() uses an unref'd timer, which lets a process exit while a
 * hung request is still waiting for its deadline.
 */
export function timeoutSignal(milliseconds: number, message: string): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(message)), milliseconds);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Reject when the signal aborts, even if the wrapped work ignores the signal. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

function capResult(value: unknown, maxChars: number): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxChars) return value ?? null;
  return { truncated: true, note: 'Result shortened to fit the context. Ask for one item at a time for details.', preview: json.slice(0, maxChars) };
}

function zodMessage(error: z.ZodError): string {
  return error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
}

function addUsage(total: TokenUsage, usage: TokenUsage) {
  total.promptTokens += usage.promptTokens;
  total.outputTokens += usage.outputTokens;
  total.thoughtTokens += usage.thoughtTokens;
  total.totalTokens += usage.totalTokens;
}

async function generateWithRetry(
  model: AgentModel,
  request: Omit<Parameters<AgentModel['generate']>[0], 'signal'>,
  limits: LoopLimits,
  runSignal: AbortSignal,
  trace?: TerminalTrace
): Promise<ModelTurn> {
  for (let attempt = 0; ; attempt++) {
    const timeout = timeoutSignal(limits.modelTimeoutMs, `Gemini did not respond within ${Math.round(limits.modelTimeoutMs / 1000)} seconds.`);
    const signal = AbortSignal.any([runSignal, timeout.signal]);
    try {
      return await raceAbort(model.generate({ ...request, signal }), signal);
    } catch (error) {
      if (runSignal.aborted) throw error;
      const timedOut = timeout.signal.aborted;
      if (attempt >= limits.modelRetries || !(timedOut || isTransientModelError(error))) {
        throw timedOut ? timeout.signal.reason : error;
      }
      // Demand spikes (429/503) usually last seconds, so they get longer, still bounded pauses.
      const overloaded = isOverloadError(error);
      const factor = overloaded ? [2, 5, 10, 10][attempt] ?? 10 : attempt + 1;
      // A rate limit can say how long it lasts (Google RetryInfo). Retrying sooner only fails
      // again; a wait longer than a customer can wait fails now with the provider's error.
      const providerDelayMs = timedOut ? null : providerRetryDelayMs(error);
      if (providerDelayMs !== null && providerDelayMs > MAX_PROVIDER_DELAY_MS) throw error;
      const delayMs = Math.max(limits.retryDelayMs * factor, providerDelayMs ?? 0);
      trace?.('agent.model.retryScheduled', {
        nextAttempt: attempt + 2, delayMs, reason: timedOut ? 'timeout' : overloaded ? 'overloaded' : 'transient',
        ...(providerDelayMs !== null ? { providerDelayMs } : {})
      }, 'warn');
      trace?.detail(`asking Gemini again in ${delayMs} ms because`, timedOut ? timeout.signal.reason : error, 'warn');
      await delay(delayMs, undefined, { signal: runSignal });
    } finally {
      timeout.clear();
    }
  }
}

/** Debug mode: what Gemini decided this turn, and why a reply is empty or cut short. */
function traceReply(trace: TerminalTrace, turn: number, response: ModelTurn, durationMs: number): void {
  const unusual = response.finishReason !== undefined && response.finishReason !== 'STOP';
  const empty = !response.text && !response.functionCalls.length;
  trace.detail(`turn ${turn}: Gemini ${empty ? 'returned an empty reply' : 'replied'} after ${formatDuration(durationMs)}`, {
    ...(response.model ? { model: response.model } : {}),
    ...(unusual ? { finishReason: response.finishReason } : {}),
    ...(response.finishMessage ? { finishMessage: response.finishMessage } : {}),
    ...(response.text ? { text: response.text } : {}),
    ...(response.functionCalls.length ? { toolCalls: response.functionCalls.map(call => ({ tool: call.name, arguments: call.args })) } : {}),
    tokens: { in: response.usage.promptTokens, out: response.usage.outputTokens, thinking: response.usage.thoughtTokens }
  }, empty || unusual ? 'warn' : 'info');
}

/**
 * Bounded plan -> act -> observe loop with Gemini function calling. Only allowlisted
 * tools run, every argument is validated, and limits stop runaway loops.
 */
export async function runAgentLoop(options: {
  model: AgentModel;
  tools: AgentTool[];
  systemInstruction: () => string | Promise<string>;
  contents: Content[];
  signal: AbortSignal;
  limits?: Partial<LoopLimits>;
  hooks?: LoopHooks;
  trace?: TerminalTrace;
}): Promise<LoopOutcome> {
  const { trace } = options;
  const limits = { ...DEFAULT_LOOP_LIMITS, ...options.limits };
  const registry = new Map(options.tools.map(tool => [tool.name, tool]));
  const declarations = toFunctionDeclarations(options.tools);
  const contents = [...options.contents];
  const usage: TokenUsage = { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };
  const toolCalls: AgentToolSummary[] = [];
  const runDeadline = timeoutSignal(limits.runTimeoutMs, `The request took longer than ${Math.round(limits.runTimeoutMs / 1000)} seconds.`);
  const runTimer = runDeadline.signal;
  const runSignal = AbortSignal.any([options.signal, runTimer]);
  let modelTurns = 0;
  let modelMs = 0;
  let forceAnswer = false;
  let callCounter = 0;
  let malformedReplies = 0;
  const validationFailures = new Map<string, number>();
  const toolBlocked = (name: string) => (validationFailures.get(name) ?? 0) >= MAX_TOOL_VALIDATION_FAILURES;
  const blockedMessage = 'Further calls to this tool are disabled for this request. Use another appropriate tool, ask a focused question, or say what could not be done.';

  function validationRecovery(tool: AgentTool): string {
    if (!tool.validationRecovery) return '';
    validationFailures.set(tool.name, (validationFailures.get(tool.name) ?? 0) + 1);
    return ` ${tool.validationRecovery}${toolBlocked(tool.name) ? ` ${blockedMessage}` : ''}`;
  }

  const finish = (status: LoopStatus, text: string, extra: Partial<LoopOutcome> = {}): LoopOutcome => ({
    status, text, clarification: null, modelTurns, modelMs, toolCalls, usage, error: null, contents, malformedReplies, ...extra
  });

  try {
    for (let turn = 1; turn <= limits.maxModelTurns; turn++) {
      const toolMode = forceAnswer || turn === limits.maxModelTurns ? 'NONE' : 'AUTO';
      const systemInstruction = await options.systemInstruction();
      trace?.('agent.model.turn.started', { turn, toolMode, messages: contents.length, instructionChars: systemInstruction.length });
      if (turn === 1 && trace?.mode === 'full') trace.detail('instructions sent to Gemini', systemInstruction);
      const turnStarted = Date.now();
      // Failed turns count too: a hung or busy Gemini is often where the time goes.
      const response = await generateWithRetry(options.model, {
        systemInstruction,
        contents,
        tools: validationFailures.size ? declarations.filter(tool => !toolBlocked(tool.name ?? '')) : declarations,
        toolMode
      }, limits, runSignal, trace).finally(() => { modelMs += Date.now() - turnStarted; });
      const turnMs = Date.now() - turnStarted;
      modelTurns++;
      addUsage(usage, response.usage);
      trace?.('agent.model.turn.completed', { turn, requestedTools: response.functionCalls.length, tokens: response.usage.totalTokens, durationMs: turnMs });
      if (trace) traceReply(trace, turn, response, turnMs);

      if (!response.functionCalls.length) {
        // A malformed function call carries no action and no text. Ending here would answer as if
        // nothing had been asked, so tell Gemini and let it try the call again.
        if (response.finishReason === 'MALFORMED_FUNCTION_CALL' && toolMode === 'AUTO' && malformedReplies < MAX_MALFORMED_RETRIES) {
          malformedReplies++;
          trace?.('agent.model.malformedRetry', { turn, retry: malformedReplies }, 'warn');
          const last = contents.at(-1);
          const note = { text: 'Your last reply was a malformed function call, so nothing happened. Call the right tool again with valid JSON arguments.' };
          if (last?.role === 'user') contents[contents.length - 1] = { ...last, parts: [...(last.parts ?? []), note] };
          else contents.push({ role: 'user', parts: [note] });
          continue;
        }
        if (response.finishReason === 'MALFORMED_FUNCTION_CALL') malformedReplies++;
        return finish(toolMode === 'NONE' ? 'limit_reached' : 'completed', response.text);
      }
      if (toolMode === 'NONE') return finish('limit_reached', response.text);
      if (response.functionCalls.every(call => toolBlocked(call.name))) {
        trace?.('agent.model.repeatedInvalidTool', { turn, tools: response.functionCalls.map(call => call.name).join(',') }, 'warn');
        return finish('limit_reached', '');
      }

      contents.push(response.content);
      const parts: Part[] = [];
      let clarification: { question: string; options: string[] } | null = null;
      for (const [index, call] of response.functionCalls.entries()) {
        const callId = call.id ?? `call_${++callCounter}`;
        const reply = (body: Record<string, unknown>) => parts.push({
          functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: body }
        });
        const tool = registry.get(call.name);
        if (!tool) {
          trace?.('tool.rejected', { reason: 'unknown_tool' }, 'warn');
          trace?.detail(`Gemini asked for an unknown tool "${call.name}"`, call.args ?? {}, 'warn');
          reply({ ok: false, error: `Unknown tool "${call.name}". Use only the declared tools.` });
          toolCalls.push({ name: call.name || 'unknown', status: 'error', durationMs: 0, summary: 'Unknown tool rejected.' });
          continue;
        }
        if (toolBlocked(tool.name)) {
          trace?.('tool.rejected', { tool: tool.name, reason: 'validation_retry_limit' }, 'warn');
          reply({ ok: false, error: blockedMessage });
          continue;
        }
        if (index >= limits.maxCallsPerTurn) {
          trace?.('tool.rejected', { tool: tool.name, reason: 'turn_tool_limit' }, 'warn');
          reply({ ok: false, error: `Too many tool calls in one turn (limit ${limits.maxCallsPerTurn}). Call it again in the next turn if still needed.` });
          continue;
        }
        if (toolCalls.length >= limits.maxToolCalls) {
          trace?.('tool.rejected', { tool: tool.name, reason: 'run_tool_limit' }, 'warn');
          forceAnswer = true;
          reply({ ok: false, error: 'The tool-call budget for this message is used up. Answer the customer now with the verified results you have.' });
          continue;
        }
        const parsed = tool.argsSchema.safeParse(call.args ?? {});
        if (!parsed.success) {
          trace?.('tool.rejected', { tool: tool.name, reason: 'invalid_arguments' }, 'warn');
          const message = `Invalid arguments: ${zodMessage(parsed.error)}`;
          trace?.detail(`tool ${tool.name}: Gemini's arguments were rejected`, { problem: message, arguments: call.args ?? {} }, 'warn');
          const repair = tool.validationRecovery ? 'Fix the arguments or switch tools.' : 'Fix the arguments and call the tool again.';
          reply({ ok: false, error: `${message}. ${repair}${tool.example ? ` Valid arguments look like: ${tool.example}` : ''}${validationRecovery(tool)}` });
          toolCalls.push({ name: tool.name, status: 'error', durationMs: 0, summary: message });
          options.hooks?.toolCompleted?.(callId, tool.name, 'error', 'Rejected invalid arguments', 0);
          continue;
        }

        const started = Date.now();
        options.hooks?.toolStarted?.(callId, tool);
        trace?.detail(`tool ${tool.name}: called with`, call.args ?? {});
        const toolDeadline = timeoutSignal(tool.timeoutMs, `${tool.name} timed out after ${Math.round(tool.timeoutMs / 1000)} seconds.`);
        const toolTimeout = toolDeadline.signal;
        const toolSignal = AbortSignal.any([runSignal, toolTimeout]);
        try {
          const result = await raceAbort(tool.execute(parsed.data as never, {
            callId,
            siblings: response.functionCalls.filter((_, other) => other !== index).map(call => ({ name: call.name, args: call.args ?? {} })),
            signal: toolSignal,
            progress: (message, processed, total) => options.hooks?.toolProgress?.(callId, tool, message, processed, total)
          }), toolSignal);
          const durationMs = Date.now() - started;
          validationFailures.delete(tool.name);
          trace?.detail(`tool ${tool.name}: done in ${formatDuration(durationMs)}`, { summary: result.summary, result: result.data });
          reply({ ok: true, result: capResult(result.data, limits.maxResultChars) });
          toolCalls.push({ name: tool.name, status: 'ok', durationMs, summary: result.summary.slice(0, 300) });
          options.hooks?.toolCompleted?.(callId, tool.name, 'ok', result.summary, durationMs);
          if (result.clarification) clarification = result.clarification;
        } catch (error) {
          const durationMs = Date.now() - started;
          trace?.('tool.execution.failed', {
            tool: tool.name, durationMs, code: options.signal.aborted ? 'CANCELLED' :
              runTimer.aborted || toolTimeout.aborted ? 'TIMEOUT' : toPublicError(error).code
          }, 'warn');
          if (options.signal.aborted || runTimer.aborted) {
            trace?.detail(`tool ${tool.name}: stopped after ${formatDuration(durationMs)}`, error, 'warn');
            throw error;
          }
          const message = toolTimeout.aborted
            ? `${tool.name} timed out after ${Math.round(tool.timeoutMs / 1000)} seconds.`
            : errorMessage(error);
          const safe = error instanceof AppError || toolTimeout.aborted ? message : `${tool.name} failed: ${message}`;
          const toldGemini = safe + (error instanceof ValidationError ? validationRecovery(tool) : '');
          trace?.detail(`tool ${tool.name}: failed after ${formatDuration(durationMs)}`, { toldGemini, error }, 'warn');
          reply({ ok: false, error: toldGemini });
          toolCalls.push({ name: tool.name, status: 'error', durationMs, summary: safe.slice(0, 300) });
          options.hooks?.toolCompleted?.(callId, tool.name, 'error', safe, durationMs);
        } finally {
          toolDeadline.clear();
        }
      }
      contents.push({ role: 'user', parts });
      if (clarification) return finish('clarification', clarification.question, { clarification });
    }
    return finish('limit_reached', '');
  } catch (error) {
    if (options.signal.aborted) return finish('cancelled', '', { error: error instanceof Error ? error : new Error(String(error)) });
    if (runTimer.aborted) {
      return finish('failed', '', { error: new TimeoutError(`The request took longer than ${Math.round(limits.runTimeoutMs / 1000)} seconds.`) });
    }
    return finish('failed', '', { error: error instanceof Error ? error : new Error(String(error)) });
  } finally {
    runDeadline.clear();
  }
}
