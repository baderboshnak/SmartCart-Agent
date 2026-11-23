import assert from 'node:assert/strict';
import test from 'node:test';
import { understandShoppingRequest } from '../../engine/smartcart-llm.mjs';
import { buildCatalog, searchCatalog } from '../../engine/smartcart-search.mjs';
import { matchProducts } from '../../engine/smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { optimizeBaskets } from '../../engine/smartcart-basket-optimizer.mjs';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';

function requestItem(sourceText, product, coreSearchTerm, quantity = { amount: 0, unit: 'unspecified' }, constraintEvidence = []) {
  return { sourceText, product, coreSearchTerm, quantity, constraintEvidence, searchTerms: [] };
}

const milk = requestItem('milk', 'milk', 'חלב');
const oatMilk = requestItem('oat milk', 'oat milk', 'חלב שיבולת');
const eggs = requestItem('eggs', 'eggs', 'ביצים');
const range = { amount: 2, unit: 'l', maxAmount: 3 };

function offer(id, item, name, amount, listedPriceIls, { storeId = '101', unit = 'l', manufacturer } = {}) {
  return {
    item, product: {
      _id: id, name, retailer: 'market', chainId: '1', subChainId: '1', storeId,
      manufacturer: manufacturer ? { name: manufacturer } : undefined,
      package: { quantity: amount, unit, isWeighted: false },
      pricing: { listedPriceIls }
    }
  };
}

async function runPipeline(text, items, offers) {
  const plan = await understandShoppingRequest(text, {
    callModel: async ({ declaration }) => {
      if (declaration.name === 'submit_shopping_request') return { items };
      assert.equal(declaration.name, 'audit_shopping_request');
      return { items: items.map(({ sourceText, quantity, constraintEvidence }) => ({ sourceText, quantity, constraintEvidence })) };
    }
  });
  const catalog = buildCatalog(offers.map(({ product }) => product));
  const identities = new Map(offers.map(({ item, product }) => [product._id, item]));
  const matched = await Promise.all(plan.items.map((item, itemIndex) => matchProducts({
    item, context: createItemContext(plan, itemIndex), products: searchCatalog(catalog, item).results,
    callModel: async ({ prompt }) => {
      const productsLabel = '\nProducts: ';
      const candidates = JSON.parse(prompt.slice(prompt.lastIndexOf(productsLabel) + productsLabel.length));
      return {
        decisions: candidates.map(candidate => {
          const identity = identities.get(candidate.id) === item.product ? 'MATCH' : 'NO_MATCH';
          const requirementChecks = item.requirements.map(requirement => {
            const evidencePattern = requirement.includes('%') ? /\d+%/u : /\d+(?:\.\d+)?\s*(?:ml|l)/iu;
            const evidence = candidate.name.match(evidencePattern)?.[0];
            return {
              requirement, kind: 'OTHER', result: evidence ? 'MET' : 'UNKNOWN',
              evidenceSource: evidence ? 'NAME' : 'NONE', evidence: evidence ?? ''
            };
          });
          return {
            id: candidate.id, identity, reason: 'Controlled catalog evidence', requirementChecks,
            preferencesMet: identity === 'MATCH' && candidate.manufacturer === 'תנובה' ? item.preferences : []
          };
        })
      };
    }
  })));
  const options = matched.map(buildQuantityPriceOptions);
  return { plan, matched, options, result: optimizeBaskets([...options].reverse(), { request: plan }) };
}

test('2–3 liters of milk buys the cheapest amount within the requested range', async () => {
  const { plan, result } = await runPipeline('I want 2–3 liters of milk.', [
    { ...milk, sourceText: '2–3 liters of milk', quantity: range }
  ], [
    offer('regular-liter', 'milk', 'חלב 1 L', 1, 6),
    offer('cheaper-but-oversize', 'milk', 'חלב 4 L', 4, 1),
    offer('oversize-only-store', 'milk', 'חלב 4 L', 4, 1, { storeId: '202' })
  ]);
  assert.deepEqual(plan.items[0].quantity, range);
  assert.equal(result.completeStores, 1);
  assert.equal(result.recommendedBasket.totalPriceIls, 12);
  const [line] = result.recommendedBasket.items;
  assert.deepEqual(line.purchasedQuantity, { amount: 2000, unit: 'ml' });
  assert.equal(line.packageCount, 2);
  assert.deepEqual(line.products.map(product => product.productId), ['regular-liter']);
});

