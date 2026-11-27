import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { understandShoppingRequest } from '../../engine/smartcart-llm.mjs';
import { buildCatalog, searchCatalog } from '../../engine/smartcart-search.mjs';
import { matchProducts, searchProductsForItem } from '../../engine/smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { optimizeBaskets } from '../../engine/smartcart-basket-optimizer.mjs';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';

const milk = {
  sourceText: '2 liters of 3% milk, preferably Tnuva',
  product: 'milk', coreSearchTerm: 'חלב', searchTerms: [],
  quantity: { amount: 2, unit: 'l' },
  constraintEvidence: [
    { type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' },
    { type: 'PREFERENCE', kind: 'BRAND', sourceText: 'Tnuva' }
  ]
};
const eggs = {
  sourceText: '12 eggs',
  product: 'eggs', coreSearchTerm: 'ביצים', searchTerms: [],
  quantity: { amount: 12, unit: 'units' }, constraintEvidence: []
};
const bread = {
  sourceText: '500 grams of bread',
  product: 'bread', coreSearchTerm: 'לחם', searchTerms: [],
  quantity: { amount: 500, unit: 'g' }, constraintEvidence: []
};
const mozzarella = {
  sourceText: '500 grams of shredded mozzarella',
  product: 'mozzarella', coreSearchTerm: 'מוצרלה', searchTerms: [],
  quantity: { amount: 500, unit: 'g' },
  constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: 'shredded' }]
};
const mozzarellaOnlyTnuva = {
  ...mozzarella,
  sourceText: `${mozzarella.sourceText}, only Tnuva`,
  constraintEvidence: [
    ...mozzarella.constraintEvidence, { type: 'REQUIREMENT', kind: 'BRAND', sourceText: 'Tnuva' }
  ]
};

const productsByItem = {
  milk: new Set(['7290000042015', '7290000042435', '7290004131074']),
  eggs: new Set(['7290001201572', '742259241895']),
  bread: new Set(['7290000002026', '379623']),
  mozzarella: new Set(['7290014692817', '7290110324025', '7290014762909', '1794142'])
};
const indexes = {
  shufersal: 'shufersal:7290027600007:002:413:',
  ramiLevy: 'rami_levy:7290058140886:001:039:'
};

const catalog = buildCatalog(JSON.parse(await readFile(
  new URL('../fixtures/catalog-sample.json', import.meta.url), 'utf8'
)));

async function extract(request, rows, firstPass = rows) {
  let passes = 0;
  return understandShoppingRequest(request, {
    callModel: async ({ declaration }) => {
      if (declaration.name === 'submit_shopping_request') {
        return { items: passes++ === 0 ? firstPass : rows };
      }
      assert.equal(declaration.name, 'audit_shopping_request');
      return { items: rows.map(({ sourceText, quantity, constraintEvidence }) =>
        ({ sourceText, quantity, constraintEvidence })) };
    }
  });
}

function catalogModel(item) {
  return async ({ prompt }) => {
    const candidates = JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + '\nProducts: '.length));
    return {
      decisions: candidates.map(candidate => {
        const code = candidate.id.split(':').at(-1);
        const testedOffer = productsByItem[item.product]?.has(code) === true;
        const confirmedTnuva = /תנובה/u.test(candidate.manufacturer ?? '') ||
          /תנובה/u.test(candidate.name);
        const requirementChecks = item.requirements.map(requirement => {
          let evidence;
          let kind = 'OTHER';
          let evidenceSource = 'NAME';
          if (testedOffer && requirement.includes('%')) evidence = candidate.name.match(/\d+%/u)?.[0];
          if (testedOffer && /shredded/i.test(requirement)) evidence = candidate.name.match(/מגורדת|פתיתי/u)?.[0];
          if (testedOffer && /tnuva/i.test(requirement)) {
            kind = 'BRAND';
            // Test that a model's positive claim about a different manufacturer cannot pass.
            evidence = candidate.manufacturer || candidate.name.match(/תנובה/u)?.[0];
            evidenceSource = candidate.manufacturer ? 'MANUFACTURER' : 'NAME';
          }
          return { requirement, kind, result: evidence ? 'MET' : 'UNKNOWN',
            evidenceSource: evidence ? evidenceSource : 'NONE', evidence: evidence ?? '' };
        });
        return {
          id: candidate.id, candidate: 'Controlled catalog fixture', identityEvidence: candidate.name,
          relation: testedOffer ? 'SAME_PRODUCT' : 'UNCLEAR', identity: testedOffer ? 'MATCH' : 'UNCERTAIN',
          requirementChecks,
          preferencesMet: testedOffer && confirmedTnuva ? item.preferences : []
        };
      })
    };
  };
}

