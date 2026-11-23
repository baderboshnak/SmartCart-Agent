import type { Content } from '@google/genai';
import type { Db } from 'mongodb';
import type { CallModel } from '@engine/smartcart-matcher.mjs';
import { countRecentRuns, createAgentRun, finishAgentRun } from '@/lib/db/agent-runs.repository';
import { getOrCreateCart } from '@/lib/db/carts.repository';
import { acquireRunLock, appendMessages, getSession, newId, releaseRunLock, updateSessionState } from '@/lib/db/sessions.repository';
import { findStores } from '@/lib/db/stores.repository';
import { AppError, errorMessage, RateLimitError, toPublicError, UnauthorizedError, ValidationError } from '@/lib/shared/errors';
import type { AgentToolSummary, Cart, ChatMessage } from '@/lib/shared/types';
import { summarizeCalculationForAgent, toCartView } from '@/lib/shopping/cart-view';
import { isCalculationFresh, selectBasket } from '@/lib/shopping/optimizer';
import { CartPipeline, type PipelineProgress } from '@/lib/shopping/pipeline';
import type { AgentEventSink } from '@/lib/agent/events';
import type { AgentModel, TokenUsage } from '@/lib/agent/gemini';
import { runAgentLoop, type LoopLimits, type LoopOutcome } from '@/lib/agent/loop';
import { buildSystemInstruction } from '@/lib/agent/prompts';
import { calculateAndSave, createShoppingTools, type ShoppingToolContext } from '@/lib/agent/tools';
import { storeDisplayName } from '@/lib/catalog/normalize';
import { formatQuantity } from '@/lib/shopping/cart-ops';

export const MAX_MESSAGE_CHARS = 2000;
const HISTORY_MESSAGES = 12;
const RUN_LOCK_MS = 6 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_RUNS = 20;

export interface RunAgentOptions {
  db: Db;
  sessionId: string;
  message: string;
  model: AgentModel;
  matcher: { callModel: CallModel | null; model: string };
  emit: AgentEventSink;
  signal: AbortSignal;
  limits?: Partial<LoopLimits>;
  now?: () => Date;
  /** The customer spoke this message. */
  via?: 'voice';
}

export interface RunAgentResult {
  runId: string;
  status: LoopOutcome['status'];
  message: ChatMessage;
}

const storeName = (storeKey: string) => {
  const [retailer = storeKey, , , storeId = ''] = storeKey.split(':');
  return storeDisplayName(retailer, storeId);
};

/** Deterministic answer used when the model cannot produce one. */
export function fallbackSummary(cart: Cart): string {
  if (!cart.items.length) return 'Your cart is empty. Tell me what you would like to buy.';
  if (!isCalculationFresh(cart) || !cart.calculation) return 'I updated your cart, but I could not finish calculating prices. Ask me to try again.';
  if (cart.calculation.status === 'VERIFICATION_FAILED') return 'I could not verify the basket against the catalog, so I am not showing a total. Please try again.';
  const { basket } = selectBasket(cart);
  if (!basket) {
    const missing = cart.calculation.result.excludedStores.flatMap(store => store.missingItems.map(item => item.product));
    return `No single store has confirmed products for every item${missing.length ? ` (missing: ${[...new Set(missing)].join(', ')})` : ''}. I did not mix stores.`;
  }
  const lines = basket.items.map(line => `• ${line.item}: ${line.products.map(product => `${product.packageCount} × ${product.productName}`).join(' + ')} — ₪${line.totalPriceIls}`);
  return [
    `${storeName(basket.storeKey)}: ₪${basket.totalPriceIls} for ${basket.items.length} item(s), ${basket.preferencesSatisfied}/${basket.preferencesPossible} preferences met.`,
    ...lines,
    'Prices are catalog snapshots, not live checkout prices.'
  ].join('\n');
}

function historyContents(messages: ChatMessage[]): Content[] {
  return messages.slice(-HISTORY_MESSAGES)
    .filter(message => message.kind !== 'error')
    .map(message => ({ role: message.role === 'user' ? 'user' : 'model', parts: [{ text: message.content }] }));
}

/**
 * One customer message -> one bounded agent run. The cart in MongoDB stays the source
 * of truth; the run ends with a verified, persisted cart or a clear error.
 */
