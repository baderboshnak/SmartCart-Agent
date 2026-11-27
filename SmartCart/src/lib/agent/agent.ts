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
import { answerProblems } from '@/lib/agent/answer-check';
import { calculateAndSave, CART_TOOL_NAMES, createShoppingTools, type ShoppingToolContext } from '@/lib/agent/tools';
import { storeDisplayName } from '@/lib/catalog/normalize';
import { conversationLanguage, detectLanguage, LANGUAGE_NAMES, type Language } from '@/lib/i18n/language';
import { formatQuantity } from '@/lib/shopping/cart-ops';
import { formatDuration, type TerminalTrace } from '@/lib/server/terminal-trace';

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
  trace?: TerminalTrace;
  signal: AbortSignal;
  limits?: Partial<LoopLimits>;
  now?: () => Date;
  /** The customer spoke this message. */
  via?: 'voice';
  /**
   * The reply language when the message's words may not show it: the language the voice model
   * heard, or the chat's language for a suggestion button's English text. Otherwise detected.
   */
  language?: Language;
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

interface SummaryText {
  empty: string;
  /** The customer asked for something, but no cart change worked (invalid or malformed tool calls). */
  notDone: string;
  resizeNotDone: string;
  /** No tool ran and Gemini gave no answer. */
  notUnderstood: string;
  failed: (message: string, code: string) => string;
  cancelled: string;
  stale: string;
  notPriced: string;
  unverified: string;
  noBasket: (missing: string[]) => string;
  basket: (store: string, totalIls: number, items: number, met: number, possible: number) => string;
  snapshot: string;
}

const SUMMARY_TEXT: Record<Language, SummaryText> = {
  en: {
    empty: 'Your cart is empty. Tell me what you would like to buy.',
    notDone: 'Sorry, I could not add that to your cart. Please try again, or say it a little differently.',
    resizeNotDone: 'I couldn’t resize the shopping plan. The cart still has the existing quantities.',
    notUnderstood: 'Sorry, I did not catch that. What would you like to buy?',
    failed: message => `Sorry, I could not complete that: ${message}`,
    cancelled: 'The request was cancelled.',
    stale: 'I updated your cart, but I could not finish calculating prices. Ask me to try again.',
    notPriced: 'I don’t have verified prices for the current cart yet.',
    unverified: 'I could not verify the basket against the catalog, so I am not showing a total. Please try again.',
    noBasket: missing => `No single store has confirmed products for every item${missing.length ? ` (missing: ${missing.join(', ')})` : ''}. I did not mix stores.`,
    basket: (store, total, items, met, possible) => `${store}: ₪${total} for ${items} item(s), ${met}/${possible} preferences met.`,
    snapshot: 'Prices are catalog snapshots, not live checkout prices.'
  },
  he: {
    empty: 'העגלה שלך ריקה. ספרו לי מה תרצו לקנות.',
    notDone: 'מצטער, לא הצלחתי להוסיף את זה לעגלה. נסו שוב, או נסחו את זה קצת אחרת.',
    resizeNotDone: 'לא הצלחתי להתאים את תוכנית הקניות למספר האנשים. הכמויות בעגלה נשארו כמו שהיו.',
    notUnderstood: 'מצטער, לא הבנתי. מה תרצו לקנות?',
    failed: (_message, code) => code === 'RATE_LIMITED' ? 'אני עדיין מטפל בבקשה הקודמת שלכם. נסו שוב בעוד רגע.' : 'מצטער, לא הצלחתי להשלים את הבקשה. נסו שוב בעוד רגע.',
    cancelled: 'הבקשה בוטלה.',
    stale: 'עדכנתי את העגלה, אבל לא הצלחתי לסיים לחשב את המחירים. בקשו ממני לנסות שוב.',
    notPriced: 'עדיין אין לי מחירים מאומתים לעגלה הנוכחית.',
    unverified: 'לא הצלחתי לאמת את הסל מול הקטלוג, ולכן לא מוצג סכום כולל. נסו שוב בבקשה.',
    noBasket: missing => `אין חנות אחת עם מוצרים מאושרים לכל הפריטים${missing.length ? ` (חסרים: ${missing.join(', ')})` : ''}. לא שילבתי בין חנויות.`,
    basket: (store, total, items, met, possible) => `${store}: ₪${total} עבור ${items === 1 ? 'פריט אחד' : `${items} פריטים`}, עמידה בהעדפות: ${met}/${possible}.`,
    snapshot: 'המחירים לקוחים מתמונת מצב של הקטלוג, ולא מהקופה בזמן אמת.'
  },
  ar: {
    empty: 'سلة المشتريات فارغة. أخبرني ماذا تريد أن تشتري.',
    notDone: 'عذراً، لم أتمكن من إضافة ذلك إلى سلتك. حاول مرة أخرى، أو اكتبه بطريقة أخرى.',
    resizeNotDone: 'لم أتمكن من تعديل خطة التسوق حسب عدد الأشخاص. بقيت الكميات في السلة كما كانت.',
    notUnderstood: 'عذراً، لم أفهم. ماذا تريد أن تشتري؟',
    failed: (_message, code) => code === 'RATE_LIMITED' ? 'ما زلت أعمل على طلبك السابق. حاول مرة أخرى بعد قليل.' : 'عذراً، لم أتمكن من إكمال الطلب. حاول مرة أخرى بعد قليل.',
    cancelled: 'تم إلغاء الطلب.',
    stale: 'حدّثت سلتك، لكن لم أتمكن من إكمال حساب الأسعار. اطلب مني المحاولة مرة أخرى.',
    notPriced: 'ليست لدي أسعار مؤكدة للسلة الحالية بعد.',
    unverified: 'لم أتمكن من التحقق من السلة مقابل الكتالوج، لذلك لا أعرض المجموع. يرجى المحاولة مرة أخرى.',
    noBasket: missing => `لا يوجد متجر واحد فيه منتجات مؤكدة لكل الأصناف${missing.length ? ` (الأصناف الناقصة: ${missing.join('، ')})` : ''}. لم أجمع بين متاجر مختلفة.`,
    basket: (store, total, items, met, possible) => `${store}: ₪${total} — عدد الأصناف: ${items}، التفضيلات المحققة: ${met}/${possible}.`,
    snapshot: 'الأسعار مأخوذة من نسخة محفوظة من الكتالوج، وليست أسعار الدفع الحالية.'
  }
};

