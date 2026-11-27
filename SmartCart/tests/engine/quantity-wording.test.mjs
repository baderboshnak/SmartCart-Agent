import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { countsPackages, normalizeAmount } from '../../engine/smartcart-package.mjs';
import { assertProductPhrase, assertRequestedQuantity } from '../../engine/smartcart-request-coverage.mjs';
import { corroborateRequirement, corroborateSizeRequirement } from '../../engine/smartcart-requirement-evidence.mjs';

const product = (name, quantity, unit, isWeighted = false) => ({ name, package: { quantity, unit, isWeighted } });

describe('a count of packages', () => {
  test('"2 packs" of anything and "3 units" of gram or liter packages count sale packages', () => {
    assert.equal(countsPackages('pack', normalizeAmount(500, 'g'), false), true);
    assert.equal(countsPackages('units', normalizeAmount(1, 'l'), false), true, '"3 milk" is three cartons');
    assert.equal(countsPackages('units', normalizeAmount(750, 'g'), false), true, '"3 לחם" is three loaves');
    assert.equal(countsPackages('units', normalizeAmount(12, 'units'), false), false, 'a 12-egg carton keeps counting eggs');
    assert.equal(countsPackages('units', normalizeAmount(1, 'kg'), true), false, 'weighed produce is not a package');
    assert.equal(countsPackages('bottle', normalizeAmount(500, 'ml'), false), false, 'a named container keeps its own rule');
  });

  test('a size with a package count is the size of each package', () => {
    const size = (requirement, record, quantity) =>
      corroborateSizeRequirement(requirement, record, { product: 'x', quantity, requirements: [requirement] })?.result;
    assert.equal(size('500 g', product('פסטה 500 g', 500, 'g'), { amount: 2, unit: 'pack' }), 'MET');
    assert.equal(size('500 g', product('פסטה 400 g', 400, 'g'), { amount: 2, unit: 'pack' }), 'CONTRADICTED');
    assert.equal(size('1 liter', product('חלב 1 l', 1, 'l'), { amount: 3, unit: 'units' }), 'MET');
    assert.equal(size('500 ml', product('מים בקבוק 500 מ"ל', 500, 'ml'), { amount: 6, unit: 'bottle' }), 'MET');
  });
});

describe('bounded percentage requirements', () => {
  const claim = (requirement, name) => corroborateRequirement(requirement, product(name, 250, 'g'), 'OTHER').result;

  test('"less than", "up to", "at least" and "or less" compare the product percentage', () => {
    assert.equal(claim('פחות מ-5% שומן', 'גבינה 3% שומן'), 'MET');
    assert.equal(claim('פחות מ-5% שומן', 'גבינה 5% שומן'), 'CONTRADICTED', '"less than" is strict');
    assert.equal(claim('עד 5% שומן', 'גבינה 5% שומן'), 'MET', '"up to" includes the bound');
    assert.equal(claim('no more than 3% fat', 'milk 3% fat'), 'MET');
    assert.equal(claim('at least 70% cocoa', 'שוקולד מריר 72% קקאו'), 'MET');
    assert.equal(claim('5% שומן ומטה', 'גבינה 3% שומן'), 'MET');
    assert.equal(claim('أقل من 5% دسم', 'جبنة 3% دسم'), 'MET');
  });

  test('exact percentages and missing evidence keep their meaning', () => {
    assert.equal(claim('3%', 'חלב תנובה 3%'), 'MET');
    assert.equal(claim('3%', 'חלב תנובה 1%'), 'CONTRADICTED');
    assert.equal(claim('פחות מ-5% שומן', 'גבינה לבנה'), 'UNKNOWN');
    assert.equal(claim('less than 5% sugar', 'cheese 3% fat'), 'UNKNOWN', 'a different nutrient proves nothing');
  });
});

describe('amounts written without digits', () => {
  const check = (sourceText, productName, quantity, constraints = []) => {
    const item = { sourceText, product: productName, quantity, constraintEvidence: constraints.map(text => ({ type: 'REQUIREMENT', kind: 'OTHER', sourceText: text })) };
    assertRequestedQuantity(item, 0);
    assertProductPhrase(item, 0);
  };

  test('a unit word alone is one, and "and a half" adds a half', () => {
    check('קילו עגבניות', 'עגבניות', { amount: 1, unit: 'kg' });
    check('ליטר וחצי חלב', 'חלב', { amount: 1.5, unit: 'l' });
    check('2 ליטר וחצי חלב', 'חלב', { amount: 2.5, unit: 'l' });
    check('וקילו מלפפון', 'מלפפון', { amount: 1, unit: 'kg' });
    check('חלב תנובה 3% ליטר', 'חלב', { amount: 1, unit: 'l' }, ['תנובה', '3%']);
    check('كيلو ونص رز', 'رز', { amount: 1.5, unit: 'kg' });
    assert.throws(() => check('קילו עגבניות', 'עגבניות', { amount: 0, unit: 'unspecified' }), /Use amount 1, unit "kg"/u);
    assert.throws(() => check('ליטר וחצי חלב', 'חלב', { amount: 1, unit: 'l' }), /explicit quantity/u);
  });

  test('Arabic number words and duals, and one container without an amount', () => {
    check('نص كيلو جبنة', 'جبنة', { amount: 0.5, unit: 'kg' });
    check('علبتين تونة', 'تونة', { amount: 2, unit: 'pack' });
    check('تلات علب تونة', 'تونة', { amount: 3, unit: 'pack' });
    assert.throws(() => check('علبتين تونة', 'تونة', { amount: 2, unit: 'units' }), /Use amount 2, unit "pack"/u);
    check('I need a box of tea', 'tea', { amount: 0, unit: 'unspecified' });
    check('בקבוק מים', 'מים', { amount: 0, unit: 'unspecified' });
    check('bottles of water', 'water', { amount: 0, unit: 'unspecified' });
    assert.throws(() => check('I need a box of tea', 'tea', { amount: 2, unit: 'pack' }), /explicit quantity/u);
  });

  test('short aliases and product words are not read as amounts', () => {
    check('לי חלב', 'חלב', { amount: 0, unit: 'unspecified' });
    check('tea bags', 'tea bags', { amount: 0, unit: 'unspecified' });
    check('water 500 ml', 'water', { amount: 0, unit: 'unspecified' }, ['500 ml']);
  });
});
