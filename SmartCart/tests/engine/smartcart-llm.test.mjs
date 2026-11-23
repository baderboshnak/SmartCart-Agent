import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertShoppingPlanCoverage, understandShoppingRequest } from '../../engine/smartcart-llm.mjs';

const required = (sourceText, kind = 'OTHER') => ({ type: 'REQUIREMENT', kind, sourceText });
const preferred = (sourceText, kind = 'OTHER') => ({ type: 'PREFERENCE', kind, sourceText });
const item = (sourceText, product, coreSearchTerm, amount, unit, constraintEvidence = []) => ({
  sourceText, product, coreSearchTerm, quantity: { amount, unit }, constraintEvidence, searchTerms: []
});
const milk = item('2 liters of 3% milk, preferably Tnuva', 'milk', 'חלב', 2, 'l', [required('3%'), preferred('Tnuva', 'BRAND')]);
const eggs = item('12 eggs', 'eggs', 'ביצים', 12, 'units');
const bread = item('500 grams of bread', 'bread', 'לחם', 500, 'g');
const mozzarella = item('500 grams of shredded mozzarella', 'shredded mozzarella', 'מוצרלה', 500, 'g', [required('shredded')]);
const singleRequest = `I want ${milk.sourceText}`;
const multiRequest = `I want ${milk.sourceText}, ${eggs.sourceText}, ${bread.sourceText}, and ${mozzarella.sourceText}`;

function responses(audit, ...drafts) {
  return async ({ declaration }) => {
    if (declaration.name === 'audit_shopping_request') return { items: audit };
    assert.equal(declaration.name, 'submit_shopping_request');
    assert.ok(drafts.length, 'Unexpected extra extraction call');
    return { items: drafts.shift() };
  };
}

test('single milk request keeps a hard fat percentage and soft brand', async () => {
  const plan = await understandShoppingRequest(singleRequest, { callModel: responses([milk], [milk]) });
  assert.deepEqual(plan.items[0], {
    sourceText: milk.sourceText, product: 'milk', searchTerms: ['חלב'], quantity: { amount: 2, unit: 'l' },
    requirements: ['3%'], preferences: ['Tnuva'],
    constraintEvidence: milk.constraintEvidence.map(evidence => ({ ...evidence, value: evidence.sourceText }))
  });
  assert.equal(assertShoppingPlanCoverage(plan), plan);
});

test('plain requests and casual shopping lead-ins leave requirements and quantities unspecified', async () => {
  const plainMilk = item('milk', 'milk', 'חלב', 0, 'unspecified');
  const plainEggs = item('eggs', 'eggs', 'ביצים', 0, 'unspecified');
  const plainBread = item('bread', 'bread', 'לחם', 0, 'unspecified');
  const requests = [
    ['I want milk', [plainMilk]],
    ['I could use some bread and eggs.', [plainBread, plainEggs]],
    ["I'm looking for milk.", [plainMilk]],
    ['Make a shopping list of milk and eggs.', [plainMilk, plainEggs]],
    ['Eggs, bread, and milk.', [{ ...plainEggs, sourceText: 'Eggs', product: 'Eggs' }, plainBread, plainMilk]]
  ];
  for (const [request, items] of requests) {
    const plan = await understandShoppingRequest(request, { callModel: responses(items, items) });
    assert.deepEqual(plan.items.map(({ product }) => product), items.map(({ product }) => product));
    for (const entry of plan.items) {
      assert.deepEqual(entry.quantity, { amount: 0, unit: 'unspecified' });
      assert.deepEqual(entry.requirements, []);
      assert.deepEqual(entry.preferences, []);
    }
  }
});