/** Deterministic answer, in the customer's language, used when the model cannot produce one. */
export function fallbackSummary(cart: Cart, language: Language = 'en', cartChanged = true): string {
  const text = SUMMARY_TEXT[language];
  if (!cart.items.length) return text.empty;
  if (!isCalculationFresh(cart) || !cart.calculation) return cartChanged ? text.stale : text.notPriced;
  if (cart.calculation.status === 'VERIFICATION_FAILED') return text.unverified;
  const { basket } = selectBasket(cart);
  if (!basket) {
    const missing = cart.calculation.result.excludedStores.flatMap(store => store.missingItems.map(item => item.product));
    return text.noBasket([...new Set(missing)]);
  }
  const lines = basket.items.map(line => `• ${line.item}: ${line.products.map(product => `${product.packageCount} × ${product.productName}`).join(' + ')} — ₪${line.totalPriceIls}`);
  return [
    text.basket(storeName(basket.storeKey), basket.totalPriceIls, basket.items.length, basket.preferencesSatisfied, basket.preferencesPossible),
    ...lines,
    text.snapshot
  ].join('\n');
}

/**
 * Where one run's time went: the agent's own Gemini turns (including the final answer), each
 * tool (Gemini product checks are part of the tool that ran them), and the rest (database, setup).
 */
