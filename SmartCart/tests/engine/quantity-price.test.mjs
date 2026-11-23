import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { corroborateUnitSize, normalizeRequestedQuantity } from '../../engine/smartcart-package.mjs';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';

function offer(name, quantity, unit, price = 15.81, extra = {}) {
  return {
    _id: 'fixture-product',
    name,
    retailer: 'shufersal',
    chainId: '7290027600007',
    subChainId: '002',
    storeId: '413',
    package: { quantity, unit, isWeighted: false },
    pricing: { listedPriceIls: price, publishedUnitPriceIls: 0.01 },
    ...extra
  };
}

function evaluate(product, amount, unit, productName = 'item', searchTerms = []) {
  return buildQuantityPriceOptions({
    item: { product: productName, searchTerms, requirements: [], preferences: [], quantity: { amount, unit } },
    matches: [{ product }]
  });
}

function fixed(product, amount, unit, productName, searchTerms) {
  const result = evaluate(product, amount, unit, productName, searchTerms);
  assert.equal(result.optionCount, 1, JSON.stringify(result.skipped));
  return result.stores[0].bestFixedPackage;
}

test('corrects the Shufersal 12-egg carton without mutating the unit placeholder', () => {
  const product = offer('ביצים ארוזות XL 12יחידות', 1, 'unit');
  const original = structuredClone(product);
  const option = fixed(product, 12, 'units');

  assert.equal(option.packageCount, 1);
  assert.equal(option.totalPriceIls, 15.81);
  assert.deepEqual(option.package, { quantity: 12, unit: 'units', isWeighted: false });
  assert.deepEqual(option.originalPackage, original.package);
  assert.deepEqual(option.packageInterpretation.evidence, [{
    text: '12יחידות', quantity: 12, unit: 'units', kind: 'LABELED_QUANTITY'
  }]);
  assert.equal(option.packageInterpretation.status, 'NORMALIZED_FROM_NAME');
  assert.deepEqual(product, original);
});

test('handles Hebrew retail counts across categories and preserves corroborated counts', () => {
  const bags = fixed(offer('שקיות זיפר M 25 יחידות', 1, 'unit', 10), 26, 'units');
  assert.equal(bags.packageCount, 2);
  assert.equal(bags.quantityToPurchase.normalizedAmount, 50);
  assert.equal(bags.overbuyBase, 24);

  const bulbs = fixed(offer('נורות לד 6יח׳', 6, 'unit', 20), 6, 'units');
  assert.equal(bulbs.packageInterpretation.status, 'CATALOG_CONFIRMED');
  assert.equal(bulbs.totalPriceIls, 20);

  const named = fixed(offer('12ביצים אורגניות M', 1, 'unit'), 12, 'units', 'eggs', ['ביצים']);
  assert.equal(named.packageInterpretation.evidence[0].kind, 'NAMED_CONTENTS_COUNT');
  assert.equal(named.packageCount, 1);
});

test('handles count times physical size in both quantity dimensions', () => {
  const product = offer('Mineral water 6 bottles x 500 ml', 500, 'ml', 9.5);
  const volume = fixed(product, 3, 'l');
  assert.equal(volume.packageCount, 1);
  assert.equal(volume.quantityToPurchase.normalizedAmount, 3000);
  assert.equal(volume.totalPriceIls, 9.5);

  const count = fixed(product, 6, 'bottles');
  assert.equal(count.packageCount, 1);
  assert.equal(count.quantityToPurchase.normalizedAmount, 6);
  assert.equal(count.packageInterpretation.evidence[1].container, 'bottle');

  const reverse = fixed(offer('סודה 500 מ״ל × 6', 3, 'l', 9.5), 3000, 'ml');
  assert.equal(reverse.packageInterpretation.status, 'CATALOG_CONFIRMED');
  assert.equal(reverse.packageCount, 1);

  const yogurt = fixed(offer('יוגורט 4 x 100 ג׳', 100, 'g', 7), 500, 'g');
  assert.equal(yogurt.quantityToPurchase.normalizedAmount, 800);
  assert.equal(yogurt.packageCount, 2);
  assert.equal(yogurt.totalPriceIls, 14);
  assert.equal(yogurt.overbuyBase, 300);
});

