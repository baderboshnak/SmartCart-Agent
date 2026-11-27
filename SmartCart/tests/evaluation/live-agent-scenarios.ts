/**
 * Live end-to-end check of the shopping agent on the labelled mock scenarios. Real Gemini calls
 * spend credits, so they need --allow-live, and every call is held under a cost cap.
 *
 *   npm run test:live:scenarios -- --estimate        the sample and its estimated cost; no calls
 *   npm run test:live:scenarios -- --dry-run         offline check of this runner with the scripted model; no calls
 *   npm run test:live:scenarios -- --allow-live [--small] [--only SC-001,SC-110] [--max-cost-usd 0.35]
 *
 * The real agent and product matcher (GEMINI_MODEL) run through the production backend with an
 * in-memory store and the synthetic two-store fixture catalog, so only synthetic requests and
 * fixture products reach Gemini. Each call is priced from the usage Gemini reports, and a call is
 * refused before it starts when it could take the run past the cap.
 */
import { performance } from 'node:perf_hooks';
import { runShoppingAgent, type RunAgentResult } from '@/lib/agent/agent';
import { createGeminiAgentModel, createGeminiMatcher, type AgentModel } from '@/lib/agent/gemini';
import { getAgentRun } from '@/lib/db/agent-runs.repository';
import { getCart } from '@/lib/db/carts.repository';
import { createSession } from '@/lib/db/sessions.repository';
import { getGeminiConfig, loadEnvFileForScripts, type GeminiConfig } from '@/lib/env';
import { detectLanguage, type Language } from '@/lib/i18n/language';
import type { Cart } from '@/lib/shared/types';
import { toCartView, type CartView } from '@/lib/shopping/cart-view';
import type { CallModel } from '@engine/smartcart-matcher.mjs';
import type { TerminalTrace } from '@/lib/server/terminal-trace';
import { fixtureDb } from './fixture-db';
import { saveReport } from './report';
import { fixtureCatalog, food, scenarios, type FixtureAction, type Scenario } from './scenario-data';
import { controlledMatcher, scriptedTurnModel } from './scenarios';
import type { EvaluationCase } from './types';

/** Every category in Hebrew, English and Arabic, weighted to the failures seen live and in the mock suite. */
const STANDARD = [
  'SC-001', 'SC-009', 'SC-007', 'SC-077', 'SC-078', 'SC-081', 'SC-080', // plain, explicit and dietary products
  'SC-110', 'SC-112', 'SC-111', // several items in one message
  'SC-146', 'SC-151', 'SC-153', // recipes
  'SC-181', 'SC-186', // budgets
  'SC-209', 'SC-329', 'SC-339', 'SC-345', // amounts, and amounts without digits
  'SC-235', 'SC-355', 'SC-349', // conversations
  'SC-253', 'SC-274', 'SC-269', 'SC-283', 'SC-296' // clarification, non-shopping, adversarial, unavailable
];
const SMALL = ['SC-001', 'SC-077', 'SC-110', 'SC-112', 'SC-146', 'SC-186', 'SC-329', 'SC-345', 'SC-235', 'SC-355', 'SC-253', 'SC-274'];

// Gemini 3.5 Flash-Lite list prices in USD per million tokens; thinking is billed as output.
const DEFAULT_RATES = { input: 0.30, output: 2.50 };
// Measured in this app: an agent call sends about 5,300 input tokens and returns about 150, and a
// customer turn takes about 3.3 agent calls. Checking one new item takes about 2 matcher calls.
const AGENT_CALL = { input: 5_300, output: 150 };
const AGENT_CALLS_PER_TURN = 3.3;
const ITEM_CHECK = { calls: 2, input: 2_100, output: 330 };
// A call starts only if this much more would still fit under the cap.
const CALL_RESERVE = { input: 12_000, output: 1_500 };

type Rates = typeof DEFAULT_RATES;
const price = (input: number, output: number, rates: Rates) => (input * rates.input + output * rates.output) / 1_000_000;

class BudgetStop extends Error {}

