import assert from 'node:assert/strict';
import type { Cart, Quantity } from '@/lib/shared/types';
import { runShoppingAgent } from '@/lib/agent/agent';
import type { AgentEvent } from '@/lib/agent/events';
import type { AgentModel, ModelTurn } from '@/lib/agent/gemini';
import { getAgentRun } from '@/lib/db/agent-runs.repository';
import { getCart } from '@/lib/db/carts.repository';
import { createSession } from '@/lib/db/sessions.repository';
import { toCartView } from '@/lib/shopping/cart-view';
import { READING_DECLARATION, type CallModel } from '@engine/smartcart-matcher.mjs';
import { functionCallTurn, parseMatcherPrompt, textTurn } from '../helpers/fake-models';
import { fixtureDb } from './fixture-db';
import { fixtureCatalog, food, item, scenarios, unspecified, type FixtureAction, type Scenario } from './scenario-data';
import { evaluateCase, type EvaluationSection } from './types';

const offers = fixtureCatalog();
const offerCodes = new Map([...food].map(([key, entry]) => [key, String(1_100_000 + entry.index)]));
const guarded = () => assert.equal(process.env.SMARTCART_EVAL_OFFLINE, '1', 'Use the offline guard preload.');

export type FixtureStorage = ReturnType<typeof fixtureDb>;
export interface RunOptions {
  storage?: FixtureStorage;
  think?: () => Promise<void>;
  sessionId?: string;
}

function actionProducts(action: FixtureAction) {
  return action.kind === 'add' ? action.items.map(entry => [entry.product, entry.key] as const)
    : action.kind === 'recipe' ? action.ingredients.map(entry => [entry.name, entry.key] as const)
    : [];
}

export function controlledMatcher(productKeys: ReadonlyMap<string, string>, think?: () => Promise<void>) {
  const stats = { matcherCalls: 0, intentReadingCalls: 0, productDecisions: 0, simulatedWaitMs: 0 };
  const callModel: CallModel = async ({ declaration, prompt }) => {
    if (think) {
      const started = performance.now();
      await think();
      stats.simulatedWaitMs += performance.now() - started;
    }
    if (declaration.name === READING_DECLARATION.name) {
      stats.intentReadingCalls++;
      const product = JSON.parse(/^Product wanted: (.*)$/mu.exec(prompt)?.[1] ?? '""') as string;
      return { wanted: product, notWanted: [] };
    }
    stats.matcherCalls++;
    const { candidates, product, requirements } = parseMatcherPrompt(prompt);
    stats.productDecisions += candidates.length;
    const accepted = offerCodes.get(productKeys.get(product) ?? '');
    return {
      decisions: candidates.map(candidate => {
        const same = Boolean(accepted && candidate.id.endsWith(':' + accepted));
        return {
          id: candidate.id, candidate: candidate.name, identityEvidence: candidate.name,
          identity: same ? 'MATCH' : 'NO_MATCH', relation: same ? 'SAME_PRODUCT' : 'RELATED_DIFFERENT',
          requirementChecks: requirements.map(requirement => ({
            requirement, kind: /תנובה|tnuva|עלית|עמק/iu.test(requirement) ? 'BRAND' : 'OTHER',
            result: same ? 'MET' : 'UNKNOWN', evidenceSource: same ? 'NAME' : 'NONE',
            evidence: same ? candidate.name : ''
          })),
          preferencesMet: []
        };
      })
    };
  };
  return { callModel, stats };
}

/** The per-action tool Gemini is offered for each cart operation. */
const TOOL_FOR_OP: Record<string, string> = {
  add_items: 'addItems', add_recipe: 'addRecipe', remove_items: 'removeItems', set_quantity: 'setQuantity',
  set_constraints: 'setConstraints', set_search_terms: 'setSearchTerms', set_mode: 'setShoppingMode',
  set_budget: 'setBudget', select_store: 'selectStore', clear: 'clearCart'
};
const OP_FOR_TOOL = Object.fromEntries(Object.entries(TOOL_FOR_OP).map(([op, tool]) => [tool, op]));

