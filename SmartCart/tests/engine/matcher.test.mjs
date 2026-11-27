import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';
import {
  matchProducts, runMatchWithCheckpoint, searchProductsForItem, validateMatchBatch
} from '../../engine/smartcart-matcher.mjs';

const check = (requirement, evidence, kind = 'OTHER', evidenceSource = 'NAME', result = 'MET') =>
  ({ requirement, kind, result, evidenceSource, evidence });

// A confirmed identity, quoting the candidate's name as the real matcher must.
const decision = (target, requirementChecks = [], preferencesMet = []) => {
  const { _id, id = _id, name = '' } = typeof target === 'string' ? { id: target } : target;
  return {
    id, candidate: 'Fixture product', identityEvidence: name, relation: 'SAME_PRODUCT', identity: 'MATCH',
    requirementChecks, preferencesMet
  };
};

const candidateIds = prompt => JSON.parse(prompt.split('\nProducts: ').at(-1)).map(product => product.id);

function validateOne(name, requirement, evidence) {
  const product = { _id: 'candidate', name };
  const raw = { decisions: [decision(product, [check(requirement, evidence)])] };
  return validateMatchBatch(raw, [product], [], [requirement])[0];
}

test('a grounded model quote cannot substitute another fat percentage or ingredient', () => {
  const wrong = validateOne('חלב תנובה 1% 1 לי', '3% fat', '1%');
  assert.equal(wrong.status, 'NO_MATCH');
  assert.equal(wrong.requirementChecks[0].evidence, '1%');
  assert.match(wrong.reason, /Contradicts.*3% fat/);
  assert.equal(validateOne('Milk 13%', '3%', '3%').status, 'NO_MATCH');
  assert.equal(validateOne('Milk with 3% cocoa and 1% fat', '3% fat', '3%').status, 'NO_MATCH');
  assert.equal(validateOne('Milk with 3% cocoa', '3% fat', '3%').status, 'UNCERTAIN');
  assert.equal(validateOne('Milk 3%', '3% fat', 'invented quote').status, 'UNCERTAIN');
  assert.equal(validateOne('חלב תנובה 3% שומן 1 ליטר', '3%', '3%').status, 'MATCH');
  assert.equal(validateOne('Yogurt 0% fat', '0% fat', '0%').status, 'MATCH');
  assert.equal(validateOne('Yogurt 0%–3% fat', '0% fat', '0%').status, 'UNCERTAIN');
  assert.equal(validateOne('Yogurt up to 3% fat', '3% fat', '3%').status, 'UNCERTAIN');
  assert.equal(validateOne('Yogurt 0–3% fat', '3% fat', '3%').status, 'UNCERTAIN');
  assert.equal(validateOne('Yogurt -1% fat', '1% fat', '1%').status, 'UNCERTAIN');
});

test('marketing comparisons and other nutrients do not establish an exact fat percentage', () => {
  for (const [name, requirement, status] of [
    ['Yogurt 3% less fat', '3% fat', 'UNCERTAIN'],
    ['Milk fat reduced by 3%', '3% fat', 'UNCERTAIN'],
    ['Chocolate 3% off', '3%', 'UNCERTAIN'],
    ['Yogurt 3% protein', '3% fat', 'UNCERTAIN'],
    ['יוגורט 3% חלבון', '3%', 'UNCERTAIN'],
    ['Milk 3% fat reduction', '3% fat', 'UNCERTAIN'],
    ['Yogurt 3% fat or above', '3% fat', 'UNCERTAIN'],
    ['Chocolate with 3% cocoa coating', '3% cocoa', 'UNCERTAIN'],
    ['Reduced-fat milk 3%', '3% fat', 'MATCH'],
    ['Yogurt 3% fat and 8% protein', '3% fat', 'MATCH']
  ]) {
    assert.equal(validateOne(name, requirement, '3%').status, status, name);
  }
});

