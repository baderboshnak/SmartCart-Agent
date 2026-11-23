import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ValidationError } from '@/lib/shared/errors';
import {
  assertNoUnassignedDetails, assertUserQuote, findMention, isVagueProductRequest, validateConstraintUpdate, validateDirectItems, validateQuantity,
  validateRecipePlan
} from '@/lib/shopping/request-items';
import { cartItem } from '../helpers/fixtures';

const message = 'Hi! I want 2 liters of 3% milk, preferably Tnuva, 12 eggs, bread and 500 grams of shredded mozzarella';
const requestText = '2 liters of 3% milk, preferably Tnuva, 12 eggs, bread and 500 grams of shredded mozzarella';
const items = [
  { sourceText: '2 liters of 3% milk, preferably Tnuva', product: 'milk', coreSearchTerm: 'חלב', quantity: { amount: 2, unit: 'l' },
    constraintEvidence: [{ type: 'REQUIREMENT' as const, kind: 'OTHER' as const, sourceText: '3%' }, { type: 'PREFERENCE' as const, kind: 'BRAND' as const, sourceText: 'Tnuva' }] },
  { sourceText: '12 eggs', product: 'eggs', coreSearchTerm: 'ביצים', quantity: { amount: 12, unit: 'units' } },
  { sourceText: 'bread', product: 'bread', coreSearchTerm: 'לחם', quantity: { amount: 0, unit: 'unspecified' } },
  { sourceText: '500 grams of shredded mozzarella', product: 'mozzarella', coreSearchTerm: 'מוצרלה', quantity: { amount: 500, unit: 'g' },
    constraintEvidence: [{ type: 'REQUIREMENT' as const, kind: 'OTHER' as const, sourceText: 'shredded' }] }
];

