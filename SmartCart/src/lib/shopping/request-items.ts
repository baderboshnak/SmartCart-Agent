import { validateShoppingPlan, type ValidatedPlanItem } from '@engine/smartcart-request-plan.mjs';
import { REQUEST_UNITS, shoppingDetailsIn } from '@engine/smartcart-request-coverage.mjs';
import { isCatalogSearchTerm } from '@engine/smartcart-search.mjs';
import { CONTAINER_UNITS, normalizeRequestedQuantity } from '@engine/smartcart-package.mjs';
import { isKnownBrand } from '@engine/smartcart-requirement-evidence.mjs';
import { errorMessage, ValidationError } from '@/lib/shared/errors';
import type { CartItem, ConstraintEvidence, Quantity } from '@/lib/shared/types';

const HEBREW = /[֐-׿]/u;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();

/** Find a value in text as a whole word or phrase, ignoring case. Returns the text as written. */
export function findMention(text: string, value: string): string | null {
  const needle = value.normalize('NFKC').trim();
  if (!needle) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle).replace(/\s+/gu, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.exec(text.normalize('NFKC'))?.[0] ?? null;
}

/** A quote must appear in the user's latest message (case and spacing are ignored). */
export function assertUserQuote(userMessage: string, quote: string | undefined, purpose: string): string {
  const value = quote?.trim() ?? '';
  if (!value || !fold(userMessage).includes(fold(value))) {
    throw new ValidationError(`${purpose} needs userQuote: the exact words from the user's latest message that ask for it.`);
  }
  return value;
}

function spansOf(text: string, quote: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const needle = quote.trim();
  if (!needle) return spans;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    spans.push({ start: index, end: index + needle.length });
  }
  return spans;
}

function isClauseBoundary(text: string, index: number): boolean {
  const char = text[index] ?? '';
  if (!/[,،;؛.!?\n]/u.test(char)) return false;
  // Decimal separators such as 1.5 or 1,5 are not clause boundaries.
  return !(/[.,،]/u.test(char) && /\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''));
}

/**
 * Reject an extracted request span when the surrounding clause, or the clause right
 * after it, still contains quantities, qualifiers, "preferably" or "only" wording
 * that no operation covers. This catches a span such as "milk" taken from
 * "2 liters of 3% milk".
 */
export function assertNoUnassignedDetails(userMessage: string, requestText: string, coveredQuotes: string[]): void {
  const span = spansOf(userMessage, requestText)[0];
  if (!span) throw new ValidationError('requestText must be copied verbatim from the user\'s latest message.');
  // UTF-16 code units, matching the indexes returned by indexOf.
  const masked = userMessage.split('');
  for (const quote of [requestText, ...coveredQuotes]) {
    for (const covered of spansOf(userMessage, quote)) {
      for (let index = covered.start; index < covered.end; index++) masked[index] = ' ';
    }
  }
  let left = span.start;
  while (left > 0 && !isClauseBoundary(userMessage, left - 1)) left--;
  let right = span.end;
  while (right < userMessage.length && !isClauseBoundary(userMessage, right)) right++;
  let nextEnd = right;
  if (right < userMessage.length && /[,،]/u.test(userMessage[right]!)) {
    nextEnd = right + 1;
    while (nextEnd < userMessage.length && !isClauseBoundary(userMessage, nextEnd)) nextEnd++;
  }
  const maskedText = masked.join('');
  const nearby = `${maskedText.slice(left, span.start)} ${maskedText.slice(span.end, nextEnd)}`;
  const details = shoppingDetailsIn(nearby);
  if (details.length) {
    throw new ValidationError(
      `Shopping details next to requestText are not assigned to any item: ${[...new Set(details.map(detail => JSON.stringify(detail.text)))].join(', ')}. ` +
      'Copy the complete wording of every item (amounts, percentages, brands, "preferably"/"only" clauses) into requestText, ' +
      'or cover that wording with another tool call in the same turn (for example setBudget for "under ₪50").'
    );
  }
}