export function timingSummary(totalMs: number, geminiMs: number, geminiTurns: number, tools: AgentToolSummary[]) {
  const byTool = new Map<string, { ms: number; calls: number }>();
  for (const tool of tools) {
    const entry = byTool.get(tool.name) ?? { ms: 0, calls: 0 };
    byTool.set(tool.name, { ms: entry.ms + tool.durationMs, calls: entry.calls + 1 });
  }
  const toolsMs = [...byTool.values()].reduce((sum, entry) => sum + entry.ms, 0);
  const breakdown = [...byTool].map(([name, entry]) => `${name}${entry.calls > 1 ? ` ×${entry.calls}` : ''} ${formatDuration(entry.ms)}`);
  return {
    totalMs,
    geminiMs,
    geminiTurns,
    toolsMs,
    ...(breakdown.length ? { tools: breakdown.join(', ') } : {}),
    otherMs: Math.max(0, totalMs - geminiMs - toolsMs)
  };
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
  const { db, sessionId, emit, signal, trace } = options;
  const now = options.now ?? (() => new Date());
  const text = options.message.trim();
  if (!text) throw new ValidationError('Type a message first.');
  if (text.length > MAX_MESSAGE_CHARS) throw new ValidationError(`Messages can be at most ${MAX_MESSAGE_CHARS} characters.`);

  const session = await getSession(db, sessionId);
  if (!session) throw new UnauthorizedError();
  // Answer in the customer's language: as the voice model heard it, else by the message's
  // words, else as in their earlier messages (for "2" or "👍"). Never left to the model.
  const fromWords = detectLanguage(text);
  const fromEarlier = conversationLanguage(session.messages);
  const language = options.language ?? fromWords ?? fromEarlier ?? 'en';
  const languageSource = options.language ? (options.via === 'voice' ? 'as Gemini Live heard it' : 'sent by the page with a suggestion button')
    : fromWords ? 'from the words of this message' : fromEarlier ? 'from earlier messages' : 'the default';
  trace?.detail('customer message', {
    text,
    ...(options.via ? { via: options.via } : {}),
    replyLanguage: `${LANGUAGE_NAMES[language]} (${languageSource})`,
    ...(session.pendingClarification ? { answersQuestion: session.pendingClarification.question } : {})
  });
  trace?.('agent.checkingRateLimit');
  if (await countRecentRuns(db, sessionId, RATE_WINDOW_MS) >= RATE_MAX_RUNS) {
    throw new RateLimitError('Too many requests in a short time. Wait a few minutes and try again.');
  }
  const runId = newId('run');
  await acquireRunLock(db, sessionId, runId, RUN_LOCK_MS);
  trace?.('agent.lock.acquired', { runId });
  const startedAt = now();
  const toolSummaries: AgentToolSummary[] = [];
  let usage: TokenUsage = { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };
  let modelTurns = 0;
  let geminiMs = 0;
  let pipeline: CartPipeline | null = null;

  try {
    const userMessage: ChatMessage = {
      id: newId('msg'), role: 'user', content: text, kind: 'text', runId, createdAt: startedAt,
      ...(options.via ? { via: options.via } : {})
    };
    await appendMessages(db, sessionId, [userMessage]);
    trace?.('agent.message.saved', { role: 'user' });
    await createAgentRun(db, {
      _id: runId, sessionId, status: 'running', model: options.model.name, startedAt, finishedAt: null, durationMs: null,
      modelTurns: 0, toolCalls: [], matcherModelCalls: 0, tokenUsage: usage, error: null
    });
    emit({ type: 'agent.started', runId, userText: text });
    const initialCart = await getOrCreateCart(db, sessionId);
    trace?.('cart.loaded', { items: initialCart.items.length, revision: initialCart.revision });

    let progressTarget: ((progress: PipelineProgress) => void) | null = null;
    pipeline = new CartPipeline({
      db,
      matcher: options.matcher,
      signal,
      trace,
      onProgress: progress => progressTarget?.(progress)
    });
    const pendingClarification = session.pendingClarification;
    const toolContext: ShoppingToolContext = {
      db,
      sessionId,
      userMessage: { id: userMessage.id, text },
      hasPendingClarification: Boolean(pendingClarification),
      pipeline,
      trace,
      setProgressTarget: target => { progressTarget = target; },
      onCartSaved: cart => emit({ type: 'cart.updated', runId, cart: toCartView(cart) }),
      coveredQuotes: []
    };
    const tools = createShoppingTools(toolContext);
    const stores = await findStores(db);
    const today = startedAt.toISOString().slice(0, 10);
    trace?.('agent.context.ready', { stores: stores.length, messages: session.messages.length, pendingClarification: Boolean(pendingClarification), language });

    const loopStarted = Date.now();
    const outcome = await runAgentLoop({
      model: options.model,
      tools,
      signal,
      limits: options.limits,
      trace,
      contents: [...historyContents(session.messages), { role: 'user', parts: [{ text }] }],
      systemInstruction: async () => buildSystemInstruction({
        cart: await getOrCreateCart(db, sessionId), stores, today, pendingClarification, language
      }),
      hooks: {
        toolStarted: (callId, tool) => emit({ type: 'tool.started', runId, callId, tool: tool.name, label: tool.label }),
        toolProgress: (callId, tool, message, processed, total) => emit({ type: 'tool.progress', runId, callId, tool: tool.name, message, processed, total }),
        toolCompleted: (callId, tool, status, summary, durationMs) => emit({ type: 'tool.completed', runId, callId, tool, status, summary, durationMs })
      }
    });
    usage = outcome.usage;
    modelTurns = outcome.modelTurns;
    geminiMs = outcome.modelMs;
    toolSummaries.push(...outcome.toolCalls);
    trace?.('agent.loop.finished', { status: outcome.status, modelTurns, toolCalls: toolSummaries.length, durationMs: Date.now() - loopStarted });

    if (outcome.status === 'cancelled') {
      throw new AppError('The request was cancelled.', { status: 499, code: 'CANCELLED' });
    }
    if (outcome.status === 'failed') throw outcome.error ?? new AppError('The agent could not finish.');

    let content = outcome.text;
    let kind: ChatMessage['kind'] = 'text';
    let messageOptions: string[] | undefined;
    const cartChanged = toolSummaries.some(summary => summary.status === 'ok' && CART_TOOL_NAMES.has(summary.name));
    const additions = toolSummaries.filter(summary => summary.name === 'addItems' || summary.name === 'addRecipe');
    const additionsFailed = additions.length > 0 && additions.every(summary => summary.status === 'error');
    const resizeFailed = toolSummaries.some(summary => summary.name === 'resizeShoppingPlan' && summary.status === 'error');
    if (outcome.status === 'clarification' && outcome.clarification) {
      kind = 'clarification';
      content = outcome.clarification.question;
      messageOptions = outcome.clarification.options;
      emit({ type: 'clarification.required', runId, question: content, options: messageOptions });
    } else if (!cartChanged && (resizeFailed || additionsFailed)) {
      trace?.(resizeFailed ? 'agent.finalAnswer.planResizeFailed' : 'agent.finalAnswer.cartAddFailed');
      content = resizeFailed ? SUMMARY_TEXT[language].resizeNotDone : SUMMARY_TEXT[language].notDone;
    } else {
      // Automatically verify prices after a cart edit. Read-only turns can use saved prices.
      let cart = await getOrCreateCart(db, sessionId);
      const needsCalculation = cartChanged && cart.items.length > 0 && !isCalculationFresh(cart);
      trace?.('cart.finalization.checked', { items: cart.items.length, needsCalculation });
      if (needsCalculation) {
        const callId = newId('final');
        const started = Date.now();
        emit({ type: 'tool.started', runId, callId, tool: 'optimizeBasket', label: 'Verifying your final cart' });
        toolContext.setProgressTarget(progress => emit({ type: 'tool.progress', runId, callId, tool: 'optimizeBasket', message: progress.message, processed: progress.processed, total: progress.total }));
        try {
          cart = await calculateAndSave(toolContext);
          const summary = cart.calculation?.status ?? 'calculated';
          toolSummaries.push({ name: 'optimizeBasket', status: 'ok', durationMs: Date.now() - started, summary: `finalization: ${summary}` });
          emit({ type: 'tool.completed', runId, callId, tool: 'optimizeBasket', status: 'ok', summary: summary === 'COMPLETE' ? 'Every price double-checked' : summary === 'NO_COMPLETE_BASKET' ? 'No single store has everything' : summary === 'VERIFICATION_FAILED' ? 'Could not double-check the basket' : 'Prices updated', durationMs: Date.now() - started });
          trace?.('agent.finalAnswer.started');
          const answerStarted = Date.now();
          const finalAnswer = await finalAnswerAfterRecalculation(options, outcome, cart, signal, language).catch(error => {
            trace?.('agent.finalAnswer.failed', { code: toPublicError(error).code }, 'warn');
            trace?.detail('Gemini could not write the final answer, so the cart summary is used', error, 'warn');
            return '';
          });
          const answerMs = Date.now() - answerStarted;
          geminiMs += answerMs;
          trace?.('agent.finalAnswer.completed', { source: finalAnswer ? 'model' : 'cartSummary', durationMs: answerMs });
          content = finalAnswer || fallbackSummary(cart, language);
          modelTurns++;
        } catch (error) {
          trace?.detail('the final cart check failed', error, 'warn');
          emit({ type: 'tool.completed', runId, callId, tool: 'optimizeBasket', status: 'error', summary: errorMessage(error).slice(0, 200), durationMs: Date.now() - started });
          toolSummaries.push({ name: 'optimizeBasket', status: 'error', durationMs: Date.now() - started, summary: errorMessage(error).slice(0, 200) });
          content = `${content ? `${content}\n\n` : ''}I could not finish verifying the cart: ${toPublicError(error).message}`;
        } finally {
          toolContext.setProgressTarget(null);
        }
      }
      const struggled = outcome.status === 'limit_reached' || outcome.malformedReplies > 0 || toolSummaries.some(summary => summary.status === 'error');
      const unfinished = () => struggled ? SUMMARY_TEXT[language].notDone : SUMMARY_TEXT[language].notUnderstood;
      if (!content) {
        trace?.('agent.finalAnswer.usedCartSummary');
        content = !cart.items.length && !cartChanged ? unfinished() : fallbackSummary(cart, language, cartChanged);
      } else {
        // Check Gemini's answer against the verified cart before the customer sees it.
        const check = (answer: string) => answerProblems(answer, { cart, language, message: text, cartChanged, stores });
        let problems = check(content);
        if (problems.length === 1 && problems[0] === 'language') {
          const started = Date.now();
          const rewritten = await rewriteInLanguage(options, outcome, cart, content, signal, language).catch(() => '');
          geminiMs += Date.now() - started;
          modelTurns++;
          if (rewritten && !check(rewritten).length) {
            content = rewritten;
            problems = [];
          }
        }
        if (problems.length) {
          trace?.('agent.answer.replaced', { problems: problems.join(',') }, 'warn');
          trace?.detail('Gemini\'s answer did not match the verified cart, so the verified summary is used', { problems, answer: content });
          content = cart.items.length ? fallbackSummary(cart, language, cartChanged) : unfinished();
        }
      }
    }

    const assistant: ChatMessage = {
      id: newId('msg'), role: 'assistant', content: content.slice(0, 6000), kind, runId, createdAt: now(),
      ...(messageOptions?.length ? { options: messageOptions } : {})
    };
    await appendMessages(db, sessionId, [assistant]);
    trace?.('agent.message.saved', { role: 'assistant', kind });
    await updateSessionState(db, sessionId, {
      pendingClarification: kind === 'clarification' ? { question: content, options: messageOptions ?? [] } : null,
      intent: kind === 'clarification' ? 'CLARIFICATION' : 'SHOPPING'
    });
    trace?.('agent.session.updated', { pendingClarification: kind === 'clarification' });
    const finishedAt = now();
    await finishAgentRun(db, runId, {
      status: kind === 'clarification' ? 'clarification' : 'completed',
      finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), modelTurns, toolCalls: toolSummaries,
      matcherModelCalls: pipeline.modelCalls, tokenUsage: usage, error: null
    });
    trace?.('agent.run.saved', { modelTurns, toolCalls: toolSummaries.length, matcherModelCalls: pipeline.modelCalls });
    trace?.('agent.timing', timingSummary(finishedAt.getTime() - startedAt.getTime(), geminiMs, modelTurns, toolSummaries));
    emit({ type: 'agent.completed', runId, message: { id: assistant.id, content: assistant.content, kind, ...(assistant.options ? { options: assistant.options } : {}) } });
    return { runId, status: outcome.status, message: assistant };
  } catch (error) {
    const publicError = toPublicError(error);
    const cancelled = publicError.code === 'CANCELLED' || signal.aborted;
    trace?.detail(cancelled ? 'run cancelled' : 'run failed', error, cancelled ? 'info' : 'error');
    const failure: ChatMessage = {
      id: newId('msg'), role: 'assistant', kind: 'error', runId, createdAt: now(),
      content: cancelled ? SUMMARY_TEXT[language].cancelled : SUMMARY_TEXT[language].failed(publicError.message, publicError.code)
    };
    const finishedAt = now();
    const [messageWrite, runWrite] = await Promise.allSettled([
      appendMessages(db, sessionId, [failure]),
      finishAgentRun(db, runId, {
        status: cancelled ? 'cancelled' : 'failed', finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
        modelTurns, toolCalls: toolSummaries, matcherModelCalls: pipeline?.modelCalls ?? 0, tokenUsage: usage,
        error: errorMessage(error).slice(0, 500)
      })
    ]);
    trace?.('agent.failure.recorded', {
      cancelled, messageSaved: messageWrite.status === 'fulfilled', runSaved: runWrite.status === 'fulfilled'
    }, messageWrite.status === 'rejected' || runWrite.status === 'rejected' ? 'warn' : 'info');
    trace?.('agent.timing', timingSummary(finishedAt.getTime() - startedAt.getTime(), geminiMs, modelTurns, toolSummaries));
    emit({ type: 'agent.failed', runId, error: { code: publicError.code, message: publicError.message } });
    return { runId, status: cancelled ? 'cancelled' : 'failed', message: failure };
  } finally {
    try {
      await releaseRunLock(db, sessionId, runId);
      trace?.('agent.lock.released');
    } catch (error) {
      trace?.('agent.lock.releaseFailed', { code: toPublicError(error).code }, 'warn');
    }
  }
}

