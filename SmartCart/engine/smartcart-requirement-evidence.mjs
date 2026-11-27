import { corroborateUnitSize, countsPackages, interpretPackage, normalizeAmount, parseUnit } from './smartcart-package.mjs';

// Catalog names can corroborate explicit label claims. A missing label gives no evidence.
const labels = [
  ['lactose-free', /lactose[- ]free|(?:no|zero|without) lactose|ללא לקטוז|נטול(?:ת)? לקטוז|خال(?:ي(?:ة)?)? من اللاكتوز|بدون لاكتوز/iu, 'contains lactose'],
  ['contains lactose', /(?:contains?|with) lactose|(?:מכיל(?:ה)?|עם) לקטוז/iu, 'lactose-free'],
  ['gluten-free', /gluten[- ]free|(?:no|zero|without) gluten|ללא גלוטן|נטול(?:ת)? גלוטן|خال(?:ي(?:ة)?)? من (?:الغلوتين|الجلوتين)|بدون (?:غلوتين|جلوتين)/iu, 'contains gluten'],
  ['contains gluten', /(?:contains?|with) gluten|(?:מכיל(?:ה)?|עם) גלוטן/iu, 'gluten-free'],
  ['sugar-free', /sugar[- ]free|(?:no|zero|without) sugar(?!\s+added)|(?:ללא|נטול(?:ת)?) סוכר(?!\s+מוסף)/iu, 'contains sugar'],
  ['no added sugar', /no added sugar|no sugar added|without added sugar|unsweetened|ללא תוספת סוכר|ללא סוכר מוסף|לא ממותק(?:ת)?/iu, 'contains added sugar'],
  ['contains sugar', /(?:contains?|with) sugar|(?:מכיל(?:ה)?|עם) סוכר/iu, 'sugar-free'],
  ['contains added sugar', /(?:contains?|with) added sugar|(?:מכיל(?:ה)?|עם) תוספת סוכר/iu, 'no added sugar'],
  ['unsalted', /unsalted|not salted|(?:no|zero|without) salt|ללא (?:תוספת )?מלח|נטול(?:ת)? מלח|לא מלוח(?:ה)?/iu, 'salted'],
  ['salted', /salted|with salt|מלוח(?:ה)?|עם מלח/iu, 'unsalted'],
  ['shredded', /shredded|grated|מגורד(?:ת|ות|ים)?|פתיתי\s+(?:גבינת\s+)?מוצרלה|مبشور(?:ة)?/iu, 'unshredded'],
  ['unshredded', /unshredded|(?:cheese|mozzarella) (?:block|slices?|sticks?)|גוש|פרוס(?:ה|ות|ים)?|מקלוני(?:ם)?/iu, 'shredded'],
  ['sliced', /sliced|פרוס(?:ה|ות|ים)?/iu, 'unsliced'],
  ['unsliced', /unsliced|not sliced|לא פרוס(?:ה|ות|ים)?/iu, 'sliced'],
  ['diced', /diced|חתוך(?:ה)? לקוביות|קוביות/iu],
  ['organic', /organic|אורגני(?:ת|ים|ות)?/iu, 'non-organic'],
  ['non-organic', /(?:non[- ]|not )organic|לא אורגני(?:ת|ים|ות)?/iu, 'organic'],
  ['free range', /free[- ]range|ביצי(?:ם)? חופש|גידול חופשי/iu, 'cage-raised'],
  ['cage-raised', /cage[- ]raised|raised in cages|גידול בכלובים/iu, 'free range'],
  ['vegan', /vegan|טבעוני(?:ת|ים|ות)?|نباتي صرف|نباتية صرفة/iu, 'non-vegan'],
  ['non-vegan', /non[- ]vegan|not vegan|לא טבעוני(?:ת|ים|ות)?|(?:contains?|with) (?:dairy|eggs?)|מכיל(?:ה)? (?:חלב(?!\s+(?:שיבולת|שקדים|סויה|קוקוס|אורז))|ביצים)/iu, 'vegan'],
  ['egg-free', /egg[- ]free|(?:no|without) eggs?|ללא ביצים|בלי ביצים|بدون بيض/iu, 'contains eggs'],
  ['contains eggs', /(?:contains?|with) eggs?|מכיל(?:ה)? ביצים|עם ביצים|يحتوي على البيض/iu, 'egg-free'],
  ['frozen', /frozen|קפוא(?:ה|ים|ות)?|مجمّد|مجمد|مجمدة/iu, 'fresh'],
  ['fresh', /fresh|טרי(?:ה|ים|ות|יה)?|طازج(?:ة)?/iu, 'frozen'],
  ['whole wheat', /whole[- ]wheat(?: flour)?|(?:קמח\s+)?(?:חיטה|חיטת) מלאה/iu]
];

