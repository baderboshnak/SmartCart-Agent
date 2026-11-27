import assert from 'node:assert/strict';
import { GenerateContentResponse } from '@google/genai';
import { z } from 'zod';
import { matchProducts } from '@engine/smartcart-matcher.mjs';
import type { EngineItem } from '@engine/engine-types.mjs';
import type { AgentEvent } from '@/lib/agent/events';
import { runShoppingAgent } from '@/lib/agent/agent';
import { runAgentLoop, type AgentTool, type LoopLimits } from '@/lib/agent/loop';
import type { AgentModel } from '@/lib/agent/gemini';
import { toModelTurn } from '@/lib/agent/gemini';
import { createPooledAgentModel, ModelHealth } from '@/lib/agent/model-pool';
import { getAgentRun } from '@/lib/db/agent-runs.repository';
import { getCart } from '@/lib/db/carts.repository';
import { createSession, getSession } from '@/lib/db/sessions.repository';
import type { TerminalTrace } from '@/lib/server/terminal-trace';
import { selectBasket } from '@/lib/shopping/optimizer';
import { createFakeMatcher, functionCallTurn, lastToolResponses, parseMatcherPrompt, scriptedModel, textTurn } from '../helpers/fake-models';
import { fixtureSearch } from '../helpers/fixtures';
import { fixtureDb } from './fixture-db';
import { recordCase } from './backend-case';
import type { EvaluationCase, EvaluationSection } from './types';

const providerError = (status: number, message = `Offline fixture HTTP ${status}`) => Object.assign(new Error(message), { status });

function traceEvents() {
  const steps: { step: string; delayMs?: number; reason?: string }[] = [];
  const trace: TerminalTrace = Object.assign((step: string, values?: Record<string, unknown>) => {
    steps.push({ step, delayMs: typeof values?.delayMs === 'number' ? values.delayMs : undefined,
      reason: typeof values?.reason === 'string' ? values.reason : undefined });
  }, { mode: 'off' as const, detail: () => {} });
  return { trace, steps };
}

function loop(model: AgentModel, options: { limits?: Partial<LoopLimits>; tools?: AgentTool[]; trace?: TerminalTrace; signal?: AbortSignal } = {}) {
  return runAgentLoop({
    model, tools: options.tools ?? [], systemInstruction: () => 'Offline fixture', contents: [{ role: 'user', parts: [{ text: 'Buy milk' }] }],
    signal: options.signal ?? new AbortController().signal,
    limits: { modelTimeoutMs: 100, runTimeoutMs: 1_000, retryDelayMs: 1, modelRetries: 2, ...options.limits }, trace: options.trace
  });
}

const states = (steps: ReturnType<typeof traceEvents>['steps']) => steps.filter(entry => entry.step === 'agent.model.retryScheduled')
  .map(({ delayMs, reason }) => ({ delayMs, reason }));

