import type { CatalogRecord, ConstraintEvidence, EngineItem } from '@engine/engine-types.mjs';

/**
 * Labelled product-identity cases for the semantic matcher. The live evaluation
 * (scripts/live-semantic-matching.ts) sends each request to Gemini once with all its
 * candidates. The offline tests use them to check plumbing and prompt hygiene only:
 * mocked answers cannot show that Gemini understands a request.
 *
 * NOT_MATCH accepts either REJECT or UNCERTAIN. DEBATABLE marks a product that reasonable
 * shoppers disagree about: its decision is reported, never scored.
 */
export type Expected = 'MATCH' | 'REJECT' | 'UNCERTAIN' | 'NOT_MATCH' | 'DEBATABLE';

export interface SemanticCandidate {
  name: string;
  /** "1 l", "397 g", "12 units", or "kg~" for a product sold by weight. */
  size: string;
  expected: Expected;
  /** What the case exercises, e.g. "derived", "flavor", "ordinary variation". */
  kind: string;
}

export interface SemanticCase {
  id: string;
  language: 'he' | 'en' | 'ar';
  /** A product category that the matcher instructions and the task examples never mention. */
  unseen?: boolean;
  product: string;
  requirements?: string[];
  candidates: SemanticCandidate[];
}

const c = (name: string, size: string, expected: Expected, kind: string): SemanticCandidate => ({ name, size, expected, kind });

// Candidates reused across languages, so the same product gets the same decision for "milk", "חלב" and "حليب".
const plainMilk = c('חלב תנובה 3% 1 ליטר', '1 l', 'MATCH', 'ordinary variation');
const condensedMilk = c('חלב מרוכז ממותק 397 גרם', '397 g', 'REJECT', 'derived');
const smoresMilkDrink = c('משקה חלב בטעם סמורס 1 ליטר', '1 l', 'REJECT', 'flavor');
const milkChocolate = c('שוקולד חלב 100 גרם', '100 g', 'REJECT', 'ingredient');
const bananaMilkDrink = c('משקה חלב בטעם בננה 250 מל', '250 ml', 'REJECT', 'flavor');
const slicedBread = c('לחם פרוס 750 גרם', '750 g', 'MATCH', 'ordinary variation');
const breadcrumbs = c('פירורי לחם 500 גרם', '500 g', 'REJECT', 'derived');