async function buildItemOptions(plan) {
  return Promise.all(plan.items.map(async (item, itemIndex) => {
    const context = createItemContext(plan, itemIndex);
    const candidates = searchCatalog(catalog, item).results;
    assert.ok(candidates.length > 0);
    const matches = await matchProducts({ item, products: candidates, context, batchSize: 50,
      callModel: catalogModel(item) });
    return { matches, options: buildQuantityPriceOptions(matches) };
  }));
}

const multiRequest = 'I want 2 liters of 3% milk, preferably Tnuva, 12 eggs, 500 grams of bread, and 500 grams of shredded mozzarella';
let multi;
function multiItemRun() {
  multi ??= (async () => {
    const rows = [milk, eggs, bread, mozzarella];
    const omitted = { ...milk, constraintEvidence: milk.constraintEvidence.slice(1) };
    const plan = await extract(multiRequest, rows, [omitted, ...rows.slice(1)]);
    const results = await buildItemOptions(plan);
    return { plan, results, files: results.map(row => row.options) };
  })();
  return multi;
}

test('original four-item request produces an audited complete basket from the catalog snapshot', async () => {
  const { plan, results, files } = await multiItemRun();
  assert.equal(plan.items.length, 4);
  assert.ok(plan.items[0].requirements.some(requirement => requirement.includes('3%')));
  assert.deepEqual(plan.items[0].preferences, ['Tnuva']);
  assert.ok(results[0].matches.rejected.some(row => row.product._id === indexes.ramiLevy + '7290000042435'));
  const result = optimizeBaskets([...files].reverse(), { request: plan });
  assert.equal(result.completeStores, 2);
  assert.equal(result.recommendedBasket.storeKey, indexes.ramiLevy.slice(0, -1));
  assert.equal(result.recommendedBasket.totalPriceIls, 67.26);
  const lines = result.recommendedBasket.items;
  assert.deepEqual(lines.map(line => line.itemIndex), [0, 1, 2, 3]);
  assert.deepEqual(lines.map(line => line.products.map(offer => offer.productId)), [
    [indexes.ramiLevy + '7290004131074'],
    [indexes.ramiLevy + '742259241895'],
    [indexes.ramiLevy + '379623'],
    [indexes.ramiLevy + '7290014692817']
  ]);
  assert.deepEqual(lines.map(line => line.purchasedQuantity.amount), [2000, 12, 750, 600]);
  for (const line of lines) {
    for (const offer of line.products) {
      assert.equal(offer.identityStatus, 'MATCH');
      assert.deepEqual(offer.requirementChecks.map(check => check.requirement), plan.items[line.itemIndex].requirements);
      assert.ok(offer.requirementChecks.every(check => check.result === 'MET'));
    }
  }
  const shufersal = result.storeComparisons.find(store => store.retailer === 'shufersal').cheapest;
  const eggLine = shufersal.items[1].products[0];
  assert.equal(shufersal.totalPriceIls, 68.69);
  assert.equal(eggLine.productId, indexes.shufersal + '7290001201572');
  assert.equal(eggLine.packageCount, 1);
  assert.equal(eggLine.linePriceIls, 15.81);
  assert.equal(eggLine.originalPackage.quantity, 1);
  assert.equal(eggLine.package.quantity, 12);
  assert.ok(eggLine.packageInterpretation.evidence.length);
  assert.ok(result.weightedEstimatesExcluded.some(row => row.itemIndex === 3));
});

test('single-item balance allows a soft Tnuva preference only within the total premium', async () => {
  const plan = await extract(`I want ${milk.sourceText}`, [milk]);
  const [{ options }] = await buildItemOptions(plan);
  const balanced = optimizeBaskets([options], { request: plan });
  assert.equal(balanced.cheapestCompleteBasket.totalPriceIls, 12.82);
  assert.equal(balanced.recommendedBasket.totalPriceIls, 14.4);
  assert.equal(balanced.recommendedBasket.preferencesSatisfied, 1);
  assert.equal(optimizeBaskets([options], { maxPremiumPct: 10 }).recommendedBasket.totalPriceIls, 12.82);
  assert.equal(optimizeBaskets([options], { mode: 'cheapest' }).recommendedBasket.totalPriceIls, 12.82);
  assert.equal(optimizeBaskets([options], { mode: 'preferences-first' }).recommendedBasket.totalPriceIls, 14.4);
});

