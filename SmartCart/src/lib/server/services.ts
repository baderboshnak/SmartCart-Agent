import type { CallModel } from '@engine/smartcart-matcher.mjs';
import { createGeminiAgentModel, createGeminiMatcher, type AgentModel } from '@/lib/agent/gemini';
import { createPooledAgentModel, createPooledMatcher, serverModelHealth } from '@/lib/agent/model-pool';
import { getGeminiConfig, getServerEnv } from '@/lib/env';
import { ConfigurationError } from '@/lib/shared/errors';
import { createLimiter, type Limiter } from '@/lib/shopping/limiter';

/** Time one model gets for one agent turn before its backup takes over. */
const AGENT_ATTEMPT_TIMEOUT_MS = 30_000;
/** Time one model gets for one batch of product checks before another model takes over. */
const MATCH_ATTEMPT_TIMEOUT_MS = 40_000;

/** The agent model: GEMINI_MODEL, with GEMINI_BACKUP_MODELS taking over when it is busy. */
export function getAgentModel(): AgentModel {
  const config = getGeminiConfig();
  return createPooledAgentModel({
    models: config.agentModels,
    health: serverModelHealth(),
    attemptTimeoutMs: AGENT_ATTEMPT_TIMEOUT_MS,
    generate: (model, request) => createGeminiAgentModel({ ...config, agentModel: model }).generate(request)
  });
}

/** Saved checks are shared by the checking models, so the cache key names the whole set. */
export function matchCacheModelLabel(matchModels: string[]): string {
  return matchModels.join('+');
}

// One count of product-checking calls for the whole server process, shared by every
// agent run and cart edit. The global survives dev hot reloads and separate route bundles.
const globalStore = globalThis as typeof globalThis & { __smartcartMatcherLimiter?: Limiter };

/** The server-wide limit on Gemini checking calls running at once (SMARTCART_MATCH_CONCURRENCY). */
export function serverMatcherLimiter(): Limiter {
  return (globalStore.__smartcartMatcherLimiter ??= createLimiter(getServerEnv().SMARTCART_MATCH_CONCURRENCY));
}

/**
 * The product matcher. Calls are spread across the checking models, with backups when
 * they are busy. Every call waits for a slot in the server-wide limit; each cart's
 * pipeline adds its own limit of 12 around it. Without Gemini configuration only cached
 * decisions can be reused.
 */
export function getMatcher(signal?: AbortSignal): { callModel: CallModel | null; model: string } {
  const env = getServerEnv();
  try {
    const config = getGeminiConfig();
    const callGemini = createPooledMatcher({
      models: config.matchModels,
      backups: config.matchBackupModels,
      health: serverModelHealth(),
      attemptTimeoutMs: MATCH_ATTEMPT_TIMEOUT_MS,
      signal,
      call: model => createGeminiMatcher({ ...config, matchModel: model }, { signal, timeoutMs: MATCH_ATTEMPT_TIMEOUT_MS })
    });
    const limiter = serverMatcherLimiter();
    return { callModel: args => limiter.run(() => callGemini(args), signal), model: matchCacheModelLabel(config.matchModels) };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    const models = env.SMARTCART_MATCH_MODEL.split(',').map(model => model.trim()).filter(Boolean);
    return { callModel: null, model: matchCacheModelLabel(models.length ? models : [env.GEMINI_MODEL]) };
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
