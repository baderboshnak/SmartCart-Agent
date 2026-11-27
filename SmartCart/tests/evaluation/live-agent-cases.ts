import { isDeepStrictEqual } from 'node:util';
import type { Cart, CartItem } from '@/lib/shared/types';

interface FirstTurnResult {
  cart: Cart;
  operationNames: string[];
  clarification?: { question: string; options: string[] };
}

export interface LiveAgentScenario {
  id: string;
  title: string;
  request: string;
  language: 'en' | 'he' | 'ar';
  expectedTool: 'updateCart' | 'requestClarification';
  expected: unknown;
  seedItems?: CartItem[];
  validate(result: FirstTurnResult): string[];
}

const arabicRequest = 'بدي ٢ علبة تونة بالماء و ٥٠٠ غرام رز بسمتي';
const pizzaRequest = 'אני רוצה להכין פיצה ל-4 אנשים. יש לי קמח ושמרים.';
const milk: CartItem = {
  id: 'itm_seed_milk',
  product: 'milk',
  searchTerms: ['חלב'],
  quantity: { amount: 2, unit: 'l' },
  requirements: ['3%'],
  preferences: ['Tnuva'],
  constraintEvidence: [
    { type: 'REQUIREMENT', kind: 'OTHER', value: '3%', sourceText: '3%' },
    { type: 'PREFERENCE', kind: 'BRAND', value: 'Tnuva', sourceText: 'Tnuva' }
  ],
  sourceText: '2 liters of 3% milk, preferably Tnuva',
  origin: { type: 'DIRECT' },
  addedAt: new Date('2026-11-19T10:00:00Z')
};

function operationProblems(operationNames: string[], expected: string): string[] {
  return isDeepStrictEqual(operationNames, [expected]) ? [] : [`Expected one ${expected} operation.`];
}

function hasOnlyRequiredQualifier(item: CartItem, phrase: string): boolean {
  const [evidence] = item.constraintEvidence;
  return isDeepStrictEqual(item.requirements, [phrase]) && !item.preferences.length &&
    item.constraintEvidence.length === 1 && evidence?.type === 'REQUIREMENT' &&
    evidence.kind === 'OTHER' && evidence.value === phrase && evidence.sourceText === phrase;
}

function validRecipeAmount(item: CartItem): boolean {
  const { amount, unit } = item.quantity;
  if (unit === 'g' || unit === 'ml') return amount >= 100 && amount <= 1_200;
  if (unit === 'l' || unit === 'kg') return amount >= 0.1 && amount <= 1.2;
  return unit !== 'unspecified' && Number.isInteger(amount) && amount >= 1 && amount <= 3;
}

const hebrew = /\p{Script=Hebrew}/u;
const concreteSweet = /שוקו|עוג(?:ה|ת|יות)|וופל|גליד(?:ה|ת)|סוכריות|מרשמלו|פודינג|מעדן|מאפין|דונאט|סופגנ|חלוו|קרפ|טופי|ביסק|קרואסון|ריבה|כנאפה|פרלינ|פירות/u;

