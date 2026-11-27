import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { auditCatalog } from '../../engine/smartcart-catalog-audit.mjs';
import { optimizeBaskets } from '../../engine/smartcart-basket-optimizer.mjs';
import { assertShoppingPlanCoverage, understandShoppingRequest } from '../../engine/smartcart-llm.mjs';
import { matchProducts, runMatchWithCheckpoint } from '../../engine/smartcart-matcher.mjs';
import { createItemContext, exactStoreKey } from '../../engine/smartcart-pipeline-context.mjs';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { buildCatalog, searchCatalog } from '../../engine/smartcart-search.mjs';
import { catalogOffer, claim, confirmedOffer, decision, shoppingItem, submittedCandidates } from './fixtures/qa-catalog.mjs';

const exec = promisify(execFile);

async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'smartcart-qa-'));
  t.after(async () => {
    for (const file of await readdir(path)) await rm(join(path, file));
    await rmdir(path);
  });
  return path;
}

function runCli(cwd, script, ...args) {
  return exec(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
    fileURLToPath(new URL(`../../engine/${script}.mjs`, import.meta.url)), ...args], { cwd });
}

const required = (sourceText, kind = 'OTHER') => ({ type: 'REQUIREMENT', kind, sourceText });
const preferred = sourceText => ({ type: 'PREFERENCE', kind: 'BRAND', sourceText });
const raw = (product, sourceText, coreSearchTerm, constraintEvidence = [], quantity = { amount: 0, unit: 'unspecified' }) =>
  ({ product, sourceText, coreSearchTerm, constraintEvidence, searchTerms: [], quantity });
const mockExtraction = items => async () => ({ items });

async function pipeline(plan, products, mockDecision) {
  assertShoppingPlanCoverage(plan);
  const catalog = buildCatalog(products);
  const matched = [];
  for (const [index, item] of plan.items.entries()) {
    const { results: candidates } = searchCatalog(catalog, item);
    matched.push(await matchProducts({
      item, products: candidates, context: createItemContext(plan, index),
      callModel: async ({ prompt }) => ({ decisions: submittedCandidates(prompt).map(row => mockDecision(row, item)) })
    }));
  }
  const files = matched.map(buildQuantityPriceOptions);
  return { matched, files, result: optimizeBaskets(files, { request: plan }) };
}

function assertBasketInvariants(basket, plan, products) {
  assert.ok(basket);
  const lookup = new Map(products.map(product => [product._id, product]));
  let cents = 0;
  for (const line of basket.items) {
    const item = plan.items[line.itemIndex];
    assert.ok(item, 'Basket line refers to a requested item');
    assert.ok(line.preferencesSatisfied.every(value => item.preferences.includes(value)));
    for (const product of line.products) {
      assert.equal(exactStoreKey(lookup.get(product.productId)), basket.storeKey);
      assert.ok(Number.isSafeInteger(product.packageCount) && product.packageCount > 0);
      assert.ok(Number.isFinite(product.linePriceIls) && product.linePriceIls > 0);
      assert.deepEqual(product.requirementChecks.map(check => check.requirement), item.requirements);
      assert.ok(product.requirementChecks.every(check => check.result === 'MET'));
      cents += Math.round(product.linePriceIls * 100);
    }
  }
  assert.equal(Math.round(basket.totalPriceIls * 100), cents);
}