class Budget {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;
  stopped = false;
  constructor(readonly capUsd: number, readonly rates: Rates) {}
  startCall() {
    if (this.stopped || this.usd + price(CALL_RESERVE.input, CALL_RESERVE.output, this.rates) > this.capUsd) {
      this.stopped = true;
      throw new BudgetStop(`Stopped before a call that could pass the $${this.capUsd.toFixed(2)} cap.`);
    }
    this.calls++;
  }
  record(input: number, output: number) {
    this.inputTokens += input;
    this.outputTokens += output;
    this.usd += price(input, output, this.rates);
  }
  snapshot() {
    return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, usd: this.usd };
  }
}

function liveAgent(config: GeminiConfig, budget: Budget, finishReasons: string[]): AgentModel {
  const base = createGeminiAgentModel(config);
  return {
    name: base.name,
    async generate(request) {
      budget.startCall();
      const turn = await base.generate(request);
      budget.record(turn.usage.promptTokens, turn.usage.outputTokens + turn.usage.thoughtTokens);
      if (turn.finishReason && turn.finishReason !== 'STOP') finishReasons.push(turn.finishReason);
      return turn;
    }
  };
}

function liveMatcher(config: GeminiConfig, budget: Budget): CallModel {
  const call = createGeminiMatcher(config, {
    timeoutMs: 40_000,
    onUsage: usage => budget.record(usage.promptTokens, usage.outputTokens + usage.thoughtTokens)
  });
  return async args => {
    budget.startCall();
    return call(args);
  };
}

const offers = fixtureCatalog();
const codeOf = (key: string) => String(1_100_000 + food.get(key)!.index);
const keyByCode = new Map([...food].map(([key, entry]) => [String(1_100_000 + entry.index), key]));
const keyOf = (productId: string) => keyByCode.get(productId.split(':').at(-1) ?? '') ?? productId;

function labelledProducts(scenario: Scenario): Map<string, string> {
  const products = new Map<string, string>();
  for (const turn of scenario.turns) for (const action of turn.actions) {
    if (action.kind === 'add') for (const entry of action.items) products.set(entry.product, entry.key);
    if (action.kind === 'recipe') for (const entry of action.ingredients) products.set(entry.name, entry.key);
  }
  return products;
}

function itemsToCheck(scenario: Scenario): number {
  const keys = new Set<string>();
  for (const turn of scenario.turns) for (const action of turn.actions) {
    if (action.kind === 'add') for (const entry of action.items) keys.add(entry.key);
    if (action.kind === 'recipe') for (const entry of action.ingredients) if (!entry.optional) keys.add(entry.key);
  }
  return keys.size;
}

function estimate(list: Scenario[], rates: Rates) {
  const rows = list.map(scenario => {
    const turns = scenario.turns.length;
    const items = itemsToCheck(scenario);
    const calls = turns * AGENT_CALLS_PER_TURN + items * ITEM_CHECK.calls;
    const input = turns * AGENT_CALLS_PER_TURN * AGENT_CALL.input + items * ITEM_CHECK.input;
    const output = turns * AGENT_CALLS_PER_TURN * AGENT_CALL.output + items * ITEM_CHECK.output;
    return { id: scenario.id, category: scenario.category, language: scenario.language, turns, items, calls, input, output, usd: price(input, output, rates) };
  });
  const sum = (key: 'calls' | 'input' | 'output' | 'usd') => rows.reduce((total, row) => total + row[key], 0);
  return { rows, calls: Math.round(sum('calls')), input: Math.round(sum('input')), output: Math.round(sum('output')), usd: sum('usd') };
}

interface Run {
  final: RunAgentResult;
  cart: Cart;
  view: CartView;
  turns: Array<{ message: string; outcome: string; reply: string; error?: string }>;
  evidence: ItemEvidence[];
}

/** What one cart item searched for and Gemini's verdicts on the products found. */
interface ItemEvidence {
  item: string;
  searchTerms?: string[];
  candidates?: number;
  matched?: string[];
  unsure?: string[];
  rejected?: string[];
}