test('diet, grain and form checks require the whole label or a supported equivalent', () => {
  for (const [name, requirement, evidence, status] of [
    ['Lemonade with no added sugar', 'sugar-free', 'no added sugar', 'UNCERTAIN'],
    ['לימונדה ללא סוכר', 'sugar-free', 'ללא סוכר', 'MATCH'],
    ['Milk contains lactose', 'lactose-free', 'contains lactose', 'NO_MATCH'],
    ['חלב נטול לקטוז', 'lactose-free', 'נטול לקטוז', 'MATCH'],
    ['Crackers contain gluten', 'gluten-free', 'gluten', 'NO_MATCH'],
    ['לחם ללא גלוטן', 'gluten-free', 'ללא גלוטן', 'MATCH'],
    ['לחם 100% קמח חיטה מלאה', '100% whole wheat', '100%', 'MATCH'],
    ['לחם 100% קמח שיפון עם חיטה מלאה', '100% whole wheat', '100%', 'UNCERTAIN'],
    ['לחם לא 100% קמח חיטה מלאה', '100% whole wheat', '100%', 'UNCERTAIN'],
    ['100% whole wheat-free crackers', '100% whole wheat', '100%', 'UNCERTAIN'],
    ['Butter salted 200 g', 'unsalted', 'salted', 'NO_MATCH'],
    ['Butter unsalted 200 g', 'unsalted', 'unsalted', 'MATCH'],
    ['חמאה לא מלוחה 200 גרם', 'unsalted', 'לא מלוחה', 'MATCH'],
    ['חמאה רכה עם מלח200 גרם', 'unsalted', 'עם מלח', 'NO_MATCH'],
    ['פתיתי מוצרלה 22% 500 גרם', 'shredded', 'פתיתי מוצרלה', 'MATCH'],
    ['Mozzarella sticks', 'shredded', 'sticks', 'NO_MATCH'],
    ['Butter 200 g', 'cultured', 'butter', 'UNCERTAIN']
  ]) {
    assert.equal(validateOne(name, requirement, evidence).status, status, `${requirement} / ${name}`);
  }
});

test('a qualified negation or an ingredient claim does not qualify the full product', () => {
  for (const [name, requirement, evidence, status] of [
    ['Crackers not certified gluten-free', 'gluten-free', 'gluten-free', 'UNCERTAIN'],
    ['Cookies no longer sugar-free', 'sugar-free', 'sugar-free', 'UNCERTAIN'],
    ['קרקרים לא בהכרח ללא גלוטן', 'gluten-free', 'ללא גלוטן', 'UNCERTAIN'],
    ['Crackers with gluten-free filling', 'gluten-free', 'gluten-free', 'UNCERTAIN'],
    ['קרקרים עם ציפוי ללא גלוטן', 'gluten-free', 'ללא גלוטן', 'UNCERTAIN'],
    ['Candies with sugar-free coating', 'sugar-free', 'sugar-free', 'UNCERTAIN'],
    ['Naturally gluten-free crackers', 'gluten-free', 'gluten-free', 'MATCH'],
    ['Lemonade with no added sugar', 'no added sugar', 'no added sugar', 'MATCH'],
    ['Chocolate gluten-free, may contain gluten', 'gluten-free', 'gluten-free', 'UNCERTAIN']
  ]) {
    assert.equal(validateOne(name, requirement, evidence).status, status, name);
  }
});

test('a per-bottle requirement measures each bottle and rejects a matching pack total', async () => {
  const item = {
    product: 'water', requirements: ['500 ml'], preferences: [],
    quantity: { amount: 6, unit: 'bottle' },
    constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '6 bottles × 500 ml', value: '500 ml' }]
  };
  const products = [
    { _id: 'per-unit', name: 'Water 6 bottles × 500 ml', package: { quantity: 3, unit: 'l' } },
    { _id: 'pack-total', name: 'Water 2 bottles × 250 ml, total 500 ml', package: { quantity: 500, unit: 'ml' } },
    { _id: 'singular', name: 'Water bottle', package: { quantity: 500, unit: 'ml' } },
    { _id: 'ambiguous', name: 'Water 6 bottles 500 ml', package: { quantity: 500, unit: 'ml' } },
    { _id: 'hebrew', name: 'מים 6 בקבוקים × 500 מ״ל', package: { quantity: 3, unit: 'l' } }
  ];
  const raw = { decisions: products.map(p => decision(p, [
    check('500 ml', p._id === 'hebrew' ? '500 מ״ל' : '500 ml', 'OTHER', p._id === 'singular' ? 'PACKAGE' : 'NAME')
  ])) };
  const result = validateMatchBatch(raw, products, [], item.requirements, { item });
  assert.deepEqual(result.map(row => row.status), ['MATCH', 'NO_MATCH', 'MATCH', 'UNCERTAIN', 'MATCH']);
  assert.equal(result[2].requirementChecks[0].evidenceSource, 'PACKAGE');
  const resumed = await matchProducts({
    item, products, initialDecisions: result,
    callModel: async () => assert.fail('Hebrew package evidence must survive checkpoint reopening')
  });
  assert.deepEqual(resumed.matches.map(row => row.product._id), ['per-unit', 'singular', 'hebrew']);
});