test('QA 98 dietary shopping rejects contradictory and unproven labels through the entire pipeline', async () => {
  const request = 'I want gluten-free bread, lactose-free milk, and sugar-free yogurt.';
  const rows = [
    raw('bread', 'gluten-free bread', 'לחם', [required('gluten-free')]),
    raw('milk', 'lactose-free milk', 'חלב', [required('lactose-free')]),
    raw('yogurt', 'sugar-free yogurt', 'יוגורט', [required('sugar-free')])
  ];
  const plan = await understandShoppingRequest(request, { callModel: mockExtraction(rows) });
  const offered = [
    catalogOffer('safe-bread', 'לחם ללא גלוטן 500 גרם', { size: 500, unit: 'g', price: 8 }),
    catalogOffer('wrong-bread', 'לחם מכיל גלוטן 500 גרם', { size: 500, unit: 'g', price: 1 }),
    catalogOffer('safe-milk', 'חלב ללא לקטוז 1 ליטר', { size: 1, unit: 'l', price: 9 }),
    catalogOffer('wrong-milk', 'חלב עם לקטוז 1 ליטר', { size: 1, unit: 'l', price: 1 }),
    catalogOffer('safe-yogurt', 'יוגורט ללא סוכר 150 גרם', { size: 150, unit: 'g', price: 6 }),
    catalogOffer('unknown-yogurt', 'יוגורט ללא תוספת סוכר 150 גרם', { size: 150, unit: 'g', price: 1 })
  ];
  const run = (items, catalog) => pipeline(items, catalog, (candidate, item) =>
    decision(candidate, { checks: [claim(item.requirements[0], candidate.name)] }));
  const { matched, result } = await run(plan, offered);
  assert.deepEqual(matched.map(row => [row.matches.length, row.rejected.length, row.uncertain.length]),
    [[1, 1, 0], [1, 1, 0], [1, 0, 1]]);
  assert.deepEqual(result.recommendedBasket.items.flatMap(line => line.products.map(p => p.productId)),
    ['safe-bread', 'safe-milk', 'safe-yogurt']);
  assert.equal(result.recommendedBasket.totalPriceIls, 23);
  assertBasketInvariants(result.recommendedBasket, plan, offered);
  const reversed = await run(plan, [...offered].reverse());
  const repeat = await run(plan, offered);
  assert.deepEqual(reversed.result.recommendedBasket, result.recommendedBasket, 'Candidate ordering independence');
  assert.deepEqual(repeat.result, result, 'QA 102 repeated fixture produces identical basket');
});

test('QA 99 hard Gad and optional Tnuva stay with their original items', async () => {
  const request = 'I want only Gad mozzarella and milk, preferably Tnuva.';
  const rows = [
    raw('mozzarella', 'only Gad mozzarella', 'מוצרלה', [required('Gad', 'BRAND')]),
    raw('milk', 'milk, preferably Tnuva', 'חלב', [preferred('Tnuva')])
  ];
  const plan = await understandShoppingRequest(request, { callModel: mockExtraction(rows) });
  const offers = [
    catalogOffer('gad-cheese', 'מוצרלה גד', { manufacturer: 'גד', price: 20 }),
    catalogOffer('tnuva-cheese', 'מוצרלה תנובה', { manufacturer: 'תנובה', price: 1 }),
    catalogOffer('tnuva-milk', 'חלב תנובה', { manufacturer: 'תנובה', price: 7 }),
    catalogOffer('tara-milk', 'חלב טרה', { manufacturer: 'טרה', price: 6 })
  ];
  const { matched, result } = await pipeline(plan, offers, (candidate, item) => {
    const checks = item.requirements.map(value => claim(value, candidate.manufacturer, {
      kind: 'BRAND', source: 'MANUFACTURER', result: candidate.id === 'gad-cheese' ? 'MET' : 'CONTRADICTED'
    }));
    return decision(candidate, { checks, preferences: candidate.id === 'tnuva-milk' ? ['Tnuva'] : [] });
  });
  assert.deepEqual(matched[0].rejected.map(row => row.product._id), ['tnuva-cheese']);
  assert.deepEqual(matched[1].matches.map(row => row.preferencesMet), [['Tnuva'], []]);
  assert.deepEqual(result.recommendedBasket.items.map(line => line.products[0].productId), ['gad-cheese', 'tnuva-milk']);
  assertBasketInvariants(result.recommendedBasket, plan, offers);
});

test('QA 100 CLI fails on corrupt stage JSON without writing a successful basket', async t => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'broken.json'), '{"item":', 'utf8');
  await assert.rejects(runCli(cwd, 'smartcart-basket-optimizer', 'broken.json'), /JSON|Unexpected end/u);
  await assert.rejects(access(join(cwd, 'basket-results.json')), { code: 'ENOENT' });
});