/**
 * A debug trace kept in memory: the pipeline's "Search for" and "Product checks for" details,
 * so the report shows why an item found nothing or why one product was chosen over another.
 */
function evidenceTrace(): { trace: TerminalTrace; items: Map<string, ItemEvidence> } {
  const items = new Map<string, ItemEvidence>();
  const entry = (name: string) => {
    if (!items.has(name)) items.set(name, { item: name });
    return items.get(name)!;
  };
  const verdicts = (rows: unknown) => (Array.isArray(rows) ? rows : []).slice(0, 8).map(row => {
    const { product, reason } = row as { product?: unknown; reason?: unknown };
    return `${String(product)}${reason ? ` — ${String(reason).slice(0, 140)}` : ''}`;
  });
  const trace = Object.assign(() => {}, {
    mode: 'on' as const,
    detail(step: string, content: unknown) {
      const search = /^Search for "(.+)": (\d+) candidates/u.exec(step);
      if (search) Object.assign(entry(search[1]!), { searchTerms: (content as { searchTerms?: string[] } | null)?.searchTerms, candidates: Number(search[2]) });
      const checks = /^Product checks for "(.+)":/u.exec(step);
      if (checks) {
        const { matched, uncertain, rejected } = (content ?? {}) as Record<string, unknown>;
        Object.assign(entry(checks[1]!), { matched: verdicts(matched), unsure: verdicts(uncertain), rejected: verdicts(rejected) });
      }
    }
  }) as TerminalTrace;
  return { trace, items };
}

/** One line per item for the console: what it searched and what was accepted or turned down. */
function describeEvidence(evidence: ItemEvidence[]): string[] {
  return evidence.map(entry => [
    `"${entry.item}" searched ${JSON.stringify(entry.searchTerms ?? [])} → ${entry.candidates ?? 0} found`,
    entry.matched?.length ? `matched: ${entry.matched.join('; ')}` : '',
    entry.unsure?.length ? `unsure: ${entry.unsure.join('; ')}` : '',
    entry.rejected?.length ? `rejected: ${entry.rejected.join('; ')}` : ''
  ].filter(Boolean).join(' | '));
}

async function runScenario(scenario: Scenario, live: null | { model: AgentModel; matcher: CallModel; modelName: string }): Promise<Run> {
  const missing = new Set(scenario.excludedKeys?.map(codeOf));
  const storeOnly = new Set(scenario.storeOnlyKeys?.map(codeOf));
  const { db } = fixtureDb(offers.filter(offer =>
    !missing.has(offer.productCode) && (!storeOnly.has(offer.productCode) || offer.storeId === '039')));
  const sessionId = (await createSession(db)).session._id;
  const scripted = controlledMatcher(labelledProducts(scenario));
  const turns: Run['turns'] = [];
  const { trace, items } = evidenceTrace();
  let final: RunAgentResult | undefined;
  for (const turn of scenario.turns) {
    final = await runShoppingAgent({
      db, sessionId, message: turn.message,
      model: live ? live.model : scriptedTurnModel(turn, db, sessionId),
      matcher: live ? { callModel: live.matcher, model: live.modelName } : { ...scripted, model: 'evaluation-fixture-v1' },
      emit: () => {}, signal: new AbortController().signal, trace
    });
    // A failed run shows the customer a generic apology; keep the server's own error for the report.
    const error = final.status === 'failed' ? (await getAgentRun(db, final.runId))?.error ?? undefined : undefined;
    turns.push({ message: turn.message, outcome: final.status, reply: final.message.content, ...(error ? { error } : {}) });
  }
  const cart = (await getCart(db, sessionId))!;
  return { final: final!, cart, view: toCartView(cart), turns, evidence: [...items.values()] };
}