test('an exact sale package size checks the full pack instead of a matching component', () => {
  const item = { product: 'yogurt', requirements: ['500 g'], preferences: [], quantity: { amount: 500, unit: 'g' } };
  const products = [
    { _id: 'single', name: 'Yogurt 500 g', package: { quantity: 500, unit: 'g' } },
    { _id: 'fourpack', name: 'Yogurt 4 × 500 g', package: { quantity: 500, unit: 'g' } },
    { _id: 'weighted', name: 'Yogurt 500 g', package: { quantity: 500, unit: 'g', isWeighted: true } }
  ];
  const raw = { decisions: products.map(p => decision(p, [check('500 g', '500 g')])) };
  assert.deepEqual(validateMatchBatch(raw, products, [], item.requirements, { item }).map(d => d.status),
    ['MATCH', 'NO_MATCH', 'UNCERTAIN']);
});

test('required Tnuva brand uses its labeled name or manufacturer and keeps missing ownership uncertain', () => {
  const products = [
    { _id: 'shufersal', name: 'פתיתי מוצרלה 22% 500 גרם', manufacturer: { name: 'תנובה בע"מ' } },
    { _id: 'rami', name: 'מוצרלה מגורדת 22% שומן השף הלבן 200 גרם', manufacturer: 'תנובה' },
    { _id: 'weighted', name: 'מוצרלה תנובה מגורדת', manufacturer: null },
    { _id: 'unknown', name: 'נעם מוצרלה 23% מגורדת', manufacturer: null },
    { _id: 'wrong', name: 'גבינת מוצרלה מגורדת 300 גרם', manufacturer: { name: 'מחלבות גד' } }
  ];
  const decisions = products.map(({ _id, name, manufacturer }) => decision({ _id, name }, [
    check('shredded', _id === 'shufersal' ? 'פתיתי מוצרלה' : 'מגורדת'),
    _id === 'wrong'
      ? check('Tnuva', manufacturer.name, 'BRAND', 'MANUFACTURER', 'CONTRADICTED')
      : manufacturer
        ? check('Tnuva', manufacturer.name ?? manufacturer, 'BRAND', 'MANUFACTURER')
        : check('Tnuva', name.split(' ')[1], 'BRAND')
  ], ['Tnuva', 'fabricated']));
  const parsed = validateMatchBatch({ decisions }, products, [], ['shredded', 'Tnuva']);
  assert.deepEqual(parsed.map(row => row.status), ['MATCH', 'MATCH', 'MATCH', 'UNCERTAIN', 'NO_MATCH']);
  assert.deepEqual(parsed.map(row => row.preferencesMet), [[], [], [], [], []]);
});

test('a soft brand preference never affects eligibility and needs brand evidence to earn credit', () => {
  const products = [
    { _id: 'preferred', name: 'חלב תנובה 3%' },
    { _id: 'other', name: 'חלב 3%', manufacturer: 'מחלבות יטבתה' }
  ];
  const parsed = validateMatchBatch({
    decisions: products.map(product => decision(product, [check('3%', '3%')], ['Tnuva', '3%', 'invented']))
  }, products, ['Tnuva'], ['3%']);
  assert.deepEqual(parsed.map(row => row.status), ['MATCH', 'MATCH']);
  assert.deepEqual(parsed.map(row => row.preferencesMet), [['Tnuva'], []]);
});

test('a known brand alias remains verifiable when the model calls it a general attribute', () => {
  const product = { _id: 'preferred', name: 'חלב תנובה 3%' };
  const raw = { decisions: [decision(product, [check('Tnuva', 'תנובה')])] };
  const item = { constraintEvidence: [{ value: 'Tnuva', kind: 'OTHER', type: 'REQUIREMENT' }] };
  const [matched] = validateMatchBatch(raw, [product], [], ['Tnuva'], { item });
  assert.equal(matched.status, 'MATCH');
  assert.equal(matched.requirementChecks[0].kind, 'BRAND');

  const unknown = { _id: 'unknown', name: 'חלב 3%', manufacturer: 'N/A' };
  const unknownRaw = { decisions: [
    decision(unknown, [check('Tnuva', 'N/A', 'BRAND', 'MANUFACTURER', 'CONTRADICTED')])
  ] };
  assert.equal(validateMatchBatch(unknownRaw, [unknown], [], ['Tnuva'])[0].status, 'UNCERTAIN');
});

