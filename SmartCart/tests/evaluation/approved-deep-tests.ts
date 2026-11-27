import type { GenerateContentResponse } from '@google/genai';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { READING_DECLARATION, type CallModel } from '@engine/smartcart-matcher.mjs';
import { runShoppingAgent } from '@/lib/agent/agent';
import { toModelTurn, type AgentModel, type ModelTurn } from '@/lib/agent/gemini';
import { getAgentRun } from '@/lib/db/agent-runs.repository';
import { getCart } from '@/lib/db/carts.repository';
import { createSession } from '@/lib/db/sessions.repository';
import type { TerminalTrace } from '@/lib/server/terminal-trace';
import { errorMessage, redactSecrets } from '@/lib/shared/errors';
import type { AgentToolSummary, Cart, CartItem, Quantity } from '@/lib/shared/types';
import { toCartView, type CartView } from '@/lib/shopping/cart-view';
import { fixtureDb } from './fixture-db';
import { evaluateCase, type EvaluationSection } from './types';

interface DeepOptions {
  generateContent(body: unknown): Promise<unknown>;
  callModel: CallModel;
  model: string;
  canContinue(): boolean;
}

interface ObservedTurn {
  request: string;
  outcome: Awaited<ReturnType<typeof runShoppingAgent>>['status'];
  reply: string;
  messageKind: string;
  cart: Cart | null;
  view: CartView | null;
  toolCalls: AgentToolSummary[];
  error: string | null;
  durationMs: number;
}

type GenerationKind = 'agent' | 'intent-reading' | 'matcher';
interface Generation {
  kind: GenerationKind;
  turn: number;
  durationMs?: number;
  toolMode?: 'AUTO' | 'NONE';
  historyEntries?: number;
  finishReason?: string;
  finishMessage?: string;
  promptBlockReason?: string;
  visibleText?: string;
  functionCalls?: ModelTurn['functionCalls'];
  usage?: ModelTurn['usage'];
  result?: unknown;
  error?: string;
}

interface DeepCase {
  id: string;
  title: string;
  category: string;
  requests: string[];
  catalog: CatalogRecord[];
  maxGenerations: number;
  expected: string;
  validate(turns: ObservedTurn[]): string[];
}

const primaryStore = 'rami_levy:1:1:039';
const otherStore = 'shufersal:1:1:413';
const STORE_NAMES = /ram[iy]\s+lev[iy]|רמי\s+לוי/iu;
const MILK = /חלב|milk|حليب/iu;
const EGGS = /ביצ(?:ים|ה)|eggs?|بيض/iu;
const BREAD = /לחם|bread|خبز/iu;
const TUNA = /טונה|tuna|تونة/iu;
const RICE = /אורז|rice|(?:أ?رز)/iu;
const CHICKPEAS = /חומוס|chickpeas?|حمص/iu;
const EMPTY_CART = /(?:your\s+)?cart\s+is\s+empty|עגלה.{0,12}ריקה|سل[ةه].{0,22}فارغ/iu;

function offer(storeKey: string, productCode: string, name: string, price: number, amount: number, unit: string): CatalogRecord {
  const [retailer, chainId, subChainId, storeId] = storeKey.split(':');
  return {
    _id: storeKey + ':' + productCode,
    retailer: retailer!,
    chainId: chainId!,
    subChainId: subChainId!,
    storeId: storeId!,
    productCode,
    name,
    ...(/תנובה/u.test(name) ? { manufacturer: { name: 'תנובה' } } : {}),
    package: { quantity: amount, unit, isWeighted: false },
    pricing: { listedPriceIls: price }
  };
}

