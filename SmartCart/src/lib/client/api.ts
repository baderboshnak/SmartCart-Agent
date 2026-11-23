import type { AgentEvent } from '@/lib/agent/events';
import type { UiCartOperation } from '@/lib/shopping/cart-service';
import type { CartView } from '@/lib/shopping/cart-view';

export type { AgentEvent, CartView, UiCartOperation };

export interface ActivityStep {
  callId: string;
  tool: string;
  label: string;
  status: 'running' | 'ok' | 'error';
  message?: string;
  processed?: number;
  total?: number;
  summary?: string;
  durationMs?: number;
}

export interface ClientMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: 'text' | 'clarification' | 'error';
  options?: string[];
  via?: 'voice';
  createdAt: string;
  steps?: ActivityStep[];
}

export interface SessionPayload {
  session: { messages: ClientMessage[]; pendingClarification: { question: string; options: string[] } | null };
  cart: CartView;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${response.status}).`);
  }
  return data as T;
}

export const api = {
  getSession: () => request<SessionPayload>('/api/sessions'),
  createSession: () => request<SessionPayload>('/api/sessions', { method: 'POST' }),
  getCart: () => request<{ cart: CartView }>('/api/cart'),
  editCart: (expectedRevision: number, operation: UiCartOperation) =>
    request<{ cart: CartView; recalculationError: string | null }>('/api/cart', {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision, operation })
    })
};

/** POST a message and read the agent's Server-Sent Events stream. */
export async function streamAgent(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, via?: 'voice'): Promise<void> {
  const response = await fetch('/api/agent', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, ...(via ? { via } : {}) }),
    signal
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'The agent request failed.');
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let boundary = buffer.indexOf('\n\n'); boundary !== -1; boundary = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        // Ignore a malformed event rather than breaking the stream.
      }
    }
  }
}