export async function runShoppingAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { db, sessionId, emit, signal } = options;
  const now = options.now ?? (() => new Date());
  const text = options.message.trim();
  if (!text) throw new ValidationError('Type a message first.');
  if (text.length > MAX_MESSAGE_CHARS) throw new ValidationError(`Messages can be at most ${MAX_MESSAGE_CHARS} characters.`);

  const session = await getSession(db, sessionId);
  if (!session) throw new UnauthorizedError();
  if (await countRecentRuns(db, sessionId, RATE_WINDOW_MS) >= RATE_MAX_RUNS) {
    throw new RateLimitError('Too many requests in a short time. Wait a few minutes and try again.');
  }
  const runId = newId('run');
  await acquireRunLock(db, sessionId, runId, RUN_LOCK_MS);
  const startedAt = now();
  const toolSummaries: AgentToolSummary[] = [];
  let usage: TokenUsage = { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };
  let modelTurns = 0;
  let pipeline: CartPipeline | null = null;

  try {
    const userMessage: ChatMessage = {
      id: newId('msg'), role: 'user', content: text, kind: 'text', runId, createdAt: startedAt,
      ...(options.via ? { via: options.via } : {})
    };
    await appendMessages(db, sessionId, [userMessage]);
    await createAgentRun(db, {
      _id: runId, sessionId, status: 'running', model: options.model.name, startedAt, finishedAt: null, durationMs: null,
      modelTurns: 0, toolCalls: [], matcherModelCalls: 0, tokenUsage: usage, error: null
    });
    emit({ type: 'agent.started', runId, userText: text });
    await getOrCreateCart(db, sessionId);

    let progressTarget: ((progress: PipelineProgress) => void) | null = null;
    pipeline = new CartPipeline({
      db,
      matcher: options.matcher,
      signal,
      onProgress: progress => progressTarget?.(progress)
    });
    const toolContext: ShoppingToolContext = {
      db,
      sessionId,
      userMessage: { id: userMessage.id, text },
      pipeline,
      setProgressTarget: target => { progressTarget = target; },
      onCartSaved: cart => emit({ type: 'cart.updated', runId, cart: toCartView(cart) }),
      coveredQuotes: []
    };
    const tools = createShoppingTools(toolContext);
    const stores = await findStores(db);
    const today = startedAt.toISOString().slice(0, 10);
    const pendingClarification = session.pendingClarification;

    const outcome = await runAgentLoop({
      model: options.model,
      tools,
      signal,
      limits: options.limits,
      contents: [...historyContents(session.messages), { role: 'user', parts: [{ text }] }],
      systemInstruction: async () => buildSystemInstruction({
        cart: await getOrCreateCart(db, sessionId), stores, today, pendingClarification
      }),
      hooks: {
        toolStarted: (callId, tool) => emit({ type: 'tool.started', runId, callId, tool: tool.name, label: tool.label }),
        toolProgress: (callId, tool, message, processed, total) => emit({ type: 'tool.progress', runId, callId, tool: tool.name, message, processed, total }),
        toolCompleted: (callId, tool, status, summary, durationMs) => emit({ type: 'tool.completed', runId, callId, tool, status, summary, durationMs })
      }
    });
    usage = outcome.usage;
    modelTurns = outcome.modelTurns;
    toolSummaries.push(...outcome.toolCalls);

    if (outcome.status === 'cancelled') {
      throw new AppError('The request was cancelled.', { status: 499, code: 'CANCELLED' });
    }
    if (outcome.status === 'failed') throw outcome.error ?? new AppError('The agent could not finish.');

    let content = outcome.text;
    let kind: ChatMessage['kind'] = 'text';
    let messageOptions: string[] | undefined;
    if (outcome.status === 'clarification' && outcome.clarification) {
      kind = 'clarification';
      content = outcome.clarification.question;
      messageOptions = outcome.clarification.options;
      emit({ type: 'clarification.required', runId, question: content, options: messageOptions });
    } else {
      // Final deterministic validation: never end with an unverified, stale cart.
      let cart = await getOrCreateCart(db, sessionId);
      if (cart.items.length && !isCalculationFresh(cart)) {
        const callId = newId('final');
        const started = Date.now();
        emit({ type: 'tool.started', runId, callId, tool: 'optimizeBasket', label: 'Verifying your final cart' });
        toolContext.setProgressTarget(progress => emit({ type: 'tool.progress', runId, callId, tool: 'optimizeBasket', message: progress.message, processed: progress.processed, total: progress.total }));
        try {
          cart = await calculateAndSave(toolContext);
          const summary = cart.calculation?.status ?? 'calculated';
          toolSummaries.push({ name: 'optimizeBasket', status: 'ok', durationMs: Date.now() - started, summary: `finalization: ${summary}` });
          emit({ type: 'tool.completed', runId, callId, tool: 'optimizeBasket', status: 'ok', summary: summary === 'COMPLETE' ? 'Every price double-checked' : summary === 'NO_COMPLETE_BASKET' ? 'No single store has everything' : summary === 'VERIFICATION_FAILED' ? 'Could not double-check the basket' : 'Prices updated', durationMs: Date.now() - started });
          content = await finalAnswerAfterRecalculation(options, outcome, cart, signal).catch(() => '') || fallbackSummary(cart);
          modelTurns++;
        } catch (error) {
          emit({ type: 'tool.completed', runId, callId, tool: 'optimizeBasket', status: 'error', summary: errorMessage(error).slice(0, 200), durationMs: Date.now() - started });
          toolSummaries.push({ name: 'optimizeBasket', status: 'error', durationMs: Date.now() - started, summary: errorMessage(error).slice(0, 200) });
          content = `${content ? `${content}\n\n` : ''}I could not finish verifying the cart: ${toPublicError(error).message}`;
        } finally {
          toolContext.setProgressTarget(null);
        }
      }
      if (!content) content = fallbackSummary(cart);
    }

    const assistant: ChatMessage = {
      id: newId('msg'), role: 'assistant', content: content.slice(0, 6000), kind, runId, createdAt: now(),
      ...(messageOptions?.length ? { options: messageOptions } : {})
    };
    await appendMessages(db, sessionId, [assistant]);
    await updateSessionState(db, sessionId, {
      pendingClarification: kind === 'clarification' ? { question: content, options: messageOptions ?? [] } : null,
      intent: kind === 'clarification' ? 'CLARIFICATION' : 'SHOPPING'
    });
    const finishedAt = now();
    await finishAgentRun(db, runId, {
      status: kind === 'clarification' ? 'clarification' : 'completed',
      finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), modelTurns, toolCalls: toolSummaries,
      matcherModelCalls: pipeline.modelCalls, tokenUsage: usage, error: null
    });
    emit({ type: 'agent.completed', runId, message: { id: assistant.id, content: assistant.content, kind, ...(assistant.options ? { options: assistant.options } : {}) } });
    return { runId, status: outcome.status, message: assistant };
  } catch (error) {
    const publicError = toPublicError(error);
    const cancelled = publicError.code === 'CANCELLED' || signal.aborted;
    const failure: ChatMessage = {
      id: newId('msg'), role: 'assistant', kind: 'error', runId, createdAt: now(),
      content: cancelled ? 'The request was cancelled.' : `Sorry, I could not complete that: ${publicError.message}`
    };
    const finishedAt = now();
    await Promise.allSettled([
      appendMessages(db, sessionId, [failure]),
      finishAgentRun(db, runId, {
        status: cancelled ? 'cancelled' : 'failed', finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
        modelTurns, toolCalls: toolSummaries, matcherModelCalls: pipeline?.modelCalls ?? 0, tokenUsage: usage,
        error: errorMessage(error).slice(0, 500)
      })
    ]);
    emit({ type: 'agent.failed', runId, error: { code: publicError.code, message: publicError.message } });
    return { runId, status: cancelled ? 'cancelled' : 'failed', message: failure };
  } finally {
    await releaseRunLock(db, sessionId, runId).catch(() => {});
  }
}

/** One extra text-only turn so the final answer describes the verified, saved cart. */
async function finalAnswerAfterRecalculation(options: RunAgentOptions, outcome: LoopOutcome, cart: Cart, signal: AbortSignal): Promise<string> {
  const note = `SYSTEM NOTE: The cart changed after your last calculation, so the backend recalculated and verified it. Verified result: ${JSON.stringify(summarizeCalculationForAgent(cart))}. ` +
    `Requested items: ${cart.items.map(item => `${item.product} (${formatQuantity(item.quantity)})`).join(', ')}. Give the customer your final answer based only on this result.`;
  const stores = await findStores(options.db);
  const response = await options.model.generate({
    systemInstruction: buildSystemInstruction({ cart, stores, today: new Date().toISOString().slice(0, 10), pendingClarification: null }),
    contents: [...outcome.contents, ...(outcome.text ? [{ role: 'model', parts: [{ text: outcome.text }] }] : []), { role: 'user', parts: [{ text: note }] }],
    tools: [],
    toolMode: 'NONE',
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  });
  return response.text;
}