test('hard Tnuva and shredded-form requirements hold before basket comparison in every mode', async () => {
  const plan = await extract(`I want ${mozzarellaOnlyTnuva.sourceText}`, [mozzarellaOnlyTnuva]);
  assert.equal(plan.items[0].requirements.length, 2);
  assert.deepEqual(plan.items[0].preferences, []);
  const [{ matches, options }] = await buildItemOptions(plan);
  assert.ok(matches.uncertain.some(row => row.product._id === indexes.shufersal + '7290014692817'));
  assert.ok(!matches.matches.some(row => row.product._id === indexes.ramiLevy + '7290014692817'));
  for (const mode of ['cheapest', 'balanced', 'preferences-first']) {
    const result = optimizeBaskets([options], { mode });
    assert.equal(result.recommendedBasket.items[0].products[0].productId, indexes.shufersal + '7290110324025');
    assert.equal(result.recommendedBasket.totalPriceIls, 41.5);
    assert.ok(result.weightedEstimatesExcluded.some(row => row.estimatedPriceIls === 41));
    assert.equal(result.storeComparisons.find(store => store.retailer === 'rami_levy').cheapest.totalPriceIls, 56.4);
  }
});

test('a subset, duplicate, mixed request, edited item or mismatched store cannot produce a bound basket', async () => {
  const { plan, files } = await multiItemRun();
  assert.throws(() => optimizeBaskets(files.slice(0, 3)), /all 4 shopping items/u);
  assert.throws(() => optimizeBaskets([files[0], ...files]), /Duplicate/u);
  assert.throws(() => optimizeBaskets(files, { request: { ...plan, userRequest: 'different' } }), /different shopping request/u);
  const mixed = { ...files[0], context: createItemContext({ ...plan, userRequest: 'different' }, 0) };
  assert.throws(() => optimizeBaskets([mixed, ...files.slice(1)]), /different shopping requests/u);
  const edited = { ...files[0], item: { ...files[0].item, requirements: [] } };
  assert.throws(() => optimizeBaskets([edited, ...files.slice(1)]), /does not identify/u);
  const wrongIndex = { ...files[0], context: { ...files[0].context, itemIndex: 1 } };
  assert.throws(() => optimizeBaskets([wrongIndex, ...files.slice(1)], { request: plan }),
    /does not match the request item at index 1/u);
  const wrongStore = structuredClone(files[0]);
  wrongStore.stores[0].options[0].storeId = 'wrong';
  assert.throws(() => optimizeBaskets([wrongStore, ...files.slice(1)]), /inconsistent store identity/u);
});

test('no complete recommendation when exact stores have complementary options only', async () => {
  const { files } = await multiItemRun();
  const split = files.map((file, index) => ({
    ...file,
    stores: file.stores.filter(store => store.retailer === (index === 0 ? 'shufersal' : 'rami_levy'))
  }));
  const result = optimizeBaskets(split);
  assert.equal(result.recommendedBasket, null);
  assert.equal(result.noCompleteBasket, true);
  assert.equal(result.excludedStores.length, 2);
});