function toolFrom(action: FixtureAction, message: string, cart: Cart | null): Array<{ name: string; args: Record<string, unknown> }> {
  const update = ({ op, ...args }: Record<string, unknown>) => [{ name: TOOL_FOR_OP[op as string]!, args }];
  const id = (product: string) => cart?.items.find(entry => entry.product === product)?.id ?? 'missing-fixture-item';
  switch (action.kind) {
    case 'add':
      return update({ op: 'add_items', requestText: action.requestText ?? message, items: action.items.map(({ key: _key, ...entry }) => entry) });
    case 'recipe':
      return update({ op: 'add_recipe', requestText: message,
        recipe: { dish: action.dish, servings: action.servings, servingsSource: action.explicit ? 'EXPLICIT' : 'ASSUMED',
          ingredients: action.ingredients.map(({ key: _key, ...entry }) => entry) } });
    case 'budget':
      return update({ op: 'set_budget', budgetIls: action.amount, userQuote: message });
    case 'quantity':
      return update({ op: 'set_quantity', itemId: id(action.target), quantity: action.quantity, userQuote: message });
    case 'requirements':
      return update({ op: 'set_constraints', itemId: id(action.target), userQuote: message,
        constraints: action.values.map(value => ({ value, type: 'REQUIREMENT' })) });
    case 'remove':
      return update({ op: 'remove_items', itemIds: [id(action.target)], userQuote: message });
    case 'cheaper':
      return update({ op: 'set_mode', mode: 'cheapest', userQuote: message });
    case 'clear':
      return update({ op: 'clear', userQuote: message });
    case 'compare':
      return [{ name: 'compareStores', args: {} }];
    case 'clarify':
      return [{ name: 'requestClarification', args: { question: action.question } }];
    case 'invalid':
      return [{ name: action.tool, args: action.args }];
    case 'optimize':
      return [{ name: 'optimizeBasket', args: {} }];
    case 'none':
    case 'malformed':
    case 'say':
      return [];
  }
}