const eggs = offer(primaryStore, '8100001', 'ביצים קרטון 12 יחידות', 14.5, 12, 'units');
const milk = offer(primaryStore, '8100002', 'חלב בקבוק 1 ליטר', 6.9, 1, 'l');
const tnuvaMilk = offer(primaryStore, '8100003', 'חלב תנובה 3% בקבוק 1 ליטר', 7.25, 1, 'l');
const lowerFatMilk = offer(primaryStore, '8100004', 'חלב תנובה 1% בקבוק 1 ליטר', 5.65, 1, 'l');
const flavouredMilk = offer(primaryStore, '8100005', 'משקה חלב בטעם שוקולד בקבוק 350 מ״ל', 3.9, 350, 'ml');
const tunaWater = offer(primaryStore, '8100006', 'טונה במים פחית 160 גרם', 6, 160, 'g');
const tunaOil = offer(primaryStore, '8100007', 'טונה בשמן פחית 160 גרם', 4.8, 160, 'g');
const basmatiRice = offer(primaryStore, '8100008', 'אורז בסמטי 500 גרם', 7, 500, 'g');
const roundRice = offer(primaryStore, '8100009', 'אורז עגול 500 גרם', 5, 500, 'g');
const mozzarella = offer(primaryStore, '8100010', 'גבינת מוצרלה 250 גרם', 10, 250, 'g');
const sauce = offer(primaryStore, '8100011', 'רוטב עגבניות לפיצה 400 גרם', 6, 400, 'g');
const frozenPizza = offer(primaryStore, '8100012', 'פיצה קפואה 450 גרם', 20, 450, 'g');
const bread = offer(primaryStore, '8100013', 'לחם כיכר 750 גרם', 8.2, 750, 'g');
const otherMilk = offer(otherStore, '8100002', 'חלב בקבוק 1 ליטר', 7.9, 1, 'l');
const unsaltedChickpeas = offer(primaryStore, '8100014', 'גרגירי חומוס ללא מלח פחית 400 גרם حمص حب بدون ملح', 6.4, 400, 'g');
const saltedChickpeas = offer(primaryStore, '8100015', 'גרגירי חומוס עם מלח פחית 400 גרם', 5, 400, 'g');
const preparedHummus = offer(primaryStore, '8100016', 'ממרח חומוס ללא מלח 400 גרם', 4, 400, 'g');

function findItem(turn: ObservedTurn | undefined, identity: RegExp): CartItem | undefined {
  return turn?.cart?.items.find(item => identity.test([item.product, ...item.searchTerms].join(' ')));
}

function exactQuantity(item: CartItem | undefined, amount: number, unit: Quantity['unit']): boolean {
  return item?.quantity.amount === amount && item.quantity.unit === unit && item.quantity.maxAmount === undefined;
}

function hasOffer(turn: ObservedTurn | undefined, product: CatalogRecord, count?: number): boolean {
  return turn?.view?.basket?.lines.some(line => line.products.some(offer =>
    offer.productId === product._id && (count === undefined || offer.packageCount === count))) ?? false;
}

function hasCompleteBasket(turn: ObservedTurn | undefined, lineCount: number): boolean {
  const view = turn?.view;
  return Boolean(view?.verification?.passed && view.status === 'COMPLETE' &&
    view.basket?.storeKey === primaryStore && view.basket.lines.length === lineCount);
}

function checkCompleteBasket(turn: ObservedTurn | undefined, lineCount: number, issues: string[]) {
  if (!hasCompleteBasket(turn, lineCount)) {
    issues.push(`Expected one independently verified basket at Rami Levy with ${lineCount} distinct line(s).`);
  }
}

function noCompleteBasket(turn: ObservedTurn | undefined): boolean {
  return turn?.view?.status === 'NO_COMPLETE_BASKET' && turn.view.verification?.passed === true && turn.view.basket === null;
}

function amountMentioned(text: string, amount: number): boolean {
  const price = amount.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
  const [whole, fraction] = price.split('.');
  const decimal = fraction ? `[.,]${fraction}${fraction.length === 1 ? '0?' : ''}` : '(?:[.,]00)?';
  return new RegExp(`(?<![\\d.,])${whole}${decimal}(?!\\d|[.,]\\d)`, 'u').test(text);
}

