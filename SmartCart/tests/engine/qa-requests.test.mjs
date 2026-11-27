import assert from 'node:assert/strict';
import { test } from 'node:test';
import { understandDirectShoppingRequest } from '../../engine/smartcart-llm.mjs';
import { assertShoppingPlanCoverage } from '../../engine/smartcart-request-coverage.mjs';
import { searchCatalog } from '../../engine/smartcart-search.mjs';
import { matchProducts } from '../../engine/smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { optimizeBaskets } from '../../engine/smartcart-basket-optimizer.mjs';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';
import { acceptanceRequests, mockAcceptanceCall } from './fixtures/acceptance-requests.mjs';

const semantics = items => items.map(({ product, quantity, requirements, preferences }) =>
  ({ product, quantity, requirements, preferences }));
const offer = (id, name, amount, unit, price) => ({
  _id: id, name, retailer: 'fixture', chainId: '10', subChainId: '20', storeId: '30',
  package: { quantity: amount, unit, isWeighted: false },
  pricing: { listedPriceIls: price }
});

test('acceptance manifest has at least 50 uniquely identified scenarios with multilingual coverage', () => {
  assert.ok(acceptanceRequests.length >= 50);
  assert.equal(new Set(acceptanceRequests.map(scenario => scenario.id)).size, acceptanceRequests.length);
  assert.deepEqual([...new Set(acceptanceRequests.map(scenario => scenario.locale))].sort(),
    ['ar', 'en', 'he', 'mixed']);
  for (const category of ['dairy', 'eggs', 'bread', 'grains', 'canned goods', 'beverages', 'household',
    'personal care', 'dietary', 'hard brand', 'soft brand', 'product form', 'multipack',
    'multi-item', 'ambiguity', 'unavailable', 'contradictory']) {
    assert.ok(acceptanceRequests.some(scenario => scenario.category === category), category);
  }
});

for (const { id, request, mockItems, expected } of acceptanceRequests) {
  test(`acceptance ${id}`, async () => {
    const promise = understandDirectShoppingRequest(request, {
      callModel: mockAcceptanceCall(mockItems), maxAttempts: 1
    });
    if (expected.outcome === 'reject') {
      await assert.rejects(promise, error => error.message.includes(expected.error));
      return;
    }

    const plan = await promise;
    assert.equal(plan.userRequest, request);
    assert.deepEqual(semantics(plan.items), expected.items);
    assert.deepEqual(plan.items.map(item => item.choiceGroup),
      expected.choiceGroups ?? mockItems.map(() => undefined));
    assert.equal(assertShoppingPlanCoverage(plan), plan);
    if (expected.availability === 'no-complete-basket') {
      const catalog = [offer('apple-juice', 'מיץ תפוחים 1 ליטר', 1, 'l', 6.25)];
      const item = plan.items[0];
      const { results: products } = searchCatalog(catalog, item);
      assert.deepEqual(products, []);
      const matches = await matchProducts({
        item, products, context: createItemContext(plan, 0),
        callModel: () => assert.fail('Empty search results should need no Gemini calls.')
      });
      const basket = optimizeBaskets([buildQuantityPriceOptions(matches)], { request: plan });
      assert.equal(basket.noCompleteBasket, true);
      assert.equal(basket.recommendedBasket, null);
    }
  });
}

test('T24 reordering direct items preserves product requirements and quantities', async () => {
  const forward = acceptanceRequests.find(scenario => scenario.id === 'T24 order A');
  const reverse = acceptanceRequests.find(scenario => scenario.id === 'T24 order B');
  const plans = await Promise.all([forward, reverse].map(scenario =>
    understandDirectShoppingRequest(scenario.request, { callModel: mockAcceptanceCall(scenario.mockItems) })));
  const sortedSemantics = plan => semantics(plan.items).sort((a, b) => a.product.localeCompare(b.product));
  assert.deepEqual(sortedSemantics(plans[0]), sortedSemantics(plans[1]));
});

test('T16 and T17 reject matching model outputs that change the Arabic dual or the Hebrew count', async () => {
  const scenarios = acceptanceRequests.filter(scenario => /^T(?:16|17) /u.test(scenario.id));
  for (const scenario of scenarios) {
    const index = scenario.locale === 'he' ? 1 : 0;
    const mocked = structuredClone(scenario.mockItems);
    mocked[index].quantity.amount -= 1;
    await assert.rejects(understandDirectShoppingRequest(scenario.request, {
      callModel: mockAcceptanceCall(mocked), maxAttempts: 1
    }), /changes the explicit quantity/u);
  }
});

