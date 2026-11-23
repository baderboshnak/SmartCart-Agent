import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  catalogOffer, claim, confirmedOffer, decision, shoppingItem, submittedCandidates
} from './fixtures/qa-catalog.mjs';
import { optimizeBaskets } from '../../engine/smartcart-basket-optimizer.mjs';
import { matchProducts, runMatchWithCheckpoint, searchProductsForItem, validateMatchBatch } from '../../engine/smartcart-matcher.mjs';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { buildCatalog, searchCatalog } from '../../engine/smartcart-search.mjs';

const scenario = (number, title, check) => test('QA ' + number + ' — ' + title, check);
const ids = products => products.map(product => product._id);
const codes = rows => ids(rows.map(row => row.product));
const milk = shoppingItem('milk', 2, 'l', { terms: ['חלב'], requirements: ['3%'], preferences: ['Tnuva'] });
const eggs = shoppingItem('eggs', 12, 'units', { terms: ['ביצים'] });
const bread = shoppingItem('bread', 500, 'g', { terms: ['לחם'] });
const mozzarella = shoppingItem('shredded mozzarella', 500, 'g', { terms: ['מוצרלה'] });
const fat = value => claim('3%', value);
const brand = (requirement, evidence, extra) => claim(requirement, evidence, { kind: 'BRAND', ...extra });
const fixtureMilk = (id, value = '3%', other = {}) => catalogOffer(id, 'חלב תנובה ' + value, { unit: 'l', ...other });

function validate(item, product, options) {
  return validateMatchBatch({ decisions: [decision(product._id, options)] }, [product],
    item.preferences, item.requirements, { item })[0];
}

function pricing(item, products, options = {}) {
  return buildQuantityPriceOptions({ item, matches: products.map(product => confirmedOffer(product, options)) });
}

function priceOffer(result) {
  return result.stores[0]?.options[0];
}

async function checkpointFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'smartcart-qa-core-'));
  const path = join(directory, 'match-progress.json');
  t.after(async () => {
    await rm(path, { force: true });
    await rmdir(directory);
  });
  return path;
}

scenario(25, 'Hebrew milk terms retrieve the correct fat label', () => {
  const catalog = buildCatalog([fixtureMilk('three'), fixtureMilk('one', '1%')]);
  assert.deepEqual(ids(searchCatalog(catalog, { searchTerms: ['חלב 3%'] }).results), ['three']);
});

scenario(26, 'search leaves hard manufacturer verification to matching', () => {
  const cheese = catalogOffer('tnuva', 'מוצרלה מגורדת 22%', { manufacturer: 'תנובה' });
  assert.deepEqual(searchCatalog([cheese], mozzarella).results, [cheese]);
});

scenario(27, 'broad mozzarella query retains all named variations', () => {
  const products = ['מוצרלה מגורדת', 'גבינת מוצרלה מגורדת', 'מוצרלה תנובה מגורדת']
    .map((name, index) => catalogOffer(String(index), name));
  assert.deepEqual(searchCatalog(products, mozzarella).results, products);
});

scenario(28, 'milk search retains nearby identities for a separate match decision', async () => {
  const products = [
    fixtureMilk('drink'), catalogOffer('chocolate', 'טובלרון חלב צימוק'),
    catalogOffer('powder', 'אבקת חלב'), catalogOffer('candy', 'סוכריות חלב')
  ];
  const candidates = searchCatalog(products, milk).results;
  assert.deepEqual(ids(candidates), ['drink', 'chocolate', 'powder', 'candy']);
  const result = await matchProducts({
    item: milk, products: candidates,
    callModel: async ({ prompt }) => ({ decisions: submittedCandidates(prompt).map(({ id }) => decision(id, {
      identity: id === 'drink' ? 'MATCH' : 'NO_MATCH',
      checks: id === 'drink' ? [fat('3%')] : [claim('3%', '', { result: 'UNKNOWN', source: 'NONE' })]
    })) })
  });
  assert.deepEqual(codes(result.matches), ['drink']);
  assert.deepEqual(codes(result.rejected), ['chocolate', 'powder', 'candy']);
});

scenario(29, 'identical hits deduplicate even when conflicting records intervene', () => {
  const first = fixtureMilk('sku');
  const conflicting = { ...first, name: 'חלב תנובה 3% אחר' };
  const separate = fixtureMilk('sku-store-202', '3%', { store: '202', code: 'sku' });
  const result = searchCatalog([first, conflicting, { ...first }, separate], { searchTerms: ['חלב', 'חלב 3%'] });
  assert.deepEqual(result.results, [first, conflicting, separate]);
});