export async function runFailures(): Promise<EvaluationSection> {
  const cases: EvaluationCase[] = [];
  const check = <T,>(id: string, request: string, expected: unknown, execute: () => T | Promise<T>, verify: (actual: T) => void, component = 'shopping agent retry loop') =>
    recordCase(cases, { id: `failure-${id}`, title: request, request, category: 'failure-handling', expected, component }, execute, verify);

  for (const failure of [
    { id: '429', error: providerError(429), delayMs: 2, reason: 'overloaded' },
    { id: '503', error: providerError(503), delayMs: 2, reason: 'overloaded' },
    { id: '504', error: providerError(504), delayMs: 1, reason: 'transient' },
    { id: 'network', error: new Error('fetch failed: ECONNRESET'), delayMs: 1, reason: 'transient' }
  ]) {
    const expected = { status: 'completed', attempts: 2, retries: [{ delayMs: failure.delayMs, reason: failure.reason }] };
    await check(failure.id, `Recover from a synthetic ${failure.id} failure`, expected, async () => {
      const model = scriptedModel([() => { throw failure.error; }, textTurn('Recovered')]);
      const { trace, steps } = traceEvents();
      const outcome = await loop(model, { trace });
      return { status: outcome.status, attempts: model.requests.length, retries: states(steps) };
    }, result => assert.deepEqual(result, expected));
  }

  await check('provider-delay', 'Respect an explicit provider retry delay on rate limiting', 'Wait at least the provider-specified 2,500 ms before retrying', async () => {
    // No real sleep. Inspect the delay decided by the actual retry loop.
    const response = providerError(429, JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Retry in 2.5 seconds',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.500s' }] } }));
    const model = scriptedModel([() => { throw response; }, textTurn('Recovered')]);
    const { trace, steps } = traceEvents();
    await loop(model, { trace });
    return { providerDelayMs: 2500, scheduledDelayMs: states(steps)[0]?.delayMs };
  }, actual => assert.ok((actual.scheduledDelayMs ?? 0) >= actual.providerDelayMs, 'Backoff used the fixed schedule and ignored RetryInfo.'));

  await check('retry-limit', 'Stop after the configured retry limit when the sole provider stays overloaded', { status: 'failed', attempts: 4, delays: [2, 5, 10] }, async () => {
    let attempts = 0;
    const { trace, steps } = traceEvents();
    const outcome = await loop({ name: 'only-fixture-model', async generate() { attempts++; throw providerError(503); } }, { trace, limits: { modelRetries: 3 } });
    return { status: outcome.status, attempts, delays: states(steps).map(entry => entry.delayMs) };
  }, actual => assert.deepEqual(actual, { status: 'failed', attempts: 4, delays: [2, 5, 10] }));

  await check('permanent', 'Fail a malformed provider request without retrying', { status: 'failed', attempts: 1 }, async () => {
    let attempts = 0;
    const outcome = await loop({ name: 'fixture', async generate() { attempts++; throw providerError(400); } });
    return { status: outcome.status, attempts };
  }, actual => assert.deepEqual(actual, { status: 'failed', attempts: 1 }));

  await check('invalid-provider-response', 'Reject a provider response with no candidates', 'A readable model error', () => {
    let error: string | undefined;
    try { toModelTurn(new GenerateContentResponse()); }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    return { error };
  }, actual => assert.match(actual.error ?? '', /returned no answer/u), 'Gemini response adapter');

  await check('timeout-recovery', 'Time out a stalled call and recover on retry', { status: 'completed', attempts: 2, reason: 'timeout' }, async () => {
    const { trace, steps } = traceEvents();
    const model = scriptedModel([() => new Promise(() => {}), textTurn('Recovered')]);
    const outcome = await loop(model, { trace, limits: { modelTimeoutMs: 8 } });
    return { status: outcome.status, attempts: model.requests.length, reason: states(steps)[0]?.reason };
  }, actual => assert.deepEqual(actual, { status: 'completed', attempts: 2, reason: 'timeout' }));

  await check('deadline', 'End a stalled run at its overall deadline', { status: 'failed', attempts: 1 }, async () => {
    const model = scriptedModel([() => new Promise(() => {})]);
    const outcome = await loop(model, { limits: { runTimeoutMs: 8 } });
    return { status: outcome.status, attempts: model.requests.length };
  }, actual => assert.deepEqual(actual, { status: 'failed', attempts: 1 }));

  await check('aborted', 'Cancel an active run from the client', { status: 'cancelled', attempts: 1 }, async () => {
    const controller = new AbortController();
    const model = scriptedModel([() => { setImmediate(() => controller.abort()); return new Promise(() => {}); }]);
    const outcome = await loop(model, { signal: controller.signal });
    return { status: outcome.status, attempts: model.requests.length };
  }, actual => assert.deepEqual(actual, { status: 'cancelled', attempts: 1 }));

  await check('tool-timeout', 'Return a tool timeout to the model and preserve the next turn', 'One tool error and completed explanation', async () => {
    const tools: AgentTool[] = [{ name: 'slow', description: 'Synthetic slow tool', label: 'Slow', argsSchema: z.object({}), timeoutMs: 7,
      execute: () => new Promise(() => {}) }];
    const model = scriptedModel([functionCallTurn([{ name: 'slow', args: {} }]), request => {
      assert.equal(lastToolResponses(request)[0]?.response.ok, false);
      return textTurn('The check timed out.');
    }]);
    const outcome = await loop(model, { tools });
    return { status: outcome.status, toolStatuses: outcome.toolCalls.map(call => call.status), text: outcome.text };
  }, actual => assert.deepEqual(actual, { status: 'completed', toolStatuses: ['error'], text: 'The check timed out.' }));

  await check('alternatives', 'Exercise a fixture pool with two busy engines and one successful fallback', ['alpha', 'bravo', 'charlie'], async () => {
    const calls: string[] = [];
    const model = createPooledAgentModel({ models: ['alpha', 'bravo', 'charlie'], health: new ModelHealth(), async generate(modelName) {
      calls.push(modelName);
      if (modelName !== 'charlie') throw providerError(modelName === 'alpha' ? 503 : 504);
      return textTurn('The third fixture engine answered.');
    } });
    const outcome = await loop(model);
    return { calls, status: outcome.status };
  }, actual => assert.deepEqual(actual, { calls: ['alpha', 'bravo', 'charlie'], status: 'completed' }), 'pool library with fixture alternatives');

  const item: EngineItem = { product: 'milk', searchTerms: ['חלב'], requirements: [], preferences: [], quantity: { amount: 1, unit: 'l' } };
  const products = fixtureSearch(['חלב']).slice(0, 3);
  await check('partial', 'Retry only the missing product decisions from a partial batch', 'First attempt submits 3 products, second attempt submits only 2 missing decisions', async () => {
    const matcher = createFakeMatcher({ identity: () => true });
    const batches: string[][] = [], saved: number[] = [];
    const result = await matchProducts({ item, products, maxAttempts: 2, callModel: async args => {
      const response = await matcher.callModel(args) as { decisions: unknown[] };
      batches.push(parseMatcherPrompt(args.prompt).candidates.map(product => product.id));
      return batches.length === 1 ? { decisions: response.decisions.slice(0, 1) } : response;
    }, onCheckpoint: async checkpoint => { saved.push(checkpoint.decisions.length); } });
    return { batches, saved, matched: result.matches.length };
  }, actual => {
    assert.deepEqual(actual.batches.map(batch => batch.length), [3, 2]);
    assert.deepEqual(actual.batches[1], actual.batches[0]?.slice(1));
    assert.deepEqual(actual.saved, [1, 3]);
    assert.equal(actual.matched, 3);
  }, 'matching batch validator');

  await check('invalid-json-and-checkpoint', 'Keep successful batches when a later batch exhausts invalid-response retries', 'Save the valid decision, retry the invalid batch twice and surface the failure', async () => {
    const matcher = createFakeMatcher({ identity: () => true });
    const saved: number[] = [];
    let calls = 0;
    let error = '';
    try {
      await matchProducts({ item, products: products.slice(0, 2), batchSize: 1, maxAttempts: 2,
        onCheckpoint: async checkpoint => { saved.push(checkpoint.decisions.length); }, callModel: args => {
          return ++calls === 1 ? matcher.callModel(args) : Promise.resolve('{ malformed response');
        } });
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    return { calls, saved, error };
  }, actual => {
    assert.equal(actual.calls, 3);
    assert.deepEqual(actual.saved, [1]);
    assert.match(actual.error, /could not|did not return a valid decision/u);
  }, 'matching batch validator');

  await check('release-lock', 'Release the session lock after a failed request and allow a subsequent request', 'A failed event, an unlocked session and successful follow-up', async () => {
    const { db } = fixtureDb([]);
    const { session } = await createSession(db);
    const events: AgentEvent[] = [];
    const common = { db, sessionId: session._id, matcher: { callModel: null, model: 'unused' },
      emit: (event: AgentEvent) => { events.push(event); }, signal: new AbortController().signal };
    const broken = scriptedModel([() => { throw providerError(400); }]);
    const first = await runShoppingAgent({ ...common, message: 'I want milk', model: broken });
    const afterFailure = (await getSession(db, session._id))?.activeRun;
    const second = await runShoppingAgent({ ...common, message: 'Hello', model: scriptedModel([textTurn('Hello!')]) });
    return { first: first.status, failedEvent: events.some(event => event.type === 'agent.failed'), lock: afterFailure, second: second.status };
  }, actual => assert.deepEqual(actual, { first: 'failed', failedEvent: true, lock: null, second: 'completed' }), 'agent persistence and session lock');

  return { name: 'Failure recovery, limits and locks', mode: 'MOCK', cases, metrics: { externalAiRequests: 0 }, notes: [
    'Uses configured millisecond deadlines and scheduled-backoff trace capture. No test sleeps for a real provider timeout.',
    'Fallback tests exercise the library with fixture alternatives. The configured application uses only one model for shopping and matching.',
    'The cache and lock persistence case uses the shared isolated repository adapter. Database integration results are reported separately.'
  ] };
}

