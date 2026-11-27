import { CONTAINER_UNITS, containerType, normalizeAmount, parseUnit } from './smartcart-package.mjs';

// Verify that an extracted plan accounts for the original wording before it
// can reach search or matching. The semantic audit complements these guards.
const LEAD_IN = /^(?:i|d|want|need|would|like|please|add|buy|get|me|find|can|could|you|to|some|my|a|shopping|list|for|here|is|s|אני|צריך|צריכה|רוצה|בבקשה|לקנות|תוסיף|תוסיפי|אשמח|קנה|קני|לי|לקבל|רשימת|קניות|بدي|أريد|اريد|أحتاج|احتاج|أشتري|اشتري|أريدك|شراء|لي|رجاء|من|فضلك)$/iu;
const SHOPPING_INTRO = /^\s*(?:i\s+(?:could|can)\s+use|i(?:['’]m|\s+am)\s+looking\s+for)\b/iu;
const SHOPPING_LIST_INTRO = /^\s*(?:i\s+(?:want|would\s+like)\s+to\s+)?(?:make|prepare)\s+(?:me\s+)?(?:a\s+)?(?:shopping|grocery)\s+list(?:\s+(?:of|with))?\b/iu;
const ENGLISH_COOKING_GOAL = /^(?:(?:i\s+(?:want|need|plan|would\s+like)|i(?:['’]m|\s+am)\s+(?:going|planning))\s+to\s+)?(?:make|cook|bake|prepare)\s+[\p{L}\p{N}][^,;.!?\n]*[.!?]?$/iu;
const HEBREW_COOKING_GOAL = /^(?:(?:אני\s+)?(?:רוצה|צריך|צריכה|מתכנן|מתכננת|בא לי)\s+)?(?:להכין|לבשל|לאפות)\s+[\p{L}\p{N}][^,;.!?\n]*[.!?]?$/u;
const ADDED_SHOPPING_CLAUSE = /\b(?:and|then)\s+(?:(?:i|we)\s+)?(?:want|need|buy|get|pick up)\b/iu;
const UNSPECIFIED_MEAL = /^(?:i\s+(?:want|need|would\s+like)\s+)?(?:something|anything)\s+for\s+(?:breakfast|lunch|dinner|a meal)[.!?]?$/iu;
const SEPARATOR = /^(?:and|plus|also|as|well|then|please|thanks|thank|you|ו|וגם|גם|וכן|בבקשה|תודה|و|وأيضا|أيضا|ثم|شكرا)$/iu;
const CHOICE_WORD = /(?<![\p{L}\p{N}])(?:or|או|أو|او)(?![\p{L}\p{N}])/giu;
const CHOICE_GAP = /^\s*[,،]?\s*(?:or|או|أو|او)\s*$/iu;
const COMMA_GAP = /^\s*[,،]\s*$/u;
const CONJUNCTION_GAP = /^\s*(?:and|plus|as\s+well\s+as|ו[-־]?|וגם|וכן|و[-ـ]?|ثم)\s*$/iu;
const OPTIONAL_CUE = /(?<!\p{L})(?:prefer(?:ably|red)?|ideally|if (?:(?:it(?:'s| is) )?(?:possible|available))|would rather|a preference for|nice to have|עדיף|רצוי|בעדיפות|אם אפשר|و?يفضل|و?أفضل|و?افضل|لو أمكن)(?!\p{L})/giu;
const MANDATORY_CUE = /(?<!\p{L})(?:only|exclusively|must(?: be| have)?|strictly|not optional|required|רק|אך ורק|בלבד|חייב(?:ת)?|فقط|حصرا|يجب)(?!\p{L})/giu;
const DIGIT = String.raw`[0-9٠-٩۰-۹]`;
const DECIMAL = String.raw`${DIGIT}+(?:[.,٫]${DIGIT}+)?`;
const PERCENTAGE = String.raw`${DECIMAL}\s*[%٪]`;
const PERCENT_ATTRIBUTE = String.raw`(?:fat|sugar|protein|cocoa|שומן|סוכר|חלבון|קקאו|دسم|دهون|سكر|بروتين|كاكاو)`;
const PERCENT_PAIR = new RegExp(
  String.raw`(?<![\p{N}.,٫])(?<left>${DECIMAL})\s*[%٪]\s*(?<firstAttribute>${PERCENT_ATTRIBUTE})?\s*(?:and\s+|ו\s*|و\s*)(?<right>${DECIMAL})\s*[%٪]\s*(?<lastAttribute>${PERCENT_ATTRIBUTE})(?!\p{L})`,
  'giu'
);
const QUALIFIERS = [
  new RegExp(String.raw`(?<![\p{N}.,٫])${PERCENTAGE}`, 'gu'),
  /(?<!\p{L})(?:lactose|sugar|gluten|nut|peanut|dairy|salt|soy|egg|wheat|caffeine)[-\s]*free(?!\p{L})/giu,
  /(?<!\p{L})(?:without|no(?: added)?|free from)\s+(?:added\s+)?(?:lactose|sugar|gluten|nuts?|peanuts?|dairy|salt|soy|eggs?|wheat|caffeine)(?!\p{L})/giu,
  /(?<!\p{L})(?:whole[-\s]+wheat|unsalted|salted|unsweetened|sweetened|shredded|grated|sliced|powdered|diced|minced|boneless|skinless|seedless)(?!\p{L})/giu,
  /(?<!\p{L})(?:non[-\s]vegan|vegan|frozen|טבעוני(?:ת|ים|ות)?|קפוא(?:ה|ים|ות)?)(?!\p{L})/giu,
  /(?<!\p{L})(?:نباتي صرف|نباتية صرفة|مجمّ?د(?:ة)?)(?!\p{L})/gu,
  /(?<!\p{L})(?:ללא|נטול(?:ת)?|בלי)\s+(?:תוספת\s+)?(?:לקטוז|סוכר|גלוטן|מלח|בוטנים|אגוזים|קפאין|חלב|סויה|ביצים|חיטה)(?!\p{L})/gu,
  /(?<!\p{L})(?:חיטה מלאה|קמח מלא|מגורד(?:ת|ים|ות)?|מגורר(?:ת|ים|ות)?|פרוס(?:ה|ים|ות)?|מומלח(?:ת|ים|ות)?)(?!\p{L})/gu,
  /(?<!\p{L})(?:خالي(?:ة)? من|خالٍ من|بدون)\s+(?:اللاكتوز|الغلوتين|الجلوتين|السكر|الملح|سكر مضاف)(?!\p{L})/gu
];
const HARD_VALUE = /(?<!\p{L})(?:only|exclusively|רק|אך ורק)\s+(?:the\s+)?(?!\p{N}|(?:want|need|buy|get|order|add|looking|רוצה|צריך|צריכה)\s)(.+?)(?=\s*(?:[,،;!?\n]|\b(?:and|plus|preferably|please)\b|$))/giu;
const ITEM_SEPARATOR = /(?<!\p{N})[,،]|[,،](?!\p{N})|[;؛\n]|(?<!\p{L})(?:and|plus|as well as|וגם|וכן|ثم)(?!\p{L})/giu;
const DETAIL_WORD = /^(?:a|an|the|of|for|from|by|with|in|at|as|is|be|to|but|or|made|size|brand|type|each|per|x|any|another|same|של|עם|מסוג|בגודל|גרם|גרמים|ליטר|ליטרים|מיליליטר|מיליליטרים|יחידות|יחידה|من|في|مع|كل|لكل|واحد|واحدة)$/iu;
const ARABIC_UNITS = new Map([
  ['لتر', 'l'], ['ليتر', 'l'], ['لترات', 'l'], ['ليترات', 'l'],
  ['مل', 'ml'], ['مليلتر', 'ml'], ['مليلترات', 'ml'],
  ['غ', 'g'], ['غرام', 'g'], ['غرامات', 'g'], ['جرام', 'g'], ['جرامات', 'g'],
  ['كغ', 'kg'], ['كجم', 'kg'], ['كيلو', 'kg'], ['كيلوغرام', 'kg'], ['كيلوجرام', 'kg'],
  ['وحدة', 'units'], ['وحدات', 'units'], ['قطعة', 'units'], ['قطع', 'units'],
  // علبة is any box, carton or tin (علبة شاي, علبة تونة), so it is a sale package, not a can.
  ['زجاجة', 'bottle'], ['زجاجات', 'bottle'], ['علبة', 'pack'], ['علب', 'pack'],
  ['رغيف', 'loaf'], ['أرغفة', 'loaf'], ['كيس', 'bag'], ['أكياس', 'bag']
]);
const DUAL_UNITS = new Map([
  ['لتران', 'l'], ['لترين', 'l'], ['ليتران', 'l'], ['ليترين', 'l'],
  ['كيلوان', 'kg'], ['كيلوين', 'kg'], ['كيلوغرامان', 'kg'], ['كيلوغرامين', 'kg'],
  ['علبتان', 'pack'], ['علبتين', 'pack'], ['زجاجتان', 'bottle'], ['زجاجتين', 'bottle'],
  ['كيسان', 'bag'], ['كيسين', 'bag'], ['رغيفان', 'loaf'], ['رغيفين', 'loaf']
]);
const WORD_AMOUNTS = new Map([
  ['zero', 0], ['אפס', 0], ['half a', 0.5], ['half an', 0.5], ['half', 0.5], ['חצי', 0.5],
  ['a', 1], ['an', 1], ['one', 1], ['אחד', 1], ['אחת', 1],
  ['two', 2], ['שני', 2], ['שתי', 2], ['שניים', 2], ['שתיים', 2],
  ['three', 3], ['שלושה', 3], ['שלוש', 3], ['four', 4], ['ארבעה', 4], ['ארבע', 4],
  ['five', 5], ['חמישה', 5], ['חמש', 5], ['six', 6], ['שישה', 6], ['שש', 6],
  ['seven', 7], ['שבעה', 7], ['שבע', 7], ['eight', 8], ['שמונה', 8],
  ['nine', 9], ['תשעה', 9], ['תשע', 9], ['ten', 10], ['עשרה', 10], ['עשר', 10],
  ['eleven', 11], ['twelve', 12], ['a dozen', 12], ['dozen', 12], ['תריסר', 12],
  ['نص', 0.5], ['نصف', 0.5], ['واحد', 1], ['واحدة', 1],
  ['اثنين', 2], ['اثنان', 2], ['إثنين', 2], ['تنين', 2],
  ['ثلاث', 3], ['ثلاثة', 3], ['تلات', 3], ['تلاتة', 3], ['أربع', 4], ['أربعة', 4], ['اربع', 4], ['اربعة', 4],
  ['خمس', 5], ['خمسة', 5], ['ست', 6], ['ستة', 6], ['سبع', 7], ['سبعة', 7],
  ['ثماني', 8], ['ثمانية', 8], ['تماني', 8], ['تمانية', 8], ['تسع', 9], ['تسعة', 9],
  ['عشر', 10], ['عشرة', 10], ['دزينة', 12]
]);
// "ליטר וחצי", "2 kilos and a half", "كيلو ونص": the half after a unit adds 0.5.
// The joined "and" may already be blanked by withoutJoinedAnd.
const HALF_SUFFIX = /^\s*(?:ו?\s*חצי|and\s+a\s+half|و?\s*نصف?)(?![\p{L}\p{M}])/iu;
const UNIT_TOKEN = /[\p{L}\p{M}][\p{L}\p{M}'׳"״.]*/gu;
const AMOUNT_WORDS = [...WORD_AMOUNTS.keys()].sort((a, b) => b.length - a.length).join('|').replace(/ /g, '\\s+');
const AMOUNT_NUMBER = String.raw`[+−-]?(?:${DIGIT}+(?:\s+${DIGIT}+)?\s*\/\s*${DIGIT}+|${DECIMAL})`;
const UNIT_LABEL = String.raw`[\p{L}'׳"״.]+`;
const AMOUNT_WITH_LABEL = String.raw`(?:(?<number>${AMOUNT_NUMBER})\s*|(?<word>${AMOUNT_WORDS})\s+)(?<unit>${UNIT_LABEL})`;
const AMOUNT_PREFIX = new RegExp(String.raw`^\s*(?:another\s+|(?:ו[-־]?|و)(?=\p{N}))?${AMOUNT_WITH_LABEL}`, 'iu');
const LABELED_AMOUNT = new RegExp(String.raw`(?<![\p{L}\p{N}.,/])${AMOUNT_WITH_LABEL}`, 'giu');
const RANGE_BOUND = String.raw`(?:${AMOUNT_NUMBER}|${AMOUNT_WORDS})`;
const RANGE_AMOUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,/])(?:(?<between>between|בין)\s+)?(?<minimum>${RANGE_BOUND})` +
  String.raw`(?:\s*(?<firstUnit>(?![ול][-־])${UNIT_LABEL}))?\s*(?<connector>[-‐‑‒–—−־]|to|and|עד|ל[-־]|ו[-־]?)` +
  String.raw`\s*(?<maximum>${RANGE_BOUND})\s*(?<lastUnit>${UNIT_LABEL})`,
  'giu'
);
const DUAL_PREFIX = new RegExp(String.raw`^\s*(?<dual>${[...DUAL_UNITS.keys()].join('|')})(?!\p{L})`, 'u');
const MEASURE_WORDING = String.raw`(?:${AMOUNT_NUMBER}\s*|(?:${AMOUNT_WORDS})\s+)${UNIT_LABEL}`;
const MULTIPLIED_SIZE = new RegExp(String.raw`^\s*[x×*]\s*(?<size>${MEASURE_WORDING})`, 'iu');
const POSTFIX_SIZE = new RegExp(String.raw`(?<![\p{L}\p{N}.,/])(?<size>${MEASURE_WORDING})\s+(?:each|per\s+(?:${UNIT_LABEL})|כל אחד|لكل\s+(?:${UNIT_LABEL}))(?!\p{L})`, 'giu');
const NEGATING_PREFIX = /(?<!\p{L})(?:not|לא|غير)\s+$/iu;
export const REQUEST_UNITS = ['l', 'ml', 'kg', 'g', 'units', 'unspecified', ...CONTAINER_UNITS];

const canonical = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const words = value => value.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
const hasWords = (text, phrase) => ` ${words(canonical(text)).join(' ')} `.includes(` ${words(canonical(phrase)).join(' ')} `);
const sourceUnit = unit => ARABIC_UNITS.get(canonical(unit)) ?? unit;
const parseSourceUnit = unit => unit && parseUnit(sourceUnit(unit));
const normalizeSourceAmount = (amount, unit) => normalizeAmount(amount, sourceUnit(unit));

function normalizeNumericText(text) {
  return text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) % 16)).replace(/٫/gu, '.');
}

const isAmountWord = word => WORD_AMOUNTS.has(word) || DUAL_UNITS.has(word);

/** A number word, a dual like "علبتين", or a unit word, with or without a joined "and" (ו, و). */
function isQuantityWord(word) {
  const value = canonical(word);
  if (isAmountWord(value) || parseSourceUnit(word)) return true;
  const rest = value.replace(/^(?:ו|و)/u, '');
  return rest !== value && rest.length > 1 && (isAmountWord(rest) || Boolean(parseSourceUnit(rest)));
}

/**
 * Blank the "and" joined to an amount ("וחצי קילו", "וקילו", "و٢") so amount patterns see the
 * amount itself. Same length, so positions in the text stay valid.
 */
function withoutJoinedAnd(text) {
  return text.replace(/(?<![\p{L}\p{M}\p{N}])(?:ו|و)[-־ـ]?(?=(\p{N}|[\p{L}\p{M}][\p{L}\p{M}'׳"״.]*))/gu, (prefix, next) =>
    /\p{N}/u.test(next) || isQuantityWord(next) && !parseSourceUnit(prefix + next) && !isAmountWord(canonical(prefix + next))
      ? ' '.repeat(prefix.length) : prefix);
}

/**
 * A unit word written without a number ("קילו עגבניות", "חלב ליטר", "بدي لتر حليب").
 * Words in the product name or a recorded qualifier do not count. Short aliases such as
 * "לי" (also "me") are ignored.
 */
function bareUnit(source, item, identity) {
  const covered = [identity, ...item.constraintEvidence.map(evidence => evidencePosition(item.sourceText, evidence.sourceText))]
    .filter(Boolean);
  for (const token of source.matchAll(UNIT_TOKEN)) {
    const start = token.index;
    const end = start + token[0].length;
    if (covered.some(span => start < span.end && end > span.start)) continue;
    if (new RegExp(String.raw`${DIGIT}\s*$`, 'u').test(source.slice(0, start))) continue;
    const label = token[0].replace(/[.]+$/u, '');
    if (label.length < 3 || canonical(label) === 'each' || !parseSourceUnit(label)) continue;
    return { text: label, start, end: start + label.length };
  }
  return null;
}

function assertGap(text, position, leading) {
  const gap = leading ? text.replace(SHOPPING_INTRO, '').replace(SHOPPING_LIST_INTRO, '') : text;
  const unexpected = words(gap).find(word => !SEPARATOR.test(word) && !(leading && LEAD_IN.test(word)));
  if (unexpected) throw new Error(`Shopping item coverage leaves ${JSON.stringify(unexpected)} unassigned near character ${position + 1}.`);
  if (/[%٪]/u.test(text)) throw new Error(`Shopping item coverage leaves a percentage sign unassigned near character ${position + 1}.`);
}

function itemSpans(request, items) {
  let end = 0;
  const spans = items.map((item, index) => {
    if (typeof item?.sourceText !== 'string' || !item.sourceText.trim() || item.sourceText !== item.sourceText.trim()) {
      throw new Error(`Item ${index + 1} needs a verbatim sourceText span.`);
    }
    const start = request.indexOf(item.sourceText, end);
    if (start === -1) throw new Error(`Item ${index + 1} sourceText does not appear in the request in order.`);
    const gap = request.slice(end, start);
    if (index === 0 || !CHOICE_GAP.test(gap)) {
      assertGap(gap.replace(/(?:^|\s)either\s*$/iu, ''), end, index === 0);
    }
    end = start + item.sourceText.length;
    return { start, end, gap };
  });
  assertGap(request.slice(end), end, false);
  for (let index = 1; index < spans.length; index++) {
    const { gap } = spans[index];
    if (!CHOICE_GAP.test(gap)) continue;
    let first = spans[index - 1].choiceStart ?? index - 1;
    // An Oxford comma marks the preceding comma-delimited items as alternatives too.
    if (/^\s*[,،]/u.test(gap)) {
      while (first > 0 && COMMA_GAP.test(spans[first].gap)) {
        first = spans[first - 1].choiceStart ?? first - 1;
      }
    }
    for (let member = first; member <= index; member++) spans[member].choiceStart = first;
  }
  for (let index = 1; index < spans.length; index++) {
    if (spans[index - 1].choiceStart !== spans[index].choiceStart &&
        CONJUNCTION_GAP.test(spans[index].gap)) {
      throw new Error('Please clarify which items are alternatives and which are required. You can write "milk or oat milk, and eggs".');
    }
  }
  return spans.map(({ start, end: finish, choiceStart }) => ({
    start, end: finish, choiceGroup: choiceStart === undefined ? undefined : `choice-${choiceStart}`
  }));
}

function scopeAt(source, start, end) {
  const before = source.slice(0, start).split(/[,،;؛\n]/u);
  const previous = before.at(-1);
  // Allow punctuation in "preferably, gluten-free" without extending a
  // preference like "preferably Tnuva, gluten-free" into the next clause.
  const preceding = before.at(-2) ?? '';
  const trailingCue = [...preceding.matchAll(OPTIONAL_CUE)].at(-1);
  const scope = !previous.trim() && trailingCue && trailingCue.index + trailingCue[0].length === preceding.trimEnd().length
    ? trailingCue[0] : previous;
  const optional = [...scope.matchAll(OPTIONAL_CUE)].at(-1)?.index ?? -1;
  const mandatory = [...scope.matchAll(MANDATORY_CUE)].at(-1)?.index ?? -1;
  if (optional > mandatory) return 'PREFERENCE';
  const after = source.slice(end);
  if (mandatory === -1 && /^\s*(?:[,،]\s*)?(?:preferred|if (?:(?:it(?:'s| is) )?(?:possible|available))|עדיף|אם אפשר|مفضل)(?=\s*(?:[,،;؛.!?]|$))/iu.test(after)) return 'PREFERENCE';
  return mandatory !== -1 ? 'REQUIREMENT' : null;
}

function explicitQualifiers(source) {
  return QUALIFIERS.flatMap(pattern => [...source.matchAll(pattern)].map(match => {
    const start = source.slice(0, match.index).match(NEGATING_PREFIX)?.index ?? match.index;
    const end = match.index + match[0].length;
    return { text: source.slice(start, end), start, end };
  }));
}

function hardValues(source) {
  return [...source.matchAll(HARD_VALUE)].map(match => ({
    text: match[1].trim().replace(/[.]+$/u, ''),
    start: match.index + match[0].length - match[1].length,
    end: match.index + match[0].length
  })).filter(claim => claim.text);
}

function evidencePosition(source, phrase) {
  let start = source.indexOf(phrase);
  while (start !== -1) {
    const end = start + phrase.length;
    // A word-length match prevents a claim like "salted" being grounded by
    // the suffix of "unsalted" or "3%" by the suffix of "13%".
    if (!continuesWord(source[start - 1], phrase[0]) && !continuesWord(phrase.at(-1), source[end])) return { start, end };
    start = source.indexOf(phrase, start + 1);
  }
  return null;
}

function continuesWord(a = '', b = '') {
  return /\p{L}/u.test(a) && /\p{L}/u.test(b) || /\p{N}/u.test(a) && /\p{N}/u.test(b);
}

export function assertProductPhrase(item, index) {
  const phrase = typeof item.product === 'string' ? item.product.trim() : '';
  const product = /\p{L}/u.test(phrase) && evidencePosition(item.sourceText, phrase);
  if (!product) throw new Error(`items[${index}].product must be a complete product phrase copied from sourceText.`);

  const source = item.sourceText;
  const covered = [product, ...item.constraintEvidence.map(evidence => evidencePosition(source, evidence.sourceText))];
  const range = requestedRange(source);
  if (range) {
    const { lastUnit } = range.groups;
    const end = range.index + range[0].length - (parseSourceUnit(lastUnit) ? 0 : lastUnit.length);
    covered.push({ start: range.index, end });
  }
  const boundaries = [...source.matchAll(ITEM_SEPARATOR)];
  let start = 0;
  for (const boundary of [...boundaries, { index: source.length, 0: '' }]) {
    const end = boundary.index;
    let detail = source.slice(start, end);
    for (const span of covered) {
      const left = Math.max(start, span.start) - start;
      const right = Math.min(end, span.end) - start;
      if (left < right) detail = detail.slice(0, left) + ' '.repeat(right - left) + detail.slice(right);
    }
    const remainder = words(detail.replace(/^\s*either\b/iu, '')
      .replace(/(?<!\p{L})(?:ו|و)[-־ـ]?(?=\p{N})/gu, '')
      .replace(OPTIONAL_CUE, ' ').replace(MANDATORY_CUE, ' '));
    if (remainder.some(word => /\p{L}/u.test(word) && !DETAIL_WORD.test(word) && !SEPARATOR.test(word) &&
        !isQuantityWord(word) && !LEAD_IN.test(word))) {
      throw new Error(`Item ${index + 1} has unassigned product or qualifier wording: ${JSON.stringify(detail.trim())}. Verify each product has its own item and all attributes are recorded.`);
    }
    start = end + boundary[0].length;
  }
}

function numericAmount(number) {
  number = normalizeNumericText(number);
  const fraction = number.match(/^([+−-]?)(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/u);
  if (!fraction) return Number(number.replace(',', '.').replace('−', '-'));
  const [, sign, whole, numerator, denominator] = fraction;
  const amount = Number(whole ?? 0) + Number(numerator) / Number(denominator);
  return sign === '-' || sign === '−' ? -amount : amount;
}

function requestedRange(source) {
  return [...source.matchAll(RANGE_AMOUNT)].find(match => {
    const { between, connector, firstUnit, lastUnit } = match.groups;
    if (!between && /^(?:and|ו[-־]?)$/iu.test(connector)) return false;
    if (firstUnit) return Boolean(parseSourceUnit(firstUnit) && parseSourceUnit(lastUnit));
    return true;
  });
}

function boundAmount(text) {
  if (/^[1-9]\d{0,2},\d{3}$/u.test(normalizeNumericText(text))) return NaN;
  return WORD_AMOUNTS.get(canonical(text)) ?? numericAmount(text);
}

function assertQuantityRange(range, quantity, index) {
  const { minimum, maximum, firstUnit, lastUnit } = range.groups;
  const endUnit = parseSourceUnit(lastUnit) ? sourceUnit(lastUnit) : 'units';
  const min = normalizeSourceAmount(boundAmount(minimum), firstUnit ?? endUnit);
  const max = normalizeAmount(boundAmount(maximum), endUnit);
  const actualMin = normalizeAmount(quantity?.amount, quantity?.unit);
  const actualMax = normalizeAmount(quantity?.maxAmount, quantity?.unit);
  const container = containerType(endUnit);
  const countUnit = container ?? (max?.family === 'count' ? 'units' : null);
  if (!min || !max || min.family !== max.family || min.amountBase > max.amountBase ||
      actualMin?.family !== min.family || actualMin.amountBase !== min.amountBase ||
      actualMax?.family !== max.family || actualMax.amountBase !== max.amountBase ||
      (countUnit && quantity.unit !== countUnit) ||
      (firstUnit && containerType(sourceUnit(firstUnit)) !== container)) {
    throw new Error(`Item ${index + 1} must preserve the requested quantity range ${JSON.stringify(range[0].trim())} with the lower amount and the upper maxAmount.`);
  }
}

function assertComponentSize(item, unit, followingText, index) {
  if (!unit) return;
  const sizes = [MULTIPLIED_SIZE.exec(followingText), ...followingText.matchAll(POSTFIX_SIZE)]
    .filter(Boolean).map(match => match.groups.size.replace(/[.]+$/u, ''));
  for (const size of sizes) {
    if (!item.constraintEvidence.some(evidence => evidence.type === 'REQUIREMENT' && evidence.sourceText === size)) {
      throw new Error(`Item ${index + 1} omits the required size per ${unit}: ${JSON.stringify(size)}.`);
    }
  }
}

export function assertRequestedQuantity(item, index) {
  const original = item.sourceText;
  const range = requestedRange(original);
  if (range) {
    assertQuantityRange(range, item.quantity, index);
    assertComponentSize(item, containerType(sourceUnit(range.groups.lastUnit)),
      original.slice(range.index + range[0].length), index);
    return;
  }
  if (item.quantity?.maxAmount !== undefined) {
    throw new Error(`Item ${index + 1} has a quantity range that wasn't specified in the request.`);
  }
  const source = withoutJoinedAnd(original);
  const actual = normalizeAmount(item.quantity?.amount, item.quantity?.unit);
  const unspecified = item.quantity?.amount === 0;
  const dual = DUAL_PREFIX.exec(source)?.groups.dual;
  if (dual) {
    const dualUnit = DUAL_UNITS.get(dual);
    const expected = normalizeAmount(2, dualUnit);
    const container = containerType(dualUnit);
    if (actual?.family !== expected.family || actual.amountBase !== expected.amountBase ||
        (container && item.quantity.unit !== container)) {
      throw new Error(`Item ${index + 1} changes the explicit quantity ${JSON.stringify(dual)}.${quantityHint(2, dualUnit)}`);
    }
    return;
  }
  const identity = typeof item.product === 'string' && evidencePosition(original, item.product.trim());
  const prefix = AMOUNT_PREFIX.exec(source);
  const prefixAmount = prefix?.groups.number ?? prefix?.groups.word;
  const bareCount = prefix && !/^(?:a|an)$/iu.test(prefixAmount) &&
    (!identity || identity.start >= prefix[0].indexOf(prefixAmount) + prefixAmount.length);
  const overlapsQualifier = match => item.constraintEvidence.some(evidence => {
    const span = evidencePosition(original, evidence.sourceText);
    return span && match.index >= span.start && match.index + match[0].trimEnd().length <= span.end;
  });
  const match = prefix && (parseSourceUnit(prefix.groups.unit) || bareCount) ? prefix
    : [...source.matchAll(LABELED_AMOUNT)].find(candidate =>
      parseSourceUnit(candidate.groups.unit) &&
      !overlapsQualifier(candidate));
  if (!match) {
    const bare = bareUnit(source, item, identity);
    if (bare) {
      assertBareUnit(item, source, bare, { actual, unspecified }, index);
      return;
    }
    if (!unspecified) {
      throw new Error(`Item ${index + 1} has a quantity that wasn't specified in the request.`);
    }
    return;
  }
  const { number, word } = match.groups;
  const amountText = number ?? word;
  const explicitUnit = parseSourceUnit(match.groups.unit);
  // An audit has no product field to distinguish a bare count from "7 Up".
  if (!explicitUnit && !identity) return;
  const end = match.index + match[0].length;
  const half = explicitUnit ? HALF_SUFFIX.exec(source.slice(end)) : null;
  const amount = (number ? numericAmount(number) : WORD_AMOUNTS.get(canonical(word))) + (half ? 0.5 : 0);
  const unit = containerType(sourceUnit(match.groups.unit));
  const expected = normalizeSourceAmount(amount, explicitUnit ? match.groups.unit : 'units');
  // "a box of tea" or "a bottle of water": one package is what an unspecified amount buys anyway.
  const oneContainer = unit && amount === 1 && unspecified;
  if (!oneContainer && (!expected || actual?.family !== expected.family || actual?.amountBase !== expected.amountBase ||
      (unit && item.quantity.unit !== unit))) {
    const written = explicitUnit ? original.slice(match.index, end + (half ? half[0].length : 0)).trim() : amountText;
    throw new Error(`Item ${index + 1} changes the explicit quantity ${JSON.stringify(written)}.${quantityHint(amount, explicitUnit ? match.groups.unit : 'units')}`);
  }

  assertComponentSize(item, unit, source.slice(end + (half ? half[0].length : 0)), index);
}

/** The quantity the wording states, so the agent can correct its call in one retry. */
function quantityHint(amount, unit) {
  const shopUnit = containerType(sourceUnit(unit)) ?? parseSourceUnit(unit)?.aliases[0];
  return shopUnit && Number.isFinite(amount) ? ` Use amount ${amount}, unit "${shopUnit}".` : '';
}

/** A unit word without a number means one of it, or one and a half with "וחצי" after it. */
function assertBareUnit(item, source, bare, { actual, unspecified }, index) {
  const half = HALF_SUFFIX.exec(source.slice(bare.end));
  const end = bare.end + (half ? half[0].length : 0);
  const unit = sourceUnit(bare.text);
  const container = containerType(unit);
  // A container or count word may be plural ("bottles of water", "علب تونة"), so no amount is fine too.
  // A measure word is singular in practice: "קילו עגבניות" is one kilo, as "a kilo" is.
  if (unspecified && !half && parseSourceUnit(bare.text)?.family === 'count') {
    assertComponentSize(item, container, source.slice(end), index);
    return;
  }
  const expected = normalizeAmount(half ? 1.5 : 1, unit);
  if (!expected || actual?.family !== expected.family || actual.amountBase !== expected.amountBase ||
      (container && item.quantity.unit !== container)) {
    throw new Error(`Item ${index + 1} changes the explicit quantity ${JSON.stringify(item.sourceText.slice(bare.start, end).trim())}.${quantityHint(half ? 1.5 : 1, unit)}`);
  }
  assertComponentSize(item, container, source.slice(end), index);
}

export function assertGroceryRequest(request) {
  const text = request.trim();
  const cookingOnly = (ENGLISH_COOKING_GOAL.test(text) || HEBREW_COOKING_GOAL.test(text)) &&
    !SHOPPING_LIST_INTRO.test(text) && !ADDED_SHOPPING_CLAUSE.test(text);
  if (UNSPECIFIED_MEAL.test(text) || cookingOnly) {
    throw new Error('Please list the groceries you want to buy for this meal. You can leave out quantities, brands, and preferences.');
  }
}

function includesQualifier(value, text) {
  if (/[%٪]/u.test(text)) {
    const percent = word => normalizeNumericText(canonical(word)).replace(/\s+/gu, '').replace(/,/gu, '.').replace(/٪/gu, '%');
    return explicitQualifiers(value).some(claim => percent(claim.text) === percent(text));
  }
  return hasWords(value, text);
}

function assertExplicitQualifiers(item, index, constraints) {
  const source = item.sourceText;
  for (const { groups } of source.matchAll(PERCENT_PAIR)) {
    const { left, right, firstAttribute, lastAttribute } = groups;
    if ((!firstAttribute || canonical(firstAttribute) === canonical(lastAttribute)) &&
        numericAmount(left) !== numericAmount(right)) {
      throw new Error(`Item ${index + 1} has conflicting ${lastAttribute} percentages. Please specify one percentage.`);
    }
  }
  for (const claim of explicitQualifiers(source)) {
    const type = scopeAt(source, claim.start, claim.end) ?? 'REQUIREMENT';
    if (!constraints.some(({ evidence, start, end }) => evidence.type === type && start <= claim.start && end >= claim.end)) {
      throw new Error(`Item ${index + 1} omits or misclassifies ${JSON.stringify(claim.text)} as a ${type.toLowerCase()}.`);
    }
  }
  for (const claim of hardValues(source)) {
    const qualifiers = constraints.filter(({ start, end }) => start === claim.start && end <= claim.end);
    if (!qualifiers.some(({ evidence }) => evidence.type === 'REQUIREMENT')) {
      throw new Error(`Item ${index + 1} omits the mandatory qualifier following an exclusivity cue: ${JSON.stringify(claim.text)}.`);
    }
  }
  for (const cue of source.matchAll(OPTIONAL_CUE)) {
    const before = source.slice(0, cue.index).split(/[,،;؛\n]/u).at(-1);
    const after = source.slice(cue.index + cue[0].length).replace(/^\s*[,،]\s*/u, '').split(/[,،;؛\n]/u)[0];
    if (!constraints.some(({ evidence }) => evidence.type === 'PREFERENCE' &&
        (after.includes(evidence.sourceText) || before.includes(evidence.sourceText)))) {
      throw new Error(`Item ${index + 1} omits the preference associated with ${JSON.stringify(cue[0])}.`);
    }
  }
}

/**
 * List shopping details in free text: explicit qualifiers, preference cues,
 * exclusivity claims ("only Tnuva") and numbers. The web agent uses this to
 * detect wording left next to an extracted request span.
 */
export function shoppingDetailsIn(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const numbers = new RegExp(String.raw`${DECIMAL}\s*[%٪]?`, 'gu');
  return [
    ...explicitQualifiers(text).map(claim => ({ kind: 'QUALIFIER', text: claim.text })),
    ...hardValues(text).map(claim => ({ kind: 'EXCLUSIVE', text: claim.text })),
    ...[...text.matchAll(OPTIONAL_CUE)].map(match => ({ kind: 'PREFERENCE_CUE', text: match[0] })),
    ...[...text.matchAll(numbers)].map(match => ({ kind: 'NUMBER', text: match[0].trim() }))
  ];
}

export function validateRequestEvidence(request, items) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('Expected the original shopping request text.');
  const spans = itemSpans(request, items);
  const specifiedChoices = new Map();
  return items.map((item, index) => {
    if (!Array.isArray(item.constraintEvidence)) throw new Error(`Item ${index + 1} needs a constraintEvidence array.`);
    const seen = new Set();
    const constraints = item.constraintEvidence.map(evidence => {
      if (!evidence || !['REQUIREMENT', 'PREFERENCE'].includes(evidence.type) ||
          !['BRAND', 'OTHER'].includes(evidence.kind) || typeof evidence.sourceText !== 'string' ||
          !evidence.sourceText.trim() || evidence.sourceText.trim() !== evidence.sourceText) {
        throw new Error(`Item ${index + 1} has invalid constraint evidence.`);
      }
      const span = evidencePosition(item.sourceText, evidence.sourceText);
      if (!span) throw new Error(`Item ${index + 1} qualifier ${JSON.stringify(evidence.sourceText)} is outside its sourceText.`);
      const key = canonical(evidence.sourceText);
      if (seen.has(key)) throw new Error(`Item ${index + 1} repeats qualifier ${JSON.stringify(evidence.sourceText)}.`);
      if (NEGATING_PREFIX.test(item.sourceText.slice(0, span.start))) {
        throw new Error(`Item ${index + 1} qualifier ${JSON.stringify(evidence.sourceText)} drops the negation before it.`);
      }
      const scopedType = scopeAt(item.sourceText, span.start, span.end);
      if (scopedType && evidence.type !== scopedType) {
        throw new Error(`Item ${index + 1} misclassifies explicit qualifier ${JSON.stringify(evidence.sourceText)}.`);
      }
      seen.add(key);
      return { ...span, evidence: { type: evidence.type, kind: evidence.kind, sourceText: evidence.sourceText, value: evidence.sourceText } };
    });
    assertExplicitQualifiers(item, index, constraints);
    if (/\banother\b.*\bthe\s+same\b/iu.test(item.sourceText)) {
      const previous = items[index - 1];
      const missingConstraint = previous?.constraintEvidence.some(prior =>
        !constraints.some(({ evidence }) =>
          evidence.type === prior.type && evidence.kind === prior.kind &&
          canonical(evidence.sourceText) === canonical(prior.sourceText)));
      if (!previous || missingConstraint ||
          (previous.product && item.product && canonical(previous.product) !== canonical(item.product))) {
        throw new Error(`Item ${index + 1} refers to an earlier item. Please list its product and constraints explicitly.`);
      }
    }
    for (const { index: start, 0: connector } of item.sourceText.matchAll(CHOICE_WORD)) {
      const end = start + connector.length;
      const before = constraints.find(span => span.end <= start && !item.sourceText.slice(span.end, start).trim());
      const after = constraints.find(span => span.start >= end && !item.sourceText.slice(end, span.start).trim());
      const qualifierChoice = before && after && before.evidence.type === after.evidence.type &&
        before.evidence.kind === after.evidence.kind;
      if (!constraints.some(span => span.start <= start && span.end >= end) && !qualifierChoice) {
        throw new Error(`Item ${index + 1} combines alternatives. Put each named product in its own item and leave "or" between their sourceText spans.`);
      }
    }
    const { choiceGroup } = spans[index];
    if (choiceGroup) {
      const specified = item.quantity?.amount > 0;
      if (specifiedChoices.has(choiceGroup) && specifiedChoices.get(choiceGroup) !== specified) {
        throw new Error('Specify the quantity for each alternative or leave the amounts unspecified for all of them.');
      }
      specifiedChoices.set(choiceGroup, specified);
    }
    for (const { evidence, start, end } of constraints) {
      if (evidence.type === 'PREFERENCE' && !scopeAt(item.sourceText, start, end)) {
        throw new Error(`Item ${index + 1} marks ${JSON.stringify(evidence.sourceText)} optional without preference wording.`);
      }
    }
    return {
      ...spans[index], constraints,
      requirements: constraints.filter(x => x.evidence.type === 'REQUIREMENT').map(x => x.evidence.value),
      preferences: constraints.filter(x => x.evidence.type === 'PREFERENCE').map(x => x.evidence.value)
    };
  });
}

function legacyItemForClaim(request, items, claim) {
  if (items.length === 1) return items[0];
  const leading = request.slice(0, claim.start).split(/[,;\n]|\band\b/iu);
  const trailing = request.slice(claim.end).split(/[,;\n]|\band\b/iu);
  const clause = `${leading.at(-1) ?? ''} ${claim.text} ${trailing[0] ?? ''}`;
  const candidates = items.filter(item => typeof item.product === 'string' && hasWords(clause, item.product));
  if (candidates.length === 1) return candidates[0];
  const previousClause = leading.at(-2) ?? '';
  const previous = items.filter(item => typeof item.product === 'string' && hasWords(previousClause, item.product));
  return !candidates.length && previous.length === 1 ? previous[0] : null;
}

function assertLegacyCoverage(request, items) {
  if (requestedRange(request) || [...request.matchAll(CHOICE_WORD)].length) {
    throw new Error('Regenerate shopping-request.json to verify quantity ranges and alternatives against the original request.');
  }
  const claims = [...explicitQualifiers(request), ...hardValues(request).map(claim => ({ ...claim, type: 'REQUIREMENT' }))];
  for (const claim of claims) {
    const type = claim.type ?? scopeAt(request, claim.start, claim.end) ?? 'REQUIREMENT';
    const item = legacyItemForClaim(request, items, claim);
    const field = type === 'REQUIREMENT' ? 'requirements' : 'preferences';
    // Earlier plans could represent a physical form in the product identity.
    const isLegacyForm = /^(?:shredded|grated|sliced|powdered|diced|minced|boneless|skinless|seedless|מגורד(?:ת|ים|ות)?|מגורר(?:ת|ים|ות)?|פרוס(?:ה|ים|ות)?)$/iu.test(claim.text);
    const values = Array.isArray(item?.[field]) ? [...item[field]] : [];
    if (type === 'REQUIREMENT' && isLegacyForm && item?.product) values.push(item.product);
    if (!values.some(value => typeof value === 'string' && (includesQualifier(value, claim.text) ||
        (claim.type === 'REQUIREMENT' && hasWords(claim.text, value.replace(/^(?:only|exclusively|רק)\s+/iu, '')))))) {
      throw new Error(`Saved shopping plan does not account for ${JSON.stringify(claim.text)} as a ${type.toLowerCase()}. Regenerate shopping-request.json from the original request.`);
    }
  }
}

function equalStrings(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
}

export function assertShoppingPlanCoverage(plan) {
  if (!Array.isArray(plan?.items) || !plan.items.length || plan.items.some(item => !item || typeof item !== 'object')) {
    throw new Error('Expected a shopping plan with a nonempty items array.');
  }
  const { items, userRequest } = plan;
  if (typeof userRequest === 'string') assertGroceryRequest(userRequest);
  if (!items.some(item => item.sourceText !== undefined || item.constraintEvidence !== undefined)) {
    if (typeof userRequest === 'string') assertLegacyCoverage(userRequest, items);
    return plan;
  }
  validateRequestEvidence(userRequest, items).forEach((coverage, index) => {
    const item = items[index];
    if (!equalStrings(item.requirements, coverage.requirements) || !equalStrings(item.preferences, coverage.preferences) ||
        coverage.constraints.some(({ evidence }, i) => evidence.value !== item.constraintEvidence[i].value)) {
      throw new Error(`Saved shopping item ${index + 1} has inconsistent requirements, preferences, or source evidence.`);
    }
    if (item.choiceGroup !== coverage.choiceGroup) {
      throw new Error(`Saved shopping item ${index + 1} has an inconsistent alternative group.`);
    }
    assertProductPhrase(item, index);
    assertRequestedQuantity(item, index);
  });
  return plan;
}
