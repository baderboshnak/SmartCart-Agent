import type { CartView } from '@/lib/shopping/cart-view';

/** Events streamed to the browser. Only real backend activity is reported. */
export type AgentEvent =
  | { type: 'agent.started'; runId: string; userText: string }
  | { type: 'tool.started'; runId: string; callId: string; tool: string; label: string }
  | { type: 'tool.progress'; runId: string; callId: string; tool: string; message: string; processed?: number; total?: number }
  | { type: 'tool.completed'; runId: string; callId: string; tool: string; status: 'ok' | 'error'; summary: string; durationMs: number }
  | { type: 'cart.updated'; runId: string; cart: CartView }
  | { type: 'clarification.required'; runId: string; question: string; options: string[] }
  | { type: 'agent.completed'; runId: string; message: { id: string; content: string; kind: 'text' | 'clarification' | 'error'; options?: string[] } }
  | { type: 'agent.failed'; runId: string; error: { code: string; message: string } };

export type AgentEventSink = (event: AgentEvent) => void;

export function encodeSse(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
