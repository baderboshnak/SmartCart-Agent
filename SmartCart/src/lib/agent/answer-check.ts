import { detectLanguage, type Language } from '@/lib/i18n/language';
import type { Cart, StoreDocument } from '@/lib/shared/types';
import { isCalculationFresh, selectBasket } from '@/lib/shopping/optimizer';

/**
 * Deterministic checks of Gemini's final answer against the verified cart. A failing answer is
 * replaced by the verified summary, so a wrong price, store or claim never reaches the customer.
 * Product names and brands in free text are not checked: the basket card shows the verified ones.
 */
export type AnswerProblem = 'price' | 'amount' | 'store' | 'stock' | 'added' | 'language';

const QUOTED_PRICE = /₪\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:₪|ש"ח|ש״ח|שקלים|שקל|شيكل|شيقل|شواكل|NIS|ILS)/giu;
const COUNTED_AMOUNT = /(\d+(?:[.,]\d+)?)\s*(?:×\s*)?(?:packages?|packs?|units?|bottles?|cans?|loaves|loaf|liters?|litres?|ml|kg|grams?|יחידות|יחידה|אריזות|אריזה|חבילות|חבילה|בקבוקים|בקבוק|ליטרים|ליטר|גרם|ק"ג|ק״ג|קילו|מ"ל|מ״ל|عبوات|عبوة|زجاجات|زجاجة|لتر|غرام|كيلو)(?![\p{L}])/giu;
// SmartCart has no live stock information, so these claims are never true.
const STOCK_CLAIM = /\bguaranteed\b|\bin stock (?:right )?now\b|\bavailable right now\b|במלאי עכשיו|מובטח במלאי|متوفر الآن|مضمون التوفر/iu;
const ADDED_CLAIM = /(?:^|[^\p{L}])added\b|הוספתי|הוספנו|أضفت|أضفنا/iu;
const CHAINS = [
  { retailer: 'shufersal', name: /shufersal|שופרסל|شوفرسال/iu },
  { retailer: 'rami_levy', name: /rami\s?levy|רמי לוי|رامي ليفي/iu }
];
const STORE_NUMBER = /(?:store|branch|סניף|فرع)\s*#?\s*(\d{2,4})(?!\d)/giu;
// "1 liter per package": the number must be a real package size, not just any amount.
const PACKAGE_SIZE = /(\d+(?:[.,]\d+)?)\s*(?:liters?|litres?|ml|kg|grams?|ליטרים|ליטר|מ"ל|מ״ל|גרם|ק"ג|ק״ג|קילו|لتر|مل|غرام|كيلو)\s*(?:per (?:package|pack|bottle|unit)|each|לאריזה|לכל אריזה|ליחידה|כל אחד|للعبوة|لكل عبوة|للوحدة)/giu;

const cents = (value: number) => Math.round(value * 100);
const parseNumber = (text: string) => Number(text.replace(',', '.'));
const westernDigits = (text: string) => text.replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660));

const PRICE_KEY = /price|total|ils$|budget|premium|saving/iu;
const AMOUNT_KEY = /count|quantity|amount/iu;

/**
 * Numbers the data states, as cents: prices from price fields, and amounts from quantity fields
 * with metric conversions (0.5 kg is also 500 g). Other numbers never vouch for an answer.
 */
interface Allowed { prices: Set<number>; amounts: Set<number>; sizes: Set<number> }

function collectNumbers(value: unknown, into: Allowed, key = '', parent = '') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const conversions = [value, value * 1000, value / 1000].map(cents);
    if (PRICE_KEY.test(key)) into.prices.add(cents(value));
    if (AMOUNT_KEY.test(key)) conversions.forEach(entry => into.amounts.add(entry));
    if (key === 'quantity' && parent === 'package') conversions.forEach(entry => into.sizes.add(entry));
  } else if (Array.isArray(value)) {
    value.forEach(entry => collectNumbers(entry, into, key, parent));
  } else if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) collectNumbers(entry, into, name, key);
  }
}

function collectStrings(value: unknown, key: string, into: Set<string>) {
  if (Array.isArray(value)) value.forEach(entry => collectStrings(entry, key, into));
  else if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) {
      if (name === key && typeof entry === 'string' && entry.trim()) into.add(entry);
      else collectStrings(entry, key, into);
    }
  }
}

export function answerProblems(text: string, context: {
  cart: Cart;
  language: Language;
  /** The customer's latest message: amounts the customer stated are fine to repeat. */
  message: string;
  /** Whether this run changed the cart. */
  cartChanged: boolean;
  /** Catalog stores, used when the cart has no calculation. */
  stores: Pick<StoreDocument, '_id'>[];
}): AnswerProblem[] {
  const problems = new Set<AnswerProblem>();
  const { cart } = context;
  const calculation = cart.calculation && isCalculationFresh(cart) ? cart.calculation : null;
  const basket = calculation ? selectBasket(cart).basket : null;

  const allowed: Allowed = { prices: new Set(), amounts: new Set(), sizes: new Set() };
  if (basket) collectNumbers(calculation!.result, allowed);
  else if (calculation?.result.cheapestOverBudgetIls) allowed.prices.add(cents(calculation.result.cheapestOverBudgetIls));
  // The customer's own prices and amounts may be repeated ("under ₪50", "2 liters"), but a bare
  // number such as the 3 in "3% milk" vouches for nothing.
  const message = westernDigits(context.message);
  for (const match of message.matchAll(QUOTED_PRICE)) allowed.prices.add(cents(parseNumber((match[1] ?? match[2])!)));
  for (const match of message.matchAll(COUNTED_AMOUNT)) allowed.amounts.add(cents(parseNumber(match[1]!)));
  if (cart.budget) allowed.prices.add(cents(cart.budget.amountIls));
  for (const item of cart.items) collectNumbers({ quantity: item.quantity }, allowed);

  // Verified product names may contain numbers ("1 ליטר"); they are checked as names, not amounts.
  const names = new Set<string>();
  if (calculation) collectStrings(calculation.result, 'productName', names);
  let scanned = westernDigits(text);
  for (const name of [...names].sort((a, b) => b.length - a.length)) scanned = scanned.split(name).join(' ');

  for (const match of scanned.matchAll(QUOTED_PRICE)) {
    if (!allowed.prices.has(cents(parseNumber((match[1] ?? match[2])!)))) problems.add('price');
  }
  for (const match of scanned.matchAll(COUNTED_AMOUNT)) {
    if (!allowed.amounts.has(cents(parseNumber(match[1]!)))) problems.add('amount');
  }
  if (basket) {
    for (const match of scanned.matchAll(PACKAGE_SIZE)) if (!allowed.sizes.has(cents(parseNumber(match[1]!)))) problems.add('amount');
  }

  const storeKeys = calculation
    ? [...calculation.result.storeComparisons.map(store => store.storeKey), ...calculation.result.excludedStores.map(store => store.storeKey)]
    : context.stores.map(store => store._id);
  const retailers = new Set(storeKeys.map(key => key.split(':')[0]));
  const storeIds = new Set(storeKeys.map(key => String(Number(key.split(':')[3]))));
  if (CHAINS.some(chain => chain.name.test(text) && !retailers.has(chain.retailer))) problems.add('store');
  for (const match of scanned.matchAll(STORE_NUMBER)) if (!storeIds.has(String(Number(match[1])))) problems.add('store');

  if (STOCK_CLAIM.test(text)) problems.add('stock');
  if (!context.cartChanged && ADDED_CLAIM.test(text)) problems.add('added');
  const written = detectLanguage(text);
  if (written && written !== context.language) problems.add('language');
  return [...problems];
}
