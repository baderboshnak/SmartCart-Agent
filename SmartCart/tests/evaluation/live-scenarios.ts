import { toModelTurn } from '@/lib/agent/gemini';
import { toFunctionDeclarations, type ToolExecutionContext } from '@/lib/agent/loop';
import { buildSystemInstruction } from '@/lib/agent/prompts';
import { ClarificationArgsSchema, UpdateCartArgsSchema } from '@/lib/agent/schemas';
import { createShoppingTools } from '@/lib/agent/tools';
import { getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { findStores } from '@/lib/db/stores.repository';
import { errorMessage } from '@/lib/shared/errors';
import { CartPipeline } from '@/lib/shopping/pipeline';
import { MATCH_DECLARATION, buildMatchPrompt, collectValidMatchDecisions } from '@engine/smartcart-matcher.mjs';
import { SEMANTIC_CASES, caseItem, caseProducts } from '../fixtures/semantic-match-cases';
import { fixtureDb } from './fixture-db';
import { liveAgentScenarios, type LiveAgentScenario } from './live-agent-cases';
import type { createLiveBudget } from './live-budget.mjs';
import { counts, saveReport } from './report';
import { fixtureCatalog } from './scenario-data';
import { evaluateCase, type EvaluationCase } from './types';

type Budget = ReturnType<typeof createLiveBudget>;

async function agentCase(scenario: LiveAgentScenario, budget: Budget, model: string): Promise<Partial<EvaluationCase>> {
  const { db } = fixtureDb(fixtureCatalog());
  const sessionId = 'live-fixture-' + scenario.id;
  const empty = await getOrCreateCart(db, sessionId);
  const cart = scenario.seedItems?.length
    ? await saveCart(db, sessionId, empty.revision, mutableFields({ ...empty, items: scenario.seedItems, itemsVersion: 1 }))
    : empty;
  const signal = new AbortController().signal;
  const pipeline = new CartPipeline({ db, matcher: { callModel: null, model }, signal });
  const tools = createShoppingTools({
    db, sessionId, pipeline, userMessage: { id: 'synthetic-user-message', text: scenario.request },
    coveredQuotes: [], setProgressTarget() {}, onCartSaved() {}
  });
  const instruction = buildSystemInstruction({ cart, stores: await findStores(db),
    today: new Date().toISOString().slice(0, 10), pendingClarification: null, language: scenario.language });
  const response = await budget.generateContent({
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: scenario.request }] }],
    tools: [{ functionDeclarations: toFunctionDeclarations(tools) }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.2 }
  });
  const turn = toModelTurn(response);
  const issues: string[] = [];
  const operations: string[] = [];
  const context: ToolExecutionContext = { callId: 'synthetic-tool-call', signal, progress() {} };
  let clarification: { question: string; options: string[] } | undefined;
  const [firstCall, ...additionalCalls] = turn.functionCalls;
  const followsUpdate = scenario.expectedTool === 'updateCart' && additionalCalls.length === 1 && additionalCalls[0]?.name === 'optimizeBasket';
  if (firstCall?.name !== scenario.expectedTool || (additionalCalls.length && !followsUpdate)) {
    issues.push(`Expected ${scenario.expectedTool} first. Received ${turn.functionCalls.map(call => call.name).join(', ') || 'no tool call'}.`);
  }
  for (const call of turn.functionCalls) {
    if (call.name !== scenario.expectedTool) continue;
    const tool = tools.find(entry => entry.name === call.name)!;
    try {
      const schema = call.name === 'updateCart' ? UpdateCartArgsSchema : ClarificationArgsSchema;
      const args = schema.parse(call.args);
      if ('operations' in args) operations.push(...args.operations.map(operation => operation.op));
      const result = await tool.execute(args as never, context);
      clarification = result.clarification;
    } catch (error) {
      issues.push(`${call.name} rejected the reply. ${errorMessage(error)}`);
    }
  }
  const saved = await getOrCreateCart(db, sessionId);
  issues.push(...scenario.validate({ cart: saved, operationNames: operations, clarification }));
  return {
    status: issues.length ? 'fail' : 'pass', logs: issues,
    actual: { functionCalls: turn.functionCalls, text: turn.text, finishReason: turn.finishReason, operations,
      cart: { mode: saved.mode, items: saved.items.map(({ product, quantity, requirements, preferences, searchTerms }) =>
        ({ product, quantity, requirements, preferences, searchTerms })), recipes: saved.recipePlans, budget: saved.budget }, clarification }
  };
}