export interface ExtractedItemArgs {
  sourceText: string;
  product: string;
  coreSearchTerm: string;
  searchTerms?: string[];
  constraintEvidence?: Array<{ type: 'REQUIREMENT' | 'PREFERENCE'; kind: 'BRAND' | 'OTHER'; sourceText: string }>;
  quantity: { amount: number; unit: string; maxAmount?: number };
}

/** Validate direct shopping items with the engine's exact source-span validator. */
// Words that ask for an unspecified product: "something tasty", "משהו מתוק", "شي طيب".
// Hebrew and Arabic words may carry a one- or two-letter prefix ("ומשהו", "وشي").
// "something like X" names a product by example, so it is allowed.
const VAGUE_PRODUCT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:something|anything|whatever|stuff|[ושהבלמכ]{0,2}(?:משהו|כלשהו|כלשהי|איזשהו|איזושהי)|و?(?:شي|شيء|اشي|إشي|حاجة))` +
  String.raw`(?![\p{L}\p{N}])(?!\s+(?:like|similar|כמו|בסגנון|مثل|زي))`,
  'iu'
);

/** True when the wording asks for an unspecified product instead of naming one. */
export function isVagueProductRequest(text: string): boolean {
  return VAGUE_PRODUCT.test(text);
}

// A question about which version of a product: "Which type of chicken?", "What brand?",
// "איזה סוג עוף?", "أي نوع جبنة؟".
const VERSION_QUESTION = new RegExp(String.raw`(?<![\p{L}])(?:${[
  String.raw`(?:which|what)\s+(?:types?|kinds?|sorts?|brands?|flavou?rs?|sizes?|variet(?:y|ies)|cuts?|fat\s+(?:level|content|percentage))`,
  String.raw`(?:preferred|particular|specific)\s+(?:types?|kinds?|brands?|flavou?rs?|sizes?|variet(?:y|ies))`,
  String.raw`[במ]?(?:איזה|איזו|אילו)\s+(?:סוג|סוגי|מותג|טעם|גודל|אחוז|אחוזי)`,
  String.raw`אחוזי?\s+שומן`,
  String.raw`(?:أي|اي|شو|ايش|ما)\s+(?:نوع|ماركة|علامة|نكهة|حجم|طعم)`,
  String.raw`نسبة\s+(?:الدسم|الدهون)`
].join('|')})(?![\p{L}])`, 'iu');

// General categories, where asking which product is right: "a drink", "meat", "vegan products".
const CATEGORY_REQUEST = new RegExp(String.raw`(?<![\p{L}])(?:${[
  String.raw`[ושהבלמכ]{0,2}(?:שתייה|שתיה|משקה|משקאות|חטיף|חטיפים|נשנוש|נשנושים|אוכל|בשר|דג|דגים|פרי|פירות|ירק|ירקות|קינוח|קינוחים|ממתק|ממתקים|מתוקים|מוצר|מוצרים|מוצרי)`,
  String.raw`drinks?|beverages?|snacks?|food|meat|fish|fruits?|vegetables?|veggies|desserts?|sweets|cand(?:y|ies)|dairy|groceries|products?|items?`,
  String.raw`و?(?:مشروب|مشروبات|سناك|تسالي|أكل|اكل|لحمة|لحم|سمك|فواكه|فاكهة|خضار|خضرة|حلويات|حلو|منتج|منتجات|أغراض|اغراض)`
].join('|')})(?![\p{L}])`, 'iu');

/**
 * True when a clarifying question asks which type, kind, brand, size or flavor of a product the
 * customer already named ("I want chicken" → "Which type of chicken?"). A named product is enough:
 * matching chooses among the catalog's versions. A vague request or a general category may be asked about.
 */
export function asksWhichVersion(question: string, message: string): boolean {
  return VERSION_QUESTION.test(question) && !isVagueProductRequest(message) && !CATEGORY_REQUEST.test(message);
}

export function validateDirectItems(
  args: { requestText: string; items: ExtractedItemArgs[] },
  userMessage: string,
  coveredQuotes: string[] = []
): ValidatedPlanItem[] {
  const requestText = args.requestText.trim();
  if (!requestText || !userMessage.includes(requestText)) {
    throw new ValidationError('requestText must be copied verbatim from the user\'s latest message.');
  }
  args.items.forEach((item, index) => {
    if (isVagueProductRequest(item.product) || isVagueProductRequest(item.sourceText)) {
      throw new ValidationError(
        `Item ${index + 1} ("${item.sourceText}") is not a specific product, so it cannot be searched or priced. ` +
        'Add only the specific products now, then call requestClarification once: ask which product they mean and offer 3-4 concrete options ' +
        'in the customer\'s language (for "something tasty with chocolate": chocolate bar, chocolate spread, chocolate cookies, chocolate milk). ' +
        'Do not call optimizeBasket before asking.'
      );
    }
  });
  let plan;
  try {
    plan = validateShoppingPlan({
      items: args.items.map(item => ({
        sourceText: item.sourceText,
        product: item.product,
        coreSearchTerm: item.coreSearchTerm,
        searchTerms: item.searchTerms ?? [],
        constraintEvidence: item.constraintEvidence ?? [],
        quantity: item.quantity
      }))
    }, requestText);
  } catch (error) {
    throw new ValidationError(`The extracted items do not match the request wording: ${errorMessage(error)}`);
  }
  assertNoUnassignedDetails(userMessage, requestText, coveredQuotes);
  return plan.items;
}

const QUANTITY_LIMITS: Record<string, number> = { mass: 50_000, volume: 50_000, count: 500 };

export function validateQuantity(quantity: { amount: number; unit: string; maxAmount?: number }, label = 'quantity'): Quantity {
  if (!REQUEST_UNITS.includes(quantity.unit)) throw new ValidationError(`${label} unit must be one of ${REQUEST_UNITS.join(', ')}.`);
  if (quantity.unit === 'unspecified') {
    if (quantity.amount !== 0 || quantity.maxAmount !== undefined) throw new ValidationError(`${label}: use amount 0 with unit "unspecified".`);
    return { amount: 0, unit: 'unspecified' };
  }
  const normalized = normalizeRequestedQuantity(quantity);
  if (!normalized) throw new ValidationError(`${label} must be a positive amount with a supported unit.`);
  const limit = QUANTITY_LIMITS[normalized.family] ?? 0;
  if ((normalized.maxAmountBase ?? normalized.amountBase) > limit) throw new ValidationError(`${label} is unrealistically large.`);
  return { amount: quantity.amount, unit: quantity.unit, ...(quantity.maxAmount === undefined ? {} : { maxAmount: quantity.maxAmount }) };
}

const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['dozen', 12], ['twenty', 20],
  ['אחד', 1], ['אחת', 1], ['שניים', 2], ['שתיים', 2], ['שני', 2], ['שתי', 2], ['שלושה', 3], ['שלוש', 3],
  ['ארבעה', 4], ['ארבע', 4], ['חמישה', 5], ['חמש', 5], ['שישה', 6], ['שש', 6], ['שבעה', 7], ['שבע', 7], ['שמונה', 8],
  ['תשעה', 9], ['תשע', 9], ['עשרה', 10], ['עשר', 10], ['תריסר', 12], ['עשרים', 20],
  ['واحد', 1], ['اثنين', 2], ['اثنان', 2], ['تنين', 2], ['شخصين', 2], ['ثلاث', 3], ['ثلاثة', 3], ['تلات', 3], ['تلاتة', 3],
  ['أربع', 4], ['أربعة', 4], ['اربع', 4], ['اربعة', 4], ['خمس', 5], ['خمسة', 5], ['ست', 6], ['ستة', 6], ['سبع', 7], ['سبعة', 7],
  ['ثمانية', 8], ['تمانية', 8], ['تسع', 9], ['تسعة', 9], ['عشر', 10], ['عشرة', 10], ['عشرين', 20]
]);
// Hebrew and Arabic join prepositions and "and" to a number: "לארבעה אנשים", "ולשניים", "لأربعة أشخاص".
const JOINED_PREFIX = '(?:[ובלהמשכ]{1,2}|[وبلفك]{1,2})?';

function mentionsNumber(text: string, value: number): boolean {
  const digits = text.replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660));
  if (new RegExp(`(?<![\\d.,])${value}(?![\\d.,]\\d)`, 'u').test(digits)) return true;
  const words = [...NUMBER_WORDS].filter(([, number]) => number === value).map(([word]) => escapeRegex(word));
  return words.length > 0 &&
    new RegExp(`(?<![\\p{L}\\p{N}])${JOINED_PREFIX}(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(text.normalize('NFKC'));
}

