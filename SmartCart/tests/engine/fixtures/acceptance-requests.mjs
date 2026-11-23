const unspecified = { amount: 0, unit: 'unspecified' };
const qty = (amount, unit, maxAmount) => ({ amount, unit, ...(maxAmount === undefined ? {} : { maxAmount }) });
const hard = (sourceText, kind = 'OTHER') => ({ type: 'REQUIREMENT', kind, sourceText });
const soft = (sourceText, kind = 'OTHER') => ({ type: 'PREFERENCE', kind, sourceText });
const item = (sourceText, product, coreSearchTerm, quantity = unspecified, constraintEvidence = []) =>
  ({ sourceText, product, coreSearchTerm, searchTerms: [], quantity, constraintEvidence });

function scenario(id, locale, category, request, items, criteria = {}) {
  return {
    id, locale, category, request,
    mockItems: items,
    expected: {
      outcome: criteria.error ? 'reject' : 'plan',
      items: criteria.error ? [] : items.map(({ product, quantity, constraintEvidence }) => ({
        product, quantity,
        requirements: constraintEvidence.filter(e => e.type === 'REQUIREMENT').map(e => e.sourceText),
        preferences: constraintEvidence.filter(e => e.type === 'PREFERENCE').map(e => e.sourceText)
      })),
      ...criteria
    }
  };
}

const sizedMilk = item('2 liters of milk', 'milk', 'חלב', qty(2, 'l'));
const fatMilk = item('2 liters of 3% milk', 'milk', 'חלב', qty(2, 'l'), [hard('3%')]);
const softMilk = item('2 liters of 3% milk, preferably Tnuva', 'milk', 'חלב',
  qty(2, 'l'), [hard('3%'), soft('Tnuva', 'BRAND')]);
const eggs = item('12 eggs', 'eggs', 'ביצים', qty(12, 'units'));
const bread = item('500 grams of bread', 'bread', 'לחם', qty(500, 'g'));
const shredded = item('500 grams of shredded mozzarella', 'shredded mozzarella', 'מוצרלה',
  qty(500, 'g'), [hard('shredded')]);
const mozzarella = item('500 grams of shredded mozzarella, only Tnuva', 'shredded mozzarella',
  'מוצרלה', qty(500, 'g'), [hard('shredded'), hard('Tnuva', 'BRAND')]);
const hebrewEggs = item('12 ביצים', 'ביצים', 'ביצים', qty(12, 'units'));
const arabicMilk = item('لترين حليب 3% ويفضل تنوفا', 'حليب', 'חלב',
  qty(2, 'l'), [hard('3%'), soft('تنوفا', 'BRAND')]);
const arabicEggs = item('12 بيضة', 'بيضة', 'ביצים', qty(12, 'units'));