test('corroborates the requested size per bottle separately from the sale package total', () => {
  const item = { quantity: { amount: 6, unit: 'bottle' } };
  const correct = offer('Six mineral water 6 bottles × 500 ml', 3, 'l');
  const different = offer('Mineral water 3 bottles × 1 l', 3, 'l');
  const single = offer('בקבוק סודה', 500, 'ml');
  const ambiguous = offer('Mineral water 6 bottles 3 l', 3, 'l');

  assert.deepEqual(corroborateUnitSize(correct, item, 500, 'ml'), {
    result: 'MET', evidenceSource: 'NAME', evidence: '6 bottles × 500 ml'
  });
  assert.equal(corroborateUnitSize(different, item, 500, 'ml').result, 'CONTRADICTED');
  assert.equal(corroborateUnitSize(single, item, 0.5, 'l').result, 'MET');
  assert.equal(corroborateUnitSize(ambiguous, item, 500, 'ml').result, 'UNKNOWN');
});

test('converts measure units and recognizes an explicitly countable loaf', () => {
  const rice = fixed(offer('אורז 2 ק״ג', 1, 'unit', 18.5), 2000, 'g');
  assert.equal(rice.packageCount, 1);
  assert.equal(rice.totalPriceIls, 18.5);

  const bread = offer('כיכר לחם פרוסה 750 גרם', 750, 'g', 7.36);
  const loaf = fixed(bread, 1, 'loaf');
  assert.equal(loaf.quantityToPurchase.normalizedAmount, 1);
  assert.equal(loaf.package.unit, 'units');
  assert.equal(loaf.totalPriceIls, 7.36);

  const weight = fixed(bread, 500, 'g');
  assert.equal(weight.quantityToPurchase.normalizedAmount, 750);
  assert.equal(weight.overbuyBase, 250);

  const roll = evaluate(offer('Bread roll 75 g', 75, 'g'), 1, 'loaf');
  assert.equal(roll.optionCount, 0);
  assert.match(roll.skipped[0].reason, /countable form/);

  const plainBread = evaluate(offer('לחם אחיד 750 גרם', 750, 'g'), 1, 'loaf');
  assert.equal(plainBread.optionCount, 0);
  assert.match(plainBread.skipped[0].reason, /countable form/);
});

test('keeps ambiguous multipacks and contradictory structured sizes out of purchase options', () => {
  for (const [product, unit] of [
    [offer('Kettle chips 4 x 100 g', 150, 'g'), 'g'],
    [offer('Cheese 200 g', 250, 'g'), 'g'],
    [offer('Tomatoes 6 cans 330 ml', 330, 'ml'), 'ml'],
    [offer('ביצים XL 20י', 1, 'unit'), 'units'],
    [offer('מגבונים 2*80', 1, 'unit'), 'units'],
    [offer('Cotton pads 12–18 units', 1, 'unit'), 'units'],
    [offer('גבינה כ-500 גרם', 500, 'g'), 'g'],
    [offer('Rice 1,000 g', 1, 'unit'), 'g']
  ]) {
    const result = evaluate(product, 12, unit);
    assert.equal(result.optionCount, 0, product.name);
    assert.equal(result.skipped[0].packageInterpretation.status, 'AMBIGUOUS', product.name);
    assert.deepEqual(result.skipped[0].originalPackage, product.package);
  }
});

test('does not accept only part of a chained or additive package quantity', () => {
  for (const [product, amount, unit] of [
    [offer('Mineral water 6 × 500 ml × 2', 500, 'ml'), 3, 'l'],
    [offer('Mineral water 500 ml × 6 × 2', 500, 'ml'), 3, 'l'],
    [offer('Mineral water 2 × 6 × 500 ml', 500, 'ml'), 3, 'l'],
    [offer('Cotton pads 12 units + 12 units', 1, 'unit'), 12, 'units'],
    [offer('Cotton pads 12 units + 6', 1, 'unit'), 12, 'units'],
    [offer('יוגורט 2×100 גרם + 2×100 גרם', 100, 'g'), 200, 'g']
  ]) {
    const result = evaluate(product, amount, unit);
    assert.equal(result.optionCount, 0, product.name);
    assert.equal(result.skipped[0].packageInterpretation.status, 'AMBIGUOUS', product.name);
  }

  const equivalent = fixed(offer('Milk 1.5 L (1500 ml)', 1.5, 'l', 11), 1500, 'ml');
  assert.equal(equivalent.packageCount, 1);
  assert.equal(equivalent.totalPriceIls, 11);
});