const brandedBudgetRequest = 'Add 2 bottles of Tnuva 3% milk. My budget is ₪15. Tell me the store, package size, unit price, and total.';
const deepCases: DeepCase[] = [
  {
    id: 'DEEP-HE-EGGS-MILK',
    title: 'Hebrew request for two egg cartons and two milk bottles',
    category: 'reported Hebrew regression',
    requests: ['אני רוצה 2 חבילות של ביצים ו-2 בקבוקים של חלב'],
    catalog: [eggs, milk, flavouredMilk],
    maxGenerations: 8,
    expected: 'Two direct cart lines, two 12-egg cartons and two 1 L milk bottles, plain milk only, ₪42.80, and an intelligible reply in Hebrew.',
    validate([turn]) {
      const issues: string[] = [];
      const eggItem = findItem(turn, EGGS);
      const milkItem = findItem(turn, MILK);
      if (turn?.cart?.items.length !== 2 || !eggItem || !milkItem || eggItem.id === milkItem.id) {
        issues.push('Expected separate egg and milk cart lines.');
      }
      if (!exactQuantity(milkItem, 2, 'bottle')) issues.push('Expected the milk request to preserve the count of two bottles.');
      checkCompleteBasket(turn, 2, issues);
      if (!hasOffer(turn, eggs, 2)) issues.push('Expected two 12-egg cartons. A count of two individual eggs is a different quantity.');
      if (!hasOffer(turn, milk, 2)) issues.push('Expected two plain 1 L milk bottles.');
      if (turn?.view?.basket?.totalPriceIls !== 42.8) issues.push('The fixture basket should total ₪42.80.');
      const reply = turn?.reply ?? '';
      if (!/\p{Script=Hebrew}/u.test(reply) || !EGGS.test(reply) || !MILK.test(reply)) {
        issues.push('The final Hebrew response should address both eggs and milk.');
      }
      return issues;
    }
  },
  {
    id: 'DEEP-AR-TUNA-RICE',
    title: 'Arabic-Indic quantities with two distinct qualifiers',
    category: 'reported Arabic regression',
    requests: ['بدي ٢ علبة تونة بالماء و ٥٠٠ غرام رز بسمتي'],
    catalog: [tunaWater, tunaOil, basmatiRice, roundRice],
    maxGenerations: 9,
    expected: 'Two cans of tuna in water, exactly 500 g of basmati rice, a verified ₪19 basket, and both products addressed in Arabic.',
    validate([turn]) {
      const issues: string[] = [];
      const tuna = findItem(turn, TUNA);
      const rice = findItem(turn, RICE);
      if (turn?.cart?.items.length !== 2 || !exactQuantity(tuna, 2, 'can')) issues.push('Expected exactly two distinct items with two tuna cans.');
      if (!(exactQuantity(rice, 500, 'g') || exactQuantity(rice, 0.5, 'kg'))) issues.push('The rice amount should remain 500 grams.');
      if (!tuna?.requirements.includes('بالماء')) issues.push('Water-packing must remain a mandatory tuna qualifier.');
      if (!rice || ![rice.product, ...rice.requirements].some(value => value.includes('بسمتي'))) issues.push('The rice must stay basmati.');
      checkCompleteBasket(turn, 2, issues);
      if (!hasOffer(turn, tunaWater, 2) || !hasOffer(turn, basmatiRice, 1) || turn?.view?.basket?.totalPriceIls !== 19) {
        issues.push('Expected the verified basket to contain two tuna-in-water cans and one 500 g basmati pack for ₪19.');
      }
      const reply = turn?.reply ?? '';
      if (!/\p{Script=Arabic}/u.test(reply) || !/تونة/iu.test(reply) || !/أ?رز/iu.test(reply)) {
        issues.push('The final Arabic reply should address both tuna and rice.');
      }
      return issues;
    }
  },
  {
    id: 'DEEP-HE-PIZZA-PANTRY',
    title: 'Pizza for four with only the two missing ingredients',
    category: 'recipe and pantry',
    requests: ['אני רוצה להכין פיצה ל-4 אנשים. יש לי כבר את כל המרכיבים חוץ מרוטב עגבניות ומוצרלה. תוסיף לעגלה רק את שני המרכיבים החסרים.'],
    catalog: [mozzarella, sauce, frozenPizza],
    maxGenerations: 9,
    expected: 'One explicit four-serving pizza plan, exactly two shopping lines linked to the plan, confirmed sauce and mozzarella in one store.',
    validate([turn]) {
      const issues: string[] = [];
      const plans = turn?.cart?.recipePlans ?? [];
      const [plan] = plans;
      if (plans.length !== 1 || !plan || !/pizza|פיצה/iu.test(plan.dish) || plan.servings !== 4 || plan.servingsSource !== 'EXPLICIT') {
        issues.push('Expected one explicitly four-serving pizza plan.');
      }
      const items = turn?.cart?.items ?? [];
      if (items.length !== 2 || items.some(item => item.origin.type !== 'RECIPE' || item.origin.recipePlanId !== plan?.id)) {
        issues.push('Only the two missing ingredients should be stored as recipe items.');
      }
      const required = plan?.ingredients.filter(ingredient => !ingredient.optional) ?? [];
      if (required.length !== 2 || required.some(ingredient => !items.some(item => item.id === ingredient.itemId))) {
        issues.push('The plan must link both required ingredients to the saved cart lines.');
      }
      checkCompleteBasket(turn, 2, issues);
      if (!hasOffer(turn, mozzarella) || !hasOffer(turn, sauce)) issues.push('Expected confirmed mozzarella and tomato sauce.');
      return issues;
    }
  },
  {
    id: 'DEEP-EN-BRAND-PRICE',
    title: 'Verified brand, fat percentage, budget and final price claims',
    category: 'requirements, budget and final answer',
    requests: [brandedBudgetRequest],
    catalog: [tnuvaMilk, milk, lowerFatMilk],
    maxGenerations: 7,
    expected: 'Two Tnuva 3% milk bottles, a ₪15 inclusive budget, and a verified Rami Levy basket showing 1 L and ₪7.25 per bottle, ₪14.50 total.',
    validate([turn]) {
      const issues: string[] = [];
      const item = findItem(turn, MILK);
      if (turn?.cart?.items.length !== 1 || !exactQuantity(item, 2, 'bottle')) issues.push('Expected one milk line for two bottles.');
      if (!item?.constraintEvidence.some(entry => entry.type === 'REQUIREMENT' && entry.kind === 'BRAND' && /tnuva/iu.test(entry.value)) ||
          !item.requirements.includes('3%')) issues.push('Tnuva and 3% should both be mandatory.');
      if (turn?.cart?.budget?.amountIls !== 15 || turn.cart.budget.exclusive) issues.push('Expected the saved inclusive ₪15 budget.');
      checkCompleteBasket(turn, 1, issues);
      const selected = turn?.view?.basket?.lines[0]?.products[0];
      if (!hasOffer(turn, tnuvaMilk, 2) || selected?.unitPriceIls !== 7.25 || turn?.view?.basket?.totalPriceIls !== 14.5) {
        issues.push('Expected the specific 3% offer for two bottles at ₪7.25 each and ₪14.50 total.');
      }
      const reply = turn?.reply ?? '';
      if (!STORE_NAMES.test(reply)) issues.push('The final reply should name the verified store.');
      if (!/tnuva|תנובה/iu.test(reply) || !/3\s*%/u.test(reply)) issues.push('The final reply should name the correct brand and fat percentage.');
      if (!/\b(?:1\s*(?:l|lit(?:er|re)s?)|1000\s*ml)\b/iu.test(reply)) issues.push('The final reply should state the verified 1 L bottle size.');
      if (!amountMentioned(reply, 7.25) || !amountMentioned(reply, 14.5)) issues.push('The final reply should give the verified unit price and total.');
      if (/shufersal|שופרסל/iu.test(reply)) issues.push('The final reply mentioned a store outside this fixture.');
      return issues;
    }
  },
  {
    id: 'DEEP-EN-FOLLOWUP-REMOVE',
    title: 'Follow-up removes milk and retains the original bread line',
    category: 'conversation and cache reuse',
    requests: ['Add one loaf of bread and one bottle of milk.', 'Remove the milk. Keep the bread.'],
    catalog: [bread, milk],
    maxGenerations: 12,
    expected: 'First turn saves and verifies both items. Follow-up removes only milk, preserves the bread line ID and quantity, and reuses the bread match.',
    validate([initial, final]) {
      const issues: string[] = [];
      const initialBread = findItem(initial, BREAD);
      const finalBread = findItem(final, BREAD);
      checkCompleteBasket(initial, 2, issues);
      if (!hasOffer(initial, bread, 1) || !hasOffer(initial, milk, 1)) issues.push('Both first-turn items should be in the checked basket.');
      if (!initialBread || !finalBread || finalBread.id !== initialBread.id || !exactQuantity(finalBread, 1, 'loaf') ||
          JSON.stringify(finalBread.quantity) !== JSON.stringify(initialBread.quantity)) {
        issues.push('The follow-up should preserve the existing loaf quantity and item ID.');
      }
      if (final?.cart?.items.length !== 1 || findItem(final, MILK)) issues.push('The follow-up should remove only milk.');
      checkCompleteBasket(final, 1, issues);
      if (!hasOffer(final, bread, 1) || final?.view?.basket?.totalPriceIls !== 8.2) issues.push('Expected only the original bread, at ₪8.20.');
      if (!(final?.view?.diagnostics.some(row => row.itemId === finalBread?.id && row.cachedDecisions > 0))) {
        issues.push('Expected the follow-up calculation to reuse the validated bread decision.');
      }
      return issues;
    }
  },
  {
    id: 'DEEP-EN-SPLIT-STORES',
    title: 'Products in separate stores remain unavailable as one basket',
    category: 'single-store availability',
    requests: ['Add one loaf of bread and one bottle of milk. I only want one store for both items.'],
    catalog: [bread, otherMilk],
    maxGenerations: 7,
    expected: 'Both items saved. Rami Levy has only bread, Shufersal only milk, so no verified complete basket or combined total is shown.',
    validate([turn]) {
      const issues: string[] = [];
      if (turn?.cart?.items.length !== 2 || !findItem(turn, BREAD) || !findItem(turn, MILK)) issues.push('Expected both requested cart lines.');
      if (!noCompleteBasket(turn)) issues.push('A same-store basket must stay unavailable when the offers are split across stores.');
      const stores = turn?.view?.stores ?? [];
      if (!stores.some(store => store.storeKey === primaryStore && store.missingItems.some(item => MILK.test(item.product))) ||
          !stores.some(store => store.storeKey === otherStore && store.missingItems.some(item => BREAD.test(item.product)))) {
        issues.push('The verified store breakdown should identify the missing product at each store.');
      }
      const reply = turn?.reply ?? '';
      if (!/no (?:single|one) store|(?:can.t|cannot|could not|unable to) (?:find|get|provide).{0,50}(?:one|same|single) store|(?:separate|different|two) stores|neither store/iu.test(reply)) {
        issues.push('The final reply should explain that the two products cannot be purchased together at one store.');
      }
      if (amountMentioned(reply, 16.1)) issues.push('The final reply quoted a combined ₪16.10 basket for offers at separate stores.');
      return issues;
    }
  },
  {
    id: 'DEEP-EN-OVER-BUDGET',
    title: 'An impossible budget does not become a complete purchase',
    category: 'budget failure and final answer',
    requests: ['Add 2 bottles of Tnuva 3% milk. My maximum budget is ₪10. Tell me if those exact products fit within the budget.'],
    catalog: [tnuvaMilk, lowerFatMilk],
    maxGenerations: 6,
    expected: 'The ₪10 cap and exact milk requirements remain saved. The ₪14.50 fixture price exceeds the budget and no complete basket is displayed.',
    validate([turn]) {
      const issues: string[] = [];
      const item = findItem(turn, MILK);
      if (!exactQuantity(item, 2, 'bottle') || !item?.requirements.some(value => /tnuva/iu.test(value)) ||
          !item.requirements.includes('3%')) issues.push('The saved cart should retain the exact count, brand and fat percentage.');
      if (turn?.cart?.budget?.amountIls !== 10 || !noCompleteBasket(turn)) {
        issues.push('The ₪10 budget must rule out a verified complete basket for the exact request.');
      }
      if (!turn?.view?.stores.some(store => /budget/iu.test(store.note ?? ''))) issues.push('The store breakdown should attribute the exclusion to the budget.');
      const reply = turn?.reply ?? '';
      if (!/over (?:your |the )?budget|exceed|too (?:low|expensive)|(?:does not|doesn't|cannot|can't|won't|will not) fit|no.{0,55}fit|(?:increase|raise|above).{0,40}budget|budget.{0,30}(?:insufficient|too low)/iu.test(reply)) {
        issues.push('The final reply should tell the customer the exact request exceeds their budget.');
      }
      if (/\b(?:fits|within|under) (?:your|the) budget\b/iu.test(reply) &&
          !/\b(?:no|not|never|cannot|can.t|doesn.t|won.t)\b/iu.test(reply)) {
        issues.push('The final reply claims an unaffordable basket fits the budget.');
      }
      return issues;
    }
  },
  {
    id: 'DEEP-AR-CANNED-CHICKPEAS',
    title: 'Arabic canned chickpeas stay distinct from prepared hummus',
    category: 'Arabic product identity and exclusion',
    requests: ['بدي ١ علبة حمص حب معلب بدون ملح.'],
    catalog: [unsaltedChickpeas, saltedChickpeas, preparedHummus],
    maxGenerations: 7,
    expected: 'One can of whole unsalted chickpeas. The cheaper salted can and prepared hummus both remain ineligible.',
    validate([turn]) {
      const issues: string[] = [];
      const item = findItem(turn, CHICKPEAS);
      if (turn?.cart?.items.length !== 1 || !exactQuantity(item, 1, 'can')) issues.push('Only one can of chickpeas should be saved.');
      if (!item?.requirements.some(value => /بدون\s+ملح/iu.test(value))) issues.push('The saved item should require no salt.');
      checkCompleteBasket(turn, 1, issues);
      if (!hasOffer(turn, unsaltedChickpeas, 1) || turn?.view?.basket?.totalPriceIls !== 6.4) {
        issues.push('The confirmed package must be the unsalted whole canned chickpeas at ₪6.40.');
      }
      if (!/حمص/iu.test(turn?.reply ?? '')) issues.push('The final Arabic reply should address the requested chickpeas.');
      return issues;
    }
  }
];

async function checkDeepCase(scenario: DeepCase, options: DeepOptions) {
  const storage = fixtureDb(scenario.catalog);
  const { db } = storage;
  const sessionId = (await createSession(db)).session._id;
  const turns: ObservedTurn[] = [];
  const generations: Generation[] = [];
  const stages: Array<{ turn: number; step: string; details?: Record<string, unknown> }> = [];
  let queue = Promise.resolve();
  let stoppedForSharedBudget = false;
  let stoppedForCaseLimit = false;

  function invoke<T>(generation: Generation, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
    // Product checks start concurrently in production. The shared budget counts and sends serially.
    const next = queue.then(async () => {
      signal.throwIfAborted();
      if (!options.canContinue()) {
        stoppedForSharedBudget = true;
        throw new Error('Shared live budget stopped before a generation.');
      }
      if (generations.length >= scenario.maxGenerations) {
        stoppedForCaseLimit = true;
        throw new Error('This test case reached its generation limit.');
      }
      generations.push(generation);
      const start = performance.now();
      try {
        return await send();
      } catch (error) {
        generation.error = errorMessage(error);
        if (!options.canContinue()) stoppedForSharedBudget = true;
        throw error;
      } finally {
        generation.durationMs = performance.now() - start;
      }
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  for (const [index, request] of scenario.requests.entries()) {
    if (stoppedForCaseLimit || stoppedForSharedBudget || !options.canContinue()) break;
    const turn = index + 1;
    const controller = new AbortController();
    const trace: TerminalTrace = Object.assign((step: string, details?: Record<string, unknown>) => {
      if (/^(?:pipeline\.(?:search\.completed|match\.(?:reading|retry|completed)|optimize\.completed|verify\.completed)|tool\.rejected|agent\.(?:finalAnswer\.|timing))/u.test(step)) {
        stages.push({ turn, step, details });
      }
    }, { mode: 'off' as const, detail() {} });
    const model: AgentModel = {
      name: options.model,
      generate({ systemInstruction, contents, tools, toolMode, signal }) {
        const generation: Generation = { kind: 'agent', turn, toolMode, historyEntries: contents.length };
        return invoke(generation, signal, async () => {
          const response = await options.generateContent({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents,
            ...(tools.length ? {
              tools: [{ functionDeclarations: tools }],
              toolConfig: { functionCallingConfig: { mode: toolMode } }
            } : {}),
            generationConfig: { temperature: 0.2 }
          }) as GenerateContentResponse;
          const candidate = response.candidates?.[0];
          generation.finishReason = candidate?.finishReason;
          generation.finishMessage = candidate?.finishMessage;
          generation.promptBlockReason = response.promptFeedback?.blockReason;
          const projected = toModelTurn(response);
          generation.visibleText = projected.text;
          generation.functionCalls = projected.functionCalls;
          generation.usage = projected.usage;
          return projected;
        });
      }
    };
    const matcher: CallModel = args => {
      const generation: Generation = { kind: args.declaration.name === READING_DECLARATION.name ? 'intent-reading' : 'matcher', turn };
      return invoke(generation, controller.signal, async () => {
        generation.result = await options.callModel(args);
        return generation.result;
      });
    };
    const start = performance.now();
    try {
      const result = await runShoppingAgent({
        db, sessionId, message: request, model, matcher: { callModel: matcher, model: options.model },
        signal: controller.signal, emit() {}, trace,
        limits: { modelRetries: 0, maxModelTurns: 4, maxToolCalls: 6, maxCallsPerTurn: 4 }
      });
      const [cart, savedRun] = await Promise.all([getCart(db, sessionId), getAgentRun(db, result.runId)]);
      turns.push({
        request, outcome: result.status, reply: result.message.content, messageKind: result.message.kind, cart,
        view: cart ? toCartView(cart) : null,
        toolCalls: savedRun?.toolCalls ?? [],
        error: savedRun?.error ? redactSecrets(savedRun.error) : null,
        durationMs: performance.now() - start
      });
    } finally {
      controller.abort();
      await queue;
    }
  }

  if (turns.length < scenario.requests.length && !stoppedForCaseLimit) stoppedForSharedBudget = true;
  const issues = scenario.validate(turns);
  for (const turn of turns) {
    if (turn.outcome === 'failed' || turn.outcome === 'cancelled') issues.push(turn.error ?? 'The shopping agent did not complete the turn.');
    if (!turn.reply.trim() || EMPTY_CART.test(turn.reply)) issues.push('The customer received an empty reply or an empty-cart claim for a concrete request.');
  }
  if (stoppedForCaseLimit) issues.push('The case exhausted its bounded generation allowance.');
  if (stoppedForSharedBudget) issues.push('The shared budget interrupted this case. The report contains the observed part.');
  return {
    status: stoppedForSharedBudget ? 'requires-live' as const : issues.length ? 'fail' as const : 'pass' as const,
    actual: {
      turns: turns.map(({ request, outcome, reply, messageKind, cart, view, toolCalls, error, durationMs }) => ({
        request, outcome, reply, messageKind, checkedCart: view,
        itemEvidence: cart?.items.map(({ id, searchTerms, constraintEvidence }) => ({ id, searchTerms, constraintEvidence })),
        toolCalls, error, durationMs
      })),
      generations,
      stages
    },
    logs: issues,
    metrics: {
      startedGenerations: generations.length,
      agentGenerations: generations.filter(call => call.kind === 'agent').length,
      matcherGenerations: generations.filter(call => call.kind === 'matcher').length,
      intentReadingGenerations: generations.filter(call => call.kind === 'intent-reading').length,
      toolErrors: turns.reduce((total, turn) => total + turn.toolCalls.filter(call => call.status === 'error').length, 0),
      ...storage.timing
    }
  };
}

export async function runApprovedDeepTests(options: DeepOptions): Promise<EvaluationSection> {
  const cases = [];
  for (const scenario of deepCases) {
    const details = {
      id: scenario.id, title: scenario.title, category: scenario.category, component: 'shopping agent through verified cart and final reply',
      request: scenario.requests.join('\n'), expected: scenario.expected
    };
    if (!options.canContinue()) {
      cases.push({ ...details, status: 'requires-live' as const, logs: ['The shared live budget stopped before this case.'] });
    } else {
      cases.push(await evaluateCase(details, () => checkDeepCase(scenario, options)));
    }
  }
  return {
    name: 'Approved end-to-end shopping flows',
    mode: 'LIVE',
    cases,
    metrics: { generationAllowance: deepCases.reduce((sum, scenario) => sum + scenario.maxGenerations, 0) },
    notes: [
      'Each case uses synthetic catalog offers and a fresh in-memory database adapter. The follow-up shares its first-turn cart and decision cache.',
      'All successful generations use the supplied live transport. The production agent parses, executes and verifies the work with no automatic shopping-agent transport retries.',
      'Only synthetic requests and catalog product fixtures reach the model. Raw purchase tool arguments, visible agent text, finish reasons and decoded matcher replies are included in the case evidence.',
      'Final-answer assertions cover the case-specific facts. The sample contains eight deliberately selected risks.'
    ]
  };
}