test('a bounded mixed-package purchase keeps the mandatory percentage and optional brand', async () => {
  const { plan, matched, result } = await runPipeline('I want 2–3 liters of 3% milk, preferably Tnuva.', [
    {
      ...milk, sourceText: '2–3 liters of 3% milk, preferably Tnuva', quantity: range,
      constraintEvidence: [
        { type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' },
        { type: 'PREFERENCE', kind: 'BRAND', sourceText: 'Tnuva' }
      ]
    }
  ], [
    offer('large-tnuva', 'milk', 'חלב תנובה 3% 1.7 L', 1.7, 8, { manufacturer: 'תנובה' }),
    offer('small-tnuva', 'milk', 'חלב תנובה 3% 500 ml', 500, 3, { unit: 'ml', manufacturer: 'תנובה' }),
    offer('wrong-fat', 'milk', 'חלב תנובה 1% 1 L', 1, 1, { manufacturer: 'תנובה' })
  ]);
  assert.deepEqual(plan.items[0].requirements, ['3%']);
  assert.deepEqual(plan.items[0].preferences, ['Tnuva']);
  assert.deepEqual(matched[0].rejected.map(row => row.product._id), ['wrong-fat']);
  const [line] = result.recommendedBasket.items;
  assert.equal(result.recommendedBasket.totalPriceIls, 11);
  assert.equal(result.recommendedBasket.preferencesSatisfied, 1);
  assert.deepEqual(line.purchasedQuantity, { amount: 2200, unit: 'ml' });
  assert.deepEqual(line.products.map(product => product.productId).sort(), ['large-tnuva', 'small-tnuva']);
});

test('milk or oat milk is one choice alongside eggs in the same store', async () => {
  const { plan, result } = await runPipeline('I want milk or oat milk, and eggs.', [milk, oatMilk, eggs], [
    offer('dairy-store-101', 'milk', 'חלב 1 L', 1, 5),
    offer('oat-store-101', 'oat milk', 'חלב שיבולת שועל 1 L', 1, 7),
    offer('eggs-store-101', 'eggs', 'ביצים', 6, 2, { unit: 'units' }),
    offer('cheaper-store-without-eggs', 'milk', 'חלב 1 L', 1, 1, { storeId: '202' }),
    offer('oat-only-store-303', 'oat milk', 'חלב שיבולת שועל 1 L', 1, 8, { storeId: '303' }),
    offer('eggs-store-303', 'eggs', 'ביצים', 6, 2, { unit: 'units', storeId: '303' })
  ]);
  assert.equal(plan.items[0].choiceGroup, 'choice-0');
  assert.equal(plan.items[1].choiceGroup, 'choice-0');
  assert.equal(plan.items[2].choiceGroup, undefined);
  assert.equal(result.completeStores, 2);
  assert.equal(result.recommendedBasket.storeId, '101');
  assert.equal(result.recommendedBasket.totalPriceIls, 7);
  assert.deepEqual(result.recommendedBasket.items.map(row => row.itemIndex), [0, 2]);
  const oatOnlyStore = result.storeComparisons.find(store => store.storeId === '303');
  assert.deepEqual(oatOnlyStore.cheapest.items.map(row => row.itemIndex), [1, 2]);
});

test('an alternative can be purchased in multiple packages without mixing different groceries', async () => {
  const { result } = await runPipeline('I want 2–3 liters of milk or 2–3 liters of oat milk.', [
    { ...milk, sourceText: '2–3 liters of milk', quantity: range },
    { ...oatMilk, sourceText: '2–3 liters of oat milk', quantity: range }
  ], [
    offer('cheap-dairy', 'milk', 'חלב 1.7 L', 1.7, 1),
    offer('small-oat', 'oat milk', 'חלב שיבולת שועל 500 ml', 500, 3, { unit: 'ml' })
  ]);
  const [line] = result.recommendedBasket.items;
  assert.equal(result.recommendedBasket.items.length, 1);
  assert.equal(line.itemIndex, 1);
  assert.equal(line.packageCount, 4);
  assert.deepEqual(line.purchasedQuantity, { amount: 2000, unit: 'ml' });
  assert.equal(result.recommendedBasket.totalPriceIls, 12);
  assert.deepEqual(line.products.map(product => product.productId), ['small-oat']);
});

test('independent choice groups must each be fulfilled at the same store', async () => {
  const bread = requestItem('bread', 'bread', 'לחם');
  const { plan, result } = await runPipeline('I want milk or oat milk, and eggs or bread.', [milk, oatMilk, eggs, bread], [
    offer('milk-store-101', 'milk', 'חלב 1 L', 1, 5),
    offer('bread-store-101', 'bread', 'לחם', 1, 4, { unit: 'units' }),
    offer('oat-store-202', 'oat milk', 'חלב שיבולת שועל 1 L', 1, 1, { storeId: '202' }),
    offer('eggs-store-303', 'eggs', 'ביצים', 6, 1, { unit: 'units', storeId: '303' })
  ]);
  assert.deepEqual(plan.items.map(item => item.choiceGroup), ['choice-0', 'choice-0', 'choice-2', 'choice-2']);
  assert.equal(result.completeStores, 1);
  assert.equal(result.recommendedBasket.storeId, '101');
  assert.equal(result.recommendedBasket.totalPriceIls, 9);
  assert.deepEqual(result.recommendedBasket.items.map(line => line.itemIndex), [0, 3]);
});

test('a bottle count range still requires the requested size per bottle', async () => {
  const text = 'I want 2–3 bottles × 500 ml of water.';
  const item = requestItem('2–3 bottles × 500 ml of water', 'water', 'מים',
    { amount: 2, maxAmount: 3, unit: 'bottle' },
    [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '500 ml' }]);
  const offers = [
    offer('half-liter-water', 'water', 'בקבוק מים 500 ml', 500, 4, { unit: 'ml' }),
    offer('cheaper-liter-water', 'water', 'בקבוק מים 1 L', 1, 2)
  ];

  await assert.rejects(runPipeline(text, [{ ...item, constraintEvidence: [] }], offers), /required size per bottle/);
  const { matched, result } = await runPipeline(text, [item], offers);
  assert.deepEqual(matched[0].rejected.map(row => row.product._id), ['cheaper-liter-water']);
  assert.equal(result.recommendedBasket.totalPriceIls, 8);
  const [line] = result.recommendedBasket.items;
  assert.equal(line.packageCount, 2);
  assert.deepEqual(line.products.map(product => product.productId), ['half-liter-water']);
});