test('T23 per-container requirement cannot disappear from the extraction or saved plan', async () => {
  const scenario = acceptanceRequests.find(scenario => scenario.id.startsWith('T23 '));
  const missing = [{ ...scenario.mockItems[0], constraintEvidence: [] }];
  await assert.rejects(understandDirectShoppingRequest(scenario.request, {
    callModel: mockAcceptanceCall(missing), maxAttempts: 1
  }), /omits the required size per bottle/u);
  const plan = await understandDirectShoppingRequest(scenario.request, {
    callModel: mockAcceptanceCall(scenario.mockItems)
  });
  plan.items[0].constraintEvidence = [];
  plan.items[0].requirements = [];
  assert.throws(() => assertShoppingPlanCoverage(plan), /omits the required size per bottle/u);
});

test('T22 repeated milk reaches checkout planning with all three liters accounted for', async () => {
  const scenario = acceptanceRequests.find(scenario => scenario.id.startsWith('T22 '));
  const plan = await understandDirectShoppingRequest(scenario.request, {
    callModel: mockAcceptanceCall(scenario.mockItems)
  });
  const product = offer('liter-milk', 'חלב 1 ליטר', 1, 'l', 6.41);
  const options = await Promise.all(plan.items.map(async (item, index) => buildQuantityPriceOptions(await matchProducts({
    item,
    products: searchCatalog([product], item).results,
    context: createItemContext(plan, index),
    callModel: () => ({ decisions: [{
      id: product._id, candidate: 'Milk', identityEvidence: product.name, relation: 'SAME_PRODUCT', identity: 'MATCH',
      requirementChecks: [], preferencesMet: []
    }] })
  }))));
  const { recommendedBasket } = optimizeBaskets(options, { request: plan });
  assert.deepEqual(recommendedBasket.items.map(line => line.packageCount), [1, 2]);
  assert.equal(recommendedBasket.items.reduce((total, line) => total + line.purchasedQuantity.amount, 0), 3000);
  assert.equal(recommendedBasket.totalPriceIls, 19.23);
});

test('T23 exact size per bottle prevents a cheap half-liter SKU from entering the basket', async () => {
  const scenario = acceptanceRequests.find(scenario => scenario.id.startsWith('T23 '));
  const plan = await understandDirectShoppingRequest(scenario.request, {
    callModel: mockAcceptanceCall(scenario.mockItems)
  });
  const item = plan.items[0];
  const products = [
    offer('full-liter-bottle', 'חלב בקבוק 1 ליטר', 1, 'l', 7.25),
    offer('half-liter-bottle', 'חלב בקבוק 500 מל', 500, 'ml', 2)
  ];
  const matches = await matchProducts({
    item,
    products: searchCatalog(products, item).results,
    context: createItemContext(plan, 0),
    callModel: () => ({ decisions: products.map(product => ({
      id: product._id, candidate: 'Milk', identityEvidence: product.name, relation: 'SAME_PRODUCT', identity: 'MATCH',
      requirementChecks: [{ requirement: '1 liter', kind: 'OTHER', result: 'MET',
        evidenceSource: 'NAME', evidence: product.name }],
      preferencesMet: []
    })) })
  });
  assert.deepEqual(matches.rejected.map(row => row.product._id), ['half-liter-bottle']);
  const { recommendedBasket } = optimizeBaskets([buildQuantityPriceOptions(matches)], { request: plan });
  assert.equal(recommendedBasket.items[0].packageCount, 3);
  assert.equal(recommendedBasket.items[0].products[0].productId, 'full-liter-bottle');
  assert.equal(recommendedBasket.totalPriceIls, 21.75);
});

test('explicit vegan and frozen descriptors require their own checks even when they remain in the product name', async () => {
  const cases = [
    ['I want to buy a frozen pizza.', 'frozen pizza', 'פיצה', 'frozen'],
    ['I want to buy vegan chocolate cake mix.', 'vegan chocolate cake mix', 'תערובת עוגת שוקולד', 'vegan'],
    ['I want to buy non-vegan cheese.', 'non-vegan cheese', 'גבינה', 'non-vegan'],
    ['אני רוצה פיצה קפואה.', 'פיצה קפואה', 'פיצה', 'קפואה'],
    ['أريد بيتزا مجمدة.', 'بيتزا مجمدة', 'פיצה', 'مجمدة']
  ];
  for (const [request, product, coreSearchTerm, qualifier] of cases) {
    const raw = {
      product, sourceText: product, coreSearchTerm, searchTerms: [],
      quantity: { amount: 0, unit: 'unspecified' }, constraintEvidence: []
    };
    await assert.rejects(understandDirectShoppingRequest(request, {
      callModel: mockAcceptanceCall([raw]), maxAttempts: 1
    }), /omits or misclassifies .* as a requirement/u);

    const corrected = { ...raw, constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: qualifier }] };
    const plan = await understandDirectShoppingRequest(request, { callModel: mockAcceptanceCall([corrected]) });
    assert.deepEqual(plan.items[0].requirements, [qualifier]);
  }
});