test('a product attribute cannot ground a quantity the customer never specified', async () => {
  const guesses = [
    item('milk', 'milk', 'חלב', 2, 'l'),
    item('3% milk', 'milk', 'חלב', 3, 'l', [required('3%')])
  ];
  for (const guess of guesses) {
    await assert.rejects(understandShoppingRequest(`I want ${guess.sourceText}`, {
      callModel: responses([guess], [guess]), maxAttempts: 1
    }), /quantity that wasn't specified/);
  }
  const postfix = item('milk, 2 liters', 'milk', 'חלב', 2, 'l');
  const plan = await understandShoppingRequest(`I want ${postfix.sourceText}`, {
    callModel: responses([postfix], [postfix])
  });
  assert.deepEqual(plan.items[0].quantity, postfix.quantity);
});

test('requested quantity ranges retain both bounds across equivalent wording and units', async () => {
  for (const sourceText of [
    '2–3 liters of milk', '2-3 liters of milk', '2 to 3 liters of milk',
    'between two and three liters of milk', '2 L to 3000 ml of milk',
    'milk, 2 to 3 liters'
  ]) {
    const range = { ...item(sourceText, 'milk', 'חלב', 2, 'l'), quantity: { amount: 2, maxAmount: 3, unit: 'l' } };
    const metric = { ...range, quantity: { amount: 2000, maxAmount: 3000, unit: 'ml' } };
    const plan = await understandShoppingRequest(`I want ${sourceText}`, {
      callModel: responses([metric], [range])
    });
    assert.deepEqual(plan.items[0].quantity, range.quantity, sourceText);
    assert.equal(assertShoppingPlanCoverage(plan), plan);
    for (const quantity of [{ amount: 2, unit: 'l' }, { amount: 3, unit: 'l' }, { maxAmount: 3, unit: 'l' }]) {
      const missingBound = { ...range, quantity };
      await assert.rejects(understandShoppingRequest(`I want ${sourceText}`, {
        callModel: responses([missingBound]), maxAttempts: 1
      }), /preserve the requested quantity range|quantity is invalid/, sourceText);
    }
  }
});

test('count ranges preserve both bounds and verify hard per-container sizes', async () => {
  const apples = { ...item('2–3 apples', 'apples', 'תפוחים', 2, 'units'), quantity: { amount: 2, maxAmount: 3, unit: 'units' } };
  const hebrewApples = { ...item('בין 2 ל-3 תפוחים', 'תפוחים', 'תפוחים', 2, 'units'), quantity: apples.quantity };
  const bottles = {
    ...item('2–3 bottles × 500 ml of water', 'water', 'מים', 2, 'bottle', [required('500 ml')]),
    quantity: { amount: 2, maxAmount: 3, unit: 'bottle' }
  };
  for (const entry of [apples, hebrewApples, bottles]) {
    const plan = await understandShoppingRequest(`I want ${entry.sourceText}`, {
      callModel: responses([entry], [entry])
    });
    assert.deepEqual(plan.items[0].quantity, entry.quantity);
  }
  await assert.rejects(understandShoppingRequest(`I want ${bottles.sourceText}`, {
    callModel: responses([{ ...bottles, constraintEvidence: [] }]), maxAttempts: 1
  }), /omits the required size per bottle/);
  const unsupportedUnit = { ...item('2–3 ounces of flour', 'flour', 'קמח', 2, 'units'), quantity: apples.quantity };
  await assert.rejects(understandShoppingRequest(`I want ${unsupportedUnit.sourceText}`, {
    callModel: responses([unsupportedUnit], [unsupportedUnit]), maxAttempts: 1
  }), /unassigned product or qualifier wording/);
});

test('explicit OR links create one choice group while required items stay separate', async () => {
  const plainMilk = item('milk', 'milk', 'חלב', 0, 'unspecified');
  const oats = item('oat milk', 'oat milk', 'חלב שיבולת שועל', 0, 'unspecified');
  const plainEggs = item('eggs', 'eggs', 'ביצים', 0, 'unspecified');
  const plainBread = item('bread', 'bread', 'לחם', 0, 'unspecified');
  for (const [request, items, groups] of [
    ['I want either milk or oat milk.', [plainMilk, oats], ['choice-0', 'choice-0']],
    ['I want milk or oat milk, and eggs.', [plainMilk, oats, plainEggs], ['choice-0', 'choice-0', undefined]],
    ['I want milk or oat milk, and eggs or bread.', [plainMilk, oats, plainEggs, plainBread], ['choice-0', 'choice-0', 'choice-2', 'choice-2']],
    ['I want milk, oat milk, or bread.', [plainMilk, oats, plainBread], ['choice-0', 'choice-0', 'choice-0']],
    ['אני רוצה חלב או לחם.', [item('חלב', 'חלב', 'חלב', 0, 'unspecified'), item('לחם', 'לחם', 'לחם', 0, 'unspecified')], ['choice-0', 'choice-0']]
  ]) {
    const plan = await understandShoppingRequest(request, { callModel: responses(items, items) });
    assert.deepEqual(plan.items.map(entry => entry.choiceGroup), groups, request);
    assert.equal(assertShoppingPlanCoverage(plan), plan);
    delete plan.items[0].choiceGroup;
    assert.throws(() => assertShoppingPlanCoverage(plan), /inconsistent alternative group/, request);
  }
});

test('retries collapsed alternatives and asks for clarification when choice scope is ambiguous', async () => {
  const plainMilk = item('milk', 'milk', 'חלב', 0, 'unspecified');
  const oats = item('oat milk', 'oat milk', 'חלב שיבולת שועל', 0, 'unspecified');
  const plainEggs = item('eggs', 'eggs', 'ביצים', 0, 'unspecified');
  const plainBread = item('bread', 'bread', 'לחם', 0, 'unspecified');
  const collapsed = item('milk or oat milk', 'milk or oat milk', 'חלב', 0, 'unspecified');
  const plan = await understandShoppingRequest('I want milk or oat milk.', {
    callModel: responses([plainMilk, oats], [collapsed], [plainMilk, oats])
  });
  assert.deepEqual(plan.items.map(entry => entry.product), ['milk', 'oat milk']);
  await assert.rejects(understandShoppingRequest('I want milk and eggs or oat milk and bread.', {
    callModel: responses([plainMilk, plainEggs, oats, plainBread]), maxAttempts: 1
  }), /clarify which items are alternatives/);
  await assert.rejects(understandShoppingRequest('I want 2 liters of milk or oat milk.', {
    callModel: responses([item('2 liters of milk', 'milk', 'חלב', 2, 'l'), oats]), maxAttempts: 1
  }), /quantity for each alternative/);

  const brands = item('milk, preferably Tnuva or Tara', 'milk', 'חלב', 0, 'unspecified', [
    preferred('Tnuva', 'BRAND'), preferred('Tara', 'BRAND')
  ]);
  const brandPlan = await understandShoppingRequest(`I want ${brands.sourceText}`, {
    callModel: responses([brands], [brands])
  });
  assert.deepEqual(brandPlan.items[0].preferences, ['Tnuva', 'Tara']);
  assert.equal(brandPlan.items[0].choiceGroup, undefined);
});

test('clarifies meal goals and accepts a named grocery product or ingredient list', async () => {
  const noModel = () => assert.fail('Meal clarification should happen before calling Gemini');
  for (const goal of ['I want to make pizza.', 'I want to bake bread', 'I need something for dinner.', 'אני רוצה להכין פיצה.']) {
    const plan = await understandShoppingRequest(goal, { callModel: noModel });
    assert.equal(plan.status, 'NEEDS_CLARIFICATION');
    assert.ok(plan.questions.length);
  }
  const pizza = item('pizza', 'pizza', 'פיצה', 0, 'unspecified');
  const plan = await understandShoppingRequest('I want pizza.', { callModel: responses([pizza], [pizza]) });
  assert.equal(plan.items[0].product, 'pizza');
  assert.throws(() => assertShoppingPlanCoverage({ ...plan, userRequest: 'I want to make pizza.' }), /recipe or clarification plan/u);

  const ingredients = [
    item('pizza dough', 'pizza dough', 'בצק', 0, 'unspecified'),
    item('pizza sauce', 'pizza sauce', 'רוטב', 0, 'unspecified'),
    item('mozzarella', 'mozzarella', 'מוצרלה', 0, 'unspecified')
  ];
  const shopping = await understandShoppingRequest('I need pizza dough, pizza sauce, and mozzarella.', {
    callModel: responses(ingredients, ingredients)
  });
  assert.deepEqual(shopping.items.map(({ product }) => product), ingredients.map(({ product }) => product));
});

test('multi-item extraction retries the legacy omission and keeps each item independent', async () => {
  const dropped = { ...milk, constraintEvidence: milk.constraintEvidence.slice(1) };
  const items = [milk, eggs, bread, mozzarella];
  const plan = await understandShoppingRequest(multiRequest, {
    callModel: responses(items, [dropped, eggs, bread, mozzarella], items)
  });
  assert.deepEqual(plan.items.map(x => x.product), ['milk', 'eggs', 'bread', 'shredded mozzarella']);
  assert.deepEqual(plan.items.map(x => x.requirements), [['3%'], [], [], ['shredded']]);
  assert.deepEqual(plan.items.map(x => x.preferences), [['Tnuva'], [], [], []]);
  assert.deepEqual(plan.items.map(x => x.quantity.amount), [2, 12, 500, 500]);
});

test('deterministic checks fail closed when even the independent audit drops a percentage', async () => {
  const dropped = { ...milk, constraintEvidence: milk.constraintEvidence.slice(1) };
  await assert.rejects(understandShoppingRequest(multiRequest, {
    callModel: responses([dropped, eggs, bread, mozzarella]), maxAttempts: 1
  }), /omits or misclassifies "3%" as a requirement/);
});

test('verbatim item spans prevent an omitted shopping item', async () => {
  await assert.rejects(understandShoppingRequest(multiRequest, {
    callModel: responses([milk, eggs, mozzarella]), maxAttempts: 1
  }), /coverage leaves "500" unassigned/);
});

test('two explicit products cannot share one item or ground a product in a word fragment', async () => {
  const grouped = item('milk and eggs', 'milk', 'חלב', 0, 'unspecified');
  await assert.rejects(understandShoppingRequest(grouped.sourceText, {
    callModel: responses([grouped], [grouped]), maxAttempts: 1
  }), /unassigned product or qualifier wording: "eggs"/);
  const fragment = item('milkshake', 'milk', 'חלב', 0, 'unspecified');
  await assert.rejects(understandShoppingRequest(fragment.sourceText, {
    callModel: responses([fragment], [fragment]), maxAttempts: 1
  }), /complete product phrase/);
});

test('hard brand and explicit physical form are stored as requirements with broad search', async () => {
  const cheese = {
    ...mozzarella,
    sourceText: `${mozzarella.sourceText}, only Tnuva`,
    constraintEvidence: [...mozzarella.constraintEvidence, required('Tnuva', 'BRAND')]
  };
  const plan = await understandShoppingRequest(`I want ${cheese.sourceText}`, { callModel: responses([cheese], [cheese]) });
  assert.deepEqual(plan.items[0].requirements, ['shredded', 'Tnuva']);
  assert.deepEqual(plan.items[0].preferences, []);
  assert.deepEqual(plan.items[0].searchTerms, ['מוצרלה']);
  const dropped = { ...cheese, constraintEvidence: mozzarella.constraintEvidence };
  await assert.rejects(understandShoppingRequest(`I want ${cheese.sourceText}`, {
    callModel: responses([cheese], [dropped]), maxAttempts: 1
  }), /mandatory qualifier following an exclusivity cue/);
  const prefixed = { ...dropped, sourceText: 'only Tnuva shredded mozzarella', quantity: { amount: 0, unit: 'unspecified' } };
  await assert.rejects(understandShoppingRequest(prefixed.sourceText, {
    callModel: responses([prefixed]), maxAttempts: 1
  }), /mandatory qualifier following an exclusivity cue/);
});

test('English and Hebrew wording preserves multiple explicit qualifiers without moving them to preferences', async () => {
  const wheat = item('500 g of sliced 100% whole wheat sugar-free bread, preferably Brand A', 'bread', 'לחם', 500, 'g', [
    required('sliced'), required('100% whole wheat'), required('sugar-free'), preferred('Brand A', 'BRAND')
  ]);
  const hebrewMilk = item('2 ליטרים של חלב3% ללא לקטוז, עדיף תנובה', 'חלב', 'חלב', 2, 'l', [
    required('3%'), required('ללא לקטוז'), preferred('תנובה', 'BRAND')
  ]);
  for (const entry of [wheat, hebrewMilk]) {
    const plan = await understandShoppingRequest(entry.sourceText, { callModel: responses([entry], [entry]) });
    assert.deepEqual(plan.items[0].requirements, entry.constraintEvidence.filter(x => x.type === 'REQUIREMENT').map(x => x.sourceText));
  }
  const wrong = { ...wheat, constraintEvidence: wheat.constraintEvidence.map(e => e.sourceText === 'sugar-free' ? preferred('sugar-free') : e) };
  await assert.rejects(understandShoppingRequest(wheat.sourceText, { callModel: responses([wheat], [wrong]), maxAttempts: 1 }), /sugar-free.*requirement/);
});

test('coverage catches dropped wording and the independent audit catches qualifier or quantity disagreement', async () => {
  const tea = item('three tea sachets grown at high altitude', 'tea sachets', 'תה', 3, 'units', [required('grown at high altitude')]);
  const noQualifier = { ...tea, constraintEvidence: [] };
  const wrongKind = { ...tea, constraintEvidence: [required('grown at high altitude', 'BRAND')] };
  const postfix = { ...tea, sourceText: 'tea sachets grown at high altitude, 3 units' };
  const wrongQuantity = { ...postfix, quantity: { amount: 2, unit: 'units' } };
  await assert.rejects(understandShoppingRequest(tea.sourceText, {
    callModel: responses([tea], [noQualifier]), maxAttempts: 1
  }), /unassigned product or qualifier wording/);
  await assert.rejects(understandShoppingRequest(tea.sourceText, {
    callModel: responses([tea], [wrongKind]), maxAttempts: 1
  }), /Independent audit assigns these qualifiers/);
  await assert.rejects(understandShoppingRequest(postfix.sourceText, {
    callModel: responses([postfix], [wrongQuantity]), maxAttempts: 1
  }), /changes the explicit quantity "3 units"/);
});

test('explicit counts and fractional measures stay grounded even when both model passes agree on a wrong amount', async () => {
  const cases = [
    item('two bananas', 'bananas', 'בננות', 2, 'units'),
    item('a dozen eggs', 'eggs', 'ביצים', 12, 'units'),
    item('שתי ביצים', 'ביצים', 'ביצים', 2, 'units'),
    item('half a liter of milk', 'milk', 'חלב', 0.5, 'l'),
    item('חצי ליטר חלב', 'חלב', 'חלב', 0.5, 'l'),
    item('1/2 kilogram of flour', 'flour', 'קמח', 0.5, 'kg'),
    item('1 1/2 liters of juice', 'juice', 'מיץ', 1.5, 'l'),
    item('0,5 liter of water', 'water', 'מים', 0.5, 'l')
  ];
  for (const entry of cases) {
    const request = `I want ${entry.sourceText}`;
    const plan = await understandShoppingRequest(request, { callModel: responses([entry], [entry]) });
    assert.deepEqual(plan.items[0].quantity, entry.quantity, entry.sourceText);

    const wrong = { ...entry, quantity: { ...entry.quantity, amount: entry.quantity.amount + 1 } };
    await assert.rejects(understandShoppingRequest(request, {
      callModel: responses([wrong], [wrong]), maxAttempts: 1
    }), /changes the explicit quantity/, entry.sourceText);
  }
  const soda = item('7 Up', '7 Up', 'סבן אפ', 0, 'unspecified');
  const plan = await understandShoppingRequest(soda.sourceText, { callModel: responses([soda], [soda]) });
  assert.deepEqual(plan.items[0].quantity, soda.quantity);
});

test('invalid derived quantities fail during request extraction', async () => {
  const broken = [
    item('-2 eggs', 'eggs', 'ביצים', 2, 'units'),
    item('1/0 liter of water', 'water', 'מים', 1, 'l'),
    item('eggs', 'eggs', 'ביצים', 1.5, 'units'),
    item('water', 'water', 'מים', 0.0000001, 'l')
  ];
  for (const entry of broken) {
    await assert.rejects(understandShoppingRequest(entry.sourceText, {
      callModel: responses([entry], [entry]), maxAttempts: 1
    }), /changes the explicit quantity|quantity is invalid/, entry.sourceText);
  }
});

test('the two model passes may use equivalent mass or volume units', async () => {
  const equivalentBread = { ...bread, quantity: { amount: 0.5, unit: 'kg' } };
  const equivalentMilk = { ...milk, quantity: { amount: 2000, unit: 'ml' } };
  const request = `I want ${bread.sourceText} and ${milk.sourceText}`;
  const plan = await understandShoppingRequest(request, {
    callModel: responses([bread, equivalentMilk], [equivalentBread, milk])
  });
  assert.deepEqual(plan.items.map(entry => entry.quantity), [equivalentBread.quantity, milk.quantity]);
});

test('optional qualifiers need a preference cue and mandatory qualifiers retain their negation', async () => {
  const optionalByMistake = item('organic oats', 'oats', 'שיבולת שועל', 0, 'unspecified', [preferred('organic')]);
  await assert.rejects(understandShoppingRequest(optionalByMistake.sourceText, {
    callModel: responses([optionalByMistake]), maxAttempts: 1
  }), /optional without preference wording/);
  const intentionallyOptional = { ...optionalByMistake, sourceText: 'oats, a preference for organic' };
  const preferredPlan = await understandShoppingRequest(intentionallyOptional.sourceText, {
    callModel: responses([intentionallyOptional], [intentionallyOptional])
  });
  assert.deepEqual(preferredPlan.items[0].preferences, ['organic']);

  const inverted = item('not sliced bread', 'not sliced bread', 'לחם', 0, 'unspecified', [required('sliced')]);
  await assert.rejects(understandShoppingRequest(inverted.sourceText, {
    callModel: responses([inverted]), maxAttempts: 1
  }), /drops the negation/);
  const negated = { ...inverted, constraintEvidence: [required('not sliced')] };
  const negatedPlan = await understandShoppingRequest(negated.sourceText, { callModel: responses([negated], [negated]) });
  assert.deepEqual(negatedPlan.items[0].requirements, ['not sliced']);
});

test('typed package counts and exact per-unit size survive shopping extraction', async () => {
  const water = item('6 bottles × 500 ml of water', 'water', 'מים', 6, 'bottle', [required('500 ml')]);
  const loaf = item('one loaf of bread', 'bread', 'לחם', 1, 'loaf');
  const source = `I want ${water.sourceText} and ${loaf.sourceText}`;
  const plan = await understandShoppingRequest(source, { callModel: responses([water, loaf], [water, loaf]) });
  assert.deepEqual(plan.items.map(entry => entry.quantity), [{ amount: 6, unit: 'bottle' }, { amount: 1, unit: 'loaf' }]);
  assert.deepEqual(plan.items[0].requirements, ['500 ml']);
  const droppedSize = { ...water, constraintEvidence: [] };
  await assert.rejects(understandShoppingRequest(source, {
    callModel: responses([droppedSize, loaf]), maxAttempts: 1
  }), /omits the required size per bottle/);
  const lostQuantity = { ...milk, quantity: { amount: 3, unit: 'l' } };
  await assert.rejects(understandShoppingRequest(singleRequest, {
    callModel: responses([lostQuantity]), maxAttempts: 1
  }), /changes the explicit quantity "2 liters"/);
  const lostEggCount = { ...eggs, quantity: { amount: 1, unit: 'units' } };
  await assert.rejects(understandShoppingRequest(eggs.sourceText, {
    callModel: responses([lostEggCount], [lostEggCount]), maxAttempts: 1
  }), /changes the explicit quantity "12"/);
});

test('saved legacy plans catch the original omission and new plans reject stripped requirements', async () => {
  const old = {
    userRequest: multiRequest,
    items: [
      { product: 'milk', requirements: [], preferences: ['Tnuva'] },
      { product: 'eggs', requirements: [], preferences: [] },
      { product: 'bread', requirements: [], preferences: [] },
      { product: 'shredded mozzarella', requirements: [], preferences: [] }
    ]
  };
  assert.throws(() => assertShoppingPlanCoverage(old), /does not account for "3%" as a requirement/);
  old.items[0].requirements.push('3% fat');
  assert.equal(assertShoppingPlanCoverage(old), old);
  const current = await understandShoppingRequest(singleRequest, { callModel: responses([milk], [milk]) });
  current.items[0].requirements = [];
  assert.throws(() => assertShoppingPlanCoverage(current), /inconsistent requirements/);
});