test('recognizes a container after a multiplier and flags conflicting container types', () => {
  for (const name of ['Mineral water 6 × 500 ml bottles', 'מארז סודה 6×500 מ״ל בקבוקים']) {
    const product = offer(name, 500, 'ml', 9.5);
    const option = fixed(product, 6, 'bottles');
    assert.equal(option.packageCount, 1);
    assert.equal(option.quantityToPurchase.normalizedAmount, 6);
    assert.equal(option.totalPriceIls, 9.5);
    assert.equal(corroborateUnitSize(product, { quantity: { amount: 6, unit: 'bottle' } }, 500, 'ml').result, 'MET');
  }

  for (const product of [
    offer('Sparkling water 6 cans × 500 ml', 1, 'bottle'),
    offer('Sparkling water 6 bottles × 500 ml cans', 3, 'l')
  ]) {
    const result = evaluate(product, 3, 'l');
    assert.equal(result.optionCount, 0, product.name);
    assert.equal(result.skipped[0].packageInterpretation.status, 'AMBIGUOUS', product.name);
  }
});

test('uses the listed price for weighted estimates and excludes inconsistent weighted indications', () => {
  const weighted = offer('מוצרלה תנובה מגורדת', 1, 'kg', 82, {
    package: { quantity: 1, unit: 'kg', isWeighted: true }
  });
  const result = evaluate(weighted, 500, 'g');
  const store = result.stores[0];

  assert.equal(store.bestFixedPackage, null);
  assert.equal(store.bestWeightedEstimate.packageCount, null);
  assert.equal(store.bestWeightedEstimate.totalPriceIls, 41);
  assert.equal(store.bestWeightedEstimate.status, 'ESTIMATE_REQUIRES_QUANTITY_CONFIRMATION');
  assert.equal(store.bestWeightedEstimate.packageInterpretation.status, 'WEIGHTED_REFERENCE');

  const halfCent = evaluate({
    ...weighted, pricing: { listedPriceIls: 29 }
  }, 145, 'g');
  assert.equal(halfCent.stores[0].bestWeightedEstimate.totalPriceIls, 4.21);

  const conflictingFlag = evaluate(offer('גבינה מגורדתבמשקל', 1, 'kg', 72), 500, 'g');
  assert.equal(conflictingFlag.optionCount, 0);
  assert.match(conflictingFlag.skipped[0].reason, /weighted offer/);

  const malformedFlag = evaluate({
    ...weighted, package: { ...weighted.package, isWeighted: 'true' }
  }, 500, 'g');
  assert.equal(malformedFlag.optionCount, 0);
  assert.match(malformedFlag.skipped[0].reason, /invalid weighted-product indicator/);

  for (const title of ['Fresh cheese per kg', 'גבינה 1 ק״ג לק״ג']) {
    const inconsistent = evaluate(offer(title, 1, 'kg', 72), 500, 'g');
    assert.equal(inconsistent.optionCount, 0, title);
    assert.match(inconsistent.skipped[0].reason, /weighted offer/);
  }
});

test('prices fractional metric quantities at exact package boundaries', () => {
  const product = offer('אורז 0,1 ק״ג', 0.1, 'kg', 2.35);
  const cases = [
    [0.3, 'kg', 3, 0, 7.05],
    [300.001, 'g', 4, 99.999, 9.4],
    [0, 'unspecified', 1, 0, 2.35]
  ];
  for (const [amount, unit, count, overbuy, price] of cases) {
    const option = fixed(product, amount, unit);
    assert.equal(option.packageCount, count);
    assert.equal(option.overbuyBase, overbuy);
    assert.equal(option.totalPriceIls, price);
  }

  assert.throws(() => evaluate(product, 0.25, 'bottle'), /Unsupported requested quantity/);
  assert.throws(() => evaluate(product, 0.0001, 'g'), /Unsupported requested quantity/);
  assert.equal(evaluate({ ...product, pricing: { listedPriceIls: NaN } }, 300, 'g').optionCount, 0);
});

test('prices a fixed SKU at an allowed amount and skips a pack above the quantity range', () => {
  const quantity = { amount: 2, maxAmount: 3, unit: 'l' };
  const matches = [
    offer('Milk 1 L', 1, 'l', 5, { _id: 'milk-1' }),
    offer('Milk 3 L', 3, 'l', 11, { _id: 'milk-3' }),
    offer('Milk 4 L', 4, 'l', 2, { _id: 'milk-4' })
  ].map(product => ({ product }));
  const result = buildQuantityPriceOptions({ item: { product: 'milk', quantity }, matches });
  const store = result.stores[0];
  assert.deepEqual(normalizeRequestedQuantity(quantity), {
    family: 'volume', base: 'ml', amountBase: 2000, maxAmountBase: 3000
  });
  assert.equal(store.bestFixedPackage.productId, 'milk-1');
  assert.equal(store.bestFixedPackage.packageCount, 2);
  assert.equal(store.bestFixedPackage.quantityToPurchase.normalizedAmount, 2000);
  assert.equal(store.bestFixedPackage.totalPriceIls, 10);

  const bothBoundsAllowed = store.options.find(option => option.productId === 'milk-3');
  assert.equal(bothBoundsAllowed.status, 'CALCULATED_FIXED_PACKAGES');
  assert.equal(bothBoundsAllowed.overbuyBase, 0);
  assert.equal(bothBoundsAllowed.quantityToPurchase.normalizedAmount, 3000);
  assert.equal(result.skipped[0].productId, 'milk-4');
  assert.match(result.skipped[0].reason, /exceeds the requested maximum/);
});