export const SEMANTIC_CASES: SemanticCase[] = [
  // The task's examples, grouped by request.
  { id: 'milk', language: 'he', product: 'חלב', candidates: [
    plainMilk,
    c('חלב טרה 1% 1 ליטר', '1 l', 'MATCH', 'ordinary variation'),
    c('חלב עמיד 3% 1 ליטר', '1 l', 'MATCH', 'ordinary variation'),
    c('חלב תנובה מלא בטעם של פעם 3.4% 1 ל\'', '1 l', 'MATCH', 'marketing words that look like a flavor'),
    milkChocolate,
    condensedMilk,
    smoresMilkDrink,
    c('שוקו 1 ליטר', '1 l', 'REJECT', 'flavor'),
    c('חלב סויה 1 ליטר', '1 l', 'REJECT', 'substitute'),
    c('אבקת חלב 400 גרם', '400 g', 'REJECT', 'derived'),
    c('גבינה לבנה 5% 250 גרם', '250 g', 'REJECT', 'related product'),
    c('קרם גוף חלב ודבש 400 מל', '400 ml', 'REJECT', 'non-food'),
    c('פריט 1 ליטר', '1 l', 'UNCERTAIN', 'missing information')
  ] },
  { id: 'condensed-milk', language: 'he', product: 'חלב מרוכז', candidates: [
    c('חלב מרוכז ממותק 397 גרם', '397 g', 'MATCH', 'explicit request'),
    c('חלב תנובה 3% 1 ליטר', '1 l', 'REJECT', 'base product of an explicit request')
  ] },
  { id: 'smores-milk', language: 'he', product: 'חלב בטעם סמורס', candidates: [
    c('משקה חלב בטעם סמורס 1 ליטר', '1 l', 'MATCH', 'explicit request'),
    c('חלב תנובה 3% 1 ליטר', '1 l', 'REJECT', 'base product of an explicit request'),
    c('משקה חלב בטעם בננה 250 מל', '250 ml', 'REJECT', 'other flavor')
  ] },
  { id: 'bread', language: 'he', product: 'לחם', candidates: [
    slicedBread,
    c('לחם אחיד 750 גרם', '750 g', 'MATCH', 'ordinary variation'),
    breadcrumbs,
    c('קרוטונים 150 גרם', '150 g', 'REJECT', 'derived')
  ] },
  { id: 'breadcrumbs', language: 'he', product: 'פירורי לחם', candidates: [
    c('פירורי לחם 500 גרם', '500 g', 'MATCH', 'explicit request'),
    c('פירורי לחם ללא גלוטן 500 גרם', '500 g', 'DEBATABLE', 'label claim, or a substitute made from other grains'),
    c('לחם פרוס 750 גרם', '750 g', 'REJECT', 'base product of an explicit request')
  ] },
  { id: 'apples', language: 'he', product: 'תפוחים', candidates: [
    c('תפוח עץ פינק ליידי', 'kg~', 'MATCH', 'ordinary variation'),
    c('מיץ תפוחים 1 ליטר', '1 l', 'REJECT', 'derived'),
    c('רסק תפוחים 4 יחידות', '4 units', 'REJECT', 'derived')
  ] },
  { id: 'apple-juice', language: 'he', product: 'מיץ תפוחים', candidates: [
    c('מיץ תפוחים טבעי 1 ליטר', '1 l', 'MATCH', 'explicit request'),
    c('תפוח עץ פינק ליידי', 'kg~', 'REJECT', 'raw product of an explicit processed request'),
    c('מיץ תפוזים טבעי 1 ליטר', '1 l', 'REJECT', 'related product')
  ] },
  { id: 'tomatoes', language: 'he', product: 'עגבניות', candidates: [
    c('עגבניות', 'kg~', 'MATCH', 'ordinary variation'),
    c('עגבניות שרי 500 גרם', '500 g', 'DEBATABLE', 'variety, or a different salad product'),
    c('רסק עגבניות 100 גרם', '100 g', 'REJECT', 'processed'),
    c('רוטב עגבניות 400 גרם', '400 g', 'REJECT', 'processed')
  ] },
  { id: 'coffee', language: 'he', product: 'קפה', candidates: [
    c('קפה נמס 200 גרם', '200 g', 'MATCH', 'ordinary variation'),
    c('קפה טורקי 250 גרם', '250 g', 'MATCH', 'ordinary variation'),
    c('עוגה בטעם קפה 400 גרם', '400 g', 'REJECT', 'flavor'),
    c('ספל קפה זכוכית', '1 units', 'REJECT', 'accessory')
  ] },
  { id: 'strawberries', language: 'he', product: 'תותים', candidates: [
    c('תותים טריים 500 גרם', '500 g', 'MATCH', 'ordinary variation'),
    c('יוגורט בטעם תות 150 גרם', '150 g', 'REJECT', 'flavor'),
    c('ריבת תות 340 גרם', '340 g', 'REJECT', 'derived')
  ] },
  { id: 'strawberry-yogurt', language: 'he', product: 'יוגורט תות', candidates: [
    c('יוגורט בטעם תות 150 גרם', '150 g', 'MATCH', 'explicit request'),
    c('יוגורט טבעי 3% 200 גרם', '200 g', 'REJECT', 'base product of an explicit request'),
    c('תותים טריים 500 גרם', '500 g', 'REJECT', 'ingredient of an explicit request')
  ] },
  { id: 'fresh-chicken', language: 'he', product: 'עוף טרי', candidates: [
    c('עוף שלם טרי', 'kg~', 'MATCH', 'ordinary variation'),
    c('שניצל עוף מוכן 400 גרם', '400 g', 'REJECT', 'raw versus processed')
  ] },
  { id: 'olive-oil', language: 'he', product: 'שמן זית', candidates: [
    c('שמן זית כתית מעולה 750 מל', '750 ml', 'MATCH', 'ordinary variation'),
    c('סבון שמן זית 4 יחידות', '4 units', 'REJECT', 'non-food'),
    c('זיתים ירוקים 560 גרם', '560 g', 'REJECT', 'related product'),
    c('שמן קנולה 1 ליטר', '1 l', 'REJECT', 'related product')
  ] },

  // Explicit customer constraints.
  { id: 'chicken-required-fresh', language: 'he', product: 'עוף', requirements: ['טרי'], candidates: [
    c('עוף שלם טרי', 'kg~', 'MATCH', 'constraint met'),
    c('עוף שלם קפוא', 'kg~', 'REJECT', 'constraint contradicted'),
    c('שניצל עוף מוכן 400 גרם', '400 g', 'REJECT', 'raw versus processed')
  ] },
  { id: 'milk-required-3-percent', language: 'he', product: 'חלב', requirements: ['3%'], candidates: [
    c('חלב תנובה 3% 1 ליטר', '1 l', 'MATCH', 'constraint met'),
    c('חלב טרה 1% 1 ליטר', '1 l', 'REJECT', 'constraint contradicted'),
    c('חלב מרוכז ממותק 397 גרם', '397 g', 'REJECT', 'derived')
  ] },
  { id: 'milk-required-lactose-free', language: 'he', product: 'חלב', requirements: ['נטול לקטוז'], candidates: [
    c('חלב נטול לקטוז 2% 1 ליטר', '1 l', 'MATCH', 'constraint met'),
    c('חלב תנובה 3% 1 ליטר', '1 l', 'NOT_MATCH', 'constraint not shown')
  ] },

  // The same products for English and Arabic requests.
  { id: 'milk-en', language: 'en', product: 'milk', candidates: [plainMilk, condensedMilk, bananaMilkDrink, milkChocolate] },
  { id: 'milk-ar', language: 'ar', product: 'حليب', candidates: [plainMilk, condensedMilk, smoresMilkDrink, milkChocolate] },
  { id: 'bread-ar', language: 'ar', product: 'خبز', candidates: [slicedBread, breadcrumbs] },
  { id: 'eggs-en', language: 'en', product: 'eggs', candidates: [
    c('ביצים L 12 יחידות', '12 units', 'MATCH', 'ordinary variation'),
    c('אטריות ביצים 500 גרם', '500 g', 'REJECT', 'ingredient'),
    c('סלט ביצים 250 גרם', '250 g', 'REJECT', 'processed')
  ] },
  { id: 'condensed-milk-en', language: 'en', product: 'condensed milk', candidates: [
    c('חלב מרוכז ממותק 397 גרם', '397 g', 'MATCH', 'explicit request'),
    c('חלב תנובה 3% 1 ליטר', '1 l', 'REJECT', 'base product of an explicit request')
  ] },

  // Categories the instructions never name.
  { id: 'rice', language: 'he', unseen: true, product: 'אורז', candidates: [
    c('אורז בסמטי 1 ק"ג', '1 kg', 'MATCH', 'ordinary variation'),
    c('אורז יסמין 1 ק"ג', '1 kg', 'MATCH', 'ordinary variation'),
    c('פריכיות אורז 100 גרם', '100 g', 'REJECT', 'derived'),
    c('משקה אורז 1 ליטר', '1 l', 'REJECT', 'substitute'),
    c('אטריות אורז 400 גרם', '400 g', 'REJECT', 'derived')
  ] },
  { id: 'peanuts', language: 'he', unseen: true, product: 'בוטנים', candidates: [
    c('בוטנים קלויים מלוחים 200 גרם', '200 g', 'MATCH', 'ordinary variation'),
    c('חמאת בוטנים 340 גרם', '340 g', 'REJECT', 'derived'),
    c('שוקולד עם בוטנים 100 גרם', '100 g', 'REJECT', 'ingredient')
  ] },
  { id: 'lemon', language: 'he', unseen: true, product: 'לימון', candidates: [
    c('לימון', 'kg~', 'MATCH', 'ordinary variation'),
    c('מיץ לימון 250 מל', '250 ml', 'REJECT', 'derived'),
    c('נוזל כלים בניחוח לימון 750 מל', '750 ml', 'REJECT', 'non-food scent')
  ] },
  { id: 'honey', language: 'he', unseen: true, product: 'דבש', candidates: [
    c('דבש פרחים 500 גרם', '500 g', 'MATCH', 'ordinary variation'),
    c('דגני בוקר בדבש 375 גרם', '375 g', 'REJECT', 'ingredient'),
    c('עוגת דבש 450 גרם', '450 g', 'REJECT', 'ingredient')
  ] },
  { id: 'potatoes', language: 'he', unseen: true, product: 'תפוחי אדמה', candidates: [
    c('תפוחי אדמה לבנים', 'kg~', 'MATCH', 'ordinary variation'),
    c('צ\'יפס תפוחי אדמה 50 גרם', '50 g', 'REJECT', 'derived'),
    c('פירה תפוחי אדמה אינסטנט 100 גרם', '100 g', 'REJECT', 'derived')
  ] },
  { id: 'garlic', language: 'he', unseen: true, product: 'שום', candidates: [
    c('שום טרי', 'kg~', 'MATCH', 'ordinary variation'),
    c('אבקת שום 80 גרם', '80 g', 'REJECT', 'derived')
  ] },
  { id: 'yellow-cheese', language: 'he', unseen: true, product: 'גבינה צהובה', candidates: [
    c('גבינה צהובה עמק 28% 200 גרם', '200 g', 'MATCH', 'ordinary variation'),
    c('קרקר בטעם גבינה 100 גרם', '100 g', 'REJECT', 'flavor'),
    c('גבינה לבנה 5% 250 גרם', '250 g', 'REJECT', 'related product')
  ] },
  { id: 'tuna', language: 'he', unseen: true, product: 'טונה', candidates: [
    c('טונה בשמן 160 גרם', '160 g', 'MATCH', 'ordinary variation'),
    c('טונה במים 160 גרם', '160 g', 'MATCH', 'ordinary variation'),
    c('סלט טונה 200 גרם', '200 g', 'REJECT', 'processed')
  ] },
  { id: 'water', language: 'he', unseen: true, product: 'מים', candidates: [
    c('מים מינרליים 1.5 ליטר', '1.5 l', 'MATCH', 'ordinary variation'),
    c('מים בטעם אפרסק 1.5 ליטר', '1.5 l', 'REJECT', 'flavor'),
    c('מי פה 500 מל', '500 ml', 'REJECT', 'non-food')
  ] }
];