export async function runFinalResponses(): Promise<EvaluationSection> {
  const cases: EvaluationCase[] = [];
  const offerId = 'rami_levy:7290058140886:001:039:7290004131074';
  const offer = fixtureSearch(['חלב']).find(product => product._id === offerId);
  assert.ok(offer, `Missing independently selected milk offer ${offerId}.`);
  const fixtureName = 'חלב תנובה 3% שומן 1 ל\' קרטון בד"צ';
  const storeKey = 'rami_levy:7290058140886:001:039';
  const fixtureStore = 'Rami Levy · store 039';
  const input = '2 liters of 3% milk';
  const milkItem = {
    sourceText: input, product: 'milk', coreSearchTerm: 'חלב', quantity: { amount: 2, unit: 'l' },
    constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' }]
  };
  const noBasketInput = `${input} and 500 grams of mozzarella`;
  const budgetInput = `${input} under 10 shekels`;
  const expectedBasket = {
    store: storeKey, total: 14.4, offer: offerId, productName: fixtureName, bought: { amount: 2000, unit: 'ml' },
    package: { quantity: 1, unit: 'l', isWeighted: false }, packageCount: 2, unitPrice: 7.2
  };
  const facts = {
    product: `Product ${fixtureName}`, brand: 'Brand תנובה', count: 'Quantity 2 packages', size: 'Size 1 liter per package',
    unitPrice: 'Unit price ₪7.20', total: 'Total ₪14.40', store: `Store ${fixtureStore}`, availability: 'Confirmed in catalog snapshot'
  };

  async function answer(text: string, condition: 'complete' | 'missing' | 'budget' = 'complete') {
    const { db } = fixtureDb([offer!]);
    const { session } = await createSession(db);
    const matcher = createFakeMatcher({ identity: () => true });
    const message = condition === 'missing' ? noBasketInput : condition === 'budget' ? budgetInput : input;
    const items = condition === 'missing' ? [milkItem, {
      sourceText: '500 grams of mozzarella', product: 'mozzarella', coreSearchTerm: 'מוצרלה', quantity: { amount: 500, unit: 'g' }
    }] : [milkItem];
    const operations: unknown[] = [{ op: 'add_items', requestText: condition === 'missing' ? noBasketInput : input, items }];
    if (condition === 'budget') operations.push({ op: 'set_budget', budgetIls: 10, budgetExclusive: true, userQuote: 'under 10 shekels' });
    const model = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations } }]),
      functionCallTurn([{ name: 'optimizeBasket', args: {} }]), textTurn(text)
    ]);
    const result = await runShoppingAgent({ db, sessionId: session._id, message, model, matcher: { model: 'fixture-final', callModel: matcher.callModel },
      emit: () => {}, signal: new AbortController().signal });
    const cart = await getCart(db, session._id);
    const basket = cart ? selectBasket(cart).basket : null;
    const line = basket?.items[0];
    const product = line?.products[0];
    const run = await getAgentRun(db, result.runId);
    const calculation = cart?.calculation;
    return {
      text: result.message.content, verified: calculation?.verification.passed, status: result.status,
      basketStatus: calculation?.status, budget: cart?.budget,
      basket: basket && { store: basket.storeKey, total: basket.totalPriceIls, offer: product?.productId,
        productName: product?.productName, bought: line?.purchasedQuantity, package: product?.package,
        packageCount: product?.packageCount, unitPrice: product?.listedUnitPriceIls },
      missing: calculation?.result.excludedStores.flatMap(store => store.missingItems.map(item => item.product)),
      cheapestOverBudgetIls: calculation?.result.cheapestOverBudgetIls,
      backendError: run?.error ?? null, toolSummaries: run?.toolCalls ?? []
    };
  }

  type Answer = Awaited<ReturnType<typeof answer>>;
  function verifyRun(observed: Answer) {
    assert.equal(observed.status, 'completed', observed.backendError ?? undefined);
    assert.equal(observed.verified, true, 'The reported answer must refer to a checked calculation.');
  }
  function verifyBasket(observed: Answer) {
    verifyRun(observed);
    assert.deepEqual(observed.basket, expectedBasket);
  }
  const verify = (id: string, title: string, request: string, expected: unknown, execute: () => Promise<Answer>, check: (actual: Answer) => void) =>
    recordCase(cases, { id: `final-${id}`, title, request, expected, category: 'final-response', component: 'agent final response' }, execute, check);

  const changes: Array<{ id: string; field?: keyof typeof facts; wrong?: string }> = [
    { id: 'correct' }, { id: 'wrong-name', field: 'product', wrong: 'Product chocolate milk' },
    { id: 'wrong-brand', field: 'brand', wrong: 'Brand Unrelated Dairy' },
    { id: 'wrong-count', field: 'count', wrong: 'Quantity 3 packages' },
    { id: 'wrong-size', field: 'size', wrong: 'Size 2 liters per package' },
    { id: 'wrong-unit-price', field: 'unitPrice', wrong: 'Unit price ₪0.01' },
    { id: 'wrong-total', field: 'total', wrong: 'Total ₪0.03' },
    { id: 'wrong-store', field: 'store', wrong: 'Store Shufersal · store 413' },
    { id: 'false-live-stock', field: 'availability', wrong: 'Guaranteed in stock right now' }
  ];
  // Prices, amounts, sizes, stores and stock claims are checked against the verified basket, and a
  // failing answer is replaced by the verified summary. Product names and brands in free text are
  // not machine-checkable: those two cases record the limit while the basket stays verified.
  const uncheckable = new Set(['product', 'brand']);
  for (const variant of changes) {
    const draft = { ...facts, ...(variant.field ? { [variant.field]: variant.wrong } : {}) };
    const limit = Boolean(variant.field && uncheckable.has(variant.field));
    const title = !variant.field ? 'Return the confirmed basket details'
      : limit ? `Known limit: a wrong ${variant.field} in free text is not detected; the basket and total stay verified`
      : `Catch an incorrect ${variant.field} assertion in the final answer`;
    await verify(variant.id, title, input, facts, () => answer(Object.values(draft).join('. ')), observed => {
      verifyBasket(observed);
      if (!variant.field) {
        const incorrect = Object.entries(facts).filter(([, value]) => !observed.text.includes(value));
        assert.deepEqual(incorrect.map(([field]) => field), [], `Unconfirmed or missing response facts: ${incorrect.map(([field]) => field).join(', ')}`);
        return;
      }
      assert.match(observed.text, /₪14\.40?(?!\d)/u, 'The verified total is missing from the answer.');
      assert.ok(observed.text.includes(fixtureStore), 'The verified store is missing from the answer.');
      if (!limit) assert.ok(!observed.text.includes(variant.wrong!), `The incorrect ${variant.field} reached the customer.`);
    });
  }

  await verify('verified-fallback', 'Render verified basket values after an empty model answer', input, expectedBasket, () => answer(''), observed => {
    verifyBasket(observed);
    const [headline, purchase, disclaimer] = observed.text.split('\n');
    assert.equal(headline, `${fixtureStore}: ₪14.4 for 1 item(s), 0/0 preferences met.`);
    assert.equal(purchase, `• milk: 2 × ${fixtureName} — ₪14.4`);
    assert.equal(disclaimer, 'Prices are catalog snapshots, not live checkout prices.');
  });

  function verifyMissing(observed: Answer) {
    verifyRun(observed);
    assert.equal(observed.basket, null);
    assert.equal(observed.basketStatus, 'NO_COMPLETE_BASKET');
    assert.deepEqual(observed.missing, ['mozzarella']);
    assert.match(observed.text, /missing: mozzarella/iu);
    assert.doesNotMatch(observed.text, /₪/u);
  }
  await verify('missing-fallback', 'List the unavailable ingredient in the deterministic fallback', noBasketInput, 'No complete basket, mozzarella missing and no payable total',
    () => answer('', 'missing'), verifyMissing);
  await verify('false-availability', 'Reject a final answer claiming a missing ingredient is available', noBasketInput, 'No complete basket, mozzarella missing and no payable total',
    () => answer('Milk and mozzarella confirmed in store 039 for ₪14.40.', 'missing'), verifyMissing);

  function verifyBudget(observed: Answer) {
    verifyRun(observed);
    assert.deepEqual(observed.budget, { amountIls: 10, exclusive: true });
    assert.equal(observed.basket, null);
    assert.equal(observed.basketStatus, 'NO_COMPLETE_BASKET');
    assert.equal(observed.cheapestOverBudgetIls, 14.4);
    assert.doesNotMatch(observed.text, /₪9\.90/u, 'The answer quotes a fabricated under-budget total.');
    assert.match(observed.text, /no single store|exceed|over budget/iu);
  }
  await verify('budget-fallback', 'Avoid quoting a payable total when the fixed budget is impossible', budgetInput, 'No feasible basket. Cheapest confirmed total in the optimizer is ₪14.40.',
    () => answer('', 'budget'), verifyBudget);
  await verify('false-budget', 'Reject a final answer claiming an impossible budget was met', budgetInput, 'No feasible basket under ₪10. Cheapest confirmed total in the optimizer is ₪14.40.',
    () => answer('Complete basket within the budget. Pay ₪9.90.', 'budget'), verifyBudget);

  return { name: 'Final answer fidelity', mode: 'MOCK', cases, metrics: { externalAiRequests: 0 }, notes: [
    'The real agent prices and verifies a controlled basket against the repository fixture. The model boundary then receives either an accurate response or a deliberately conflicting name or price.',
    'Fidelity results distinguish the checked basket from the natural-language answer, including quantities, store, missing products and budget feasibility.',
    'The deterministic fallback is tested for the values it displays. It does not separately render unit prices or a detailed reason for an impossible budget. Future real voice tests must also assess the provider’s spoken paraphrase.'
  ] };
}