scenario(30, 'empty search completes the matching phase without API calls', async () => {
  const request = shoppingItem('unavailable');
  const result = searchCatalog([fixtureMilk('milk')], request);
  assert.equal(result.totalCandidates, 0);
  const matched = await matchProducts({ item: request, products: result.results,
    callModel: async () => assert.fail('No candidates require evaluation') });
  assert.deepEqual([matched.matches, matched.rejected, matched.uncertain], [[], [], []]);
  assert.equal(optimizeBaskets([buildQuantityPriceOptions(matched)]).noCompleteBasket, true);
});

scenario(31, '1,205 matching records retain all stable IDs without a result cap', () => {
  const products = Array.from({ length: 1205 }, (_, index) => fixtureMilk('milk-' + index));
  const result = searchCatalog(buildCatalog(products), milk);
  assert.equal(result.totalCandidates, 1205);
  assert.deepEqual(ids(result.results), ids(products));
});

scenario(32, 'Hebrew punctuation, spacing and compact quantity formatting preserve recall', () => {
  const products = [
    catalogOffer('spaced', 'חלב  3%'), catalogOffer('compact', 'חלב3%'),
    catalogOffer('dotted', 'גב. מוצרלה מגורדת'), catalogOffer('simple', 'מוצרלה מגורדת')
  ];
  assert.deepEqual(ids(searchCatalog(products, { searchTerms: ['חלב 3%'] }).results), ['spaced', 'compact']);
  assert.deepEqual(ids(searchCatalog(products, mozzarella).results), ['dotted', 'simple']);
});

scenario(33, 'candidate results are bound to the correct item index', () => {
  const plan = { userRequest: 'Milk and eggs', items: [milk, eggs] };
  const products = [fixtureMilk('dairy'), catalogOffer('eggs', 'ביצים ארוזות')];
  const contexts = plan.items.map((_, index) => createItemContext(plan, index));
  const search = plan.items.map((item, index) => ({ ...searchCatalog(products, item), context: contexts[index], itemIndex: index }));
  assert.deepEqual(ids(searchProductsForItem(search[0], contexts[0], milk)), ['dairy']);
  assert.deepEqual(ids(searchProductsForItem(search[1], contexts[1], eggs)), ['eggs']);
  assert.throws(() => searchProductsForItem(search[0], contexts[1], eggs), /pipeline context|different shopping/iu);
});

for (const [number, title, value, expected] of [
  [34, 'explicit 3% milk', '3%', 'MATCH'],
  [35, 'clearly different milk percentage', '1%', 'NO_MATCH']
]) {
  scenario(number, title, () => {
    assert.equal(validate(milk, fixtureMilk('milk', value), { checks: [fat(value)] }).status, expected);
  });
}

scenario(36, 'drinking milk does not accept the mocked chocolate identity', () => {
  const chocolate = catalogOffer('chocolate', 'טובלרון חלב צימוק 100גר');
  assert.equal(validate(shoppingItem('drinking milk'), chocolate, { identity: 'NO_MATCH' }).status, 'NO_MATCH');
});

scenario(37, 'sliced mozzarella contradicts mandatory shredded form', () => {
  const item = { ...mozzarella, requirements: ['shredded'] };
  const candidate = catalogOffer('sliced', 'מוצרלה פרוסות');
  assert.equal(validate(item, candidate, { checks: [claim('shredded', 'פרוסות')] }).status, 'NO_MATCH');
});

const tnuvaOnly = { ...mozzarella, requirements: ['Tnuva'] };
scenario(38, 'an explicitly different manufacturer contradicts hard Tnuva', () => {
  const candidate = catalogOffer('gad', 'מוצרלה מגורדת', { manufacturer: 'Gad' });
  const checks = [brand('Tnuva', 'Gad', { result: 'CONTRADICTED', source: 'MANUFACTURER' })];
  assert.equal(validate(tnuvaOnly, candidate, { checks }).status, 'NO_MATCH');
});
scenario(39, 'absent manufacturer leaves a hard brand uncertain', () => {
  const candidate = catalogOffer('unlabeled', 'מוצרלה מגורדת');
  assert.equal(validate(tnuvaOnly, candidate, { checks: [brand('Tnuva', 'מוצרלה')] }).status, 'UNCERTAIN');
});
scenario(40, 'unambiguous brand in the title suffices without manufacturer', () => {
  const candidate = catalogOffer('named', 'מוצרלה תנובה מגורדת');
  assert.equal(validate(tnuvaOnly, candidate, { checks: [brand('Tnuva', 'תנובה')] }).status, 'MATCH');
});
scenario(41, 'brand preference is credited on only one of two eligible offers', () => {
  const options = { checks: [fat('3%')], preferences: ['Tnuva'] };
  const satisfied = validate(milk, fixtureMilk('tnuva'), options);
  const other = validate(milk, catalogOffer('tara', 'חלב טרה 3%'), options);
  assert.deepEqual([satisfied.status, other.status], ['MATCH', 'MATCH']);
  assert.deepEqual([satisfied.preferencesMet, other.preferencesMet], [['Tnuva'], []]);
});
scenario(42, 'mistaken model positive cannot override literal contrary fat evidence', () => {
  assert.equal(validate(milk, fixtureMilk('one', '1%'), { checks: [fat('1%')] }).status, 'NO_MATCH');
});

