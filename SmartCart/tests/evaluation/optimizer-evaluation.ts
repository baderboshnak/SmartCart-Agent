import assert from 'node:assert/strict';
import { optimizeBaskets } from '@engine/smartcart-basket-optimizer.mjs';
import type { Basket, BasketMode } from '@engine/smartcart-basket-optimizer.mjs';
import type { CatalogRecord, EngineItem, EngineQuantity } from '@engine/engine-types.mjs';
import { createItemContext } from '@engine/smartcart-pipeline-context.mjs';
import { buildQuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import type { Budget } from '@/lib/shared/types';
import { basketsIn, verifyBasketResult } from '@/lib/shopping/validation';
import { recordCase } from './backend-case';
import type { EvaluationCase, EvaluationSection } from './types';

const exactStores = ['market:1:7:001', 'market:1:7:002'];
const preference = 'local maker';
type Offer = {
  item: number; store: number; size: number; unit: 'units' | 'g' | 'kg' | 'ml' | 'l'; priceCents: number;
  preferred?: boolean; weighted?: boolean; verdict?: 'MATCH' | 'NO_MATCH' | 'UNCERTAIN'; code?: string;
};
type Item = { product: string; quantity: EngineQuantity };
type Trial = { id: string; items: Item[]; offers: Offer[]; budget?: Budget; premium: number; mode: BasketMode };
type Option = { cents: number; score: number };

const baseAmount = (amount: number, unit: string) => unit === 'kg' || unit === 'l' ? amount * 1000 : amount;
const priceFirst = (a: Option, b: Option) => a.cents - b.cents || b.score - a.score;
const preferencesFirst = (a: Option, b: Option) => b.score - a.score || a.cents - b.cents;

/** Independent enumerator. Counts and costs come from the fixture's raw offers. */
function enumerateLine(qty: EngineQuantity, candidates: Offer[]): Option[] {
  const minimum = qty.amount === 0 ? 1 : baseAmount(qty.amount, qty.unit);
  const maximum = qty.maxAmount === undefined ? Infinity : baseAmount(qty.maxAmount, qty.unit);
  function countFrom(start: number, amount: number, cents: number, preferred: boolean): Option[] {
    if (amount >= minimum) return [{ cents, score: Number(preferred) }];
    return candidates.slice(start).flatMap((offer, offset) => {
      const nextAmount = amount + baseAmount(offer.size, offer.unit);
      if (nextAmount > maximum) return [];
      return countFrom(start + offset, nextAmount, cents + offer.priceCents, preferred && offer.preferred === true);
    });
  }
  return countFrom(0, 0, 0, true);
}

function legalBaskets(trial: Trial, store: number): Option[] {
  let options: Option[] = [{ cents: 0, score: 0 }];
  for (const [index, item] of trial.items.entries()) {
    const eligible = trial.offers.filter(offer => offer.item === index && offer.store === store
      && !offer.weighted && (offer.verdict ?? 'MATCH') === 'MATCH');
    const lines = enumerateLine(item.quantity, eligible);
    options = options.flatMap(basket => lines.map(line => ({ cents: basket.cents + line.cents, score: basket.score + line.score })));
  }
  return options;
}

function reference(trial: Trial) {
  const budget = trial.budget ? Math.round(trial.budget.amountIls * 100) - Number(trial.budget.exclusive) : Infinity;
  const stores = exactStores.map((storeKey, index) => ({ storeKey, options: legalBaskets(trial, index).filter(option => option.cents <= budget) }));
  const all = stores.flatMap(store => store.options);
  const cheapest = all.toSorted(priceFirst)[0] ?? null;
  const preferred = all.toSorted(preferencesFirst)[0] ?? null;
  const max = cheapest ? Math.min(budget, Math.floor(cheapest.cents * (100 + trial.premium) / 100)) : null;
  const balanced = all.filter(option => max !== null && option.cents <= max).toSorted(preferencesFirst)[0] ?? null;
  return {
    cheapest, preferred, balanced, recommended: { balanced, cheapest, 'preferences-first': preferred }[trial.mode],
    max, completeStores: stores.filter(store => store.options.length).map(store => store.storeKey)
  };
}

function runTrial(trial: Trial) {
  const items: EngineItem[] = trial.items.map(item => ({ ...item, searchTerms: ['מזון'], requirements: [], preferences: [preference] }));
  const plan = { items, userRequest: trial.items.map(item => item.product).join(', '),
    ...(trial.budget ? { budgetIls: trial.budget.amountIls, budgetExclusive: trial.budget.exclusive } : {}) };
  const products = new Map<string, CatalogRecord>();
  const offerTypes = new Map<string, Offer>();
  const files = items.map((item, itemIndex) => {
    const rows = trial.offers.flatMap((offer, index) => {
      if (offer.item !== itemIndex) return [];
      const productCode = offer.code ?? `SKU-${index}`;
      const storeId = offer.store === 0 ? '001' : '002';
      const product: CatalogRecord = {
        _id: `${exactStores[offer.store]}:${productCode}`, retailer: 'market', chainId: '1', subChainId: '7', storeId, productCode,
        name: `Fixture ${item.product} ${offer.size} ${offer.unit}`, package: { quantity: offer.size, unit: offer.unit, isWeighted: offer.weighted ?? false },
        pricing: { listedPriceIls: offer.priceCents / 100 }
      };
      products.set(product._id, product);
      offerTypes.set(product._id, offer);
      return [{ product, identityStatus: offer.verdict ?? 'MATCH', requirementChecks: [], preferencesMet: offer.preferred ? [preference] : [] }];
    });
    return buildQuantityPriceOptions({
      item, context: createItemContext(plan, itemIndex),
      matches: rows.filter(row => row.identityStatus === 'MATCH'),
      rejected: rows.filter(row => row.identityStatus === 'NO_MATCH'),
      uncertain: rows.filter(row => row.identityStatus === 'UNCERTAIN')
    });
  });
  const result = optimizeBaskets(files, { mode: trial.mode, maxPremiumPct: trial.premium, request: plan });
  const summary = (basket: Basket | null) => basket && ({ cents: Math.round(basket.totalPriceIls * 100), score: basket.preferencesSatisfied });
  const integrity = verifyBasketResult({ result, items, products, mode: trial.mode, maxPremiumPct: trial.premium, budget: trial.budget ?? null });
  const selected = basketsIn(result).flatMap(basket => basket.items.flatMap(line => line.products.map(product => ({
    productId: product.productId, originStore: exactStores[offerTypes.get(product.productId)!.store], store: basket.storeKey,
    verdict: offerTypes.get(product.productId)!.verdict ?? 'MATCH', weighted: offerTypes.get(product.productId)!.weighted ?? false,
    priceCents: offerTypes.get(product.productId)!.priceCents, packageCount: product.packageCount,
    actualCents: Math.round(product.linePriceIls * 100)
  }))));
  return {
    cheapest: summary(result.cheapestCompleteBasket), preferred: summary(result.preferencesFirstBasket),
    balanced: summary(result.balancedBasket), recommended: summary(result.recommendedBasket),
    max: result.balancedMaxPriceIls === null ? null : Math.round(result.balancedMaxPriceIls * 100),
    completeStores: result.storeComparisons.map(store => store.storeKey),
    missing: result.excludedStores.flatMap(store => store.missingItems.map(item => item.product)),
    weightedEstimates: result.weightedEstimatesExcluded.length, selected, integrity
  };
}

function testScenarios(): Trial[] {
  const bread: Item = { product: 'bread', quantity: { amount: 1, unit: 'units' } };
  const tomatoes: Item = { product: 'tomatoes', quantity: { amount: 1.5, unit: 'kg' } };
  const p = (size: number, priceCents: number, store = 0, item = 0): Offer => ({ item, store, size, unit: 'units', priceCents });
  const trials: Trial[] = [
    { id: 'inclusive-exact', items: [bread], offers: [p(1, 1000)], budget: { amountIls: 10, exclusive: false }, premium: 15, mode: 'balanced' },
    { id: 'exclusive-exact', items: [bread], offers: [p(1, 1000)], budget: { amountIls: 10, exclusive: true }, premium: 15, mode: 'balanced' },
    { id: 'half-kilo-mix', items: [tomatoes], offers: [{ ...p(0.5, 370), unit: 'kg' }, { ...p(1000, 660), unit: 'g' }, { ...p(1500, 500, 1), unit: 'g', weighted: true }], premium: 15, mode: 'cheapest' },
    { id: 'rejected-cheap-decoys', items: [bread], offers: [p(1, 499), { ...p(1, 20), verdict: 'NO_MATCH' }, { ...p(1, 10, 1), verdict: 'UNCERTAIN' }], premium: 0, mode: 'cheapest' },
    { id: 'split-stores', items: [bread, { product: 'eggs', quantity: { amount: 12, unit: 'units' } }], offers: [p(1, 400), p(12, 1200, 1, 1)], premium: 15, mode: 'balanced' },
    { id: 'same-code-different-store', items: [bread], offers: [{ ...p(1, 599), code: '46000001' }, { ...p(1, 495, 1), code: '46000001' }], premium: 15, mode: 'balanced' },
    { id: 'exact-range-multipack', items: [{ product: 'eggs', quantity: { amount: 10, maxAmount: 12, unit: 'units' } }], offers: [p(6, 605), p(4, 419), p(15, 300)], premium: 0, mode: 'cheapest' },
    { id: 'unknown-quantity', items: [{ product: 'bread', quantity: { amount: 0, unit: 'unspecified' } }], offers: [p(2, 950), p(5, 1750), p(3, 790, 1)], premium: 0, mode: 'cheapest' }
  ];
  let seed = 104609;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 2 ** 32 * max);
  };
  const modes: BasketMode[] = ['cheapest', 'balanced', 'preferences-first'];
  for (let trial = 0; trial < 24; trial++) {
    const items: Item[] = ['rice package', 'eggs'].map(product => {
      const amount = 1 + random(6);
      return { product, quantity: { amount, unit: 'units', ...(trial % 2 ? { maxAmount: amount + random(4) } : {}) } };
    });
    const offers = items.flatMap((_, item) => exactStores.flatMap((_, store) => Array.from({ length: 3 }, () => ({
      ...p(1 + random(5), 120 + random(1330), store, item), preferred: random(2) === 1
    }))));
    trials.push({ id: `enumerated-${trial + 1}`, items, offers, mode: modes[trial % modes.length]!, premium: random(41),
      ...(trial % 3 ? { budget: { amountIls: (900 + random(4600)) / 100, exclusive: trial % 2 === 1 } } : {}) });
  }
  return trials;
}

