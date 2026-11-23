import { GoogleGenAI, type CreateAuthTokenConfig, type LiveConnectConfig } from '@google/genai';
import { getVoiceConfig } from '@/lib/env';
import { errorMessage, ModelError, RateLimitError } from '@/lib/shared/errors';
import type { ChatMessage } from '@/lib/shared/types';
import { buildLiveConfig } from '@/lib/voice/live-config';

const TOKEN_WINDOW_MS = 10 * 60 * 1000;
const MAX_TOKENS_PER_WINDOW = 20;
const recentTokens = new Map<string, number[]>();

/** Per-process limit on voice sessions per shopping session. */
export function checkVoiceRateLimit(sessionId: string, now = Date.now()): void {
  const recent = (recentTokens.get(sessionId) ?? []).filter(time => now - time < TOKEN_WINDOW_MS);
  if (recent.length >= MAX_TOKENS_PER_WINDOW) {
    throw new RateLimitError('Too many voice sessions in a short time. Wait a few minutes and try again.');
  }
  recent.push(now);
  recentTokens.set(sessionId, recent);
}

/**
 * Token settings: one use, a 60-second window to connect, a 30-minute session, and every
 * Live setting locked so the browser cannot change the instructions or the tool.
 */
export function buildTokenConfig(liveModel: string, liveConfig: LiveConnectConfig, now = Date.now()): CreateAuthTokenConfig {
  return {
    uses: 1,
    newSessionExpireTime: new Date(now + 60_000).toISOString(),
    expireTime: new Date(now + 30 * 60_000).toISOString(),
    liveConnectConstraints: { model: liveModel, config: liveConfig },
    httpOptions: { apiVersion: 'v1alpha' }
  };
}

export interface VoiceTokenResponse {
  token: string;
  model: string;
  config: LiveConnectConfig;
  expiresAt: string;
}

/** Create a short-lived Gemini Live token. The real API key never leaves the server. */
export async function createVoiceToken(messages: readonly ChatMessage[] = []): Promise<VoiceTokenResponse> {
  const { apiKey, liveModel } = getVoiceConfig();
  const config = buildLiveConfig(messages);
  const tokenConfig = buildTokenConfig(liveModel, config);
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  try {
    const token = await ai.authTokens.create({ config: tokenConfig });
    if (!token.name) throw new Error('Gemini returned no token.');
    return { token: token.name, model: liveModel, config, expiresAt: tokenConfig.expireTime! };
  } catch (error) {
    throw new ModelError(`Could not start a voice session: ${errorMessage(error)}`, { cause: error });
  }
}