const HEADCOUNT_NUMBER = `(?:[0-9]{1,3}|${[...NUMBER_WORDS.keys()].map(escapeRegex).join('|')})`;
const HEADCOUNT_UNIT = '(?:people|persons?|guests?|servings?|attendees?|אנשים|איש|אורחים|מנות|סועדים|משתתפים|أشخاص|اشخاص|شخص|ضيوف|أفراد|افراد|حصص)';
const HEADCOUNT_WITH_UNIT = new RegExp(`(?<![\\p{L}\\p{N}.,])${HEADCOUNT_NUMBER}\\s+${HEADCOUNT_UNIT}(?![\\p{L}\\p{N}])`, 'iu');
const HEADCOUNT_ONLY = new RegExp([
  '^(?:(?:actually|instead|בעצם|למעשה|في الواقع|بدل ذلك)[,،]?\\s+)?',
  "(?:(?:make (?:it|(?:that|the) (?:party|event|meal|plan|recipe))|change (?:it|the plan)|(?:the )?(?:party|event|meal|plan) (?:is|will be)|it(?:['’]s| is| will be)|ה(?:מסיבה|ארוחה|אירוע|מתכון|תוכנית) (?:היא|הוא)|ת(?:שנה|עשה|עדכן)(?: (?:את זה|את התוכנית))?|الحفلة (?:هي|ستكون)|اجعلها|خليها)\\s+)?",
  '(?<prefix>for\\s+|to\\s+|ל[-־]?\\s*|עבור\\s+|ل\\s*|لعدد\\s+)?',
  `(?<amount>${HEADCOUNT_NUMBER})(?:\\s+(?<unit>${HEADCOUNT_UNIT}))?[.!?؟]*$`
].join(''), 'iu');