const goodMilkDecision = id => decision(id, { checks: [fat('3%')], preferences: ['Tnuva'] });
for (const [number, title, invalid] of [
  [43, 'malformed response for one candidate', { id: 'affected', identity: false }],
  [44, 'duplicate mandatory check', { ...goodMilkDecision('affected'), requirementChecks: [fat('3%'), fat('3%')] }],
  [45, 'omitted candidate', null],
  [46, 'duplicate candidate ID', [goodMilkDecision('affected'), goodMilkDecision('affected')]],
  [47, 'unknown candidate ID', goodMilkDecision('unlisted')]
]) {
  scenario(number, title + ' retries precisely the affected ID', async () => {
    const requests = [];
    const result = await matchProducts({
      item: milk, products: [fixtureMilk('first'), fixtureMilk('affected')],
      callModel: async ({ prompt }) => {
        const batch = submittedCandidates(prompt).map(product => product.id);
        requests.push(batch);
        return { decisions: requests.length === 1 ? [goodMilkDecision('first'), ...[invalid].flat().filter(Boolean)]
          : batch.map(goodMilkDecision) };
      }
    });
    assert.deepEqual(requests, [['first', 'affected'], ['affected']]);
    assert.deepEqual(codes(result.matches), ['first', 'affected']);
  });
}

scenario(48, 'invented preference and mandatory checks cannot be credited as preferences', () => {
  const candidate = fixtureMilk('named');
  const invalid = { checks: [fat('3%')], preferences: ['Tnuva', '3%'] };
  assert.deepEqual(validate({ ...milk, preferences: ['3%'] }, candidate, invalid).preferencesMet, []);
});

scenario(49, 'exhausted invalid responses retain completed work and fail explicitly', async t => {
  const checkpointPath = await checkpointFile(t);
  let calls = 0;
  await assert.rejects(runMatchWithCheckpoint({
    item: milk, products: [fixtureMilk('complete'), fixtureMilk('missing')], checkpointPath, maxAttempts: 2,
    callModel: async () => (++calls === 1 ? { decisions: [goodMilkDecision('complete')] } : null)
  }), /after 2 attempts.*First unresolved ID: missing/u);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')).decisions.map(row => row.id), ['complete']);
});

scenario(50, 'completed decisions resume with the exact pending candidate', async t => {
  const checkpointPath = await checkpointFile(t);
  const config = { item: milk, products: [fixtureMilk('complete'), fixtureMilk('pending')], checkpointPath };
  await assert.rejects(runMatchWithCheckpoint({
    ...config, maxAttempts: 1, callModel: async () => ({ decisions: [goodMilkDecision('complete')] })
  }), /First unresolved ID: pending/u);
  const result = await runMatchWithCheckpoint({ ...config, callModel: async ({ prompt }) => {
    assert.deepEqual(submittedCandidates(prompt).map(product => product.id), ['pending']);
    return { decisions: [goodMilkDecision('pending')] };
  } });
  assert.deepEqual(codes(result.matches), ['complete', 'pending']);
});

scenario(51, 'changing hard brand to optional invalidates the checkpoint', async t => {
  const checkpointPath = await checkpointFile(t);
  const products = [catalogOffer('gad', 'מוצרלה מגורדת', { manufacturer: 'גד' })];
  const hard = await runMatchWithCheckpoint({
    item: tnuvaOnly, products, checkpointPath,
    callModel: async () => ({ decisions: [decision('gad', {
      checks: [brand('Tnuva', 'גד', { result: 'CONTRADICTED', source: 'MANUFACTURER' })]
    })] })
  });
  const soft = await runMatchWithCheckpoint({
    item: { ...mozzarella, preferences: ['Tnuva'] }, products, checkpointPath,
    callModel: async () => ({ decisions: [decision('gad')] })
  });
  assert.deepEqual(codes(hard.rejected), ['gad']);
  assert.deepEqual(codes(soft.matches), ['gad']);
});

scenario(52, 'catalog name change invalidates a successful verified match', async t => {
  const checkpointPath = await checkpointFile(t);
  await runMatchWithCheckpoint({
    item: milk, products: [fixtureMilk('child')], checkpointPath,
    callModel: async () => ({ decisions: [goodMilkDecision('child')] })
  });
  const changed = await runMatchWithCheckpoint({
    item: milk, products: [fixtureMilk('child', '1%')], checkpointPath,
    callModel: async () => ({ decisions: [decision('child', { checks: [fat('1%')] })] })
  });
  assert.deepEqual(codes(changed.rejected), ['child']);
});

