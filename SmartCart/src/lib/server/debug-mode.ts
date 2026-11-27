export type DebugMode = 'off' | 'on' | 'full';

/**
 * SMARTCART_DEBUG decides whether the trace includes content: what the customer said,
 * Gemini's replies, tool arguments and results, product checks and Gemini's error text.
 * Local development shows readable details by default. In production details are opt-in.
 * "full" also expands long blocks and includes low-level events in the terminal.
 */
export function debugMode(env: Record<string, string | undefined> = process.env): DebugMode {
  const value = env.SMARTCART_DEBUG?.trim().toLowerCase();
  if (!value) return env.NODE_ENV === 'development' ? 'on' : 'off';
  if (value === 'full') return 'full';
  return ['0', 'false', 'off', 'no'].includes(value) ? 'off' : 'on';
}