function normalizeHeadcountText(text: string): string {
  return fold(text).replace(/ـ/gu, '')
    .replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, digit => String(digit.charCodeAt(0) - 0x06f0));
}

/** A bare correction to a plan's size, such as "Actually, make it for 6". */
export function isHeadcountCorrection(message: string): boolean {
  const match = HEADCOUNT_ONLY.exec(normalizeHeadcountText(message));
  return Boolean(match?.groups?.prefix || match?.groups?.unit);
}

export function assertShoppingPlanHeadcount(message: string, quote: string, servings: number): void {
  const wording = normalizeHeadcountText(assertUserQuote(message, quote, 'Resizing a shopping plan'));
  const countPhrase = HEADCOUNT_WITH_UNIT.exec(wording)?.[0];
  const shortPhrase = HEADCOUNT_ONLY.exec(wording)?.groups;
  if (!(countPhrase && mentionsNumber(countPhrase, servings)) &&
      !(shortPhrase?.amount && (shortPhrase.prefix || shortPhrase.unit) && mentionsNumber(shortPhrase.amount, servings))) {
    throw new ValidationError('Quote the customer’s new headcount for this plan. Purchase amounts and budget limits do not specify a headcount.');
  }
}

/**
 * Recipe amounts are estimates, so near misses are corrected instead of refused: an "unspecified"
 * unit or a zero amount means one package, and part of a counted item (0.5 onion) is one whole item.
 * A container in Gemini's own plan ("1 bag of flour") is a count of sale packages: the customer
 * did not ask for that container, and most catalog records never say "bag", so it would match nothing.
 * Negative or missing amounts are still refused.
 */