test('keeps a package within the maximum available for mixed quantities', () => {
  const quantity = { amount: 0.5, maxAmount: 0.6, unit: 'kg' };
  const cheese = offer('Cheese 400 g', 400, 'g', 10);
  const item = { product: 'cheese', quantity };
  const result = buildQuantityPriceOptions({ item, matches: [{ product: cheese }] });
  const store = result.stores[0];
  assert.equal(store.bestFixedPackage, null);
  assert.equal(store.options[0].type, 'PACKAGED');
  assert.equal(store.options[0].status, 'MIXED_PACKAGES_ONLY');
  assert.deepEqual(store.options[0].package, cheese.package);
  assert.equal(store.options[0].listedPriceIls, 10);
  for (const field of ['packageCount', 'quantityToPurchase', 'overbuyBase', 'totalPriceIls']) {
    assert.equal(store.options[0][field], null, field);
  }
  const weighted = offer('Cheese sold by weight', 1, 'kg', 82, {
    package: { quantity: 1, unit: 'kg', isWeighted: true }
  });
  const estimated = buildQuantityPriceOptions({ item, matches: [{ product: weighted }] }).stores[0];
  assert.equal(estimated.bestFixedPackage, null);
  assert.equal(estimated.bestWeightedEstimate.status, 'ESTIMATE_REQUIRES_QUANTITY_CONFIRMATION');
  assert.equal(estimated.bestWeightedEstimate.totalPriceIls, 41);
  assert.match(estimated.bestWeightedEstimate.note, /lower bound/);
});

test('rejects invalid range bounds even when there are no candidate matches', () => {
  const invalid = [
    { amount: 3, maxAmount: 2, unit: 'l' },
    { amount: 2, maxAmount: null, unit: 'l' },
    { amount: 2, maxAmount: 2.5, unit: 'units' },
    { amount: 0, maxAmount: 3, unit: 'unspecified' },
    { amount: 1, maxAmount: 0, unit: 'l' }
  ];
  for (const quantity of invalid) {
    assert.equal(normalizeRequestedQuantity(quantity), null);
    assert.throws(() => buildQuantityPriceOptions({ item: { product: 'test', quantity }, matches: [] }),
      /Unsupported requested quantity/);
  }
});

test('audits bound requirement proofs and excludes unverified matches or unknown stores', () => {
  const item = {
    product: 'milk', requirements: ['3% fat'], preferences: [], quantity: { amount: 1, unit: 'l' }
  };
  const context = createItemContext({ userRequest: '1 liter 3% milk', items: [item] }, 0);
  const requirementChecks = [{ requirement: '3% fat', result: 'MET', evidence: '3%', evidenceSource: 'NAME' }];
  const verified = {
    product: offer('3% milk 1 l', 1, 'l', 7),
    identityStatus: 'MATCH',
    requirementChecks
  };
  const inconsistent = {
    ...verified,
    product: offer('1% milk 1 l', 1, 'l', 6, { _id: 'inconsistent' }),
    requirementChecks: [{ ...requirementChecks[0], result: 'UNKNOWN' }]
  };
  const unknownStore = { ...verified, product: { ...verified.product, _id: 'unknown-store', storeId: '' } };
  const result = buildQuantityPriceOptions({ context, item, matches: [verified, inconsistent, unknownStore] });

  assert.equal(result.optionCount, 1);
  assert.deepEqual(result.context, context);
  assert.deepEqual(result.stores[0].bestFixedPackage.requirementChecks, requirementChecks);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /mandatory requirements/);
  assert.match(result.skipped[1].reason, /exact store/);
  assert.throws(() => {
    buildQuantityPriceOptions({ context, item: { ...item, requirements: [] }, matches: [] });
  }, /Pipeline context/);
});