describe('direct shopping items from the agent', () => {
  test('accepts a complete extraction with requirements, preferences and quantities', () => {
    const validated = validateDirectItems({ requestText, items }, message);
    assert.equal(validated.length, 4);
    assert.deepEqual(validated[0]!.requirements, ['3%']);
    assert.deepEqual(validated[0]!.preferences, ['Tnuva']);
    assert.deepEqual(validated[1]!.quantity, { amount: 12, unit: 'units' });
    assert.deepEqual(validated[3]!.requirements, ['shredded']);
    assert.deepEqual(validated[0]!.searchTerms, ['חלב']);
  });

  test('rejects an extraction that drops the mandatory 3% (the original defect)', () => {
    const dropped = [{ ...items[0]!, constraintEvidence: [items[0]!.constraintEvidence![1]!] }, ...items.slice(1)];
    assert.throws(() => validateDirectItems({ requestText, items: dropped }, message), /3%/u);
  });

  test('rejects a narrowed request span that leaves "2 liters of 3%" behind', () => {
    const narrowed = { requestText: 'milk', items: [{ sourceText: 'milk', product: 'milk', coreSearchTerm: 'חלב', quantity: { amount: 0, unit: 'unspecified' } }] };
    assert.throws(() => validateDirectItems(narrowed, 'I want 2 liters of 3% milk'), /not assigned to any item/u);
  });

  test('rejects a preference clause left after the span', () => {
    const partial = { requestText: '12 eggs', items: [items[1]!] };
    assert.throws(() => validateDirectItems(partial, '12 eggs, preferably free range'), /preferably/u);
  });

  test('allows unrelated chat around the request and wording covered by other operations', () => {
    assert.doesNotThrow(() => validateDirectItems({ requestText: '12 eggs', items: [items[1]!] }, 'Hello there! Please add 12 eggs. Thanks!'));
    assert.throws(() => assertNoUnassignedDetails('Add 12 eggs and change the milk to 3 liters', '12 eggs', []), /"3"/u);
    assert.doesNotThrow(() => assertNoUnassignedDetails('Add 12 eggs and change the milk to 3 liters', '12 eggs', ['3 liters']));
  });

  test('an unspecified product ("something tasty with chocolate") is refused with a request to ask the customer', () => {
    const he = '2 בקבוקים של חלב ומשהו טעים עם שוקולד';
    const milk = { sourceText: '2 בקבוקים של חלב', product: 'חלב', coreSearchTerm: 'חלב', quantity: { amount: 2, unit: 'bottle' } };
    const vague = { sourceText: 'משהו טעים עם שוקולד', product: 'משהו טעים עם שוקולד', coreSearchTerm: 'שוקולד', quantity: { amount: 0, unit: 'unspecified' } };
    assert.throws(
      () => validateDirectItems({ requestText: he, items: [milk, vague] }, he),
      (error: unknown) => error instanceof ValidationError && /not a specific product/u.test(error.message) && /requestClarification/u.test(error.message)
    );
    assert.throws(() => validateDirectItems({ requestText: he, items: [milk, { ...vague, product: 'שוקולד' }] }, he), /not a specific product/u,
      'vague wording in sourceText is caught even when product is just "chocolate"');
    assert.equal(validateDirectItems({ requestText: '2 בקבוקים של חלב', items: [milk] }, he)[0]!.product, 'חלב',
      'the specific item alone is accepted, so the agent can add it and then ask');
  });

  test('vague wording is recognized in English, Hebrew and Arabic without false alarms', () => {
    for (const text of ['something tasty', 'anything sweet', 'משהו מתוק', 'ומשהו לארוחת בוקר', 'שוקולד כלשהו', 'شي طيب', 'وشيء حلو', 'حاجة حلوة']) {
      assert.equal(isVagueProductRequest(text), true, text);
    }
    for (const text of ['milk', 'shredded mozzarella', 'something like Tnuva milk', 'משהו כמו במבה', 'מדבר', 'שוקולד מריר', 'شيبس', 'حليب', 'stuffed peppers']) {
      assert.equal(isVagueProductRequest(text), false, text);
    }
  });

  test('requires requestText to be verbatim from the latest message', () => {
    assert.throws(() => validateDirectItems({ requestText: '12 large eggs', items: [items[1]!] }, 'I want 12 eggs'), ValidationError);
  });

  test('validates Hebrew requests with the engine coverage rules', () => {
    const hebrew = 'אני רוצה 2 ליטר חלב 3% ו-12 ביצים';
    const validated = validateDirectItems({
      requestText: '2 ליטר חלב 3% ו-12 ביצים',
      items: [
        { sourceText: '2 ליטר חלב 3%', product: 'חלב', coreSearchTerm: 'חלב', quantity: { amount: 2, unit: 'l' }, constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' }] },
        { sourceText: '12 ביצים', product: 'ביצים', coreSearchTerm: 'ביצים', quantity: { amount: 12, unit: 'units' } }
      ]
    }, hebrew);
    assert.deepEqual(validated.map(item => item.requirements), [['3%'], []]);
  });
});

describe('constraint changes are grounded in the customer\'s words', () => {
  const milk = cartItem({ id: 'itm_milk', product: 'milk', searchTerms: ['חלב'], quantity: { amount: 2, unit: 'l' }, requirements: ['3%'], preferences: ['Tnuva'] });

  test('"Only Tnuva milk" turns the preference into a requirement and keeps 3%', () => {
    const update = validateConstraintUpdate(milk, [{ value: '3%', type: 'REQUIREMENT' }, { value: 'Tnuva', type: 'REQUIREMENT' }], 'Only Tnuva milk');
    assert.deepEqual(update.requirements, ['3%', 'Tnuva']);
    assert.deepEqual(update.preferences, []);
    assert.equal(update.constraintEvidence.find(entry => entry.value === 'Tnuva')?.kind, 'BRAND');
  });

  test('"Make it cheaper" cannot silently drop the mandatory 3%', () => {
    assert.throws(() => validateConstraintUpdate(milk, [{ value: 'Tnuva', type: 'PREFERENCE' }], 'Make it cheaper'), /mandatory requirement/u);
  });

  test('an explicit request can relax a requirement', () => {
    const update = validateConstraintUpdate(milk, [{ value: 'Tnuva', type: 'PREFERENCE' }], 'The 3% doesn\'t matter, any milk is fine');
    assert.deepEqual(update.requirements, []);
  });

  test('new constraints must appear in the message', () => {
    assert.throws(() => validateConstraintUpdate(milk, [{ value: '3%', type: 'REQUIREMENT' }, { value: 'organic', type: 'REQUIREMENT' }], 'Make it cheaper'), /not in the user's latest message/u);
    const update = validateConstraintUpdate(milk, [{ value: '3%', type: 'REQUIREMENT' }, { value: 'Tnuva', type: 'PREFERENCE' }, { value: 'lactose-free', type: 'REQUIREMENT' }], 'Make the milk lactose-free');
    assert.deepEqual(update.requirements, ['3%', 'lactose-free']);
  });

  test('quotes and mentions are matched case-insensitively', () => {
    assert.equal(findMention('only TNUVA please', 'Tnuva'), 'TNUVA');
    assert.equal(findMention('unsalted butter', 'salted'), null);
    assert.equal(assertUserQuote('Please remove the eggs', 'remove the EGGS', 'Removing'), 'remove the EGGS');
    assert.throws(() => assertUserQuote('Make it cheaper', 'remove eggs', 'Removing items'), /userQuote/u);
  });
});

describe('30. recipe ingredient plans', () => {
  const plan = {
    requestText: 'I want to make pizza for 4 people',
    dish: 'pizza',
    servings: 4,
    servingsSource: 'EXPLICIT' as const,
    ingredients: [
      { name: 'wheat flour', coreSearchTerm: 'קמח', quantity: { amount: 500, unit: 'g' } },
      { name: 'dry yeast', coreSearchTerm: 'שמרים', quantity: { amount: 0, unit: 'unspecified' } },
      { name: 'tomato sauce', coreSearchTerm: 'רוטב עגבניות', quantity: { amount: 250, unit: 'g' } },
      { name: 'mozzarella', coreSearchTerm: 'מוצרלה', quantity: { amount: 300, unit: 'g' } },
      { name: 'fresh basil', coreSearchTerm: 'בזיליקום', quantity: { amount: 0, unit: 'unspecified' }, optional: true }
    ]
  };

  test('accepts a realistic plan and keeps optional extras out of the cart', () => {
    const { plan: validated, ingredients } = validateRecipePlan(plan, plan.requestText);
    assert.equal(validated.servings, 4);
    assert.equal(ingredients.length, 5);
    assert.equal(ingredients.filter(ingredient => !ingredient.optional).length, 4);
    assert.deepEqual(ingredients[0]!.searchTerms, ['קמח']);
  });

  test('explicit servings must be stated; otherwise they are marked as assumed', () => {
    assert.throws(() => validateRecipePlan({ ...plan, requestText: 'I want to make pizza' }, 'I want to make pizza'), /ASSUMED/u);
    assert.doesNotThrow(() => validateRecipePlan({ ...plan, requestText: 'I want to make pizza', servingsSource: 'ASSUMED' }, 'I want to make pizza'));
    assert.doesNotThrow(() => validateRecipePlan({ ...plan, requestText: 'pizza for four people' }, 'pizza for four people'));
  });

  test('rejects invented constraints, invalid quantities, non-Hebrew search terms and empty plans', () => {
    const withBrand = { ...plan, ingredients: [{ ...plan.ingredients[3]!, requirements: ['Tnuva'] }] };
    assert.throws(() => validateRecipePlan(withBrand, plan.requestText), /not in the customer's words/u);
    const vegan = { ...plan, requestText: 'I want to make a vegan pizza for 4 people', ingredients: [{ ...plan.ingredients[3]!, requirements: ['vegan'] }] };
    assert.equal(validateRecipePlan(vegan, vegan.requestText).ingredients[0]!.requirements[0], 'vegan');
    assert.throws(() => validateRecipePlan({ ...plan, ingredients: [{ ...plan.ingredients[0]!, quantity: { amount: -1, unit: 'g' } }] }, plan.requestText), ValidationError);
    assert.throws(() => validateRecipePlan({ ...plan, ingredients: [{ ...plan.ingredients[0]!, coreSearchTerm: 'flour' }] }, plan.requestText), /Hebrew/u);
    assert.throws(() => validateRecipePlan({ ...plan, ingredients: [{ ...plan.ingredients[4]! }] }, plan.requestText), /required ingredient/u);
    assert.throws(() => validateRecipePlan({ ...plan, servings: 0 }, plan.requestText), /servings/u);
  });

  test('quantities are bounded and well-formed', () => {
    assert.deepEqual(validateQuantity({ amount: 2, unit: 'l' }), { amount: 2, unit: 'l' });
    assert.deepEqual(validateQuantity({ amount: 0, unit: 'unspecified' }), { amount: 0, unit: 'unspecified' });
    assert.throws(() => validateQuantity({ amount: 3, unit: 'unspecified' }), ValidationError);
    assert.throws(() => validateQuantity({ amount: 1.5, unit: 'units' }), ValidationError);
    assert.throws(() => validateQuantity({ amount: 900, unit: 'kg' }), /unrealistically/u);
    assert.throws(() => validateQuantity({ amount: 2, unit: 'cups' }), /unit must be/u);
  });
});