function recipeQuantity(quantity: { amount: number; unit: string }): { amount: number; unit: string } {
  if (!(quantity.amount >= 0)) return quantity;
  if (quantity.unit === 'unspecified' || quantity.amount === 0) return { amount: 0, unit: 'unspecified' };
  if (CONTAINER_UNITS.includes(quantity.unit)) return { amount: Math.ceil(quantity.amount), unit: 'pack' };
  if (quantity.unit === 'units' && !Number.isInteger(quantity.amount)) return { amount: Math.ceil(quantity.amount), unit: 'units' };
  return quantity;
}

export interface RecipeArgs {
  requestText: string;
  dish: string;
  servings: number;
  servingsSource: 'EXPLICIT' | 'ASSUMED';
  ingredients: Array<{
    name: string;
    coreSearchTerm: string;
    searchTerms?: string[];
    quantity: { amount: number; unit: string };
    optional?: boolean;
    requirements?: string[];
    preferences?: string[];
    note?: string;
  }>;
  notes?: string;
}

export interface NewItemFields {
  product: string;
  searchTerms: string[];
  requirements: string[];
  preferences: string[];
  constraintEvidence: ConstraintEvidence[];
  quantity: Quantity;
}

/**
 * Validate a Gemini-generated ingredient plan. Quantities are estimates; constraints
 * must be grounded in the customer's wording; products and prices never come from the plan.
 */
export function validateRecipePlan(args: RecipeArgs, userMessage: string, coveredQuotes: string[] = []): {
  plan: { dish: string; servings: number; servingsSource: 'EXPLICIT' | 'ASSUMED'; requestText: string; notes?: string };
  ingredients: Array<NewItemFields & { name: string; optional: boolean; note?: string }>;
} {
  const requestText = args.requestText.trim();
  if (!requestText || !userMessage.includes(requestText)) {
    throw new ValidationError('requestText must be copied verbatim from the user\'s latest message.');
  }
  if (!Number.isInteger(args.servings) || args.servings < 1 || args.servings > 100) {
    throw new ValidationError('servings must be a whole number between 1 and 100.');
  }
  if (args.servingsSource === 'EXPLICIT' && !mentionsNumber(requestText, args.servings)) {
    throw new ValidationError(`servingsSource is EXPLICIT but ${args.servings} servings is not stated in requestText. Use ASSUMED and tell the customer.`);
  }
  const required = args.ingredients.filter(ingredient => !ingredient.optional);
  if (!required.length) throw new ValidationError('A recipe plan needs at least one required ingredient.');
  const names = new Set<string>();
  const ingredients = args.ingredients.map((ingredient, index) => {
    const label = `ingredients[${index}] (${ingredient.name})`;
    const name = ingredient.name.trim();
    if (!name) throw new ValidationError(`${label} needs a name.`);
    if (names.has(fold(name))) throw new ValidationError(`${label} repeats an ingredient; combine the amounts instead.`);
    names.add(fold(name));
    const core = ingredient.coreSearchTerm.trim();
    if (!HEBREW.test(core) || !isCatalogSearchTerm(core)) throw new ValidationError(`${label} coreSearchTerm must be the ingredient's Hebrew name, in Hebrew letters only.`);
    const quantity = validateQuantity(recipeQuantity(ingredient.quantity), `${label} quantity`);
    const constraintEvidence: ConstraintEvidence[] = [];
    const ground = (values: string[] | undefined, type: 'REQUIREMENT' | 'PREFERENCE') => (values ?? []).map(value => {
      const written = findMention(requestText, value);
      if (!written) {
        throw new ValidationError(`${label} ${type.toLowerCase()} "${value}" is not in the customer's words. Only use constraints the customer stated.`);
      }
      constraintEvidence.push({ type, kind: isKnownBrand(written) ? 'BRAND' : 'OTHER', sourceText: written, value: written });
      return written;
    });
    const requirements = ground(ingredient.requirements, 'REQUIREMENT');
    const preferences = ground(ingredient.preferences, 'PREFERENCE');
    return {
      name,
      product: name,
      searchTerms: [...new Set([core, ...(ingredient.searchTerms ?? []).map(term => term.trim()).filter(Boolean).filter(isCatalogSearchTerm)])].slice(0, 6),
      requirements,
      preferences,
      constraintEvidence,
      quantity,
      optional: Boolean(ingredient.optional),
      ...(ingredient.note ? { note: ingredient.note.slice(0, 200) } : {})
    };
  });
  assertNoUnassignedDetails(userMessage, requestText, coveredQuotes);
  return {
    plan: {
      dish: args.dish.trim().slice(0, 80), servings: args.servings, servingsSource: args.servingsSource, requestText,
      ...(args.notes ? { notes: args.notes.slice(0, 300) } : {})
    },
    ingredients
  };
}