test('file-based CLIs carry the item index from search through the complete basket', async t => {
  const { plan, results } = await multiItemRun();
  const cwd = await mkdtemp(join(tmpdir(), 'smartcart-cli-'));
  t.after(async () => {
    for (const file of await readdir(cwd)) await rm(join(cwd, file));
    await rmdir(cwd);
  });
  const run = (name, ...args) => promisify(execFile)(process.execPath, [
    '--preserve-symlinks', '--preserve-symlinks-main',
    fileURLToPath(new URL(`../../engine/${name}.mjs`, import.meta.url)), ...args
  ], { cwd });
  const write = (name, value) => writeFile(join(cwd, name), JSON.stringify(value), 'utf8');
  const read = async name => JSON.parse(await readFile(join(cwd, name), 'utf8'));
  const catalogPath = fileURLToPath(new URL('../fixtures/catalog-sample.json', import.meta.url));
  const requestPath = 'shopping-request.json';
  await write(requestPath, plan);
  await run('smartcart-matcher', 'search', requestPath, catalogPath, '1');
  const eggSearch = await read('search-results.json');
  assert.deepEqual(eggSearch.context, createItemContext(plan, 1));
  const legacyPath = 'legacy-shopping-request.json';
  await write(legacyPath, { userRequest: multiRequest, items: plan.items.map(item => ({
    product: item.product, searchTerms: item.searchTerms, quantity: item.quantity,
    requirements: [], preferences: item.preferences
  })) });
  await assert.rejects(run('smartcart-matcher', 'search', legacyPath, catalogPath, '1'), /3%/u);
  await run('smartcart-search', requestPath, catalogPath, '0');
  const milkSearch = await read('search-results.json');
  assert.deepEqual(milkSearch.context, createItemContext(plan, 0));
  assert.throws(() => searchProductsForItem(milkSearch, eggSearch.context, plan.items[1]), /shopping item/u);

  const optionPaths = [];
  for (const [index, { matches }] of results.entries()) {
    const matchPath = `match-results-${index}.json`;
    const optionPath = `shopping-options-${index}.json`;
    await write(matchPath, matches);
    await run('smartcart-quantity-price', matchPath, optionPath);
    assert.deepEqual((await read(optionPath)).context, createItemContext(plan, index));
    optionPaths.push(optionPath);
  }
  await assert.rejects(run('smartcart-basket-optimizer', '--request', requestPath, ...optionPaths.slice(1)),
    /all 4 shopping items/u);
  await run('smartcart-basket-optimizer', '--request', requestPath, ...optionPaths);
  assert.equal((await read('basket-results.json')).recommendedBasket.totalPriceIls, 67.26);
});

test('basket chooses a cheaper mixed-SKU quantity within one exact store', () => {
  const plan = { userRequest: 'I want 500 grams of rice', items: [{
    product: 'rice', searchTerms: ['אורז'], requirements: [], preferences: [],
    quantity: { amount: 500, unit: 'g' }
  }] };
  const item = plan.items[0];
  const rows = [[200, 4], [300, 5]].map(([quantity, listedPriceIls]) => ({
    product: {
      _id: `rice-${quantity}`, retailer: 'shop', chainId: '1', subChainId: '2', storeId: '3',
      name: `Rice ${quantity} g`, package: { quantity, unit: 'g', isWeighted: false },
      pricing: { listedPriceIls }
    }, identityStatus: 'MATCH', requirementChecks: [], preferencesMet: []
  }));
  const options = buildQuantityPriceOptions({ item, context: createItemContext(plan, 0), matches: rows });
  const { recommendedBasket } = optimizeBaskets([options]);
  assert.equal(recommendedBasket.totalPriceIls, 9);
  assert.equal(recommendedBasket.items[0].products.length, 2);
  assert.equal(recommendedBasket.items[0].overbuy.amount, 0);
});

test('six 500 ml bottles cannot be replaced by a cheaper pack with the same total volume', async () => {
  const draft = {
    sourceText: '6 bottles × 500 ml of water',
    product: 'water', coreSearchTerm: 'מים', searchTerms: [],
    quantity: { amount: 6, unit: 'bottle' },
    constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '500 ml' }]
  };
  const plan = await extract(`I want ${draft.sourceText}`, [draft]);
  const offer = (_id, name, listedPriceIls) => ({
    _id, name, retailer: 'store', chainId: '10', subChainId: '20', storeId: '30',
    package: { quantity: 3, unit: 'l', isWeighted: false },
    pricing: { listedPriceIls }
  });
  const { results: products } = searchCatalog([
    offer('six-half-liter', 'מים 6 bottles × 500 ml', 12),
    offer('three-one-liter', 'מים 3 bottles × 1 l', 4)
  ], plan.items[0]);
  const matches = await matchProducts({
    item: plan.items[0], products, context: createItemContext(plan, 0),
    callModel: async () => ({ decisions: products.map(product => ({
      id: product._id, candidate: 'Controlled fixture', identityEvidence: product.name, relation: 'SAME_PRODUCT', identity: 'MATCH',
      requirementChecks: [{ requirement: '500 ml', kind: 'OTHER', result: 'MET',
        evidence: product.name, evidenceSource: 'NAME' }],
      preferencesMet: []
    })) })
  });
  assert.deepEqual(matches.rejected.map(row => row.product._id), ['three-one-liter']);
  const { recommendedBasket } = optimizeBaskets([buildQuantityPriceOptions(matches)], { mode: 'cheapest' });
  assert.equal(recommendedBasket.totalPriceIls, 12);
  assert.equal(recommendedBasket.items[0].products[0].productId, 'six-half-liter');
  assert.equal(recommendedBasket.items[0].purchasedQuantity.amount, 6);
});