test('QA 101, 108–110 network interruption resumes completed work and a new item invalidates it', async t => {
  const cwd = await temporaryDirectory(t);
  const checkpointPath = join(cwd, 'match-progress.json');
  const item = shoppingItem('milk', 2, 'l', { terms: ['חלב'] });
  const plan = { userRequest: '2 liters of milk', items: [item] };
  const products = ['a', 'b', 'c'].map(id => catalogOffer(id, `חלב ${id}`, { size: 1, unit: 'l' }));
  const calls = [];
  const setup = { item, products, batchSize: 1, maxAttempts: 1, checkpointPath, context: createItemContext(plan, 0) };
  const send = (prompt, failingId) => {
    const [candidate] = submittedCandidates(prompt);
    calls.push(candidate.id);
    if (candidate.id === failingId) {
      const offline = new Error('Network unavailable in fixture');
      offline.code = 'ENETUNREACH';
      throw offline;
    }
    return { decisions: [decision(candidate)] };
  };
  await assert.rejects(runMatchWithCheckpoint({
    ...setup, callModel: async ({ prompt }) => send(prompt, 'b')
  }), /Network unavailable|network/u);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(JSON.parse(await readFile(checkpointPath, 'utf8')).decisions.length, 1);
  calls.length = 0;
  const resumed = await runMatchWithCheckpoint({ ...setup, callModel: async ({ prompt }) => send(prompt) });
  assert.deepEqual(calls, ['b', 'c']);
  assert.deepEqual(resumed.matches.map(row => row.product._id), ['a', 'b', 'c']);
  const repeat = await runMatchWithCheckpoint({ ...setup, callModel: () => assert.fail('Reusable completed checkpoint') });
  assert.deepEqual(repeat, resumed);
  const other = { ...item, quantity: { amount: 3, unit: 'l' } };
  const next = { userRequest: '3 liters of milk', items: [other] };
  calls.length = 0;
  const invalidated = await runMatchWithCheckpoint({ ...setup, item: other, context: createItemContext(next, 0),
    callModel: async ({ prompt }) => send(prompt) });
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(invalidated.item.quantity.amount, 3);
});

test('QA 103 missing product gives an explicit incomplete-store result', async () => {
  const rows = [raw('milk', 'milk', 'חלב'), raw('moon cereal', 'moon cereal', 'קורנפלקס')];
  const plan = await understandShoppingRequest('I want milk and moon cereal.', { callModel: mockExtraction(rows) });
  const offers = [catalogOffer('milk', 'חלב 1 ליטר', { size: 1, unit: 'l' })];
  const { matched, result } = await pipeline(plan, offers, candidate => decision(candidate));
  assert.equal(matched[1].totalCandidates, 0);
  assert.equal(result.recommendedBasket, null);
  assert.equal(result.noCompleteBasket, true);
  assert.deepEqual(result.excludedStores[0].missingItems.map(item => item.product), ['moon cereal']);
});

test('QA 106 processes 20 different grocery items with complete candidate and basket coverage', async () => {
  const groceries = [
    ['milk', 'חלב'], ['eggs', 'ביצים'], ['bread', 'לחם'], ['rice', 'אורז'], ['pasta', 'פסטה'],
    ['beans', 'שעועית'], ['tea', 'תה'], ['coffee', 'קפה'], ['pepper', 'פלפל'], ['salt', 'מלח'],
    ['apples', 'תפוחים'], ['bananas', 'בננות'], ['tomatoes', 'עגבניות'], ['potatoes', 'תפוחי אדמה'],
    ['soap', 'סבון'], ['toothpaste', 'משחת שיניים'], ['shampoo', 'שמפו'], ['paper towels', 'מגבות נייר'],
    ['oats', 'שיבולת שועל'], ['sardines', 'סרדינים']
  ];
  const rows = groceries.map(([product, name]) => raw(product, product, name));
  const plan = await understandShoppingRequest(`I want ${groceries.map(([product]) => product).join(', ')}.`,
    { callModel: mockExtraction(rows) });
  const offers = groceries.map(([, name], index) => catalogOffer(`sku-${index}`, name, { price: (100 + index) / 100 }));
  let calls = 0;
  const { matched, result } = await pipeline(plan, offers, candidate => {
    calls++;
    return decision(candidate);
  });
  assert.equal(plan.items.length, 20);
  assert.ok(matched.every(record => record.matches.length + record.rejected.length + record.uncertain.length === record.totalCandidates));
  assert.equal(calls, matched.reduce((sum, result) => sum + result.totalCandidates, 0));
  assert.deepEqual(result.recommendedBasket.items.map(line => line.item), groceries.map(([name]) => name));
  assert.equal(result.recommendedBasket.totalPriceIls, 21.90);
  assertBasketInvariants(result.recommendedBasket, plan, offers);
});