// These are spellings of the same name. Ownership and private-label relationships
// are never inferred from a different brand in the name or manufacturer field.
const brandSpellings = [
  ['tnuva', 'tenuva', 'תנובה', 'تنوفا', 'تنوڤا'],
  ['gad', 'גד'],
  ['tara', 'טרה'],
  ['yotvata', 'יטבתה']
];

const metrics = [
  ['fat', /(?:milk )?fat(?: content)?|שומן|אחוזי שומן|دهون|دسم|نسبة الدسم/iu],
  ['whole wheat', /whole[- ]wheat(?: flour)?|(?:קמח\s+)?(?:חיטה|חיטת) מלאה/iu],
  ['cocoa', /cacao|cocoa|קקאו/iu],
  ['sugar', /sugar|סוכר/iu],
  ['protein', /protein|חלבון/iu],
  ['fiber', /(?:dietary )?fib(?:er|re)|סיבים(?: תזונתיים)?/iu],
  ['salt', /salt|מלח/iu],
  ['sodium', /sodium|נתרן/iu],
  ['water', /water|מים/iu],
  ['fruit', /fruit|פרי|פירות/iu],
  ['alcohol', /alcohol|abv|אלכוהול/iu]
];

const norm = value => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[״“”]/gu, '"').replace(/['’‘]/gu, '׳')
  .replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/gu, digit => String(digit.charCodeAt(0) - 0x06f0))
  .replace(/٪/gu, '%').replace(/٫/gu, '.')
  .replace(/[\p{Cf}\u0591-\u05bd\u05bf-\u05c7]/gu, '').trim();
const whole = (expression, boundary = '\\p{L}\\p{N}') =>
  new RegExp(`(?<![${boundary}])(?:${expression.source})(?![${boundary}])`, 'giu');
const exact = (value, expression) => new RegExp(`^(?:${expression.source})$`, 'iu').test(value);
const literal = value => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
const cleanRequirement = value => norm(value)
  .replace(/^(?:only|must be|brand|manufacturer|רק|בלבד|מותג)\s*:?\s+/u, '')
  .replace(/\s+(?:only|בלבד)$/u, '').replace(/[.!]+$/u, '');

const negatedClaim = /(?:\b(?:not|non|no|without|style of)(?:[-\s]+(?:naturally|certified|necessarily|strictly|actually|truly|entirely|completely|longer))*|(?<!\p{L})(?:לא|ללא|אינו|אינה|אינם|אינן|בסגנון)(?:[-־\s]+(?:בהכרח|באמת|לגמרי))*)[-־\s]+$/u;
const ingredientNames = /(?:coating|crust|filling|ingredients?|flavou?ring|topping|sauce|sweetener|syrup|[במל]?(?:ציפוי|מילוי|תוספת|רכיבים|רוטב))/u;
const ingredientNoun = new RegExp(`(?<!\\p{L})${ingredientNames.source}(?:\\s+of)?\\s+$`, 'u');
const ingredientIntroducer = /(?:\b(?:with|made from|containing)|(?<!\p{L})(?:עם|בתוספת|מכיל(?:ה)?))\s+$/u;
const ingredientAfterClaim = new RegExp(`^\\s+${ingredientNames.source}(?!\\p{L})`, 'u');

function isAsserted(prefix, suffix) {
  return !negatedClaim.test(prefix) && !/^[-\s]+(?:style\b|free\b(?![-\s]+range\b))/u.test(suffix) &&
    !ingredientNoun.test(prefix) &&
    !(ingredientIntroducer.test(prefix) && ingredientAfterClaim.test(suffix));
}

function asserted(text, expression, boundary) {
  return Array.from(text.matchAll(whole(expression, boundary))).find(match => {
    const prefix = text.slice(0, match.index);
    const suffix = text.slice(match.index + match[0].length);
    return isAsserted(prefix, suffix);
  })?.[0];
}

const confirmed = (result, evidence, evidenceSource = 'NAME') => ({ result, evidence, evidenceSource });
const unknown = () => confirmed('UNKNOWN', '', 'NONE');

export function corroborateSizeRequirement(requirement, product, item) {
  if (!item) return null;
  const size = norm(requirement).match(/^(\d+(?:[.,]\d+)?)\s*(\p{L}[\p{L}"'״׳]*)$/u);
  if (!size) return null;
  const [, value, unit] = size;
  const amount = Number(value.replace(',', '.'));
  const normalized = normalizeAmount(amount, unit);
  if (!normalized || normalized.family === 'count') return null;
  // "2 packs of 500 g pasta" or "3 units of 1 l milk": the size is the size of each sale package.
  const plainItem = { ...item, quantity: { amount: 0, unit: 'unspecified' } };
  const perPackage = countsPackages(item.quantity?.unit, interpretPackage(product, plainItem, null).packageAmount,
    product.package?.isWeighted);
  if (!perPackage && parseUnit(item.quantity?.unit)?.family === 'count') {
    return corroborateUnitSize(product, item, amount, unit);
  }
  const reconciled = interpretPackage(product, perPackage ? plainItem : item, normalized);
  const actual = reconciled.packageAmount;
  if (!actual || reconciled.package.isWeighted) return unknown();
  const named = reconciled.packageInterpretation.evidence.find(entry =>
    entry.unit === actual.base && entry.quantity === actual.amountBase);
  return confirmed(actual.amountBase === normalized.amountBase ? 'MET' : 'CONTRADICTED',
    named?.text ?? (product.package.quantity + ' ' + product.package.unit), named ? 'NAME' : 'PACKAGE');
}

const percentages = /(?<![\p{N}.,])(\d+(?:[.,]\d+)?)\s*%/gu;
const percentAmount = value => Number(value[1].replace(',', '.'));
const rangeBefore = /(?:[~≈<≤>≥−-]\s*|\b(?:up to|at most|at least|less than|more than|around|about|over|under|maximum|minimum|max|min|approx(?:imately)?)\s+|(?:^|\s)(?:עד|פחות מ|יותר מ|כ)[-־\s]+|\d\s*%?\s*(?:[-‐‑‒–—−־]|to|or|עד|או)\s*)$/u;
const rangeAfter = /^\s*(?:[-‐‑‒–—−־]|to|or|עד|או)\s*\d/u;
const relativeBefore = /(?:\b(?:reduced by|increased by|lower by|higher by|reduction of|increase of|discount of)|(?<!\p{L})(?:הופחת ב|הפחתה של|הנחה של))\s*$/u;
const relativeAfter = /^\s*(?:less|more|fewer|lower|higher|extra|reduced|reduction|increased|increase|decrease|discount|off|savings|or (?:above|below|more|less)|פחות|יותר|תוספת|הפחתה|הנחה|ומעלה|ומטה|או פחות|או יותר)(?!\p{L})/u;

// A requirement can bound a percentage instead of naming it: "less than 5% fat", "עד 3%",
// "5% שומן ומטה", "أقل من 5%". "No more than" is listed before "more than" so it wins.
const boundBefore = [
  ['<=', /up to|at most|no more than|not more than|maximum(?: of)?|max\.?|<=|≤|לא יותר מ|לכל היותר|מקסימום|עד|لا يزيد عن|بحد أقصى|حتى|لغاية/],
  ['>=', /at least|no less than|not less than|minimum(?: of)?|min\.?|>=|≥|לא פחות מ|לפחות|מינימום|على الأقل|بحد أدنى|لا يقل عن/],
  ['<', /less than|fewer than|lower than|under|below|<|פחות מ|מתחת ל|أقل من|اقل من|تحت/],
  ['>', /more than|greater than|higher than|over|above|>|יותר מ|מעל ל?|أكثر من|اكثر من|فوق/]
];
const boundAfter = [
  ['<=', /or (?:less|lower|below|under)|and (?:less|lower|below|under)|max(?:imum)?|at most|ומטה|או פחות|לכל היותר|מקסימום|فأقل|أو أقل|او اقل|كحد أقصى/],
  ['>=', /or (?:more|higher|above|over)|and (?:more|higher|above|over)|min(?:imum)?|at least|ומעלה|או יותר|לפחות|מינימום|فأكثر|أو أكثر|او اكثر|كحد أدنى/]
];
const compare = { '=': (a, b) => a === b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };

/** The comparison a percentage requirement asks for, and its wording without the bound. */
function percentBound(requirement, target) {
  const before = requirement.slice(0, target.index);
  const after = requirement.slice(target.index + target[0].length);
  for (const [op, cue] of boundBefore) {
    const found = before.match(new RegExp(`(?<![\\p{L}])(?:${cue.source})\\s*[-־]?\\s*$`, 'iu'));
    if (found) return { op, subject: `${before.slice(0, found.index)} ${after}` };
  }
  for (const [op, cue] of boundAfter) {
    const lead = after.match(new RegExp(`^\\s*(?:${cue.source})(?![\\p{L}])`, 'iu'));
    if (lead) return { op, subject: `${before} ${after.slice(lead[0].length)}` };
    const tail = after.match(new RegExp(`(?<![\\p{L}])(?:${cue.source})\\s*$`, 'iu'));
    if (tail) return { op, subject: `${before} ${after.slice(0, tail.index)}` };
  }
  return { op: '=', subject: `${before} ${after}` };
}

function percentageClaim(requirement, name) {
  const amounts = Array.from(requirement.matchAll(percentages));
  if (amounts.length !== 1) return null;
  const target = amounts[0];
  const bound = percentBound(requirement, target);
  const subject = bound.subject.replace(/\s+/gu, ' ').trim().replace(/^(?:with|containing|עם|مع)\s+/iu, '');
  const knownMetric = metrics.find(([, label]) => exact(subject, label))?.[0];
  const metric = knownMetric ?? subject;
  const metricLabels = subject && !knownMetric ? [...metrics, [subject, literal(subject)]] : metrics;

  const observations = Array.from(name.matchAll(percentages), match => {
    const after = name.slice(match.index + match[0].length);
    const before = name.slice(0, match.index);
    const labeled = metricLabels.map(([key, label]) => {
      const preceding = before.match(new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${label.source})\\s*:?\\s*$`, 'iu'
      ));
      const following = after.match(new RegExp(
        `^\\s*(?:${label.source})(?![\\p{L}\\p{N}])`, 'iu'
      ));
      if (preceding || following) return { key, preceding, following };
      return null;
    }).filter(Boolean);
    const roles = labeled.map(label => label.key);
    const relevant = labeled.find(label => label.key === metric) ?? labeled[0];
    const prefix = relevant?.preceding ? before.slice(0, relevant.preceding.index) : before;
    const suffix = relevant?.following ? after.slice(relevant.following[0].length) : after;
    return {
      amount: percentAmount(match),
      roles,
      exact: isAsserted(prefix, suffix) && !rangeBefore.test(prefix) && !rangeBefore.test(before) &&
        !rangeAfter.test(after) && !rangeAfter.test(suffix) &&
        !relativeBefore.test(prefix) && !relativeBefore.test(before) &&
        !relativeAfter.test(after) && !relativeAfter.test(suffix),
      evidence: `${relevant?.preceding?.[0] ?? ''}${match[0]}${relevant?.following?.[0] ?? ''}`.trim()
    };
  });

  let candidates = observations.filter(observation => {
    if (!metric) return observation.roles.every(role => role === 'fat');
    return observation.roles.length === 1 && observation.roles[0] === metric;
  });
  // Catalog labels often write just the fat percentage. Other percentage metrics
  // still need a named ingredient or nutrient to establish what the number measures.
  if (metric === 'fat' && !candidates.length && observations.length === 1 &&
      observations[0].roles.length === 0) candidates = observations;
  if (candidates.some(observation => !observation.exact)) return unknown();
  if ((!metric && observations.length !== 1) || new Set(candidates.map(x => x.amount)).size !== 1) return unknown();
  const first = candidates[0];
  return confirmed(compare[bound.op](first.amount, percentAmount(target)) ? 'MET' : 'CONTRADICTED', first.evidence);
}

export function manufacturerName(product) {
  return typeof product.manufacturer === 'string'
    ? product.manufacturer : (product.manufacturer?.name ?? '');
}

export function isKnownBrand(value) {
  const requirement = cleanRequirement(value);
  return brandSpellings.some(spellings => spellings.includes(requirement));
}

function recognizedBrandFamilies(value) {
  return brandSpellings.filter(spellings => spellings.some(alias => asserted(value, literal(alias))));
}

export function corroborateRequirement(value, product, kind = 'OTHER') {
  const requirement = cleanRequirement(value);
  const name = norm(product.name);
  if (!requirement) return unknown();

  if (kind === 'BRAND') {
    const aliases = brandSpellings.find(spellings => spellings.includes(requirement)) ?? [requirement];
    const manufacturer = norm(manufacturerName(product));
    const fromName = aliases.map(alias => asserted(name, literal(alias))).find(Boolean);
    const fromManufacturer = aliases.map(alias => asserted(manufacturer, literal(alias))).find(Boolean);
    if ((fromName && recognizedBrandFamilies(manufacturer).some(brand => brand !== aliases)) ||
        (fromManufacturer && recognizedBrandFamilies(name).some(brand => brand !== aliases))) {
      return { ...unknown(), conflict: true };
    }
    if (fromManufacturer) return confirmed('MET', fromManufacturer, 'MANUFACTURER');
    if (fromName) return confirmed('MET', fromName);
    return unknown();
  }

  const percentage = percentageClaim(requirement, name);
  if (percentage) return percentage;
  const label = labels.find(([, expression]) => exact(requirement, expression));
  if (label) {
    const [, expression, opposite] = label;
    const positive = asserted(name, expression, '\\p{L}');
    const opposingExpression = labels.find(([key]) => key === opposite)?.[1];
    const negative = opposingExpression && asserted(name, opposingExpression, '\\p{L}');
    if (positive && !negative) return confirmed('MET', positive);
    if (negative && !positive) return confirmed('CONTRADICTED', negative);
    return unknown();
  }

  // Open-ended hard requirements need the full claim in the name. An arbitrary
  // excerpt or shared word is insufficient corroboration.
  const fromName = asserted(name, literal(requirement));
  return fromName ? confirmed('MET', fromName) : unknown();
}

export function evidenceInSource(product, source, evidence) {
  if (source === 'PACKAGE') {
    const pkg = product.package;
    return Boolean(pkg && Number.isFinite(pkg.quantity) && typeof pkg.unit === 'string' &&
      norm(evidence).replace(/\s+/gu, '') === norm(`${pkg.quantity}${pkg.unit}`).replace(/\s+/gu, ''));
  }
  const text = source === 'NAME' ? product.name : source === 'MANUFACTURER' ? manufacturerName(product) : '';
  return Boolean(norm(evidence) && norm(text).includes(norm(evidence)));
}

export function isFullManufacturer(product, evidence) {
  const manufacturer = norm(manufacturerName(product));
  return Boolean(manufacturer && norm(evidence) === manufacturer &&
    !/^(?:unknown|not available|n\/?a|other|לא ידוע|לא זמין|אחר|[?-]+)$/u.test(manufacturer));
}
