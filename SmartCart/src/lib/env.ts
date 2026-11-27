import { z } from 'zod';
import { ConfigurationError } from '@/lib/shared/errors';

const MATCH_CONCURRENCY_ERROR = 'SMARTCART_MATCH_CONCURRENCY must be a whole number from 1 to 64.';

// Server-side configuration. None of these values are sent to the browser.
const EnvSchema = z.object({
  MONGODB_URI: z.string().trim().min(1, 'MONGODB_URI is not set.'),
  MONGODB_DB_NAME: z.string().trim().regex(/^[A-Za-z0-9_-]{1,63}$/u, 'MONGODB_DB_NAME is invalid.').default('smartcart'),
  GEMINI_API_KEY: z.string().trim().optional(),
  /** One model for agent turns and product checks. */
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash-lite'),
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
  model: string;
}

/** Gemini settings for generateContent with function calling. */
export function getGeminiConfig(): GeminiConfig {
  const { GEMINI_API_KEY: apiKey, GEMINI_MODEL: model } = getServerEnv();
  if (!apiKey) throw new ConfigurationError('GEMINI_API_KEY is not set on the server.');
  if (model.includes(',')) throw new ConfigurationError('GEMINI_MODEL must name one model.');
  if (/live/iu.test(model)) {
    throw new ConfigurationError('GEMINI_MODEL needs a generateContent model such as gemini-3.5-flash-lite. Set the Live model in GEMINI_LIVE_MODEL.');
  }
  return { apiKey, model };
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
