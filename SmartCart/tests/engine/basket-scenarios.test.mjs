import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeBaskets } from '../../engine/smartcart-basket-optimizer.mjs';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { searchCatalog } from '../../engine/smartcart-search.mjs';

test('Hebrew search finds the same product with or without points and direction markers', () => {
  const catalog = [
    { _id: 'regular', name: 'חלב 3%' },
    { _id: 'points', name: 'חָלָב 1%' },
    { _id: 'direction', name: 'חל\u200fב 2%' },
    { _id: 'other', name: 'לחם' }
  ];
  for (const term of ['חלב', 'חָלָב', 'חל\u200fב']) {
    const result = searchCatalog(catalog, { searchTerms: [term] });
    assert.deepEqual(result.results.map(product => product._id), ['regular', 'points', 'direction']);
  }
});

const preferenceNames = ['Local', 'Organic'];
const stores = ['101', '202'];

function scenarioFiles(targets, catalog) {
  const plan = { userRequest: 'A count of two grocery items', items: targets.map((amount, index) => ({
    product: `grocery ${index}`, searchTerms: ['מזון'], requirements: [],
    preferences: preferenceNames, quantity: { amount, unit: 'units' }
  })) };
  return plan.items.map((item, index) => {
    const matches = catalog[index].flatMap((offers, storeIndex) =>
      offers.map(({ size, cents, preferences }, offerIndex) => ({
        product: {
          _id: `${index}-${storeIndex}-${offerIndex}`, name: item.product,
          retailer: 'market', chainId: '1', subChainId: '1', storeId: stores[storeIndex],
          package: { quantity: size, unit: 'units', isWeighted: false },
          pricing: { listedPriceIls: cents / 100 }
        },
        identityStatus: 'MATCH', requirementChecks: [], preferencesMet: preferences
      })));
    return buildQuantityPriceOptions({ item, context: createItemContext(plan, index), matches });
  });
}

function enumeratePurchases(offers, remaining, start = 0, cost = 0, preferences = preferenceNames) {
  if (remaining <= 0) return [{ cost, score: preferences.length }];
  return offers.slice(start).flatMap(({ size, cents, preferences: have }, offset) =>
    enumeratePurchases(offers, remaining - size, start + offset,
      cost + cents, preferences.filter(preference => have.includes(preference))));
}

function referenceBaskets(targets, catalog) {
  return stores.flatMap((_, storeIndex) => {
    let combinations = [{ cost: 0, score: 0 }];
    for (const [index, target] of targets.entries()) {
      const purchases = enumeratePurchases(catalog[index][storeIndex], target);
      combinations = combinations.flatMap(basket => purchases.map(purchase => ({
        cost: basket.cost + purchase.cost, score: basket.score + purchase.score
      })));
    }
    return combinations;
  });
}

const cheapestFirst = (a, b) => a.cost - b.cost || b.score - a.score;
const preferencesFirst = (a, b) => b.score - a.score || a.cost - b.cost;
const outcome = basket => basket && ({
  cost: Math.round(basket.totalPriceIls * 100),
  score: basket.preferencesSatisfied
});

test('basket modes agree with exhaustive package combinations across 80 reproducible scenarios', () => {
  let seed = 908318;
  function random(maximum) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / (2 ** 32) * maximum);
  }
  const premiums = [0, 15, 37, 100];
  for (let scenario = 0; scenario < 80; scenario++) {
    const targets = [1 + random(4), 1 + random(4)];
    const catalog = targets.map((_, itemIndex) => stores.map((_, storeIndex) => {
      if (scenario % 8 === 0 && storeIndex !== itemIndex) return [];
      return Array.from({ length: 3 }, () => ({
        size: 1 + random(4), cents: 150 + random(351),
        preferences: preferenceNames.filter(() => random(2) === 1)
      }));
    }));
    const files = scenarioFiles(targets, catalog);
    const reference = referenceBaskets(targets, catalog);
    const cheapest = [...reference].sort(cheapestFirst)[0] ?? null;
    const preferred = [...reference].sort(preferencesFirst)[0] ?? null;
    for (const premium of premiums) {
      const withinBudget = reference.filter(candidate => candidate.cost * 100 <= cheapest.cost * (100 + premium));
      const balanced = withinBudget.sort(preferencesFirst)[0] ?? null;
      const result = optimizeBaskets(files, { maxPremiumPct: premium });
      const message = `scenario ${scenario}, premium ${premium}%`;
      assert.deepEqual(outcome(result.cheapestCompleteBasket), cheapest, message);
      assert.deepEqual(outcome(result.preferencesFirstBasket), preferred, message);
      assert.deepEqual(outcome(result.recommendedBasket), balanced, message);
      assert.equal(result.noCompleteBasket, cheapest === null, message);
    }
  }
});

test('balanced mode accepts an exact premium cutoff and rejects an offer one cent above it', () => {
  const targets = [1];
  const cheap = { size: 1, cents: 1000, preferences: [] };
  const preferred = { size: 1, cents: 1150, preferences: ['Local'] };
  const equal = scenarioFiles(targets, [[[cheap], [preferred]]]);
  const over = scenarioFiles(targets, [[[cheap], [{ ...preferred, cents: 1151 }]]]);
  assert.equal(optimizeBaskets(equal).recommendedBasket.storeId, '202');
  assert.equal(optimizeBaskets(over).recommendedBasket.storeId, '101');
  assert.equal(optimizeBaskets(over, { mode: 'preferences-first' }).recommendedBasket.storeId, '202');
  assert.equal(optimizeBaskets(equal, { mode: 'cheapest' }).recommendedBasket.storeId, '101');
});