scenario(53, 'temporary timeout and rate limit retry with bounded backoff', async () => {
  const errors = [
    Object.assign(new Error('mock timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('mock rate limit'), { status: 429 })
  ];
  const waits = [];
  const requests = [];
  const result = await matchProducts({
    item: milk, products: [fixtureMilk('milk')], maxAttempts: 3,
    waitForRetry: async milliseconds => waits.push(milliseconds),
    callModel: async ({ prompt }) => {
      requests.push(submittedCandidates(prompt).map(product => product.id));
      if (errors.length) throw errors.shift();
      return { decisions: [goodMilkDecision('milk')] };
    }
  });
  assert.deepEqual(requests, [['milk'], ['milk'], ['milk']]);
  assert.deepEqual(waits, [100, 200]);
  assert.deepEqual(codes(result.matches), ['milk']);
  await assert.rejects(matchProducts({
    item: milk, products: [fixtureMilk('milk')], maxAttempts: 2,
    waitForRetry: async () => {},
    callModel: async () => { throw Object.assign(new Error('rate limit'), { status: 429 }); }
  }), /after 2 attempt\(s\).*rate limit/u);
  let authAttempts = 0;
  await assert.rejects(matchProducts({
    item: milk, products: [fixtureMilk('milk')], maxAttempts: 3,
    waitForRetry: async () => assert.fail('An authentication failure is permanent'),
    callModel: async () => {
      authAttempts++;
      throw Object.assign(new Error('Authentication failed at https://example.test/?key=fixture-secret'), { status: 401 });
    }
  }), error => /Authentication failed.*\[redacted\]/u.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(authAttempts, 1);
});

scenario(54, 'every offered ID appears exactly once across all result buckets', async () => {
  const products = Array.from({ length: 39 }, (_, index) => catalogOffer(String(index),
    index % 3 === 0 ? 'חלב 3%' : (index % 3 === 1 ? 'חלב 1%' : 'חלב')));
  const result = await matchProducts({
    item: milk, products,
    callModel: async ({ prompt }) => ({ decisions: submittedCandidates(prompt).map(({ id, name }) =>
      decision(id, { checks: [fat(name.includes('3%') ? '3%' : (name.includes('1%') ? '1%' : 'חלב'))] })) })
  });
  const buckets = [result.matches, result.rejected, result.uncertain];
  const all = buckets.flatMap(codes);
  assert.deepEqual(buckets.map(bucket => bucket.length), [13, 13, 13]);
  assert.equal(result.totalCandidates, 39);
  assert.deepEqual(new Set(all), new Set(ids(products)));
  assert.equal(all.length, new Set(all).size);
});

scenario(55, 'conflicting title and manufacturer brands stay uncertain in both directions', () => {
  const candidate = catalogOffer('conflict', 'מוצרלה מגורדת תנובה', { manufacturer: 'Gad' });
  const checks = [
    brand('Tnuva', 'תנובה'),
    brand('Tnuva', 'Gad', { result: 'CONTRADICTED', source: 'MANUFACTURER' })
  ];
  for (const evidence of checks) {
    assert.equal(validate(tnuvaOnly, candidate, { checks: [evidence] }).status, 'UNCERTAIN');
  }
  const reverse = { ...tnuvaOnly, requirements: ['Gad'] };
  assert.equal(validate(reverse, candidate, { checks: [brand('Gad', 'Gad', { source: 'MANUFACTURER' })] }).status, 'UNCERTAIN');
});

test('localized Arabic, dietary and food-form hard claims require clear evidence', () => {
  const arabic = { ...milk, requirements: ['٣٪', 'تنوفا'] };
  assert.equal(validate(arabic, fixtureMilk('three'), {
    checks: [claim('٣٪', '3%'), brand('تنوفا', 'תנובה')]
  }).status, 'MATCH');
  const cheese = { ...mozzarella, requirements: ['مبشورة', 'تنوفا'] };
  assert.equal(validate(cheese, catalogOffer('shredded', 'מוצרלה מגורדת', { manufacturer: 'תנובה' }), {
    checks: [claim('مبشورة', 'מגורדת'), brand('تنوفا', 'תנובה', { source: 'MANUFACTURER' })]
  }).status, 'MATCH');
  const item = shoppingItem('chocolate', 1, 'units', { requirements: ['vegan'] });
  for (const [name, quote, expected] of [
    ['שוקולד טבעוני', 'טבעוני', 'MATCH'],
    ['שוקולד מריר', 'מריר', 'UNCERTAIN'],
    ['Chocolate contains dairy', 'contains dairy', 'NO_MATCH'],
    ['Chocolate with vegan filling', 'vegan', 'UNCERTAIN']
  ]) {
    assert.equal(validate(item, catalogOffer(name, name), { checks: [claim('vegan', quote)] }).status, expected, name);
  }
  for (const [requirement, name, quote, expected] of [
    ['egg-free', 'בצק פיצה ללא ביצים', 'ללא ביצים', 'MATCH'],
    ['egg-free', 'Pizza dough contains eggs', 'contains eggs', 'NO_MATCH'],
    ['egg-free', 'בצק פיצה', 'בצק פיצה', 'UNCERTAIN'],
    ['frozen', 'פיצה קפואה', 'קפואה', 'MATCH'],
    ['frozen', 'פיצה טרייה', 'טרייה', 'NO_MATCH']
  ]) {
    const item = shoppingItem('pizza', 1, 'units', { requirements: [requirement] });
    assert.equal(validate(item, catalogOffer(name, name), { checks: [claim(requirement, quote)] }).status, expected, name);
  }
});

const packagedCheese = (id, size, price, other = {}) =>
  catalogOffer(id, 'מוצרלה מגורדת', { size, unit: 'g', price, ...other });
for (const [number, title, purchaseItem, product, count, amount, total, overbuy] of [
  [56, 'exact mozzarella package', mozzarella, packagedCheese('exact', 500, 41.50), 1, 500, 41.50, 0],
  [57, 'three small mozzarella packages', mozzarella, packagedCheese('small', 200, 18.80), 3, 600, 56.40, 100],
  [60, 'milliliters converted to liters', { ...milk, requirements: [] },
    catalogOffer('ml', 'Milk 1000 ml', { size: 1000, unit: 'ml', price: 7 }), 2, 2000, 14, 0],
  [61, 'gram bags for a kilogram request', shoppingItem('rice', 1.5, 'kg'),
    catalogOffer('rice', 'Rice 500 g', { size: 500, unit: 'g', price: 4 }), 3, 1500, 12, 0],
  [62, 'one corrected 12-egg carton', eggs, catalogOffer('eggs', 'ביצים ארוזות XL 12יחידות', { price: 15.81 }),
    1, 12, 15.81, 0],
  [63, 'single six-pack with explicit bottle count', shoppingItem('water', 6, 'bottle'),
    catalogOffer('six-pack', '6 bottles x 500 ml water', { size: 1, price: 7 }), 1, 6, 7, 0],
  [64, 'four components contribute 400 g per package', shoppingItem('rice', 400, 'g'),
    catalogOffer('rice-pack', 'אורז 4 x 100 גרם', { size: 100, unit: 'g', price: 12 }), 1, 400, 12, 0],
  [70, 'line price remains exact to the cent', shoppingItem('milk', 3, 'l'),
    catalogOffer('milk', 'Milk 1 l', { size: 1, unit: 'l', price: 6.41 }), 3, 3000, 19.23, 0]
]) {
  scenario(number, title, () => {
    const option = priceOffer(pricing(purchaseItem, [product]));
    assert.equal(option?.packageCount, count);
    assert.equal(option.quantityToPurchase.normalizedAmount, amount);
    assert.equal(option.totalPriceIls, total);
    assert.equal(option.overbuyBase, overbuy);
    if (number === 63) {
      assert.ok(option.packageInterpretation.evidence.some(entry => entry.quantity === 3000 && entry.unit === 'ml'));
    }
  });
}

for (const number of [58, 86]) {
  scenario(number, 'mix fixed package sizes in one exact store', () => {
    const result = optimizeBaskets([pricing(mozzarella, [packagedCheese('small', 200, 12), packagedCheese('large', 300, 15)])]);
    const line = result.recommendedBasket.items[0];
    assert.equal(line.totalPriceIls, 27);
    assert.deepEqual(line.purchasedQuantity, { amount: 500, unit: 'g' });
    assert.deepEqual(line.products.map(row => [row.productId, row.packageCount]), [['small', 1], ['large', 1]]);
  });
}

scenario(59, 'permitted overbuy can legitimately produce the cheapest basket', () => {
  const result = optimizeBaskets([pricing(mozzarella, [packagedCheese('exact', 500, 30), packagedCheese('oversize', 600, 25)])]);
  const line = result.recommendedBasket.items[0];
  assert.equal(line.totalPriceIls, 25);
  assert.equal(line.products[0].productId, 'oversize');
  assert.deepEqual(line.overbuy, { amount: 100, unit: 'g' });
});

scenario(65, 'egg-count correction preserves the raw catalog record and evidence', () => {
  const product = catalogOffer('eggs', '12 eggs', { price: 15.81 });
  const original = structuredClone(product);
  const option = priceOffer(pricing(eggs, [product]));
  assert.equal(option.package.quantity, 12);
  assert.deepEqual(option.originalPackage, original.package);
  assert.ok(option.packageInterpretation.evidence.some(entry => entry.quantity === 12 && entry.unit === 'units'));
  assert.deepEqual(product, original);
});

scenario(66, 'competing measurements do not become a made-up package size', () => {
  const result = pricing(mozzarella, [packagedCheese('ambiguous', 300, 15, {})].map(product =>
    ({ ...product, name: 'Mozzarella 200 g 300 g' })));
  assert.equal(result.optionCount, 0);
  assert.match(result.skipped[0].reason, /conflict/iu);
});

scenario(67, 'a weight request does not convert volume without evidence', () => {
  const result = pricing(mozzarella, [catalogOffer('liquid', 'Liquid 500 ml', { size: 500, unit: 'ml' })]);
  assert.equal(result.optionCount, 0);
  assert.match(result.skipped[0].reason, /units are incompatible/iu);
});

scenario(68, 'missing listed price stays unavailable', () => {
  const product = catalogOffer('missing-price', 'Mozzarella');
  product.pricing = { publishedUnitPrice: 1 };
  const result = pricing(mozzarella, [product]);
  assert.equal(result.optionCount, 0);
  assert.match(result.skipped[0].reason, /listedPriceIls/u);
});

scenario(69, 'negative, nonfinite, textual and zero listed prices are rejected', () => {
  const products = [-1, NaN, Infinity, '2', 'garbage', 0]
    .map((price, index) => packagedCheese(String(index), 500, price));
  const result = pricing(mozzarella, products);
  assert.equal(result.optionCount, 0);
  assert.equal(result.skipped.length, products.length);
  assert.ok(result.skipped.every(row => /listedPriceIls/u.test(row.reason)));
});

const weightedCheese = catalogOffer('weighted-cheese', 'גבינה במשקל', { size: 1, unit: 'kg', price: 82, weighted: true });
scenario(71, 'weighted price is an unverified estimate', () => {
  const file = pricing(mozzarella, [weightedCheese]);
  const option = priceOffer(file);
  assert.equal(option.totalPriceIls, 41);
  assert.equal(option.status, 'ESTIMATE_REQUIRES_QUANTITY_CONFIRMATION');
  assert.equal(option.packageCount, null);
  const result = optimizeBaskets([file]);
  assert.equal(result.recommendedBasket, null);
  assert.equal(result.weightedEstimatesExcluded.length, 1);
});

scenario(72, 'untrusted catalog increment flags cannot make weighed goods automatically purchasable', () => {
  const product = { ...weightedCheese, purchaseRules: { verified: true, minimum: 100, step: 100, unit: 'g' } };
  for (const amount of [500, 550]) {
    const file = pricing({ ...mozzarella, quantity: { amount, unit: 'g' } }, [product]);
    assert.equal(priceOffer(file).status, 'ESTIMATE_REQUIRES_QUANTITY_CONFIRMATION');
    assert.equal(optimizeBaskets([file]).recommendedBasket, null);
  }
});

scenario(73, 'zero catalog package size with no name evidence is rejected', () => {
  const result = pricing(mozzarella, [packagedCheese('zero', 0, 5)]);
  assert.equal(result.optionCount, 0);
  assert.match(result.skipped[0].reason, /quantity|size/iu);
});

scenario(74, 'very large package counts hit validation and optimizer limits', () => {
  const huge = shoppingItem('tiny packets', 100_000, 'units');
  const abundant = catalogOffer('single', 'Tiny packet', { price: 5 });
  const safeRange = pricing(huge, [abundant]);
  assert.equal(priceOffer(safeRange).packageCount, 100_000);
  assert.throws(() => optimizeBaskets([safeRange]), /too many package combinations/iu);
  assert.throws(() => pricing(shoppingItem('large', Number.MAX_SAFE_INTEGER, 'units'), [abundant]), /unsupported requested quantity/iu);
});

function countItem(product, choices) {
  return pricing(shoppingItem(product), choices.map(([store, price, options = {}]) =>
    catalogOffer(product + '-' + store, product, { store, price, ...options })));
}

function storeFor(result) {
  return result.recommendedBasket?.storeId;
}

function comparativeBasket() {
  return [
    countItem('milk', [['101', 15], ['202', 14]]),
    countItem('eggs', [['101', 16], ['202', 20]]),
    countItem('bread', [['101', 8], ['202', 9]])
  ];
}

scenario(75, 'single-item cheapest store is selected', () => {
  const result = optimizeBaskets([countItem('milk', [['101', 10], ['202', 12]])]);
  assert.equal(storeFor(result), '101');
  assert.equal(result.recommendedBasket.totalPriceIls, 10);
});

scenario(76, 'complete basket compares independently summed store prices', () => {
  const result = optimizeBaskets(comparativeBasket());
  assert.equal(storeFor(result), '101');
  assert.deepEqual(result.storeComparisons.map(store => store.cheapest.totalPriceIls), [39, 43]);
});

scenario(77, 'lower price cannot compensate for a missing grocery', () => {
  const files = [countItem('milk', [['101', 1], ['202', 14]]), countItem('eggs', [['101', 1], ['202', 20]]),
    countItem('bread', [['202', 9]])];
  const result = optimizeBaskets(files);
  assert.equal(storeFor(result), '202');
  assert.equal(result.excludedStores[0].missingItems[0].product, 'bread');
});

scenario(78, 'two branches of the same retailer cannot fulfill one basket together', () => {
  const files = [countItem('milk', [['101', 1]]), countItem('eggs', [['202', 1]])];
  const result = optimizeBaskets(files);
  assert.equal(result.recommendedBasket, null);
  assert.equal(result.excludedStores.length, 2);
});

function preferredOptions(product, cheap, preferred, preference = 'preferred') {
  const item = shoppingItem(product, 0, 'unspecified', { preferences: [preference] });
  const offers = [
    confirmedOffer(catalogOffer(product + '-regular', product, { price: cheap })),
    confirmedOffer(catalogOffer(product + '-preferred', product, { price: preferred }), { preferences: [preference] })
  ];
  return buildQuantityPriceOptions({ item, matches: offers });
}

for (const [number, title, mode, regular, preferred, total, score] of [
  [79, 'cheapest mode rejects a pricier optional preference', 'cheapest', 10, 12, 10, 0],
  [80, 'balanced mode buys a preference within 15 percent', 'balanced', 100, 110, 110, 1],
  [81, 'balanced mode declines an excessive premium', 'balanced', 100, 120, 100, 0],
  [82, 'preferences-first mode chooses a verified optional preference', 'preferences-first', 100, 120, 120, 1]
]) {
  scenario(number, title, () => {
    const result = optimizeBaskets([preferredOptions('milk', regular, preferred)], { mode });
    assert.equal(result.recommendedBasket.totalPriceIls, total);
    assert.equal(result.recommendedBasket.preferencesSatisfied, score);
  });
}

scenario(83, 'balanced premium applies to the entire basket', () => {
  const files = [preferredOptions('milk', 10, 20), countItem('eggs', [['101', 20]]), countItem('bread', [['101', 70]])];
  const result = optimizeBaskets(files);
  assert.equal(result.cheapestCompleteBasket.totalPriceIls, 100);
  assert.equal(result.recommendedBasket.totalPriceIls, 110);
  assert.equal(result.recommendedBasket.preferencesSatisfied, 1);
});

scenario(84, 'preferences count once per requested item, independent of package count', () => {
  const files = ['Tnuva', 'Gad'].map((preference, index) => {
    const product = index === 0 ? 'milk' : 'mozzarella';
    return pricing(shoppingItem(product, 2, 'units', { preferences: [preference] }),
      [catalogOffer(product, product, { price: 5 })], { preferences: [preference] });
  });
  const { recommendedBasket } = optimizeBaskets(files);
  assert.equal(recommendedBasket.packageCount, 4);
  assert.equal(recommendedBasket.preferencesSatisfied, 2);
  assert.deepEqual(recommendedBasket.items.map(item => item.preferencesSatisfied), [['Tnuva'], ['Gad']]);
});

scenario(85, 'very cheap wrong hard brand cannot enter any pricing mode', async () => {
  const item = { ...milk, requirements: ['Tnuva'], preferences: [] };
  const products = [fixtureMilk('tnuva', '3%', { price: 15 }), catalogOffer('gad', 'חלב גד 3%', {
    unit: 'l', price: 1, manufacturer: 'גד', store: '202'
  })];
  const match = await matchProducts({
    item, products,
    callModel: async () => ({ decisions: [
      decision('tnuva', { checks: [brand('Tnuva', 'תנובה')] }),
      decision('gad', { checks: [brand('Tnuva', 'גד', { result: 'CONTRADICTED', source: 'MANUFACTURER' })] })
    ] })
  });
  const file = buildQuantityPriceOptions(match);
  for (const mode of ['cheapest', 'balanced', 'preferences-first']) {
    assert.equal(storeFor(optimizeBaskets([file], { mode })), '101');
  }
});

test('contradictory catalog facts cannot be promoted through an edited matching file', () => {
  const water = shoppingItem('water', 3, 'bottle', { requirements: ['500 ml'] });
  const cases = [
    [milk, fixtureMilk('wrong-fat', '1%')],
    [water, catalogOffer('wrong-bottle-size', 'Water bottle 1 l', { unit: 'l' })]
  ];
  for (const [item, product] of cases) {
    const context = createItemContext({ userRequest: item.product, items: [item] }, 0);
    const edited = confirmedOffer(product, { requirements: item.requirements });
    const options = buildQuantityPriceOptions({ item, context, matches: [edited] });
    assert.equal(options.optionCount, 0);
    assert.match(options.skipped[0].reason, /catalog evidence contradicts/iu);
    assert.equal(optimizeBaskets([options]).recommendedBasket, null);
  }
});

scenario(87, 'two retailers cannot jointly supply the requested package quantity', () => {
  const item = shoppingItem('mozzarella', 500, 'g', { maxAmount: 500 });
  const file = pricing(item, [packagedCheese('small', 200, 1), packagedCheese('large', 300, 1, { store: '202' })]);
  const result = optimizeBaskets([file]);
  assert.equal(result.recommendedBasket, null);
  assert.equal(result.excludedStores.length, 2);
  for (const store of result.excludedStores) assert.match(store.missingItems[0].reason, /range/iu);
});

scenario(88, 'no complete basket explains the missing item per store', () => {
  const result = optimizeBaskets([countItem('milk', [['101', 1]]), countItem('eggs', [['202', 1]])]);
  assert.equal(result.noCompleteBasket, true);
  assert.deepEqual(result.excludedStores.map(store => store.missingItems[0].product), ['eggs', 'milk']);
});

scenario(89, 'an uncertain catalog match is excluded from automatic purchase', async () => {
  const products = [fixtureMilk('confirmed'), catalogOffer('unlabeled', 'חלב', { unit: 'l', price: 1 })];
  const matched = await matchProducts({
    item: milk, products,
    callModel: async () => ({ decisions: [goodMilkDecision('confirmed'), decision('unlabeled', { checks: [fat('חלב')] })] })
  });
  assert.deepEqual(codes(matched.uncertain), ['unlabeled']);
  const basket = optimizeBaskets([buildQuantityPriceOptions(matched)]).recommendedBasket;
  assert.deepEqual(basket.items[0].products.map(product => product.productId), ['confirmed']);
});

scenario(90, 'cheaper weighed estimate does not beat a purchasable fixed package', () => {
  const file = pricing(mozzarella, [weightedCheese, packagedCheese('shelf', 500, 50)]);
  const result = optimizeBaskets([file]);
  assert.equal(result.recommendedBasket.totalPriceIls, 50);
  assert.equal(result.weightedEstimatesExcluded[0].estimatedPriceIls, 41);
});

scenario(91, 'equal cost and preferences select the deterministic store key', () => {
  for (const stores of [[['202', 10], ['101', 10]], [['101', 10], ['202', 10]]]) {
    assert.equal(storeFor(optimizeBaskets([countItem('milk', stores)])), '101');
  }
});

scenario(92, 'all four requested groceries have a sufficient purchasable amount', () => {
  const items = [
    pricing({ ...milk, requirements: [] }, [fixtureMilk('milk')]),
    pricing(eggs, [catalogOffer('eggs', '12 eggs')]),
    pricing(bread, [catalogOffer('bread', 'Bread 250 g', { size: 250, unit: 'g' })]),
    pricing(mozzarella, [packagedCheese('cheese', 300, 10)])
  ];
  const basket = optimizeBaskets(items).recommendedBasket;
  assert.deepEqual(basket.items.map(row => row.item), [milk.product, eggs.product, bread.product, mozzarella.product]);
  assert.deepEqual(basket.items.map(row => row.purchasedQuantity.amount), [2000, 12, 500, 600]);
  assert.ok(basket.items.every(row => Number.isInteger(row.packageCount) && row.packageCount > 0));
});

const cents = money => Math.round(money * 100);
scenario(93, 'complete basket arithmetic reconciles individual lines in cents', () => {
  const files = [
    pricing(shoppingItem('milk', 3, 'l'), [catalogOffer('three', 'Milk 1 l', { unit: 'l', price: 6.41 })]),
    pricing(eggs, [catalogOffer('eggs', '12 eggs', { price: 15.81 })]),
    pricing(mozzarella, [packagedCheese('small', 200, 12.33), packagedCheese('large', 300, 15.44)])
  ];
  const basket = optimizeBaskets(files).recommendedBasket;
  let total = 0;
  for (const item of basket.items) {
    const subtotal = item.products.reduce((sum, line) => sum + cents(line.linePriceIls), 0);
    assert.equal(subtotal, cents(item.totalPriceIls));
    total += subtotal;
  }
  assert.equal(total, cents(basket.totalPriceIls));
  assert.equal(total, 6281);
});

scenario(94, 'bound input files can be reordered without changing the best basket', () => {
  const sources = comparativeBasket();
  const plan = { userRequest: 'Milk, eggs and bread', items: sources.map(file => file.item) };
  const files = sources.map((file, index) => ({ ...file, context: createItemContext(plan, index),
    stores: file.stores.map(store => ({ ...store,
      options: store.options.map(option => ({ ...option, identityStatus: 'MATCH', requirementChecks: [] }))
    })) }));
  const baseline = optimizeBaskets(files, { request: plan });
  assert.deepEqual(optimizeBaskets([...files].reverse(), { request: plan }), baseline);
});