test('QA 112 and catalog audit classify records, preserve file bytes, and distinguish store duplicates', async t => {
  const cwd = await temporaryDirectory(t);
  const catalogPath = join(cwd, 'catalog.json');
  const validOffer = (id, store) => ({
    ...catalogOffer(id, 'לחם 500 גרם', { store, code: 'bread-barcode', size: 500, unit: 'g',
      price: 10, manufacturer: 'Bakery' }),
    pricing: { listedPriceIls: 10, publishedUnitPriceIls: 2, publishedUnitPriceBasis: '100 גרם' },
    priceUpdatedAt: '2026-11-18T08:00:00'
  });
  const mismatch = { ...validOffer('duplicate', '2'), productCode: 'egg-barcode', name: 'ביצים 12 יחידות',
    package: { quantity: 1, unit: 'unit', isWeighted: false }, priceUpdatedAt: '2026-09-19', manufacturer: {} };
  const invalid = { ...validOffer('duplicate', '3'), productCode: 'damaged',
    pricing: {}, package: { quantity: 0 } };
  const input = [validOffer('one', '1'), validOffer('two', '2'), mismatch, invalid];
  const text = JSON.stringify(input);
  await writeFile(catalogPath, text, 'utf8');
  const options = { asOf: '2026-11-19', maxExamples: 1 };
  const direct = auditCatalog(input, options);
  const result = await runCli(cwd, 'smartcart-catalog-audit', 'catalog.json', '--as-of', options.asOf, '--examples', '1');
  assert.deepEqual(JSON.parse(result.stdout), direct);
  assert.equal(await readFile(catalogPath, 'utf8'), text);
  assert.deepEqual(await readdir(cwd), ['catalog.json']);
  assert.deepEqual(direct.classification, { confirmedDataErrors: 2, suspiciousRecords: 0, acceptableRecords: 2 });
  assert.equal(direct.productCodesInMultipleStores, 1);
  for (const issue of ['invalidPrice', 'missingPackageUnit', 'invalidPackageQuantity', 'missingManufacturer',
    'possiblePackageConflict', 'stalePrice']) assert.equal(direct.issues[issue].count, 1, issue);
  assert.equal(direct.issues.duplicateId.count, 2);
  assert.equal(direct.issues.duplicateStoreCode.count, 0);
});

test('opt-in command refuses to load and call Gemini with its default arguments', async t => {
  const cwd = await temporaryDirectory(t);
  await assert.rejects(runCli(cwd, 'smartcart-live-qa'), error =>
    error.code === 2 && /explicit opt-in/u.test(error.stderr));
  assert.deepEqual(await readdir(cwd), []);
});

test('R12 a verified shopping budget applies to every optimizer mode with one-cent precision', () => {
  const item = shoppingItem('dinner', 1, 'units', { preferences: ['preferred'] });
  const fixed = [
    confirmedOffer(catalogOffer('affordable', 'Dinner', { price: 99.99 })),
    confirmedOffer(catalogOffer('at-limit', 'Preferred dinner', { store: '202', price: 100 }), { preferences: ['preferred'] })
  ];
  const plan = { userRequest: 'Dinner under 100 shekels', budgetIls: 100, budgetExclusive: true, items: [item] };
  const context = createItemContext(plan, 0);
  const files = [buildQuantityPriceOptions({ item, context, matches: fixed })];
  for (const mode of ['cheapest', 'balanced', 'preferences-first']) {
    const result = optimizeBaskets(files, { request: plan, mode });
    assert.equal(result.recommendedBasket.totalPriceIls, 99.99);
    assert.equal(result.cheapestOverBudgetIls, 100);
  }
  const overBudget = [buildQuantityPriceOptions({ item, context, matches: fixed.slice(1) })];
  const result = optimizeBaskets(overBudget, { request: plan });
  assert.equal(result.noCompleteBasket, true);
  assert.equal(result.recommendedBasket, null);
  assert.equal(result.cheapestOverBudgetIls, 100);
  assert.match(result.warning, /budget/u);
  const inclusive = { ...plan, budgetExclusive: false };
  const inclusiveFiles = [buildQuantityPriceOptions({ item, context: createItemContext(inclusive, 0), matches: fixed })];
  assert.equal(optimizeBaskets(inclusiveFiles, { request: inclusive, mode: 'preferences-first' }).recommendedBasket.totalPriceIls, 100);
});

