import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BasketResult } from '@engine/smartcart-basket-optimizer.mjs';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { matchProducts, type MatchResults } from '@engine/smartcart-matcher.mjs';
import type { QuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import type { Cart, CartItem, ShoppingMode } from '@/lib/shared/types';
import { buildEnginePlan, engineItemCore } from '@/lib/shopping/engine-items';
import { matchItemCandidates, matchProductFingerprint } from '@/lib/shopping/matching';
import { optimizeCart, selectBasket } from '@/lib/shopping/optimizer';
import { buildItemOptions } from '@/lib/shopping/quantity';
import { verifyBasketResult } from '@/lib/shopping/validation';
import { catalogFixture, cartItem, fixtureSearch, referenceItems, STORES } from '../helpers/fixtures';
import { createFakeMatcher } from '../helpers/fake-models';

const products = new Map(catalogFixture.map(record => [record._id, record]));

function cartOf(items: CartItem[], mode: ShoppingMode = 'balanced', maxPremiumPct = 15): Cart {
  const now = new Date('2026-11-19T10:00:00Z');
  return {
    _id: 'cart_unit', sessionId: 'session_unit', revision: 1, itemsVersion: 1, mode, maxPremiumPct, budget: null,
    items, recipePlans: [], selectedStoreKey: null, calculation: null, createdAt: now, updatedAt: now, expiresAt: now
  };
}

/** The deterministic pipeline offline: engine search over the fixture, fake matcher, real pricing and optimizer. */
async function calculate(items: CartItem[], mode: ShoppingMode = 'balanced', maxPremiumPct = 15) {
  const cart = cartOf(items, mode, maxPremiumPct);
  const { plan, contexts } = buildEnginePlan(cart);
  const matcher = createFakeMatcher();
  const matches: MatchResults[] = [];
  const files: QuantityPriceOptions[] = [];
  for (const [index, item] of items.entries()) {
    const outcome = await matchItemCandidates(engineItemCore(item), fixtureSearch(item.searchTerms), { db: null, callModel: matcher.callModel, model: 'fake' });
    matches.push(outcome.results);
    files.push(buildItemOptions(outcome.results, plan.items[index]!, contexts[index]!));
  }
  const result = optimizeCart(files, plan, mode, maxPremiumPct);
  const verification = verifyBasketResult({ result, items: plan.items, products, mode, maxPremiumPct, budget: null });
  return { cart, plan, matches, files, result, verification, matcher };
}

const ids = (result: BasketResult) => result.recommendedBasket?.items.map(line => line.products.map(product => product.productId)) ?? [];

describe('matching through the TypeScript adapter', () => {
  test('8. confirms the right products and rejects other identities', async () => {
    const [milk] = referenceItems();
    const { matches } = await calculate([milk!]);
    const matched = matches[0]!.matches.map(row => row.product._id);
    assert.ok(matched.includes(`${STORES.ramiLevy}:7290004131074`));
    assert.ok(matches[0]!.rejected.length > 0);
    assert.ok(matched.every(id => ['7290000042015', '7290000042435', '7290004131074'].includes(id.split(':').at(-1)!)));
  });

  test('9. a mandatory 3% requirement rejects 1% milk even when the model claims a match', async () => {
    const [milk] = referenceItems();
    const { matches, result } = await calculate([milk!]);
    const rejected = matches[0]!.rejected.find(row => row.product._id === `${STORES.ramiLevy}:7290000042435`);
    assert.ok(rejected, '1% Tnuva milk must be rejected');
    assert.match(rejected.reason, /3%/u);
    for (const line of result.storeComparisons.flatMap(store => [store.cheapest, store.preferencesFirst]).flatMap(basket => basket.items)) {
      for (const product of line.products) {
        assert.doesNotMatch(product.productName, /1%/u);
        assert.deepEqual(product.requirementChecks.map(check => check.result), ['MET']);
      }
    }
  });

  test('9. "only Tnuva" shredded mozzarella never falls back to an unverified brand', async () => {
    const item = cartItem({ product: 'mozzarella', searchTerms: ['מוצרלה'], quantity: { amount: 500, unit: 'g' }, requirements: ['shredded', 'Tnuva'] });
    for (const mode of ['cheapest', 'balanced', 'preferences-first'] as const) {
      const { result, verification } = await calculate([item], mode);
      assert.equal(verification.passed, true, verification.failures.join('\n'));
      assert.deepEqual(ids(result), [[`${STORES.shufersal}:7290110324025`]]);
      assert.equal(result.recommendedBasket?.totalPriceIls, 41.5);
      assert.equal(result.storeComparisons.find(store => store.retailer === 'rami_levy')?.cheapest.totalPriceIls, 56.4);
    }
  });
});

describe('saved checks: which product changes need a new check', () => {
  const item = engineItemCore(referenceItems()[0]!);

  /** The exact prompt the matcher sends to Gemini for one product. */
  async function promptFor(product: CatalogRecord): Promise<string> {
    let prompt = '';
    await matchProducts({
      item, products: [product], batchSize: 1, maxAttempts: 1,
      callModel: async args => { prompt = args.prompt; throw new Error('prompt captured'); }
    }).catch(() => {});
    assert.ok(prompt, 'the prompt was captured');
    return prompt;
  }

  /** Paths to every leaf value of a record, such as ['pricing', 'listedPriceIls']. */
  const leafPaths = (value: unknown, path: string[] = []): string[][] =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...path, key]))
      : [path];

  function withChangedLeaf(product: CatalogRecord, path: string[]): CatalogRecord {
    const copy = structuredClone(product) as Record<string, unknown>;
    const parent = path.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, copy);
    const key = path.at(-1)!;
    const value = parent[key];
    parent[key] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${String(value)} x`;
    return copy as CatalogRecord;
  }

  test('a new price, price date or snapshot date keeps the fingerprint; a new name, manufacturer or package changes it', () => {
    const product = fixtureSearch(['חלב'])[0]!;
    const keeps = (label: string, other: CatalogRecord) =>
      assert.equal(matchProductFingerprint(other), matchProductFingerprint(product), `${label} must keep the fingerprint`);
    const changes = (label: string, other: CatalogRecord) =>
      assert.notEqual(matchProductFingerprint(other), matchProductFingerprint(product), `${label} must change the fingerprint`);
    keeps('a new price', { ...product, pricing: { ...product.pricing, listedPriceIls: product.pricing.listedPriceIls + 2, publishedUnitPriceIls: 9.99 } });
    keeps('new dates and source flags', { ...product, priceUpdatedAt: '2026-12-01T08:00:00', snapshotDate: '2026-12-02', source: { itemType: '0', allowDiscount: false } });
    keeps('new import fields', { ...product, storeKey: 'x', normalizedName: 'x', searchTokens: ['x'], catalog: { contentHash: 'x' }, dataQuality: ['X'], importedAt: new Date() });
    changes('a new name', { ...product, name: `${product.name} 2` });
    changes('another manufacturer', { ...product, manufacturer: { name: 'יצרן אחר', country: 'IL' } });
    changes('a removed manufacturer', { ...product, manufacturer: undefined });
    changes('a new package size', { ...product, package: { ...product.package, quantity: product.package.quantity + 1 } });
    changes('a new weighted flag', { ...product, package: { ...product.package, isWeighted: !product.package.isWeighted } });
  });

  test('every product field Gemini sees is part of the saved-check key', async () => {
    const samples = [
      fixtureSearch(['חלב'])[0]!,
      catalogFixture.find(product => product.manufacturer === undefined)!,
      catalogFixture.find(product => product.manufacturer && !product.manufacturer.name)!,
      catalogFixture.find(product => product.package.isWeighted)!
    ];
    assert.ok(samples.every(Boolean), 'the fixture has every kind of sample product');
    for (const product of samples) {
      const prompt = await promptFor(product);
      const keyFields: string[] = [];
      for (const path of leafPaths(product)) {
        const changed = withChangedLeaf(product, path);
        const sameKey = changed._id === product._id && matchProductFingerprint(changed) === matchProductFingerprint(product);
        if (!sameKey) keyFields.push(path.join('.'));
        else assert.equal(await promptFor(changed), prompt, `${path.join('.')} changes what Gemini sees but not the saved-check key`);
      }
      // Everything else (store fields, prices, dates, source flags) can change without a new check.
      const expected = ['_id', 'name', 'package.quantity', 'package.unit', 'package.isWeighted',
        ...Object.keys(product.manufacturer ?? {}).map(key => `manufacturer.${key}`)];
      assert.deepEqual(keyFields.sort(), expected.sort());
    }
  });
});

describe('soft preferences and modes', () => {
  test('10/16/17. Tnuva is preferred only within the 15% balanced premium', async () => {
    const [milk] = referenceItems();
    const balanced = await calculate([milk!], 'balanced');
    assert.equal(balanced.result.cheapestCompleteBasket?.totalPriceIls, 12.82);
    assert.equal(balanced.result.recommendedBasket?.totalPriceIls, 14.4);
    assert.equal(balanced.result.recommendedBasket?.preferencesSatisfied, 1);
    assert.equal((await calculate([milk!], 'balanced', 10)).result.recommendedBasket?.totalPriceIls, 12.82);
    assert.equal((await calculate([milk!], 'cheapest')).result.recommendedBasket?.totalPriceIls, 12.82);
    const preferencesFirst = await calculate([milk!], 'preferences-first');
    assert.equal(preferencesFirst.result.recommendedBasket?.totalPriceIls, 14.4);
    assert.equal(preferencesFirst.verification.passed, true);
  });

  test('15. cheapest mode recommends the lowest complete basket', async () => {
    const { result, verification } = await calculate(referenceItems(), 'cheapest');
    assert.equal(verification.passed, true, verification.failures.join('\n'));
    const totals = result.storeComparisons.map(store => store.cheapest.totalPriceIls);
    assert.equal(result.recommendedBasket?.totalPriceIls, Math.min(...totals));
  });
});

describe('quantities, packages and prices', () => {
  test('11/13/14/16/18. the four-item request produces a complete, verified single-store basket', async () => {
    const { result, verification } = await calculate(referenceItems(), 'balanced');
    assert.equal(verification.passed, true, verification.failures.join('\n'));
    assert.equal(result.completeStores, 2);
    const basket = result.recommendedBasket!;
    assert.equal(basket.storeKey, STORES.ramiLevy);
    assert.equal(basket.totalPriceIls, 67.26);
    assert.deepEqual(basket.items.map(line => line.itemIndex), [0, 1, 2, 3]);
    assert.deepEqual(ids(result), [
      [`${STORES.ramiLevy}:7290004131074`], [`${STORES.ramiLevy}:742259241895`], [`${STORES.ramiLevy}:379623`], [`${STORES.ramiLevy}:7290014692817`]
    ]);
    // 2 l milk from 1 l packs, 12 eggs, a 750 g loaf for 500 g, and 3 x 200 g for 500 g mozzarella.
    assert.deepEqual(basket.items.map(line => line.purchasedQuantity.amount), [2000, 12, 750, 600]);
    assert.equal(basket.items[0]!.products[0]!.packageCount, 2);
    assert.deepEqual(basket.items.map(line => line.overbuy?.amount), [0, 0, 250, 100]);
    const cents = basket.items.flatMap(line => line.products).reduce((sum, product) => sum + Math.round(product.linePriceIls * 100), 0);
    assert.equal(cents, Math.round(basket.totalPriceIls * 100));
    assert.equal(new Set(basket.items.flatMap(line => line.products.map(product => product.productId.split(':').slice(0, 4).join(':')))).size, 1);
  });

  test('12. a 12-egg carton listed as "1 unit" is one package of 12 eggs', async () => {
    const { result } = await calculate(referenceItems(), 'balanced');
    const shufersal = result.storeComparisons.find(store => store.storeKey === STORES.shufersal)!.cheapest;
    const egg = shufersal.items[1]!.products[0]!;
    assert.equal(egg.productId, `${STORES.shufersal}:7290001201572`);
    assert.equal(egg.packageCount, 1);
    assert.equal(egg.linePriceIls, 15.81);
    assert.equal(egg.originalPackage?.quantity, 1);
    assert.equal(egg.package.quantity, 12);
    assert.equal(shufersal.totalPriceIls, 68.69);
  });

  test('19. no complete basket when an item exists in no store', async () => {
    const cereal = cartItem({ product: 'lunar pebble cereal', searchTerms: ['דגני ירח'], quantity: { amount: 0, unit: 'unspecified' } });
    const { result, verification } = await calculate([referenceItems()[1]!, cereal]);
    assert.equal(result.noCompleteBasket, true);
    assert.equal(result.recommendedBasket, null);
    assert.ok(result.excludedStores.every(store => store.missingItems.some(item => item.product === 'lunar pebble cereal')));
    assert.equal(verification.passed, true);
  });

  test('20. weighted offers are reported but never bought automatically', async () => {
    const { result } = await calculate(referenceItems());
    assert.ok(result.weightedEstimatesExcluded.some(row => row.itemIndex === 3));
    const lines = result.storeComparisons.flatMap(store => [store.cheapest, store.preferencesFirst]).flatMap(basket => basket.items);
    assert.ok(lines.flatMap(line => line.products).every(product => product.package.isWeighted === false));
  });

  test('a user-selected store is evaluated with the active mode', async () => {
    const { cart, result, verification } = await calculate(referenceItems(), 'balanced');
    const selected = selectBasket({
      ...cart,
      selectedStoreKey: STORES.shufersal,
      calculation: {
        status: 'COMPLETE', itemsVersion: cart.itemsVersion, requestFingerprint: 'x', mode: 'balanced', maxPremiumPct: 15,
        itemIds: cart.items.map(item => item.id), result, verification, itemDiagnostics: [],
        catalog: { snapshotDates: [], priceUpdatedAtRange: { min: null, max: null } }, calculatedAt: new Date(), durationMs: 1
      }
    });
    assert.equal(selected.basket?.storeKey, STORES.shufersal);
    assert.equal(selected.isRecommended, false);
  });
});

describe('32. independent server-side verification', () => {
  test('passes for an untouched result and catches tampering', async () => {
    const { plan, result, verification } = await calculate(referenceItems());
    assert.equal(verification.passed, true);
    assert.ok(verification.checkedLines >= 8);
    const verify = (tampered: BasketResult, catalog = products) =>
      verifyBasketResult({ result: tampered, items: plan.items, products: catalog, mode: 'balanced', maxPremiumPct: 15, budget: null });

    const cheaper = structuredClone(result);
    cheaper.recommendedBasket!.items[0]!.products[0]!.listedUnitPriceIls = 1;
    assert.match(verify(cheaper).failures.join('\n'), /unit price/u);

    const total = structuredClone(result);
    total.recommendedBasket!.totalPriceIls -= 1;
    assert.match(verify(total).failures.join('\n'), /basket total/u);

    const mixed = structuredClone(result);
    const foreign = result.storeComparisons.find(store => store.storeKey === STORES.shufersal)!.cheapest.items[1]!.products[0]!;
    mixed.recommendedBasket!.items[1]!.products[0] = foreign;
    assert.match(verify(mixed).failures.join('\n'), /another store/u);

    const unverified = structuredClone(result);
    unverified.recommendedBasket!.items[0]!.products[0]!.requirementChecks[0]!.result = 'UNKNOWN';
    assert.match(verify(unverified).failures.join('\n'), /not confirmed/u);

    const short = structuredClone(result);
    short.recommendedBasket!.items[0]!.products[0]!.packageCount = 1;
    assert.ok(verify(short).failures.some(failure => /below the requested amount|line price/u.test(failure)));

    const missingItem = structuredClone(result);
    missingItem.recommendedBasket!.items.pop();
    assert.match(verify(missingItem).failures.join('\n'), /exactly once/u);

    const priceChanged = new Map(products);
    const milkId = result.recommendedBasket!.items[0]!.products[0]!.productId;
    priceChanged.set(milkId, { ...products.get(milkId)!, pricing: { listedPriceIls: 99.99 } });
    assert.match(verify(result, priceChanged).failures.join('\n'), /differs from the catalog/u);

    const removed = new Map(products);
    removed.delete(milkId);
    assert.match(verify(result, removed).failures.join('\n'), /no longer exists/u);
  });
});