export const liveAgentScenarios: LiveAgentScenario[] = [
  {
    id: 'arabic-cans-and-grams',
    title: 'Arabic-Indic quantities and separate mandatory qualifiers',
    request: arabicRequest,
    language: 'ar',
    expectedTool: 'updateCart',
    expected: {
      operations: ['add_items'],
      items: [
        { product: 'تونة', amount: 2, unit: 'can', required: ['بالماء'], HebrewSearch: 'טונה' },
        { product: 'رز', amount: 500, unit: 'g', variety: 'بسمتي in the product identity or a requirement', HebrewSearch: 'אורז' }
      ],
      preferences: [],
      sourceText: 'One verbatim span per item, including its amount and qualifier'
    },
    validate({ cart, operationNames }) {
      const problems = operationProblems(operationNames, 'add_items');
      const [tuna, rice] = cart.items;
      if (cart.items.length !== 2 || !tuna || !rice) return [...problems, 'Expected exactly two cart lines.'];
      if (!tuna.product.includes('تونة') || !isDeepStrictEqual(tuna.quantity, { amount: 2, unit: 'can' })) {
        problems.push('The first item should be exactly two cans of tuna.');
      }
      const riceGrams = rice.quantity.unit === 'kg' ? rice.quantity.amount * 1_000 :
        rice.quantity.unit === 'g' ? rice.quantity.amount : 0;
      if (!rice.product.includes('رز') || riceGrams !== 500 || rice.quantity.maxAmount !== undefined) {
        problems.push('The second item should be exactly 500 grams of rice.');
      }
      if (!hasOnlyRequiredQualifier(tuna, 'بالماء')) problems.push('Only the tuna should require the exact water-packing qualifier.');
      const basmatiIdentity = rice.product.includes('بسمتي') && !rice.requirements.length && !rice.preferences.length && !rice.constraintEvidence.length;
      if (!basmatiIdentity && !hasOnlyRequiredQualifier(rice, 'بسمتي')) problems.push('The rice should keep basmati without inheriting another product’s qualifier.');
      if (!tuna.searchTerms.some(term => term.includes('טונה')) || !rice.searchTerms.some(term => term.includes('אורז'))) {
        problems.push('Each item needs a Hebrew search term for its own base product.');
      }
      for (const [item, amount, qualifier] of [[tuna, '٢', 'بالماء'], [rice, '٥٠٠', 'بسمتي']] as const) {
        const quote = item.sourceText ?? '';
        if (!quote.includes(amount) || !quote.includes(qualifier) || !arabicRequest.includes(quote) || item.origin.type !== 'DIRECT') {
          problems.push(`The ${item.product} line needs a verbatim direct-purchase span containing its amount and qualifier.`);
        }
      }
      return problems;
    }
  },
  {
    id: 'hebrew-pizza-pantry',
    title: 'Four-person pizza using the customer’s flour and yeast',
    request: pizzaRequest,
    language: 'he',
    expectedTool: 'updateCart',
    expected: {
      operations: ['add_recipe'], dish: 'pizza', servings: 4, servingsSource: 'EXPLICIT',
      requiredPurchases: ['tomato sauce or tomatoes for the sauce', 'mozzarella or another pizza cheese'],
      alreadyOwned: ['flour', 'yeast'], dietaryConstraints: []
    },
    validate({ cart, operationNames }) {
      const problems = operationProblems(operationNames, 'add_recipe');
      const [plan] = cart.recipePlans;
      if (cart.recipePlans.length !== 1 || !plan) return [...problems, 'Expected one saved pizza recipe.'];
      if (!/pizza|פיצה/iu.test(plan.dish) || plan.servings !== 4 || plan.servingsSource !== 'EXPLICIT') {
        problems.push('The saved recipe should be pizza for four explicitly stated servings.');
      }
      if (!pizzaRequest.includes(plan.requestText) || !plan.requestText.includes('4')) {
        problems.push('The recipe should quote the customer’s stated serving count.');
      }
      const shoppingLines = cart.items.map(item => ({
        item,
        label: [item.product, ...item.searchTerms].join(' ')
      }));
      const sauce = shoppingLines.find(({ label }) => /tomato|marinara|passata|עגבני|רוטב פיצה/iu.test(label))?.item;
      const cheese = shoppingLines.find(({ label }) => /cheese|mozzarella|provolone|גבינ|מוצרל/iu.test(label))?.item;
      if (!sauce || !cheese || sauce.id === cheese.id) {
        problems.push('The recipe should add separate sauce and cheese shopping lines.');
      }
      if (shoppingLines.some(({ label }) => /flour|yeast|קמח|שמרים/iu.test(label))) {
        problems.push('Flour and yeast already in the pantry should stay out of the shopping cart.');
      }
      for (const item of [sauce, cheese]) {
        if (item && (!validRecipeAmount(item) || !item.searchTerms.some(term => hebrew.test(term)))) {
          problems.push(`The ${item.product} line needs a plausible amount for four and a Hebrew search term.`);
        }
      }
      const requiredIngredients = plan.ingredients.filter(ingredient => !ingredient.optional);
      if (requiredIngredients.length !== cart.items.length || requiredIngredients.some(ingredient =>
        !cart.items.some(item => item.id === ingredient.itemId))) {
        problems.push('Each required ingredient should link to its own shopping line, with optional extras left out.');
      }
      if (cart.items.some(item => item.origin.type !== 'RECIPE' || item.origin.recipePlanId !== plan.id ||
        item.requirements.length || item.preferences.length)) {
        problems.push('Shopping lines should come from the saved recipe and contain only customer-stated constraints.');
      }
      return problems;
    }
  },
  {
    id: 'english-make-it-cheaper',
    title: 'Cheapest mode preserves the existing milk line and its constraints',
    request: 'Make it cheaper.',
    language: 'en',
    expectedTool: 'updateCart',
    expected: { operations: ['set_mode'], mode: 'cheapest', sameItem: milk.id, mandatory: ['3%'], optional: ['Tnuva'] },
    seedItems: [milk],
    validate({ cart, operationNames }) {
      const problems = operationProblems(operationNames, 'set_mode');
      if (cart.mode !== 'cheapest') problems.push('The cart mode should switch to cheapest.');
      if (cart.items.length !== 1 || !isDeepStrictEqual(cart.items[0], milk)) {
        problems.push('The existing milk line should retain its ID, quantity, search terms, 3% requirement and Tnuva preference.');
      }
      return problems;
    }
  },
  {
    id: 'hebrew-sweet-clarification',
    title: 'Clarify an unspecified sweet food in Hebrew',
    request: 'אני רוצה משהו מתוק',
    language: 'he',
    expectedTool: 'requestClarification',
    expected: { operations: [], clarificationLanguage: 'he', concreteOptions: '3–4 distinct sweet grocery choices', cartItems: 0 },
    validate({ cart, operationNames, clarification }) {
      const problems = [];
      if (operationNames.length || cart.items.length || cart.recipePlans.length) problems.push('An unspecified sweet food should leave the cart empty.');
      if (!clarification) return [...problems, 'Expected the clarification tool to return one question.'];
      if (!hebrew.test(clarification.question) || !/איז|מה|תרצ|מעדיפ/u.test(clarification.question)) {
        problems.push('The clarification should ask in Hebrew which sweet product the customer wants.');
      }
      const options = clarification.options.map(option => option.trim());
      if (options.length < 3 || options.length > 4 || new Set(options).size !== options.length ||
        options.some(option => !hebrew.test(option) || !concreteSweet.test(option))) {
        problems.push('Offer three or four distinct, concrete sweet groceries in Hebrew.');
      }
      return problems;
    }
  }
];