export interface ConstraintArgs {
  value: string;
  type: 'REQUIREMENT' | 'PREFERENCE';
  kind?: 'BRAND' | 'OTHER';
}

/**
 * Replace an item's constraints. New or reclassified values must appear in the user's
 * latest message. A mandatory requirement is removed only when the user names it.
 */
export function validateConstraintUpdate(item: CartItem, constraints: ConstraintArgs[], userMessage: string): {
  requirements: string[];
  preferences: string[];
  constraintEvidence: ConstraintEvidence[];
} {
  const seen = new Set<string>();
  const existing = new Map(item.constraintEvidence.map(entry => [fold(entry.value), entry]));
  const evidence: ConstraintEvidence[] = [];
  for (const constraint of constraints) {
    const key = fold(constraint.value);
    if (!key) throw new ValidationError('Constraint values cannot be empty.');
    if (seen.has(key)) throw new ValidationError(`Constraint "${constraint.value}" is repeated.`);
    seen.add(key);
    const previous = existing.get(key);
    if (previous && previous.type === constraint.type) {
      evidence.push(previous);
      continue;
    }
    const written = findMention(userMessage, constraint.value);
    if (!written) {
      throw new ValidationError(previous
        ? `Changing "${previous.value}" to a ${constraint.type.toLowerCase()} needs the user's explicit wording in the latest message.`
        : `Constraint "${constraint.value}" is not in the user's latest message. Only add constraints the customer stated.`);
    }
    const value = previous?.value ?? written;
    const kind = isKnownBrand(value) ? 'BRAND' : (constraint.kind ?? previous?.kind ?? 'OTHER');
    evidence.push({ type: constraint.type, kind, sourceText: previous?.sourceText ?? written, value });
  }
  for (const previous of item.constraintEvidence) {
    const kept = evidence.find(entry => fold(entry.value) === fold(previous.value));
    if (previous.type === 'REQUIREMENT' && (!kept || kept.type !== 'REQUIREMENT') && !findMention(userMessage, previous.value)) {
      throw new ValidationError(
        `"${previous.value}" is a mandatory requirement for ${item.product}. It can be relaxed only when the customer explicitly asks; ` +
        'keep it, or confirm with requestClarification.'
      );
    }
  }
  return {
    requirements: evidence.filter(entry => entry.type === 'REQUIREMENT').map(entry => entry.value),
    preferences: evidence.filter(entry => entry.type === 'PREFERENCE').map(entry => entry.value),
    constraintEvidence: evidence
  };
}

export function validateSearchTerms(terms: string[]): string[] {
  const cleaned = [...new Set(terms.map(term => term.trim()).filter(Boolean).filter(isCatalogSearchTerm))];
  if (!cleaned.length || cleaned.length > 6) throw new ValidationError('Provide 1 to 6 search terms.');
  if (!cleaned.some(term => HEBREW.test(term))) throw new ValidationError('Search terms must include a Hebrew phrase; catalog names are Hebrew.');
  if (cleaned.some(term => term.length > 60)) throw new ValidationError('Search terms must be short product phrases.');
  return cleaned;
}