export async function runOptimizer(): Promise<EvaluationSection> {
  const cases: EvaluationCase[] = [];
  for (const trial of testScenarios()) {
    const expected = reference(trial);
    const request = trial.items.map(item => `${item.quantity.amount} ${item.quantity.unit} ${item.product}`).join(', ');
    await recordCase(cases, { id: `optimizer-${trial.id}`, title: trial.id.replaceAll('-', ' '), request,
      category: 'optimizer', component: 'quantity, pricing and basket optimizer', expected }, () => runTrial(trial), actual => {
      const { selected, integrity, missing, weightedEstimates, ...observed } = actual;
      assert.deepEqual(observed, expected);
      assert.equal(integrity.passed, true, integrity.failures.join('; '));
      assert.ok(selected.every(purchase => purchase.originStore === purchase.store && purchase.verdict === 'MATCH' && !purchase.weighted));
      assert.ok(selected.every(purchase => purchase.priceCents * purchase.packageCount === purchase.actualCents));
      if (trial.id === 'split-stores') assert.equal(new Set(missing).size, 2);
      if (trial.id === 'half-kilo-mix') assert.equal(weightedEstimates, 1);
    });
  }
  const changingPrice = testScenarios().find(trial => trial.id === 'same-code-different-store')!;
  await recordCase(cases, { id: 'optimizer-price-change', title: 'Rerank the same offers after a catalog price change',
    request: 'Buy bread at the current prices', category: 'optimizer', component: 'basket optimizer',
    expected: { beforeCents: 495, afterCents: 299, beforeStore: exactStores[1], afterStore: exactStores[0] }
  }, () => {
    const before = runTrial(changingPrice);
    const after = runTrial({ ...changingPrice, offers: changingPrice.offers.map(offer => offer.store === 0 ? { ...offer, priceCents: 299 } : offer) });
    return { beforeCents: before.recommended?.cents, afterCents: after.recommended?.cents,
      beforeStore: before.selected.find(row => row.priceCents === before.recommended?.cents)?.store,
      afterStore: after.selected.find(row => row.priceCents === after.recommended?.cents)?.store };
  }, actual => assert.deepEqual(actual, { beforeCents: 495, afterCents: 299, beforeStore: exactStores[1], afterStore: exactStores[0] }));
  return {
    name: 'Basket arithmetic and independent optimum', mode: 'DETERMINISTIC', cases,
    metrics: { exhaustiveFixtures: cases.length, existingExhaustiveFixtures: 80, externalAiRequests: 0 },
    notes: [
      'The independent reference enumerates valid raw-offer package combinations in integer cents and base units. It compares all optimization modes and separate store availability without using the production optimizer to derive expected results.',
      'Fixtures exercise budget equality and exclusion, missing items, package ranges, mixed units, weighted offers, duplicate barcodes across stores and cheaper rejected candidates.',
      'The existing engine basket scenario suite also compares 80 reproducible catalogs against an independent oracle at four premium limits.'
    ]
  };
}
