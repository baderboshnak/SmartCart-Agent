import type { Content, FunctionDeclaration, GenerateContentResponse } from '@google/genai';
import { runShoppingAgent } from '@/lib/agent/agent';
import { toModelTurn } from '@/lib/agent/gemini';
import { toFunctionDeclarations } from '@/lib/agent/loop';
import { buildSystemInstruction } from '@/lib/agent/prompts';
import { createShoppingTools } from '@/lib/agent/tools';
import { getOrCreateCart } from '@/lib/db/carts.repository';
import { findStores } from '@/lib/db/stores.repository';
import { detectLanguage } from '@/lib/i18n/language';
import { errorMessage, ValidationError } from '@/lib/shared/errors';
import type { Cart, CartItem, Quantity } from '@/lib/shared/types';
import { CartPipeline } from '@/lib/shopping/pipeline';
import { fixtureDb } from './fixture-db';
import { fixtureCatalog, food, scenarios, type ExpectedItem, type FixtureAction, type Scenario } from './scenario-data';
import { evaluateCase, type EvaluationCase } from './types';

export interface PreparedFirstTurn {
  id: string;
  title: string;
  request: string;
  category: string;
  expected: unknown;
  body: {
    contents: Content[];
    systemInstruction: { parts: [{ text: string }] };
    tools: { functionDeclarations: FunctionDeclaration[] }[];
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } };
    generationConfig: { temperature: number; maxOutputTokens: number };
  };
  score(response: GenerateContentResponse): Promise<EvaluationCase>;
}

const operationByAction: Partial<Record<FixtureAction['kind'], string>> = {
  add: 'add_items', recipe: 'add_recipe', budget: 'set_budget', quantity: 'set_quantity',
  requirements: 'set_constraints', remove: 'remove_items', cheaper: 'set_mode', clear: 'clear'
};
const productAliases: Record<string, string[]> = {
  חלב: ['חלב'], לחם: ['לחם', 'כיכר'], ביצים: ['ביצה', 'ביצי'], עגבניות: ['עגבני'],
  מלפפון: ['מלפפ'], 'שיבולת שועל': ['שבולת שועל', 'קוואקר', 'קואקר'],
  'רוטב עגבניות': ['רוטב פיצה', 'עגבני', 'פסאטה'], מוצרלה: ['מוצארלה', 'מוצרל'],
  קוטג: ['קוטג׳'], 'קוקה קולה': ['קולה זירו'], דובדבנים: ['דובדבן'],
  עוף: ['חזה עוף', 'פרגיות'], מים: ['מי שתייה', 'מי עדן', 'מים מינרליים']
};

const fold = (value: string) => value.normalize('NFKC').toLowerCase()
  .replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
  .replace(/٪/gu, '%').replace(/[\p{M}\p{Cf}]/gu, '')
  .replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();

const equivalentAmounts: Partial<Record<Quantity['unit'], { unit: Quantity['unit']; factor: number }>> = {
  kg: { unit: 'g', factor: 1_000 }, l: { unit: 'ml', factor: 1_000 }
};