function parseSize(size: string): CatalogRecord['package'] {
  if (size === 'kg~') return { quantity: 1, unit: 'kg', isWeighted: true };
  const [quantity, unit] = size.split(' ');
  return { quantity: Number(quantity), unit: unit!, isWeighted: false };
}

/** The engine item for a case: one package of the product, with the case's mandatory requirements. */
export function caseItem(entry: SemanticCase): EngineItem {
  const requirements = entry.requirements ?? [];
  const constraintEvidence: ConstraintEvidence[] = requirements.map(value => ({ type: 'REQUIREMENT', kind: 'OTHER', sourceText: value, value }));
  return { product: entry.product, searchTerms: [entry.product], requirements, preferences: [], quantity: { amount: 0, unit: 'unspecified' }, constraintEvidence };
}

/** Catalog-shaped offers for a case's candidates, in one store. */
export function caseProducts(entry: SemanticCase): CatalogRecord[] {
  return entry.candidates.map((candidate, index) => ({
    _id: `case:${entry.id}:${index}`,
    retailer: 'eval',
    chainId: '1',
    subChainId: '1',
    storeId: '1',
    productCode: `${entry.id}-${index}`,
    name: candidate.name,
    package: parseSize(candidate.size),
    pricing: { listedPriceIls: 10 }
  }));
}

