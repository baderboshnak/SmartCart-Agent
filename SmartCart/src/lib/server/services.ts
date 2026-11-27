import type { CallModel } from '@engine/smartcart-matcher.mjs';
import { createGeminiAgentModel, createGeminiMatcher, type AgentModel } from '@/lib/agent/gemini';
import { createPooledAgentModel, createPooledMatcher, serverModelHealth } from '@/lib/agent/model-pool';
import { getGeminiConfig, getServerEnv } from '@/lib/env';
import type { TerminalTrace } from '@/lib/server/terminal-trace';
import { ConfigurationError } from '@/lib/shared/errors';
import { createLimiter, type Limiter } from '@/lib/shopping/limiter';

/** Time allowed for one agent model attempt. */
const AGENT_ATTEMPT_TIMEOUT_MS = 30_000;
/** Time allowed for one attempt to check a batch of products. */
const MATCH_ATTEMPT_TIMEOUT_MS = 40_000;

/** Use the configured shopping model for agent turns, with timeout and trace reporting. */
export function getAgentModel(trace?: TerminalTrace): AgentModel {
  const config = getGeminiConfig();
  const model = createGeminiAgentModel(config);
  return createPooledAgentModel({
    models: [config.model],
    health: serverModelHealth(),
    attemptTimeoutMs: AGENT_ATTEMPT_TIMEOUT_MS,
    trace,
    generate: (_name, request) => model.generate(request)
  });
}

// One count of product-checking calls for the whole server process, shared by every
// agent run and cart edit. The global survives dev hot reloads and separate route bundles.
const globalStore = globalThis as typeof globalThis & { __smartcartMatcherLimiter?: Limiter };

/** The server-wide limit on Gemini checking calls running at once (SMARTCART_MATCH_CONCURRENCY). */
export function serverMatcherLimiter(): Limiter {
  return (globalStore.__smartcartMatcherLimiter ??= createLimiter(getServerEnv().SMARTCART_MATCH_CONCURRENCY));
}

/**
 * The product matcher uses the same model as the agent. Every call waits for a slot
 * in the server-wide limit. Each cart's
 * pipeline adds its own limit of 12 around it. Without Gemini configuration only cached
 * decisions can be reused.
 */
export function getMatcher(signal?: AbortSignal, trace?: TerminalTrace): { callModel: CallModel | null; model: string } {
  const { GEMINI_MODEL: model } = getServerEnv();
  try {
    const config = getGeminiConfig();
    const callGemini = createPooledMatcher({
      models: [config.model],
      backups: [],
      health: serverModelHealth(),
      attemptTimeoutMs: MATCH_ATTEMPT_TIMEOUT_MS,
      signal,
      trace,
      call: () => createGeminiMatcher(config, { signal, timeoutMs: MATCH_ATTEMPT_TIMEOUT_MS })
    });
    const limiter = serverMatcherLimiter();
    return {
      callModel: args => {
        if (trace && !signal?.aborted && limiter.active === limiter.max) {
          trace('model.matcher.queued', { active: limiter.active, waiting: limiter.waiting + 1, limit: limiter.max });
        }
        return limiter.run(() => callGemini(args), signal);
      },
      model: config.model
    };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    trace?.('model.matcher.cache-only', { reason: error.code }, 'warn');
    return { callModel: null, model };
  }
}

export function geminiConfigured(): boolean {
  try {
    getGeminiConfig();
    return true;
  } catch {
    return false;
  }
}