function sameQuantity(left: Quantity, right: Quantity): boolean {
  const canonical = (quantity: Quantity) => {
    const conversion = equivalentAmounts[quantity.unit];
    const factor = conversion?.factor ?? 1;
    return [conversion?.unit ?? quantity.unit, quantity.amount * factor, quantity.maxAmount === undefined ? null : quantity.maxAmount * factor];
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function hasSearchTerm(item: CartItem, target: string): boolean {
  const search = item.searchTerms.map(fold);
  return [target, ...(productAliases[target] ?? [])].map(fold)
    .some(alias => search.some(term => alias && term.includes(alias)));
}

function directItemProblems(item: CartItem, reference: ExpectedItem, request: string): string[] {
  const problems: string[] = [];
  const label = fold(item.product);
  const authored = fold(reference.product);
  const knownFood = food.get(reference.key);
  const names = [authored, ...(knownFood ? [knownFood.he, knownFood.en, knownFood.ar].map(fold) : [])];
  const specialty = /בטעם|מרוכז|s mores|condensed|flavoured|flavored|juice|מיץ|عصير/u.test(authored);
  const exact = names.includes(label);
  const related = label.split(' ').some(word => word.length >= 2 && authored.split(' ').includes(word));
  if (!exact && (specialty || !related)) problems.push(`Expected ${reference.product}, got ${item.product}.`);
  if (!sameQuantity(item.quantity, reference.quantity)) problems.push(`Incorrect quantity for ${reference.product}.`);
  if (!hasSearchTerm(item, reference.coreSearchTerm)) problems.push(`Missing the intended Hebrew retrieval term for ${reference.product}.`);
  const expectedEvidence = (reference.constraintEvidence ?? []).map(entry =>
    [entry.type, entry.kind, fold(entry.sourceText)].join('|')).sort();
  const actualEvidence = item.constraintEvidence.map(entry =>
    [entry.type, entry.kind, fold(entry.value)].join('|')).sort();
  if (JSON.stringify(expectedEvidence) !== JSON.stringify(actualEvidence)) {
    problems.push(`Missing, added or reclassified qualifier for ${reference.product}.`);
  }
  if (!item.sourceText || !request.includes(item.sourceText)) problems.push(`Missing verbatim source wording for ${reference.product}.`);
  return problems;
}

function recipeProblems(cart: Cart, action: Extract<FixtureAction, { kind: 'recipe' }>, scenario: Scenario): string[] {
  const problems: string[] = [];
  const [plan] = cart.recipePlans;
  if (!plan || cart.recipePlans.length !== 1) return ['Expected one recipe plan.'];
  if (action.explicit && (plan.servings !== action.servings || plan.servingsSource !== 'EXPLICIT')) {
    problems.push(`Expected the stated ${action.servings} servings.`);
  }
  if (!action.explicit && plan.servingsSource !== 'ASSUMED') problems.push('The customer supplied no serving count.');
  if (!cart.items.length || cart.items.some(item => item.origin.type !== 'RECIPE' || item.origin.recipePlanId !== plan.id)) {
    problems.push('Required ingredients must be linked to the saved recipe.');
  }
  if (plan.ingredients.filter(ingredient => !ingredient.optional).length !== cart.items.length) {
    problems.push('The cart should contain the required recipe ingredients.');
  }
  if (cart.items.some(item => !item.searchTerms.some(term => /\p{Script=Hebrew}/u.test(term)) ||
    (item.quantity.unit === 'unspecified' ? item.quantity.amount !== 0 : item.quantity.amount <= 0))) {
    problems.push('Recipe lines need grounded Hebrew search terms and valid amounts.');
  }
  // Broad requests such as dinner or weekly groceries permit different menus.
  if (!/dinner|breakfast|ingredients|weekly|groceries|meal|snack/u.test(action.dish)) {
    for (const ingredient of action.ingredients.filter(entry => !entry.optional)) {
      const acceptedKeys = scenario.expected.acceptableAlternatives?.find(group => group.includes(ingredient.key)) ?? [ingredient.key];
      const acceptedTerms = [ingredient.coreSearchTerm, ...acceptedKeys.flatMap(key => {
        const record = food.get(key);
        return record ? [record.he] : [];
      })];
      if (!cart.items.some(item => acceptedTerms.some(term => hasSearchTerm(item, term)))) {
        problems.push(`Recipe lacks the labelled essential ingredient ${ingredient.name} or an accepted alternative.`);
      }
    }
  }
  return problems;
}

function maxOutput(actions: FixtureAction[]): number {
  if (actions.some(action => action.kind === 'recipe')) return 700;
  if (actions.length > 1 ||
    actions.some(action => action.kind === 'add' && (action.items.length > 1 || (action.items[0]?.constraintEvidence?.length ?? 0) > 1))) {
    return 512;
  }
  return 256;
}

function firstActionExpectation(actions: FixtureAction[]) {
  return actions.map(action => {
    switch (action.kind) {
      case 'invalid': return { behavior: 'Respond safely without ungrounded mutation or unknown tool calls' };
      case 'none': return { behavior: 'Reply to the message without tools or cart changes' };
      default: return action;
    }
  });
}

/** Use production declarations and validators on isolated synthetic carts. No catalog or matcher tools execute. */
export async function prepareFirstTurns(): Promise<{ cases: PreparedFirstTurn[]; localCases: EvaluationCase[] }> {
  const { db } = fixtureDb(fixtureCatalog());
  const stores = await findStores(db);
  const cases: PreparedFirstTurn[] = [];
  const localCases: EvaluationCase[] = [];
  for (const scenario of scenarios) {
    const first = scenario.turns[0]!;
    const request = first.message;
    const caseInfo = {
      id: scenario.id, title: request || 'Empty customer request', request, category: scenario.category,
      component: 'Production agent first reply and tool acceptance',
      expected: { actions: firstActionExpectation(first.actions), laterMessagesOutsideScope: scenario.turns.length - 1 }
    };
    const sessionId = 'approved-first-turn-' + scenario.id;
    const signal = new AbortController().signal;
    if (!request.trim()) {
      localCases.push(await evaluateCase({ ...caseInfo, expected: 'Backend rejects empty input before model or cart work.' }, async () => {
        let modelCalls = 0;
        try {
          await runShoppingAgent({ db, sessionId, message: request, signal, emit() {},
            model: { name: 'fixture-guard', async generate() { modelCalls++; throw new Error('Unexpected model call.'); } },
            matcher: { model: 'fixture-guard', callModel: null } });
        } catch (error) {
          if (error instanceof ValidationError && modelCalls === 0) return { actual: 'Validation error before any model call.' };
          throw error;
        }
        throw new Error('Empty request was accepted.');
      }));
      continue;
    }
    const empty = await getOrCreateCart(db, sessionId);
    const tools = createShoppingTools({
      db, sessionId, userMessage: { id: 'approved-synthetic-message', text: request },
      pipeline: new CartPipeline({ db, matcher: { model: 'disabled-for-first-reply', callModel: null }, signal }),
      coveredQuotes: [], setProgressTarget() {}, onCartSaved() {}
    });
    const language = scenario.language === 'mixed' ? detectLanguage(request) ?? 'en' : scenario.language;
    const instruction = buildSystemInstruction({ cart: empty, stores, today: new Date().toISOString().slice(0, 10),
      pendingClarification: null, language });
    cases.push({
      ...caseInfo,
      body: {
        contents: [{ role: 'user', parts: [{ text: request }] }],
        systemInstruction: { parts: [{ text: instruction }] },
        tools: [{ functionDeclarations: toFunctionDeclarations(tools) }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: 0.2, maxOutputTokens: maxOutput(first.actions) }
      },
      score: response => evaluateCase(caseInfo, async () => {
        const turn = toModelTurn(response);
        const problems: string[] = [];
        const operations: string[] = [];
        const acceptedTools: string[] = [];
        const intendedOperations = first.actions.map(action => operationByAction[action.kind]).filter(Boolean);
        const clarify = first.actions.some(action => action.kind === 'clarify');
        const noChange = first.actions.some(action => action.kind === 'none');
        const invalidFixture = first.actions.some(action => action.kind === 'invalid');
        const completed = new Set<string>();
        let clarification: { question: string; options: string[] } | undefined;
        for (const [index, call] of turn.functionCalls.entries()) {
          const tool = tools.find(entry => entry.name === call.name);
          if (!tool) {
            problems.push(`The model called unknown tool ${call.name}.`);
            continue;
          }
          const checked = tool.argsSchema.safeParse(call.args);
          if (!checked.success) {
            problems.push(`${call.name} failed the production schema: ${checked.error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join(', ')}.`);
            continue;
          }
          if (call.name === 'optimizeBasket' && index > 0 && completed.size && intendedOperations.length && !clarify) continue;
          if (!['updateCart', 'requestClarification', 'getCurrentCart'].includes(call.name)) {
            problems.push(`Unexpected first-reply tool: ${call.name}.`);
            continue;
          }
          const proposed = call.name === 'updateCart'
            ? (checked.data as { operations: Array<{ op: string }> }).operations.map(entry => entry.op)
            : [];
          if (proposed.length) {
            operations.push(...proposed);
            if (proposed.some(op => !intendedOperations.includes(op))) problems.push('Proposed an unrequested cart operation.');
          }
          try {
            const result = await tool.execute(checked.data as never, { callId: call.id ?? 'approved-call-' + index, signal, progress() {} });
            acceptedTools.push(call.name);
            proposed.forEach(op => completed.add(op));
            clarification ??= result.clarification;
          } catch (error) {
            problems.push(`${call.name} failed production tool validation: ${errorMessage(error)}`);
          }
        }
        const cart = await getOrCreateCart(db, sessionId);
        if (intendedOperations.length && !completed.size) problems.push('The first reply did not complete an applicable shopping operation.');
        if (operations.length !== new Set(operations).size) problems.push('A cart operation was repeated in the first reply.');
        if (clarify && (turn.functionCalls.length !== 1 || acceptedTools[0] !== 'requestClarification' || !clarification)) {
          problems.push('A vague request should ask one clarification question before cart or catalog work.');
        }
        if (clarification && detectLanguage(clarification.question) !== language) {
          problems.push(`The clarification question should be in ${language}.`);
        }
        if (noChange && (turn.functionCalls.length || !turn.text.trim())) {
          problems.push('Expected a text reply without tool calls.');
        }
        if (invalidFixture && !turn.functionCalls.length && !turn.text.trim()) problems.push('Expected a safe response to the incomplete or invalid request.');
        if ((noChange || clarify || invalidFixture) && cart.revision !== empty.revision) problems.push('A request lacking an authorized change mutated the cart.');
        for (const action of first.actions) {
          const op = operationByAction[action.kind];
          if (!op || !completed.has(op)) continue;
          if (action.kind === 'add') {
            if (cart.items.length !== action.items.length) problems.push('The number of added grocery lines differs from the request.');
            action.items.forEach((item, index) => {
              const saved = cart.items[index];
              if (saved) problems.push(...directItemProblems(saved, item, request));
            });
          }
          if (action.kind === 'recipe') problems.push(...recipeProblems(cart, action, scenario));
          if (action.kind === 'budget' && cart.budget?.amountIls !== action.amount) problems.push('The saved budget differs from the stated maximum.');
          if (action.kind === 'cheaper' && cart.mode !== 'cheapest') problems.push('Expected cheapest basket mode.');
        }
        return {
          status: problems.length ? 'fail' : 'pass',
          logs: problems,
          actual: {
            language, calls: turn.functionCalls, text: turn.text, finishReason: turn.finishReason,
            operations, acceptedTools, clarification,
            firstReplyOnly: true, otherExpectedOperations: intendedOperations.filter(op => op && !completed.has(op)),
            cart: { revision: cart.revision, items: cart.items, recipes: cart.recipePlans, mode: cart.mode, budget: cart.budget }
          }
        };
      })
    });
  }
  return { cases, localCases };
}