// Gold expectations are curated from the customer requests. The scripted tool
// outputs are independent of the implementation and can be replaced by a model
// response when comparing providers.
export const acceptanceRequests = [
  scenario('T01 simple milk', 'en', 'dairy', 'I want 2 liters of milk.', [sizedMilk]),
  scenario('T02 required fat', 'en', 'dairy', 'I want 2 liters of 3% milk.', [fatMilk]),
  scenario('T03 optional brand', 'en', 'soft brand', 'I want 2 liters of 3% milk, preferably Tnuva.', [softMilk]),
  scenario('T04 required brand', 'en', 'hard brand', 'I want 2 liters of 3% milk, only Tnuva.', [
    item('2 liters of 3% milk, only Tnuva', 'milk', 'חלב', qty(2, 'l'), [hard('3%'), hard('Tnuva', 'BRAND')])
  ]),
  scenario('T05 cheese form', 'en', 'product form', 'I want 500 grams of shredded mozzarella.', [shredded]),
  scenario('T06 cheese brand and form', 'en', 'hard brand', 'I want 500 grams of shredded mozzarella, only Tnuva.', [mozzarella]),
  scenario('T07 four items', 'en', 'multi-item', 'I want 2 liters of 3% milk, 12 eggs, 500 grams of bread, and 500 grams of shredded mozzarella.', [
    fatMilk, eggs, bread, shredded
  ]),
  scenario('T08 four items with soft brand', 'en', 'multi-item', 'I want 2 liters of 3% milk, preferably Tnuva, 12 eggs, 500 grams of bread, and 500 grams of shredded mozzarella.', [
    softMilk, eggs, bread, shredded
  ]),
  scenario('T09 isolate item preferences', 'en', 'mixed brands', 'Prefer Tnuva milk, only Gad mozzarella, and any eggs.', [
    item('Prefer Tnuva milk', 'milk', 'חלב', unspecified, [soft('Tnuva', 'BRAND')]),
    item('only Gad mozzarella', 'mozzarella', 'מוצרלה', unspecified, [hard('Gad', 'BRAND')]),
    item('any eggs', 'eggs', 'ביצים')
  ]),
  scenario('T10 lactose-free', 'en', 'dietary', 'I need 2 liters of lactose-free milk.', [
    item('2 liters of lactose-free milk', 'milk', 'חלב', qty(2, 'l'), [hard('lactose-free')])
  ]),
  scenario('T11 sugar-free', 'en', 'dietary', 'I want sugar-free yogurt.', [
    item('sugar-free yogurt', 'yogurt', 'יוגורט', unspecified, [hard('sugar-free')])
  ]),
  scenario('T12 gluten-free', 'en', 'dietary', 'I need gluten-free bread.', [
    item('gluten-free bread', 'bread', 'לחם', unspecified, [hard('gluten-free')])
  ]),
  scenario('T13 whole wheat', 'en', 'dietary', 'I want 100% whole wheat bread.', [
    item('100% whole wheat bread', 'bread', 'לחם', unspecified, [hard('100% whole wheat')])
  ]),
  scenario('T14 unsalted', 'en', 'dietary', 'I need unsalted butter.', [
    item('unsalted butter', 'butter', 'חמאה', unspecified, [hard('unsalted')])
  ]),
  scenario('T15 exclusion and preference', 'en', 'dietary', 'I want yogurt without added sugar, preferably Tnuva.', [
    item('yogurt without added sugar, preferably Tnuva', 'yogurt', 'יוגורט', unspecified,
      [hard('without added sugar'), soft('Tnuva', 'BRAND')])
  ]),
  scenario('T16 Hebrew conjunction and brand', 'he', 'multi-item', 'אני רוצה 2 ליטר חלב 3% עדיף תנובה ו-12 ביצים', [
    item('2 ליטר חלב 3% עדיף תנובה', 'חלב', 'חלב', qty(2, 'l'), [hard('3%'), soft('תנובה', 'BRAND')]), hebrewEggs
  ]),
  scenario('T17 Arabic dual quantity and brand', 'ar', 'multi-item', 'بدي لترين حليب 3% ويفضل تنوفا و12 بيضة', [arabicMilk, arabicEggs]),
  scenario('T18 bilingual name and unit', 'mixed', 'dairy', 'I want חלב 3% 2 liters, preferably תנובה.', [
    item('חלב 3% 2 liters, preferably תנובה', 'חלב', 'חלב', qty(2, 'l'), [hard('3%'), soft('תנובה', 'BRAND')])
  ]),
  scenario('T19 incompatible fat percentages', 'en', 'contradictory', 'I want milk that is both 1% and 3% fat.', [
    item('milk that is both 1% and 3% fat', 'milk', 'חלב', unspecified, [hard('1% and 3% fat')])
  ], { error: 'conflicting fat percentages' }),
  scenario('T20 unspecified egg count', 'en', 'ambiguity', 'I want some eggs.', [item('eggs', 'eggs', 'ביצים')]),
  scenario('T21 zero quantity', 'en', 'invalid quantity', '0 liters of milk', [
    item('0 liters of milk', 'milk', 'חלב', qty(0, 'l'))
  ], { error: 'quantity is invalid' }),
  scenario('T21 negative quantity', 'en', 'invalid quantity', '-2 kilograms of rice', [
    item('-2 kilograms of rice', 'rice', 'אורז', qty(2, 'kg'))
  ], { error: 'changes the explicit quantity' }),
  scenario('T22 repeated milk preserves quantities', 'en', 'repeated item', '1 liter milk and another 2 liters of the same milk.', [
    item('1 liter milk', 'milk', 'חלב', qty(1, 'l')),
    item('another 2 liters of the same milk', 'milk', 'חלב', qty(2, 'l'))
  ]),
  scenario('T23 exact size per bottle', 'en', 'multipack', 'I want 3 bottles of milk, 1 liter each.', [
    item('3 bottles of milk, 1 liter each', 'milk', 'חלב', qty(3, 'bottle'), [hard('1 liter')])
  ]),
  scenario('T24 order A', 'en', 'multi-item', '2 liters of 3% milk and 12 eggs.', [fatMilk, eggs]),
  scenario('T24 order B', 'en', 'multi-item', '12 eggs and 2 liters of 3% milk.', [eggs, fatMilk]),
  scenario('A27 metric rice', 'en', 'grains', 'I need 1.5 kg of rice.', [
    item('1.5 kg of rice', 'rice', 'אורז', qty(1.5, 'kg'))
  ]),
  scenario('A28 rice variety', 'en', 'product form', 'I want 850 grams of basmati rice.', [
    item('850 grams of basmati rice', 'rice', 'אורז', qty(850, 'g'), [hard('basmati')])
  ]),
  scenario('A29 cans of chickpeas', 'en', 'canned goods', 'I need 2 cans of chickpeas.', [
    item('2 cans of chickpeas', 'chickpeas', 'חומוס', qty(2, 'can'))
  ]),
  scenario('A30 bags of lentils', 'en', 'grains', 'I want 3 bags of dried lentils.', [
    item('3 bags of dried lentils', 'lentils', 'עדשים', qty(3, 'bag'), [hard('dried')])
  ]),
  scenario('A31 pasta and sauce', 'en', 'multi-item', '1 kilogram pasta and 500 grams tomato sauce.', [
    item('1 kilogram pasta', 'pasta', 'פסטה', qty(1, 'kg')),
    item('500 grams tomato sauce', 'tomato sauce', 'רוטב עגבניות', qty(500, 'g'))
  ]),
  scenario('A32 multiplied bottle size', 'en', 'multipack', 'I need 6 bottles × 500 ml of water.', [
    item('6 bottles × 500 ml of water', 'water', 'מים', qty(6, 'bottle'), [hard('500 ml')])
  ]),
  scenario('A33 juice with dietary preference', 'en', 'beverages', 'I want 750 ml orange juice, preferably no added sugar.', [
    item('750 ml orange juice, preferably no added sugar', 'orange juice', 'מיץ תפוזים',
      qty(750, 'ml'), [soft('no added sugar')])
  ]),
  scenario('A34 sparkling water', 'en', 'beverages', 'I need sparkling water.', [
    item('sparkling water', 'water', 'מים', unspecified, [hard('sparkling')])
  ]),
  scenario('A35 bottled water', 'en', 'beverages', 'I need bottled water.', [
    item('bottled water', 'water', 'מים', unspecified, [hard('bottled')])
  ]),
  scenario('A36 paper towel rolls', 'en', 'household', 'I need 2 rolls of paper towels.', [
    item('2 rolls of paper towels', 'paper towels', 'מגבות נייר', qty(2, 'roll'))
  ]),
  scenario('A37 detergent scent', 'en', 'household', 'I want unscented laundry detergent.', [
    item('unscented laundry detergent', 'laundry detergent', 'חומר כביסה', unspecified, [hard('unscented')])
  ]),
  scenario('A38 toothpaste brand', 'en', 'personal care', 'I need toothpaste, only Colgate.', [
    item('toothpaste, only Colgate', 'toothpaste', 'משחת שיניים', unspecified, [hard('Colgate', 'BRAND')])
  ]),
  scenario('A39 shampoo preference', 'en', 'personal care', 'I want shampoo, preferably Pantene.', [
    item('shampoo, preferably Pantene', 'shampoo', 'שמפו', unspecified, [soft('Pantene', 'BRAND')])
  ]),
  scenario('A40 bars of soap', 'en', 'personal care', 'I want 3 bars of soap.', [
    item('3 bars of soap', 'bars of soap', 'סבון', qty(3, 'units'))
  ]),
  scenario('A41 Hebrew eggs and grains', 'he', 'multi-item', 'אני צריך שתי ביצים ו-500 גרם אורז', [
    item('שתי ביצים', 'ביצים', 'ביצים', qty(2, 'units')), item('500 גרם אורז', 'אורז', 'אורז', qty(500, 'g'))
  ]),
  scenario('A42 Hebrew gluten-free bread', 'he', 'dietary', 'אני רוצה 500 גרם לחם ללא גלוטן', [
    item('500 גרם לחם ללא גלוטן', 'לחם', 'לחם', qty(500, 'g'), [hard('ללא גלוטן')])
  ]),
  scenario('A43 Hebrew hard-brand cheese', 'he', 'hard brand', 'אני רוצה מוצרלה מגורדת, רק תנובה', [
    item('מוצרלה מגורדת, רק תנובה', 'מוצרלה', 'מוצרלה', unspecified, [hard('מגורדת'), hard('תנובה', 'BRAND')])
  ]),
  scenario('A44 Hebrew loaf count', 'he', 'bread', 'אני צריך שתי כיכרות לחם', [
    item('שתי כיכרות לחם', 'לחם', 'לחם', qty(2, 'loaf'))
  ]),
  scenario('A45 Arabic-Indic quantities and percent', 'ar', 'multi-item', 'بدي ٢ لتر حليب ٣٪ ويفضل تنوفا و١٢ بيضة', [
    item('٢ لتر حليب ٣٪ ويفضل تنوفا', 'حليب', 'חלב', qty(2, 'l'), [hard('٣٪'), soft('تنوفا', 'BRAND')]),
    item('و١٢ بيضة', 'بيضة', 'ביצים', qty(12, 'units'))
  ]),
  scenario('A46 Arabic grams', 'ar', 'grains', 'أريد ٥٠٠ غرام أرز.', [
    item('٥٠٠ غرام أرز', 'أرز', 'אורז', qty(500, 'g'))
  ]),
  scenario('A47 Arabic gluten-free', 'ar', 'dietary', 'أريد خبز خالي من الغلوتين.', [
    item('خبز خالي من الغلوتين', 'خبز', 'לחם', unspecified, [hard('خالي من الغلوتين')])
  ]),
  scenario('A48 Arabic bottles', 'ar', 'beverages', 'أريد ٢ زجاجة ماء.', [
    item('٢ زجاجة ماء', 'ماء', 'מים', qty(2, 'bottle'))
  ]),
  scenario('A49 bounded potato quantity', 'en', 'produce', 'I want 2–3 kg of potatoes.', [
    item('2–3 kg of potatoes', 'potatoes', 'תפוחי אדמה', qty(2, 'kg', 3))
  ]),
  scenario('A50 alternatives with a required item', 'en', 'multi-item', 'I need milk or oat milk, and 2 loaves of bread.', [
    item('milk', 'milk', 'חלב'), item('oat milk', 'oat milk', 'משקה שיבולת שועל'),
    item('2 loaves of bread', 'bread', 'לחם', qty(2, 'loaf'))
  ], { choiceGroups: ['choice-0', 'choice-0', undefined] }),
  scenario('A51 fractional weight and dozen', 'en', 'multi-item', 'I want 0.5 kg of rice and a dozen eggs.', [
    item('0.5 kg of rice', 'rice', 'אורז', qty(0.5, 'kg')), item('a dozen eggs', 'eggs', 'ביצים', qty(12, 'units'))
  ]),
  scenario('A52 unavailable fixture product', 'en', 'unavailable', 'I want 2 liters of moonberry juice.', [
    item('2 liters of moonberry juice', 'moonberry juice', 'מיץ ירח', qty(2, 'l'))
  ], { availability: 'no-complete-basket' }),
  scenario('A53 vague amount cannot become an exact count', 'en', 'ambiguity', 'I want a few apples.', [
    item('a few apples', 'apples', 'תפוחים', qty(3, 'units'))
  ], { error: "quantity that wasn't specified" }),
  scenario('A54 reversed quantity bounds', 'en', 'contradictory', 'I want 3–2 liters of milk.', [
    item('3–2 liters of milk', 'milk', 'חלב', qty(3, 'l', 2))
  ], { error: 'quantity is invalid' }),
  scenario('A55 repeated product with ungrounded hard constraint inheritance', 'en', 'ambiguity',
    '1 liter of 3% milk and another 2 liters of the same milk.', [
      item('1 liter of 3% milk', 'milk', 'חלב', qty(1, 'l'), [hard('3%')]),
      item('another 2 liters of the same milk', 'milk', 'חלב', qty(2, 'l'))
    ], { error: 'refers to an earlier item' }),
  scenario('A56 baking groceries with fraction', 'en', 'multi-item', 'I want 1/2 kilogram of flour, 250 grams of butter, and 12 eggs.', [
    item('1/2 kilogram of flour', 'flour', 'קמח', qty(0.5, 'kg')),
    item('250 grams of butter', 'butter', 'חמאה', qty(250, 'g')), eggs
  ]),
  scenario('A57 free-range eggs', 'en', 'eggs', 'I want 12 free-range eggs.', [
    item('12 free-range eggs', 'eggs', 'ביצים', qty(12, 'units'), [hard('free-range')])
  ]),
  scenario('A58 Greek yogurt with preference', 'en', 'dairy', 'I want Greek yogurt, preferably unsweetened.', [
    item('Greek yogurt, preferably unsweetened', 'yogurt', 'יוגורט', unspecified,
      [hard('Greek'), soft('unsweetened')])
  ])
];

export function mockAcceptanceCall(audit, draft = audit) {
  return async ({ declaration }) => {
    if (declaration.name === 'audit_shopping_request') {
      return { items: structuredClone(audit.map(({ sourceText, quantity, constraintEvidence }) =>
        ({ sourceText, quantity, constraintEvidence }))) };
    }
    if (declaration.name === 'submit_shopping_request') return { items: structuredClone(draft) };
    throw new Error(`Unexpected Gemini function in direct-request fixture: ${declaration.name}`);
  };
}
