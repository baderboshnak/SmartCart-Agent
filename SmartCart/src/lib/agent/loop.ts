import { setTimeout as delay } from 'node:timers/promises';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import type { z } from 'zod';
import { AppError, errorMessage, TimeoutError } from '@/lib/shared/errors';
import type { AgentToolSummary } from '@/lib/shared/types';
import { isOverloadError, isTransientModelError, type AgentModel, type ModelTurn, type TokenUsage } from '@/lib/agent/gemini';
import { toGeminiSchema } from '@/lib/agent/schemas';

export interface ToolExecutionContext {
  callId: string;
  signal: AbortSignal;
  progress: (message: string, processed?: number, total?: number) => void;
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
  toolCalls: AgentToolSummary[];
  usage: TokenUsage;
  error: AppError | Error | null;
  contents: Content[];
}

export function toFunctionDeclarations(tools: AgentTool[]): FunctionDeclaration[] {
  return tools.map(tool => ({
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
  runSignal: AbortSignal
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
      const factor = isOverloadError(error) ? [2, 5, 10, 10][attempt] ?? 10 : attempt + 1;
      await delay(limits.retryDelayMs * factor, undefined, { signal: runSignal });
    } finally {
      timeout.clear();
    }
  }
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
}): Promise<LoopOutcome> {
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
  let forceAnswer = false;
  let callCounter = 0;

  const finish = (status: LoopStatus, text: string, extra: Partial<LoopOutcome> = {}): LoopOutcome => ({
    status, text, clarification: null, modelTurns, toolCalls, usage, error: null, contents, ...extra
  });

  try {
    for (let turn = 1; turn <= limits.maxModelTurns; turn++) {
      const toolMode = forceAnswer || turn === limits.maxModelTurns ? 'NONE' : 'AUTO';
      const response = await generateWithRetry(options.model, {
        systemInstruction: await options.systemInstruction(),
        contents,
        tools: declarations,
        toolMode
      }, limits, runSignal);
      modelTurns++;
      addUsage(usage, response.usage);

      if (!response.functionCalls.length) {
        return finish(toolMode === 'NONE' ? 'limit_reached' : 'completed', response.text);
      }
      if (toolMode === 'NONE') return finish('limit_reached', response.text);

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
          reply({ ok: false, error: `Unknown tool "${call.name}". Use only the declared tools.` });
          toolCalls.push({ name: call.name || 'unknown', status: 'error', durationMs: 0, summary: 'Unknown tool rejected.' });
          continue;
        }
        if (index >= limits.maxCallsPerTurn) {
          reply({ ok: false, error: `Too many tool calls in one turn (limit ${limits.maxCallsPerTurn}). Call it again in the next turn if still needed.` });
          continue;
        }
        if (toolCalls.length >= limits.maxToolCalls) {
          forceAnswer = true;
          reply({ ok: false, error: 'The tool-call budget for this message is used up. Answer the customer now with the verified results you have.' });
          continue;
        }
        const parsed = tool.argsSchema.safeParse(call.args ?? {});
        if (!parsed.success) {
          const message = `Invalid arguments: ${zodMessage(parsed.error)}`;
          reply({ ok: false, error: `${message}. Fix the arguments and call the tool again.` });
          toolCalls.push({ name: tool.name, status: 'error', durationMs: 0, summary: message });
          options.hooks?.toolCompleted?.(callId, tool.name, 'error', 'Rejected invalid arguments', 0);
          continue;
        }

        const started = Date.now();
        options.hooks?.toolStarted?.(callId, tool);
        const toolDeadline = timeoutSignal(tool.timeoutMs, `${tool.name} timed out after ${Math.round(tool.timeoutMs / 1000)} seconds.`);
        const toolTimeout = toolDeadline.signal;
        const toolSignal = AbortSignal.any([runSignal, toolTimeout]);
        try {
          const result = await raceAbort(tool.execute(parsed.data as never, {
            callId,
            signal: toolSignal,
            progress: (message, processed, total) => options.hooks?.toolProgress?.(callId, tool, message, processed, total)
          }), toolSignal);
          const durationMs = Date.now() - started;
          reply({ ok: true, result: capResult(result.data, limits.maxResultChars) });
          toolCalls.push({ name: tool.name, status: 'ok', durationMs, summary: result.summary.slice(0, 300) });
          options.hooks?.toolCompleted?.(callId, tool.name, 'ok', result.summary, durationMs);
          if (result.clarification) clarification = result.clarification;
        } catch (error) {
          if (options.signal.aborted || runTimer.aborted) throw error;
          const durationMs = Date.now() - started;
          const message = toolTimeout.aborted
            ? `${tool.name} timed out after ${Math.round(tool.timeoutMs / 1000)} seconds.`
            : errorMessage(error);
          const safe = error instanceof AppError || toolTimeout.aborted ? message : `${tool.name} failed: ${message}`;
          reply({ ok: false, error: safe });
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
