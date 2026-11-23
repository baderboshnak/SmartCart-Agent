import { z } from 'zod';
import { ConfigurationError } from '@/lib/shared/errors';

// Defaults from a test of every model on this project's key (2026-11-21): these call the
// tools correctly. gemini-3.5-flash-lite checks products well but builds invalid cart
// changes, so it only checks; gemma-4-26b builds carts but timed out checking products.
const DEFAULT_AGENT_BACKUPS = 'gemini-3.6-flash,gemma-4-26b-a4b-it,gemini-3.8-flash,gemma-4-31b-it,gemini-4-hydrogen';
const DEFAULT_MATCH_MODELS = 'gemini-3.1-flash-lite,gemini-3.5-flash-lite';
const DEFAULT_MATCH_BACKUPS = 'gemini-3.6-flash,gemini-3.8-flash,gemma-4-31b-it,gemini-4-hydrogen';

const MATCH_CONCURRENCY_ERROR = 'SMARTCART_MATCH_CONCURRENCY must be a whole number from 1 to 64.';

// Server-side configuration. None of these values are sent to the browser.
const EnvSchema = z.object({
  MONGODB_URI: z.string().trim().min(1, 'MONGODB_URI is not set.'),
  MONGODB_DB_NAME: z.string().trim().regex(/^[A-Za-z0-9_-]{1,63}$/u, 'MONGODB_DB_NAME is invalid.').default('smartcart'),
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.1-flash-lite'),
  /** Backups for the agent, tried in order when GEMINI_MODEL is busy. Comma-separated. */
  GEMINI_BACKUP_MODELS: z.string().trim().default(DEFAULT_AGENT_BACKUPS),
  /** Product-checking models; calls are spread across them. Comma-separated. */
  SMARTCART_MATCH_MODEL: z.string().trim().default(DEFAULT_MATCH_MODELS),
  /** Backups for product checking, used when every checking model is busy. Comma-separated. */
  SMARTCART_MATCH_BACKUP_MODELS: z.string().trim().default(DEFAULT_MATCH_BACKUPS),
  /** Most product-checking Gemini calls running at once across the whole server process. */
  SMARTCART_MATCH_CONCURRENCY: z.coerce.number({ error: MATCH_CONCURRENCY_ERROR })
    .int(MATCH_CONCURRENCY_ERROR).min(1, MATCH_CONCURRENCY_ERROR).max(64, MATCH_CONCURRENCY_ERROR).default(12),
  GEMINI_LIVE_MODEL: z.string().trim().min(1).default('gemini-3.8-live')
});

export type ServerEnv = z.infer<typeof EnvSchema>;

export function getServerEnv(): ServerEnv {
  const parsed = EnvSchema.safeParse({
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || undefined,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    GEMINI_MODEL: process.env.GEMINI_MODEL || undefined,
    GEMINI_BACKUP_MODELS: process.env.GEMINI_BACKUP_MODELS ?? undefined,
    SMARTCART_MATCH_MODEL: process.env.SMARTCART_MATCH_MODEL || undefined,
    SMARTCART_MATCH_BACKUP_MODELS: process.env.SMARTCART_MATCH_BACKUP_MODELS ?? undefined,
    SMARTCART_MATCH_CONCURRENCY: process.env.SMARTCART_MATCH_CONCURRENCY || undefined,
    GEMINI_LIVE_MODEL: process.env.GEMINI_LIVE_MODEL || undefined
  });
  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues.map(issue => issue.message).join(' '));
  }
  return parsed.data;
}

export interface GeminiConfig {
  apiKey: string;
  /** The main agent model. */
  agentModel: string;
  /** The first checking model (used when only one model is needed). */
  matchModel: string;
  /** The main agent model followed by its backups. */
  agentModels: string[];
  /** Checking models that share the work. */
  matchModels: string[];
  /** Checking backups, used when every checking model is busy. */
  matchBackupModels: string[];
}

/** Split a comma-separated model list, dropping blanks and repeats. */
export function modelList(value: string): string[] {
  return [...new Set(value.split(',').map(model => model.trim()).filter(Boolean))];
}

/** Gemini settings for generateContent with function calling. */
export function getGeminiConfig(): GeminiConfig {
  const env = getServerEnv();
  if (!env.GEMINI_API_KEY) {
    throw new ConfigurationError('GEMINI_API_KEY is not set on the server.');
  }
  const agentModels = modelList([env.GEMINI_MODEL, env.GEMINI_BACKUP_MODELS].join(','));
  const matchModels = modelList(env.SMARTCART_MATCH_MODEL);
  if (!matchModels.length) matchModels.push(env.GEMINI_MODEL);
  const matchBackupModels = modelList(env.SMARTCART_MATCH_BACKUP_MODELS)
    .filter(model => !matchModels.includes(model));
  for (const model of [...agentModels, ...matchModels, ...matchBackupModels]) {
    if (/live/iu.test(model)) {
      throw new ConfigurationError(
        `"${model}" is a Gemini Live model. The agent and product checks need generateContent models such as gemini-3.1-flash-lite. ` +
        'Keep the Live model in GEMINI_LIVE_MODEL.'
      );
    }
  }
  return { apiKey: env.GEMINI_API_KEY, agentModel: agentModels[0]!, matchModel: matchModels[0]!, agentModels, matchModels, matchBackupModels };
}

/** Gemini Live settings for the voice feature. */
export function getVoiceConfig(): { apiKey: string; liveModel: string } {
  const env = getServerEnv();
  if (!env.GEMINI_API_KEY) throw new ConfigurationError('GEMINI_API_KEY is not set on the server.');
  return { apiKey: env.GEMINI_API_KEY, liveModel: env.GEMINI_LIVE_MODEL };
}

/** Load .env for standalone scripts; existing variables always win. */
export function loadEnvFileForScripts(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