const EMPTY_CART = /cart is empty|העגלה שלך ריקה|سلة المشتريات فارغة/iu;
const ADDED_CLAIM = /(?:^|[^a-z])added\b|הוספתי|أضفت/iu;
const SCRIPT: Record<Language, RegExp> = { he: /[֐-׿]/u, ar: /[؀-ۿ]/u, en: /[A-Za-z]{3}/u };
const QUOTED_PRICE = /₪\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:₪|ש"ח|ש״ח|שקל|شيكل|شيقل|NIS|ILS)/giu;

/** Live scoring: Gemini may name products and choose tools its own way, so the checks use outcomes. */
function score(scenario: Scenario, run: Run): string[] {
  const { cart, view, final, turns } = run;
  const expected = scenario.expected;
  const problems: string[] = [];
  const shopping = expected.intent === 'shopping' || expected.intent === 'recipe';
  // Gemini plans a recipe its own way (a lasagna may get a béchamel), so a live recipe is checked
  // for a real plan and a complete basket, not for the scripted ingredient list.
  const recipe = expected.intent === 'recipe';
  const actions = scenario.turns.flatMap(turn => turn.actions);

  if (expected.intent === 'clarification' && final.status !== 'clarification') problems.push(`Expected a clarification question; the run ended "${final.status}".`);
  if (shopping && final.status === 'clarification') problems.push(`Asked a question instead of shopping: ${final.message.content.slice(0, 120)}`);
  if (!shopping && expected.intent !== 'clarification' && cart.items.length) problems.push(`A ${expected.intent} message changed the cart (${cart.items.length} items).`);
  if (turns.some(turn => turn.outcome === 'limit_reached')) problems.push('The agent ran out of model turns or tool calls.');
  for (const turn of turns) if (turn.error) problems.push(`Server error on "${turn.message.slice(0, 60)}": ${turn.error.slice(0, 300)}`);
  if (recipe && cart.items.length < 2) problems.push(`Expected a recipe plan, found ${cart.items.length} cart items.`);
  if (shopping && !recipe && cart.items.length !== expected.products.length) {
    problems.push(`Expected ${expected.products.length} cart items, found ${cart.items.length}: ${cart.items.map(entry => entry.product).join(', ') || 'none'}.`);
  }
  if (shopping && expected.basket !== 'NOT_CALCULATED' && view.status !== expected.basket) problems.push(`Basket ${view.status}; expected ${expected.basket}.`);
  if (view.basket && !cart.calculation?.verification.passed) problems.push('An unverified basket was shown.');
  if (expected.basket === 'COMPLETE' && view.basket && !recipe) {
    const bought = new Set(view.basket.lines.flatMap(line => line.products.map(product => keyOf(product.productId))));
    expected.products.forEach((key, index) => {
      const options = expected.acceptableAlternatives?.[index] ?? [key];
      if (!options.some(option => bought.has(option))) problems.push(`The basket does not buy ${options.join(' or ')} (it buys ${[...bought].join(', ')}).`);
    });
  }
  if (expected.budget !== undefined && cart.budget?.amountIls !== expected.budget) problems.push(`Budget ${cart.budget?.amountIls ?? 'none'}; expected ₪${expected.budget}.`);
  if (expected.budget !== undefined && view.basket && view.basket.totalPriceIls > expected.budget) problems.push('The basket exceeds the budget.');
  if (expected.servings !== undefined && cart.recipePlans[0]?.servings !== expected.servings) {
    problems.push(`Recipe for ${cart.recipePlans[0]?.servings ?? 'no'} servings; expected ${expected.servings}.`);
  }
  // Gemini names lines its own way, so requirements are checked across the cart.
  const savedRequirements = cart.items.flatMap(entry => entry.requirements.map(value => value.toLowerCase()));
  for (const requirements of Object.values(expected.retainedRequirements ?? {})) {
    for (const value of requirements) if (!savedRequirements.includes(value.toLowerCase())) problems.push(`The requirement "${value}" was lost.`);
  }
  if (actions.some((action: FixtureAction) => action.kind === 'cheaper') && cart.mode !== 'cheapest') problems.push('The cheaper request did not switch to the cheapest mode.');

  turns.forEach((turn, index) => {
    const language = detectLanguage(turn.message);
    if (!turn.reply.trim()) problems.push(`Turn ${index + 1}: empty reply.`);
    else if (language && !SCRIPT[language].test(turn.reply)) problems.push(`Turn ${index + 1}: the reply is not in ${language}: ${turn.reply.slice(0, 100)}`);
  });
  const reply = final.message.content;
  if (cart.items.length && EMPTY_CART.test(reply)) problems.push('The reply says the cart is empty, but it has items.');
  if (shopping && !cart.items.length && ADDED_CLAIM.test(reply)) problems.push('The reply claims items were added, but the cart is empty.');

  // Every price in the reply must come from the verified cart, its store comparison or the customer's words.
  const known = new Set<number>();
  const collect = (value: unknown) => {
    if (typeof value === 'number') known.add(Math.round(value * 100));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(view);
  for (const turn of scenario.turns) for (const match of turn.message.matchAll(/\d+(?:[.,]\d+)?/gu)) known.add(Math.round(Number(match[0].replace(',', '.')) * 100));
  const unknown = [...reply.matchAll(QUOTED_PRICE)].map(match => Number((match[1] ?? match[2])!.replace(',', '.')))
    .filter(amount => !known.has(Math.round(amount * 100)));
  if (unknown.length) problems.push(`The reply quotes prices that are not in the verified cart: ₪${unknown.join(', ₪')}.`);
  return problems;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--allow-live');
  const dryRun = args.includes('--dry-run');
  const small = args.includes('--small');
  const ids = option(args, 'only')?.split(',').map(id => id.trim()).filter(Boolean) ?? (small ? SMALL : STANDARD);
  const list = ids.map(id => {
    const found = scenarios.find(entry => entry.id === id);
    if (!found) throw new Error(`Unknown scenario ${id}.`);
    return found;
  });
  const rates: Rates = {
    input: Number(option(args, 'input-usd-per-million') ?? DEFAULT_RATES.input),
    output: Number(option(args, 'output-usd-per-million') ?? DEFAULT_RATES.output)
  };
  const capUsd = Number(option(args, 'max-cost-usd') ?? (small ? 0.15 : 0.35));
  if (![rates.input, rates.output, capUsd].every(value => Number.isFinite(value) && value > 0)) throw new Error('Rates and the cap must be positive numbers.');

  const plan = estimate(list, rates);
  console.log(`${list.length} scenarios, ${list.reduce((total, entry) => total + entry.turns.length, 0)} customer turns.`);
  for (const row of plan.rows) {
    console.log(`  ${row.id} ${row.category.padEnd(14)} ${row.language.padEnd(5)} ${row.turns} turn(s), ${row.items} item(s)  ≈ $${row.usd.toFixed(4)}`);
  }
  console.log(`Estimated: about ${plan.calls} Gemini calls, ${plan.input.toLocaleString('en-US')} input and ${plan.output.toLocaleString('en-US')} output tokens, $${plan.usd.toFixed(3)}. Cap: $${capUsd.toFixed(2)}.`);
  console.log(`Rates: $${rates.input}/M input, $${rates.output}/M output. Gemini may cache the repeated instructions, which only lowers the cost.`);
  if (args.includes('--estimate')) return;
  if (live === dryRun) {
    console.error('Choose --dry-run (offline, no calls) or --allow-live (real Gemini calls that spend credits).');
    process.exitCode = 2;
    return;
  }
  if (live && plan.usd > capUsd) {
    console.error(`The estimate is above the $${capUsd.toFixed(2)} cap. Raise --max-cost-usd or use --small.`);
    process.exitCode = 2;
    return;
  }

  let config: GeminiConfig | null = null;
  if (live) {
    loadEnvFileForScripts();
    config = getGeminiConfig();
  }
  const budget = new Budget(capUsd, rates);
  const cases: EvaluationCase[] = [];
  for (const scenario of list) {
    const details = {
      id: scenario.id, title: scenario.turns[0]!.message, category: scenario.category,
      request: scenario.turns.map(turn => turn.message).join('\n'), expected: scenario.expected,
      component: live ? `live ${config!.model} agent and matcher` : 'scripted agent and matcher'
    };
    if (budget.stopped) {
      cases.push({ ...details, status: 'skip', actual: 'Not run: the cost cap was reached.' });
      continue;
    }
    const before = budget.snapshot();
    const finishReasons: string[] = [];
    const started = performance.now();
    try {
      const run = await runScenario(scenario, live ? {
        model: liveAgent(config!, budget, finishReasons), matcher: liveMatcher(config!, budget), modelName: config!.model
      } : null);
      const problems = score(scenario, run);
      const after = budget.snapshot();
      cases.push({
        ...details, status: problems.length ? 'fail' : 'pass', durationMs: performance.now() - started,
        actual: {
          outcome: run.final.status, items: run.cart.items.map(entry => ({ product: entry.product, quantity: entry.quantity, requirements: entry.requirements })),
          basket: run.view.status, store: run.view.basket?.storeName, totalIls: run.view.basket?.totalPriceIls,
          bought: run.view.basket?.lines.flatMap(line => line.products.map(product => `${product.name} (${keyOf(product.productId)})`)),
          replies: run.turns.map(turn => turn.reply),
          evidence: run.evidence
        },
        logs: problems.length ? [...problems, ...describeEvidence(run.evidence)] : undefined,
        metrics: {
          language: scenario.language, geminiCalls: after.calls - before.calls,
          inputTokens: after.inputTokens - before.inputTokens, outputTokens: after.outputTokens - before.outputTokens,
          usd: Number((after.usd - before.usd).toFixed(5)), ...(finishReasons.length ? { unusualFinish: finishReasons } : {})
        }
      });
    } catch (error) {
      const stopped = error instanceof BudgetStop || budget.stopped;
      cases.push({ ...details, status: stopped ? 'skip' : 'fail', durationMs: performance.now() - started,
        actual: stopped ? 'Stopped at the cost cap.' : String(error), logs: [String(error)] });
    }
    const last = cases.at(-1)!;
    console.log(`${last.status.toUpperCase().padEnd(5)} ${scenario.id} ${String(details.title).slice(0, 60)}${last.logs ? `\n      ${last.logs.join('\n      ').slice(0, 2500)}` : ''}`);
  }

  const passed = cases.filter(entry => entry.status === 'pass').length;
  const failed = cases.filter(entry => entry.status === 'fail').length;
  const files = await saveReport({
    schemaVersion: 1, generatedAt: new Date().toISOString(), runner: live ? 'smartcart-live-agent-scenarios' : 'smartcart-live-agent-scenarios-dry-run',
    externalAiRequests: budget.calls,
    sections: [{
      name: live ? 'Live agent on labelled scenarios' : 'Live scoring with the scripted model (dry run)', mode: live ? 'LIVE' : 'MOCK', cases,
      metrics: { model: config?.model ?? 'scripted', capUsd, estimateUsd: Number(plan.usd.toFixed(4)), ...budget.snapshot(), usd: Number(budget.usd.toFixed(4)) },
      notes: [
        'Only synthetic requests and fixture catalog products reach Gemini. Each scenario uses a fresh in-memory store.',
        'Live scoring checks outcomes (cart lines, the fixture products bought, basket status, budget, servings, kept requirements), the reply language, empty-cart and added claims, and that every quoted price is in the verified cart.',
        `Cost uses $${rates.input} per million input and $${rates.output} per million output tokens from the usage Gemini reported.`
      ]
    }],
    recommendations: []
  }, live ? 'live-agent-scenarios' : 'live-agent-scenarios-dry-run');
  console.log(`\n${passed} passed, ${failed} failed, ${cases.length - passed - failed} skipped. ${budget.calls} Gemini calls, ` +
    `${budget.inputTokens.toLocaleString('en-US')} input and ${budget.outputTokens.toLocaleString('en-US')} output tokens, $${budget.usd.toFixed(4)}.`);
  console.log(files.html);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