/** One text-only turn that rewrites an answer written in the wrong language. */
async function rewriteInLanguage(options: RunAgentOptions, outcome: LoopOutcome, cart: Cart, answer: string, signal: AbortSignal, language: Language): Promise<string> {
  const stores = await findStores(options.db);
  const response = await options.model.generate({
    systemInstruction: buildSystemInstruction({ cart, stores, today: new Date().toISOString().slice(0, 10), pendingClarification: null, language }),
    contents: [...outcome.contents, { role: 'model', parts: [{ text: answer }] }, { role: 'user', parts: [{
      text: `SYSTEM NOTE: Write your last answer again in ${LANGUAGE_NAMES[language]} only. Keep every fact, price and product name exactly as it is.`
    }] }],
    tools: [],
    toolMode: 'NONE',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  });
  return response.text;
}

/** One extra text-only turn so the final answer describes the verified, saved cart. */
async function finalAnswerAfterRecalculation(options: RunAgentOptions, outcome: LoopOutcome, cart: Cart, signal: AbortSignal, language: Language): Promise<string> {
  // This note is the last "user" turn the model sees, so it repeats the reply language:
  // without it the model tends to answer the English note in English.
  const note = `SYSTEM NOTE: The cart changed after your last calculation, so the backend recalculated and verified it. Verified result: ${JSON.stringify(summarizeCalculationForAgent(cart))}. ` +
    `Requested items: ${cart.items.map(item => `${item.product} (${formatQuantity(item.quantity)})`).join(', ')}. Give the customer your final answer based only on this result, written in ${LANGUAGE_NAMES[language]}.`;
  const stores = await findStores(options.db);
  const response = await options.model.generate({
    systemInstruction: buildSystemInstruction({ cart, stores, today: new Date().toISOString().slice(0, 10), pendingClarification: null, language }),
    contents: [...outcome.contents, ...(outcome.text ? [{ role: 'model', parts: [{ text: outcome.text }] }] : []), { role: 'user', parts: [{ text: note }] }],
    tools: [],
    toolMode: 'NONE',
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  });
  return response.text;
}