test('combining individually representable prices cannot produce an unsafe cent total', () => {
  const plan = {
    userRequest: 'I want milk and bread.',
    items: ['milk', 'bread'].map(name => shoppingItem(name, 1, 'units'))
  };
  const options = plan.items.map((item, index) => buildQuantityPriceOptions({
    item,
    context: createItemContext(plan, index),
    matches: [confirmedOffer(catalogOffer(item.product, item.product, { price: 50_000_000_000_000 }))]
  }));
  assert.deepEqual(options.map(file => file.optionCount), [1, 1]);
  const result = optimizeBaskets(options, { request: plan });
  assert.equal(result.recommendedBasket, null);
  assert.match(result.excludedStores[0].reason, /safe integer limits/u);
});

test('gluten-free recipe flows through search, independent mandatory matching, and pricing', async () => {
  const neverCalled = () => assert.fail('Recipe templates are entirely local');
  const plan = await understandShoppingRequest('I want to make gluten-free pizza for 4 people with ready-made dough.',
    { callModel: neverCalled });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.recipes[0].servings, 4);
  assert.equal(plan.provenance.kind, 'LOCAL_TEMPLATE_ESTIMATE');
  const offers = [
    catalogOffer('dough', 'בצק לפיצה ללא גלוטן 500 גרם', { size: 500, unit: 'g', price: 15 }),
    catalogOffer('sauce', 'רוטב עגבניות ללא גלוטן 220 גרם', { size: 220, unit: 'g', price: 5 }),
    catalogOffer('cheese', 'מוצרלה ללא גלוטן 200 גרם', { size: 200, unit: 'g', price: 8 }),
    catalogOffer('unsafe-dough', 'בצק לפיצה מכיל גלוטן 500 גרם', { size: 500, unit: 'g', price: 1 })
  ];
  const { matched, result } = await pipeline(plan, offers, (candidate, item) =>
    decision(candidate, { checks: item.requirements.map(value => claim(value, candidate.name)) }));
  assert.equal(matched[0].rejected[0].product._id, 'unsafe-dough');
  assert.equal(result.recommendedBasket.totalPriceIls, 28);
  assertBasketInvariants(result.recommendedBasket, plan, offers);
  const tampered = structuredClone(plan);
  tampered.items[0].requirements = [];
  assert.throws(() => assertShoppingPlanCoverage(tampered), /provenance|items/u);
});

test('recipe CLI returns clarification and then writes a replayable plan for the existing search commands', async t => {
  const cwd = await temporaryDirectory(t);
  const planPath = join(cwd, 'shopping-request.json');
  await assert.rejects(runCli(cwd, 'smartcart-llm', 'I want to make pizza.'), error => {
    const response = JSON.parse(error.stdout);
    return error.code === 2 && response.status === 'NEEDS_CLARIFICATION' && response.questions.length > 0;
  });
  await assert.rejects(access(planPath), { code: 'ENOENT' });
  await runCli(cwd, 'smartcart-llm', 'I want to make pizza for 4 people with ready-made dough.');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal(assertShoppingPlanCoverage(plan), plan);
  assert.equal(plan.items[0].ingredientId, 'dough');
  await writeFile(join(cwd, 'catalog.json'), JSON.stringify([
    catalogOffer('dough', 'בצק לפיצה 500 גרם', { size: 500, unit: 'g' }),
    catalogOffer('sauce', 'רוטב עגבניות 220 גרם', { size: 220, unit: 'g' })
  ]), 'utf8');
  await runCli(cwd, 'smartcart-matcher', 'search', 'shopping-request.json', 'catalog.json', '0');
  const dough = JSON.parse(await readFile(join(cwd, 'search-results.json'), 'utf8'));
  assert.deepEqual(dough.results.map(row => row._id), ['dough']);
  assert.deepEqual(dough.context, createItemContext(plan, 0));
  await runCli(cwd, 'smartcart-search', 'shopping-request.json', 'catalog.json', '1');
  const sauce = JSON.parse(await readFile(join(cwd, 'search-results.json'), 'utf8'));
  assert.deepEqual(sauce.results.map(row => row._id), ['sauce']);
  assert.deepEqual(sauce.context, createItemContext(plan, 1));
});