async function riceCase(budget: Budget): Promise<Partial<EvaluationCase>> {
  const fixture = SEMANTIC_CASES.find(entry => entry.id === 'rice')!;
  const item = caseItem(fixture);
  const products = caseProducts(fixture);
  const reading = { wanted: 'Rice grains for cooking, in usual varieties', notWanted: ['products merely made from rice', 'rice-based drinks'] };
  const reply = await budget.callModel({ prompt: buildMatchPrompt(item, products, '', reading), declaration: MATCH_DECLARATION });
  const verified = collectValidMatchDecisions(reply, products, item.preferences ?? [], item.requirements ?? [], item);
  const raw = Array.isArray(reply?.decisions) ? reply.decisions as Array<{ id?: string; identity?: string }> : [];
  const productsById = new Map(products.map(entry => [entry._id, entry]));
  const unexpectedIds = raw.map(row => row?.id).filter(id => !id || !productsById.has(id));
  const comparisons = products.map((product, index) => {
    const expected = fixture.candidates[index]!.expected === 'MATCH' ? 'MATCH' : 'NO_MATCH';
    const decision = verified.decisions.find(entry => entry.id === product._id);
    return { product: product.name, expected, actual: decision?.status ?? 'MISSING',
      rawIdentity: raw.find(entry => entry?.id === product._id)?.identity, validationError: verified.errors.get(product._id) };
  });
  const issues = comparisons.filter(row => row.expected !== row.actual || row.rawIdentity !== row.expected)
    .map(row => `${row.product} expected ${row.expected}, model declared ${row.rawIdentity ?? 'missing'} and validator returned ${row.actual}.`);
  if (unexpectedIds.length) issues.push('The matcher returned a decision with a missing or unknown offer ID.');
  return { status: issues.length ? 'fail' : 'pass', logs: issues, actual: { reading, comparisons, unexpectedIds, reply } };
}

export async function runLiveCoverage(budget: Budget, model: string): Promise<boolean> {
  const tests = liveAgentScenarios.map(scenario => ({
    id: scenario.id, title: scenario.title, request: scenario.request, expected: scenario.expected,
    category: 'agent first turn', component: 'web agent prompt and shopping tools',
    check: () => agentCase(scenario, budget, model)
  }));
  tests.push({ id: 'LIVE-RICE', title: 'Distinguish cooking rice from related products', request: 'אורז',
    expected: 'Accept basmati and jasmine rice. Reject rice cakes, rice drink, and rice noodles.',
    category: 'product matching', component: 'product matcher and validator', check: () => riceCase(budget) });
  const cases: EvaluationCase[] = [];
  for (const { check, ...test } of tests) {
    const before = budget.stats();
    if (before.stopped) {
      cases.push({ ...test, status: 'skip', actual: before.stopped });
      continue;
    }
    const result = await evaluateCase(test, check);
    const after = budget.stats();
    if (after.stoppedForBudget && after.generationAttempts === before.generationAttempts) result.status = 'skip';
    result.metrics = { apiAttempts: after.attempts - before.attempts,
      generationAttempts: after.generationAttempts - before.generationAttempts,
      inputTokens: after.inputTokens - before.inputTokens, outputTokens: after.outputTokens - before.outputTokens };
    cases.push(result);
    console.log(`${result.id} ${result.status} ${result.title}`);
  }
  const usage = budget.stats();
  const files = await saveReport({ schemaVersion: 1, generatedAt: new Date().toISOString(), runner: 'smartcart-live-coverage',
    externalAiRequests: usage.attempts, sections: [{ name: 'Budgeted live scenarios', mode: 'LIVE', cases,
      metrics: { model, ...usage }, notes: [
        'Each scenario uses one model generation and one token check. The four agent scenarios use the production system prompt and validate and apply the selected tool against an isolated in-memory cart.',
        'The matching scenario checks an independently labelled batch with a fixed interpretation. These scenarios cover first-turn behavior and matching. Full conversation, live audio, catalog access and final basket answers are outside this run.',
        'Only synthetic requests and catalog fixtures are sent. The estimated cost in this report uses the configured budget rates.'
      ] }], recommendations: [] }, 'live-coverage');
  console.log(JSON.stringify({ model, usage, ...counts(cases), files }, null, 2));
  return cases.some(result => result.status !== 'pass');
}