/** A scripted Gemini reply without a function call: a malformed call, or text that takes no action. */
function replyWithoutAction(action: FixtureAction | undefined): ModelTurn | null {
  if (action?.kind === 'malformed') {
    return { ...textTurn(''), finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call.' };
  }
  return action?.kind === 'say' ? textTurn(action.text) : null;
}

/**
 * The scripted Gemini for one customer turn: each model call returns the next labelled action,
 * then one optimizeBasket, then an empty reply.
 */
export function scriptedTurnModel(turn: Scenario['turns'][number], db: FixtureStorage['db'], sessionId: string, hooks: {
  operations?: string[];
  think?: () => Promise<void>;
  onRequest?: (request: Parameters<AgentModel['generate']>[0]) => void;
  onWait?: (milliseconds: number) => void;
} = {}): AgentModel {
  let index = 0;
  let optimized = false;
  return {
    name: 'offline-script',
    async generate(request): Promise<ModelTurn> {
      hooks.onRequest?.(request);
      if (hooks.think) {
        const started = performance.now();
        await hooks.think();
        hooks.onWait?.(performance.now() - started);
      }
      const saved = await getCart(db, sessionId);
      const action = turn.actions[index++];
      const withoutAction = replyWithoutAction(action);
      if (withoutAction) return withoutAction;
      const calls = action ? toolFrom(action, turn.message, saved) : [];
      if (calls.length) {
        if (action?.kind === 'optimize') optimized = true;
        for (const call of calls) {
          const names = call.args.operations as Array<{ op?: string }> | undefined;
          hooks.operations?.push(...(action?.kind === 'invalid' ? [call.name]
            : names?.map(entry => entry.op ?? call.name) ?? [OP_FOR_TOOL[call.name] ?? call.name]));
        }
        return functionCallTurn(calls);
      }
      if (!optimized && saved?.items.length && turn.actions.some(entry => !['none', 'invalid', 'clarify', 'malformed', 'say'].includes(entry.kind))) {
        optimized = true;
        return functionCallTurn([{ name: 'optimizeBasket', args: {} }]);
      }
      return textTurn('');
    }
  };
}

export async function executeScenario(scenario: Scenario, options: RunOptions = {}) {
  guarded();
  const missing = new Set(scenario.excludedKeys?.map(key => offerCodes.get(key)));
  const storeOnly = new Set(scenario.storeOnlyKeys?.map(key => offerCodes.get(key)));
  const storage = options.storage ?? fixtureDb(offers.filter(offer =>
    !missing.has(offer.productCode) && (!storeOnly.has(offer.productCode) || offer.storeId === '039')));
  const { db } = storage;
  const sessionId = options.sessionId ?? (await createSession(db)).session._id;
  const wanted = new Map(scenario.turns.flatMap(turn => turn.actions.flatMap(actionProducts)));
  const matcher = controlledMatcher(wanted, options.think);
  const events: AgentEvent[] = [];
  const operations: string[] = [];
  const observedToolErrors: string[] = [];
  const traces: Array<{ step: string; details: Record<string, unknown> }> = [];
  let final: Awaited<ReturnType<typeof runShoppingAgent>> | undefined;
  let agentTurns = 0;
  let simulatedAgentWaitMs = 0;
  let sentHistoryMessages = 0;
  const trace = Object.assign((step: string, details = {}) => traces.push({ step, details }), {
    detail() {}, mode: 'off' as const
  });

  for (const turn of scenario.turns) {
    const model = scriptedTurnModel(turn, db, sessionId, {
      operations, think: options.think,
      onRequest: request => {
        agentTurns++;
        sentHistoryMessages = Math.max(sentHistoryMessages, request.contents.length);
      },
      onWait: milliseconds => { simulatedAgentWaitMs += milliseconds; }
    });
    final = await runShoppingAgent({
      db, sessionId, message: turn.message, model, matcher: { ...matcher, model: 'evaluation-fixture-v1' },
      emit: event => events.push(event), trace, signal: new AbortController().signal
    });
    const savedRun = await getAgentRun(db, final.runId);
    observedToolErrors.push(...(savedRun?.toolCalls ?? []).filter(call => call.status === 'error').map(call => call.summary));
  }
  assert.ok(final);
  const cart = await getCart(db, sessionId);
  assert.ok(cart);
  const view = toCartView(cart);
  const catalogOffers = new Set(cart.calculation?.result.storeComparisons.flatMap(row => [
    ...row.cheapest.items.flatMap(line => line.products.map(product => product.productId)),
    ...row.preferencesFirst.items.flatMap(line => line.products.map(product => product.productId))
  ]));
  return {
    final, cart, view, events, operations, observedToolErrors, traces, sessionId, storage,
    actualProducts: cart.items.map(entry => wanted.get(entry.product) ?? entry.product),
    metrics: {
      agentTurns, sentHistoryMessages, toolCalls: events.filter(event => event.type === 'tool.started').length,
      ...matcher.stats, simulatedAgentWaitMs, ...storage.timing, uniqueSelectedOffers: catalogOffers.size,
      candidates: cart.calculation?.itemDiagnostics.reduce((total, entry) => total + entry.candidates, 0) ?? 0,
      cacheHits: cart.calculation?.itemDiagnostics.reduce((total, entry) => total + entry.cachedDecisions, 0) ?? 0,
      optimizationMs: traces.filter(entry => entry.step === 'pipeline.optimize.completed').reduce((total, entry) => total + Number(entry.details.durationMs ?? 0), 0),
      validationMs: traces.filter(entry => entry.step === 'pipeline.verify.completed').reduce((total, entry) => total + Number(entry.details.durationMs ?? 0), 0)
    }
  };
}

function validateScenario(scenario: Scenario, result: Awaited<ReturnType<typeof executeScenario>>) {
  const { cart, view, final, observedToolErrors, actualProducts } = result;
  const expected = scenario.expected;
  const problems: string[] = [];
  if (actualProducts.join('|') !== expected.products.join('|')) problems.push('Cart product identities or ordering differ');
  if (result.operations.join('|') !== expected.operations.join('|')) problems.push('Scripted tool operations did not reach the loop');
  if (view.status !== expected.basket && expected.basket !== 'NOT_CALCULATED') problems.push('Basket status differs');
  if (Boolean(observedToolErrors.length) !== Boolean(expected.toolError)) problems.push('Tool acceptance or rejection differs');
  if (expected.intent === 'clarification' && final.status !== 'clarification') problems.push('Clarification never reached the customer');
  if (expected.servings !== undefined && cart.recipePlans[0]?.servings !== expected.servings) problems.push('Recipe servings differ');
  if (expected.budget !== undefined && cart.budget?.amountIls !== expected.budget) problems.push('Budget differs');
  if (expected.budget !== undefined && view.basket && view.basket.totalPriceIls > expected.budget) problems.push('Explicit budget was exceeded');
  if (expected.cache === 'no-checks' && result.metrics.matcherCalls + result.metrics.intentReadingCalls > 0) problems.push('A non-shopping turn checked products');
  if (view.basket && !cart.calculation?.verification.passed) problems.push('An unverified basket was shown');
  for (const [product, requirements] of Object.entries(expected.retainedRequirements ?? {})) {
    const saved = cart.items.find(entry => entry.product === product)?.requirements ?? [];
    if (saved.length !== requirements.length || !requirements.every(value => saved.includes(value))) {
      problems.push('An unrelated turn changed the requirements for ' + product);
    }
  }
  for (const turn of scenario.turns) for (const action of turn.actions) {
    if (action.kind === 'quantity') {
      const entry = cart.items.find(row => row.product === action.target);
      if (entry?.quantity.amount !== action.quantity.amount || entry?.quantity.unit !== action.quantity.unit) problems.push('Cart quantity change was not saved');
    }
    if (action.kind === 'requirements' && !action.values.every(value => cart.items.some(row => row.product === action.target && row.requirements.includes(value)))) {
      problems.push('Cart requirement change was not saved');
    }
    if (action.kind === 'cheaper' && cart.mode !== 'cheapest') problems.push('Shopping mode did not change');
  }
  const reply = final.message.content;
  for (const pattern of expected.reply?.forbid ?? []) {
    if (new RegExp(pattern, 'iu').test(reply)) problems.push(`The reply says what it must not (/${pattern}/): ${reply.slice(0, 160)}`);
  }
  for (const pattern of expected.reply?.require ?? []) {
    if (!new RegExp(pattern, 'iu').test(reply)) problems.push(`The reply is missing /${pattern}/: ${reply.slice(0, 160)}`);
  }
  // The label is the last scripted extraction: earlier ones may be deliberate mistakes that the backend rejects.
  const lastAdd = scenario.turns.length === 1
    ? [...scenario.turns[0]!.actions].reverse().find((entry): entry is Extract<FixtureAction, { kind: 'add' }> => entry.kind === 'add')
    : undefined;
  if (lastAdd) {
    const scripted = lastAdd.items;
    for (const [index, entry] of scripted.entries()) {
      const stored = cart.items[index];
      if (stored && JSON.stringify(stored.quantity) !== JSON.stringify(entry.quantity)) problems.push('Stored quantity differs from the labelled request');
      if (stored) {
        const requirements = entry.constraintEvidence?.filter(value => value.type === 'REQUIREMENT').map(value => value.sourceText) ?? [];
        const preferences = entry.constraintEvidence?.filter(value => value.type === 'PREFERENCE').map(value => value.sourceText) ?? [];
        if (requirements.length !== stored.requirements.length || !requirements.every(value => stored.requirements.includes(value)) ||
          preferences.length !== stored.preferences.length || !preferences.every(value => stored.preferences.includes(value))) {
          problems.push('Stored requirements or preferences differ from the labelled request');
        }
      }
    }
  }
  return {
    problems,
    actual: {
      products: actualProducts, status: view.status, budget: cart.budget, store: view.basket?.storeName,
      totalIls: view.basket?.totalPriceIls, toolErrors: observedToolErrors, outcome: final.status,
      offerIds: view.basket?.lines.flatMap(line => line.products.map(product => product.productId))
    }
  };
}

export async function runScenarios(): Promise<EvaluationSection> {
  guarded();
  assert.ok(scenarios.length >= 300, 'At least 300 authored customer scenarios required');
  assert.equal(new Set(scenarios.map(row => row.id)).size, scenarios.length);
  const cases = [];
  for (const scenario of scenarios) {
    cases.push(await evaluateCase({
      id: scenario.id, title: scenario.turns[0]!.message, category: scenario.category, component: 'shopping agent and cart',
      request: scenario.turns.map(turn => turn.message).join('\n'), expected: scenario.expected
    }, async () => {
      if (scenario.turns[0]?.message === '' && scenario.expected.intent === 'rejection') {
        await assert.rejects(executeScenario(scenario), { code: 'VALIDATION_ERROR' });
        return { actual: 'Empty user request rejected before model or cart work' };
      }
      const result = await executeScenario(scenario);
      const { problems, actual } = validateScenario(scenario, result);
      return {
        status: problems.length ? 'fail' : 'pass', actual,
        logs: problems.length ? [...problems, ...result.observedToolErrors, result.final.message.content,
          ...result.traces.filter(entry => /tool\.|pipeline\.|agent\.model\.turn/u.test(entry.step)).slice(-12)
            .map(entry => entry.step + ' ' + JSON.stringify(entry.details))] : undefined,
        metrics: { ...result.metrics, split: scenario.split, language: scenario.language, modelUnderstandingRequiresLive: true }
      };
    }));
  }
  return {
    name: 'Customer scenarios', mode: 'MOCK', cases,
    metrics: { development: scenarios.filter(row => row.split === 'development').length,
      heldOut: scenarios.filter(row => row.split === 'held-out').length, modelUnderstandingRequiresLive: scenarios.length },
    notes: [
      'Production agent, tools, cart operations, matcher validation, price calculation and basket verification run against controlled catalog offers and scripted AI.',
      'The adapter executes repository filters in memory. This section measures backend behavior, not MongoDB query plans or unseen language understanding.',
      'The dataset records acceptable recipe ingredients while the offline reply supplies one representative plan. Judging new Gemini-generated plans requires live or complete real recordings.'
    ]
  };
}

/** Quantities for the benchmark run through the production cart pipeline. */
export function benchmarkScenario(count: number, id: string, amount: Quantity = unspecified): Scenario {
  const keys = ['milk', 'bread', 'eggs', 'tomatoes', 'coffee', 'chicken', 'rice', 'olive oil', 'yogurt', 'cucumber',
    'mozzarella', 'flour', 'yeast', 'tomato sauce', 'pasta', 'butter', 'onions', 'garlic', 'pepper', 'sugar'].slice(0, count);
  const items = keys.map(key => item(key, 'en', amount));
  return {
    id, language: 'en', category: 'benchmark', split: 'development',
    turns: [{ message: 'Please add ' + items.map(entry => entry.sourceText).join(', ') + '.', actions: [{ kind: 'add', items }] }],
    expected: { intent: 'shopping', products: keys, operations: ['add_items'], basket: 'COMPLETE', cache: 'cold-within-scenario' }
  };
}