test('unverified or contradicted optional product attributes do not get preference credit', () => {
  const preferences = ['70% cocoa', 'sugar-free'];
  const products = [
    { _id: 'preferred', name: 'Sugar-free chocolate 70% cocoa' },
    { _id: 'contradicted', name: 'Chocolate 50% cocoa with sugar' },
    { _id: 'unlabeled', name: 'Plain chocolate' }
  ];
  const parsed = validateMatchBatch({
    decisions: products.map(product => decision(product, [], preferences))
  }, products, preferences);
  assert.deepEqual(parsed.map(row => row.status), ['MATCH', 'MATCH', 'MATCH']);
  assert.deepEqual(parsed.map(row => row.preferencesMet), [preferences, [], []]);
});

test('English and Hebrew organic and free-range claims require an explicit product label', () => {
  const name = '12ביצים חופש אורגניות M';
  assert.equal(validateOne(name, 'organic', 'אורגניות').status, 'MATCH');
  assert.equal(validateOne(name, 'free-range', 'ביצים חופש').status, 'MATCH');
  assert.equal(validateOne('Organic free-range eggs', 'אורגניות', 'Organic').status, 'MATCH');
  assert.equal(validateOne('Organic free-range eggs', 'ביצים חופש', 'free-range').status, 'MATCH');
  assert.equal(validateOne('12ביצים רגילות סדרת חופש', 'free range', 'חופש').status, 'UNCERTAIN');
  assert.equal(validateOne('Cage-free eggs', 'free range', 'Cage-free').status, 'UNCERTAIN');
  assert.equal(validateOne('Non-organic eggs', 'organic', 'organic').status, 'NO_MATCH');

  const preferences = ['organic', 'free range'];
  const products = [
    { _id: 'labeled', name },
    { _id: 'unverified', name: '12ביצים רגילות סדרת חופש' }
  ];
  const parsed = validateMatchBatch({
    decisions: products.map(product => decision(product, [], preferences))
  }, products, preferences);
  assert.deepEqual(parsed.map(row => row.preferencesMet), [preferences, []]);
});

const milk = {
  product: 'milk', requirements: ['3%'], preferences: ['Tnuva'],
  quantity: { amount: 2, unit: 'l' }, searchTerms: ['חלב']
};
const milkWith = id => ({ _id: id, name: 'חלב תנובה 3%', pricing: { listedPriceIls: 7.2 } });
const milkDecision = id => decision({ id, name: 'חלב תנובה 3%' }, [check('3%', '3%')], ['Tnuva']);

test('retry covers omitted candidates, missing checks and invalid decisions without reusing valid candidates', async () => {
  const requested = [];
  const products = ['valid', 'omitted', 'no-check', 'bad', 'duplicate'].map(milkWith);
  const result = await matchProducts({
    item: milk, products,
    callModel: async ({ prompt }) => {
      const ids = candidateIds(prompt);
      requested.push(ids);
      if (requested.length === 1) return {
        decisions: [milkDecision('valid'), decision('no-check'),
          { ...milkDecision('bad'), identity: 'invalid' },
          milkDecision('duplicate'), milkDecision('duplicate'), milkDecision('unexpected')]
      };
      assert.match(prompt, /omitted requirement checks for no-check/);
      return { decisions: ids.map(milkDecision) };
    }
  });
  assert.deepEqual(requested, [
    ['valid', 'omitted', 'no-check', 'bad', 'duplicate'], ['omitted', 'no-check', 'bad', 'duplicate']
  ]);
  assert.deepEqual(result.matches.map(row => row.product._id), ['valid', 'omitted', 'no-check', 'bad', 'duplicate']);
});

test('a model exception leaves earlier batches available for checkpoint resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartcart-matcher-'));
  const checkpointPath = join(directory, 'match-progress.json');
  t.after(async () => {
    await rm(checkpointPath, { force: true });
    await rmdir(directory);
  });
  const config = { item: milk, products: ['first', 'second', 'third'].map(milkWith), checkpointPath, batchSize: 2 };
  await assert.rejects(runMatchWithCheckpoint({
    ...config,
    callModel: async ({ prompt }) => {
      const ids = candidateIds(prompt);
      if (ids.includes('third')) throw new Error('model disconnected');
      return { decisions: ids.map(milkDecision) };
    }
  }), /model disconnected/);
  const calls = [];
  const resumed = await runMatchWithCheckpoint({
    ...config,
    callModel: async ({ prompt }) => {
      const ids = candidateIds(prompt);
      calls.push(ids);
      return { decisions: ids.map(milkDecision) };
    }
  });
  assert.deepEqual(calls, [['third']]);
  assert.deepEqual(resumed.matches.map(row => row.product._id), ['first', 'second', 'third']);
});