/**
 * Catalog fixture offers found for "חלב", labelled for a plain milk request. The v2 matcher
 * accepted every NOT_PLAIN name below; offers in neither list are other products (chocolate,
 * cereal, cosmetics, desserts) and must not match either.
 */
export const CATALOG_MILK = {
  plain: [
    'חלב תנובה 1% 1 לי', 'חלב תנובה עמיד 3% שומן 1 ל\' קרטון בד"צ', 'חלב תנובה מלא בטעם של פעם 3.4% 1 ל\'',
    'חלב תנובה 3% שומן 1.5 ל\' קרטון בד"צ', 'רמת הגולן חלב טרי 3% 1 ליטר', 'רמת הגולן חלב טרי 1% 1 ליטר',
    'חלב טרי 3% 1 ליטר רמי לוי', 'חלב מועשר 2 ל 3% מהדרין', 'חלב תנובה 3% שומן 1 ל\' קרטון בד"צ', 'חלב 3% טרה 2 ליטר',
    'חלב טבעי 4% רמת הגולן 1לי', 'חלב מועשר3% רמת הגולן 1לי', 'חלב יטבתה 3.6% 1 לי', 'חלב בבקבוק 3% מועשר 1 ליטר',
    'חלב בבקבוק 1% מועשר 1 ליטר', 'חלב תנובה מועשר 2% בקרטון 800 מ"ל', 'חלב תנובה 3% שומן 2 ל\'',
    'חלב תנובה 3% שומן 2 ל\' מהדרין', 'חלב 3% מהדרין שקית 1 ל', 'חלב בקבוק 3% יטבתה 1 ל', 'חלב מפוסטר 1% בקרטון 1ל',
    'חלב עמיד הומוגני 3% 1 ל', 'חלב מלא 3.8% 1ליטר תנובה', 'חלב טרי הומוגני3% 1.5ל', 'חלב טרי מהגולן 3% 1 ליטר',
    'חלב טרי מהגולן 1% 1 ליטר', 'חלב מועשר3% כד 2ל', 'חלב בקרטון 3% שומן 1 ל', 'חלב טבעי 4% שומן 1 ליטר',
    'חלב מועשר 3% שומן 1 ליטר', 'חלב 3% בקרטון מהדרין 2ל', 'חלב טבעי 3.6% 1ל יטבתה', 'חלב מועשר3%בקבוק1ל יטבתה',
    'חלב מועשר1%בקבוק1ל יטבתה', 'חלב 3% מהדרין 2ל תנובה'
  ],
  notPlain: [
    'חלב מרוכז ממותק 370 גר', 'חלב מרוכז ממותק 1לי', 'חלב מרוכז ממותק ושומן צמחי 500גר כשלפ', 'חלב מרוכז 340 גר',
    'חלב מרוכז ממותק 370 גרם', 'גו משקה חלב עם וניל 27גר חלבון', 'משקה חלב בטעם בננה 250 מל',
    'משקה חלב בטעם אייס קפוצ\'ינו 250 מל', 'משקה חלב נטול לקטוז וניל 1לי', 'משקה חלב נטול לקטוז טעם שוקו 350 מ"ל',
    'משקה חלב וניל תנובה 2% 1ליטר', 'משקה חלב עם קקאו שוקו 2.7% תנובה 1 ליטר', 'משקה חלב טעם סמורס 1 ליטר',
    'משקה חלב טעם סמורס 350 מל', 'משקה חלב טירמיסו 350 מל', 'חלב סויה אורגני 1ליטר ISOLA', 'חלב קוקוס AROY-D 250 מ"ל -מבצע',
    'חלב קוקוס 100% 1 ל', 'משקה חלב בננה 250 מ"ל', 'חלב נטול לקטוז וניל2% 1ל', 'חלב וניל2% 1ליטר תנובה',
    'מ/חלב טעם טירמיסו יטבתה1', 'מ.חלב טעם סמורס יטבתה1', 'מ.חלב טעם סמורס יטבתה350', 'משקה חלב בטעם טירמיסו350',
    'קוקו מקס חלב קוקוס 1 ליט'
  ],
  /** Milks reported but not scored: reasonable shoppers disagree (goat milk, lactose-free, milk for coffee, extra protein). */
  ambiguous: /^חלב.*(?:עיזים|עזים|לקטוז|לקטז|לקפה|להקצפה|בחלבון)/u
};