test('disk resume saves partial batches and invalidates product prices or request context changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartcart-matcher-'));
  const checkpointPath = join(directory, 'match-progress.json');
  t.after(async () => {
    await rm(checkpointPath, { force: true });
    await rmdir(directory);
  });
  const context = createItemContext({ userRequest: 'original', items: [milk] }, 0);
  const products = ['first', 'pending'].map(milkWith);
  const config = { item: milk, products, context, checkpointPath };
  await assert.rejects(runMatchWithCheckpoint({
    ...config, maxAttempts: 1, callModel: async () => ({ decisions: [milkDecision('first')] })
  }), /First unresolved ID: pending/);
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.deepEqual(checkpoint.decisions.map(entry => entry.id), ['first']);

  const calls = [];
  const callModel = async ({ prompt }) => {
    const ids = candidateIds(prompt);
    calls.push(ids);
    return { decisions: ids.map(milkDecision) };
  };
  const resumed = await runMatchWithCheckpoint({ ...config, callModel });
  assert.deepEqual(calls, [['pending']]);
  assert.deepEqual(resumed.matches.map(row => row.product._id), ['first', 'pending']);
  assert.deepEqual(resumed.context, context);

  const updatedProducts = [{ ...products[0], pricing: { listedPriceIls: 7.4 } }, products[1]];
  const updated = await runMatchWithCheckpoint({ ...config, products: updatedProducts, callModel });
  assert.equal(updated.matches[0].product.pricing.listedPriceIls, 7.4);
  const anotherContext = createItemContext({ userRequest: 'rewritten', items: [milk] }, 0);
  await runMatchWithCheckpoint({ ...config, products: updatedProducts, context: anotherContext, callModel });
  assert.deepEqual(calls, [['pending'], ['first', 'pending'], ['first', 'pending']]);
});

test('checkpoint validation preserves uncertainty and discards a changed status without proof', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartcart-matcher-'));
  const checkpointPath = join(directory, 'match-progress.json');
  t.after(async () => {
    await rm(checkpointPath, { force: true });
    await rmdir(directory);
  });
  const products = [{ _id: 'unlabeled', name: 'חלב תנובה' }];
  const config = { item: milk, products, checkpointPath };
  const raw = { decisions: [decision('unlabeled', [check('3%', 'חלב')])] };
  const result = await runMatchWithCheckpoint({ ...config, callModel: async () => raw });
  assert.equal(result.uncertain.length, 1);
  const resumed = await runMatchWithCheckpoint({
    ...config, callModel: async () => assert.fail('validated uncertainty should be reusable')
  });
  assert.equal(resumed.uncertain.length, 1);
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  saved.decisions[0].status = 'MATCH';
  await writeFile(checkpointPath, JSON.stringify(saved));
  let checked = false;
  const revalidated = await runMatchWithCheckpoint({
    ...config, callModel: async () => { checked = true; return raw; }
  });
  assert.equal(checked, true);
  assert.equal(revalidated.uncertain.length, 1);
});

test('search output must identify the exact request and item', () => {
  const plan = { userRequest: 'request', items: [milk, { ...milk, quantity: { amount: 1, unit: 'l' } }] };
  const context = createItemContext(plan, 0);
  const products = [milkWith('first')];
  assert.equal(searchProductsForItem({
    context, itemIndex: 0, searchTerms: milk.searchTerms, results: products
  }, context, milk), products);
  assert.throws(() => searchProductsForItem({
    context: createItemContext({ ...plan, userRequest: 'changed' }, 0), results: products
  }, context, milk), /different shopping request or item/);
  assert.throws(() => searchProductsForItem({
    context: createItemContext(plan, 1), results: products
  }, context, milk), /Pipeline context/);
  assert.throws(() => searchProductsForItem({
    context, itemIndex: 0, searchTerms: ['מיץ'], results: products
  }, context, milk), /terms differ/);
  assert.throws(() => searchProductsForItem({ results: products }, context, milk), /Run search again/);
  assert.throws(() => searchProductsForItem({
    context: null, itemIndex: 0, searchTerms: milk.searchTerms, results: products
  }, context, milk), /Pipeline context/);
  assert.equal(searchProductsForItem({
    itemIndex: 0, searchTerms: milk.searchTerms, results: products
  }, context, milk), products);
});

test('conflicting catalog offers with a reused ID cannot silently collapse stores', async () => {
  await assert.rejects(matchProducts({
    item: milk, products: [
      { ...milkWith('duplicated'), storeId: '001' }, { ...milkWith('duplicated'), storeId: '002' }
    ],
    callModel: async () => assert.fail('should reject before calling the model')
  }), /Conflicting catalog offers/);
});
