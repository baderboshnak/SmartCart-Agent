// Catalog names may describe the contents of a sale package more precisely
// than its structured metadata. Only explicit quantity wording is evidence.
const unitGroups = [
  { family: 'mass', factor: 1, base: 'g', aliases: ['g', 'gr', 'gram', 'grams', 'ג', 'ג׳', 'גרם', 'גר', 'גר׳'] },
  { family: 'mass', factor: 1000, base: 'g', aliases: ['kg', 'kgs', 'kilogram', 'kilograms', 'קג', 'ק"ג', 'קילוגרם'] },
  { family: 'volume', factor: 1, base: 'ml', aliases: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'מל', 'מ"ל', 'מיליליטר'] },
  { family: 'volume', factor: 1000, base: 'ml', aliases: ['l', 'lt', 'liter', 'liters', 'litre', 'litres', 'ל', 'ל׳', 'לי', 'ליטר', 'ליטרים'] },
  { family: 'count', factor: 1, base: 'units', aliases: ['units', 'unit', 'piece', 'pieces', 'pcs', 'pc', 'each', 'יחידות', 'יחידה', 'יח', 'יחי', 'יח׳'] }
];

const containerGroups = [
  ['bottle', 'bottles', 'בקבוק', 'בקבוקים'],
  ['can', 'cans', 'פחית', 'פחיות'],
  ['loaf', 'loaves', 'כיכר', 'כיכרות'],
  ['bag', 'bags', 'שקית', 'שקיות'],
  ['roll', 'rolls', 'גליל', 'גלילים'],
  ['capsule', 'capsules', 'כמוסה', 'כמוסות', 'קפסולה', 'קפסולות']
];
export const CONTAINER_UNITS = Object.freeze(containerGroups.map(([canonical]) => canonical));
const countUnit = unitGroups.at(-1);
const containerLabels = containerGroups.flat();
const pluralContainerLabels = containerGroups.flatMap(([, plural, , hebrew]) => [plural, hebrew]);
const countLabels = [...countUnit.aliases.filter(unit => unit !== 'each'), ...containerLabels];
const measureLabels = unitGroups.slice(0, -1).flatMap(unit => unit.aliases);

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[״“”]/gu, '"').replace(/['’‘]/gu, '׳')
    .replace(/\p{Cf}/gu, '');
}

export function parseUnit(value) {
  const label = unitLabel(value);
  return unitGroups.find(unit => unit.aliases.includes(label)) ??
    (containerLabels.includes(label) ? countUnit : null);
}

const unitLabel = value => normalizedText(value).replace(/[.\s]/gu, '');
export const containerType = value => containerGroups.find(group => group.includes(unitLabel(value)))?.[0];

export function normalizeAmount(amount, unit) {
  const definition = parseUnit(unit);
  if (!definition || !Number.isFinite(amount) || amount <= 0 ||
      (definition.family === 'count' && !Number.isSafeInteger(amount))) return null;
  const amountBase = amount * definition.factor;
  const ticks = Math.round(amountBase * 1000);
  if (ticks <= 0 || !Number.isSafeInteger(ticks) || Math.abs(ticks - amountBase * 1000) > 1e-5) return null;
  return { family: definition.family, base: definition.base, amountBase: ticks / 1000 };
}

export function normalizeRequestedQuantity(quantity) {
  const minimum = normalizeAmount(quantity?.amount, quantity?.unit);
  if (!minimum) return null;
  if (quantity.maxAmount === undefined) return { ...minimum, maxAmountBase: null };

  const maximum = normalizeAmount(quantity.maxAmount, quantity.unit);
  if (!maximum || maximum.amountBase < minimum.amountBase) return null;
  return { ...minimum, maxAmountBase: maximum.amountBase };
}

function alternatives(labels) {
  return [...labels].sort((a, b) => b.length - a.length)
    .map(label => label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
}

const countPattern = alternatives(countLabels);
const unitPattern = alternatives([...countLabels, ...measureLabels]);
const number = String.raw`(?<![\d.,/+\-])\d+(?:[.,]\d+)?`;
const wordEnd = String.raw`(?![\p{L}\p{N}%])`;
const multiplier = String.raw`[x×*]`;
const trailingContainerPattern = alternatives(pluralContainerLabels);
const forward = new RegExp(
  String.raw`(?<count>${number})\s*(?:(?<label>${countPattern})${wordEnd}\s*(?:${multiplier}|of\b|של(?!\p{L}))|${multiplier})\s*(?<size>${number})\s*(?<unit>${unitPattern})${wordEnd}(?:\s+(?<trailingLabel>${trailingContainerPattern})${wordEnd})?`, 'gu'
);
const reverse = new RegExp(
  String.raw`(?<size>${number})\s*(?<unit>${unitPattern})\s*${multiplier}\s*(?<count>${number})(?:\s*(?<label>${countPattern}))?${wordEnd}(?![.,]\d)`, 'gu'
);
const labeledAmount = new RegExp(String.raw`(?<size>${number})\s*(?<unit>${unitPattern})${wordEnd}`, 'gu');
const packCount = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}])(?:pack\s+of|מארז(?:\s+של)?)\s+(?<prefix>${number})${wordEnd}(?!\s*[-–—/+])|(?<suffix>${number})\s*[- ]\s*pack${wordEnd})`, 'gu'
);
const ambiguousQuantity = new RegExp(
  String.raw`(?:${number}\s*(?:[-–—/+]|\bto\b|עד)\s*|(?:[~≈]|(?:כ|בערך)\s*[-־]?\s+|כ[-־]))\d+(?:[.,]\d+)?\s*(?:${unitPattern})${wordEnd}`, 'u'
);
const unfinishedMultiplier = new RegExp(String.raw`${number}\s*${multiplier}\s*(?=\d)`, 'gu');
const singleContainer = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?<label>${alternatives(containerGroups.flatMap(([singular, , hebrew]) => [singular, hebrew]))})(?![\p{L}\p{N}])`, 'gu'
);
const pluralContainer = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:${trailingContainerPattern})(?![\p{L}\p{N}])`, 'u'
);
const continuedQuantity = /^\s*(?:[x×*+]|or\b|או(?!\p{L}))\s*\d+(?:[.,]\d+)?(?![\d.,]|\s*[%٪])/u;
const weightedWording = /במשקל|לפי משקל|\b(?:sold|priced) by weight\b|\bper\s+(?:kg|kilograms?)\s*$|(?:^|[\s/])ל\s*-?\s*ק"?ג\s*$/u;

function numeric(value) {
  // A comma before exactly three digits could be a decimal or thousands
  // separator. Treating "1,000 g" as 1 g can distort the basket.
  return /^[1-9]\d{0,2},\d{3}$/.test(value) ? NaN : Number(value.replace(',', '.'));
}

function nameFacts(name, item, structured) {
  const title = normalizedText(name);
  const entries = [];
  const occupied = [];
  let ambiguous = ambiguousQuantity.test(title);
  const overlaps = match => occupied.some(([start, end]) =>
    match.index < end && match.index + match[0].length > start);
  const record = (match, amount, unit, kind, component = null) => {
    const quantity = normalizeAmount(amount, unit);
    if (!quantity) {
      ambiguous = true;
      return;
    }
    const text = title.length === name.length
      ? name.slice(match.index, match.index + match[0].length).trim() : match[0].trim();
    entries.push({ ...quantity, text, kind, component, container: containerType(unit) });
    if (continuedQuantity.test(title.slice(match.index + match[0].length))) ambiguous = true;
  };

  for (const pattern of [forward, reverse]) {
    for (const match of title.matchAll(pattern)) {
      if (overlaps(match)) continue;
      occupied.push([match.index, match.index + match[0].length]);
      const { count, size, unit, label, trailingLabel } = match.groups;
      const pieces = numeric(count);
      const pieceSize = numeric(size);
      const component = normalizeAmount(pieceSize, unit);
      const types = new Set([unit, label, trailingLabel].map(containerType).filter(Boolean));
      if (!Number.isSafeInteger(pieces) || pieces <= 0 || !component || types.size > 1) {
        ambiguous = true;
        continue;
      }
      record(match, pieces * pieceSize, unit, 'MULTIPACK_TOTAL', component.amountBase);
      if (component.family !== 'count') record(match, pieces, types.values().next().value ?? 'units', 'MULTIPACK_COUNT');
    }
  }
  for (const match of title.matchAll(unfinishedMultiplier)) {
    if (!overlaps(match)) ambiguous = true;
  }
  for (const match of title.matchAll(labeledAmount)) {
    if (!overlaps(match)) record(match, numeric(match.groups.size), match.groups.unit, 'LABELED_QUANTITY');
  }
  for (const match of title.matchAll(packCount)) {
    if (!overlaps(match)) record(match, numeric(match.groups.prefix ?? match.groups.suffix), 'units', 'EXPLICIT_PACK_COUNT');
  }

  // Unlabeled counts require the named contents at the start of the title.
  // A number mid-name could refer to a model, ingredient or marketing claim.
  const terms = [item?.product, ...(Array.isArray(item?.searchTerms) ? item.searchTerms : [])]
    .filter(term => typeof term === 'string').map(normalizedText)
    .filter(term => /^\p{L}{2,}$/u.test(term));
  if (terms.length) {
    const namedCount = new RegExp(String.raw`^\s*(?<count>${number})\s*(?:${alternatives(terms)})${wordEnd}`, 'u');
    const match = title.match(namedCount);
    if (match && !overlaps(match)) record(match, numeric(match.groups.count), 'units', 'NAMED_CONTENTS_COUNT');
  }

  if (!entries.some(entry => entry.family === 'count')) {
    // A standalone singular container can establish one countable item
    // when the catalog or title also provides a package size.
    const containers = [...title.matchAll(singleContainer)];
    const unlabeledPack = /\b(?:multipack|bundle|pack)\b|מארז|חבילה/u.test(title);
    const hasSize = structured !== null || entries.some(entry => entry.family !== 'count');
    if (hasSize && !unlabeledPack && !pluralContainer.test(title) && containers.length === 1) {
      record(containers[0], 1, containers[0].groups.label, 'NAMED_SINGLE_CONTAINER');
    }
  }
  return { entries, ambiguous, truncatedCount: /\d\s*י(?![\p{L}\p{N}])/u.test(title) };
}

export function interpretPackage(product, item, requested) {
  const originalPackage = product.package && typeof product.package === 'object'
    ? { ...product.package } : null;
  const structured = normalizeAmount(originalPackage?.quantity, originalPackage?.unit);
  const isWeighted = originalPackage?.isWeighted === true;
  const { entries, ambiguous, truncatedCount } = isWeighted
    ? { entries: [], ambiguous: false, truncatedCount: false }
    : nameFacts(typeof product.name === 'string' ? product.name : '', item, structured);
  const finish = (status, reason, quantity = null, pkg = null) => ({
    originalPackage,
    packageInterpretation: {
      status, reason,
      evidence: entries.map(({ text, amountBase, base, kind, container, component }) => ({
        text, quantity: amountBase, unit: base, kind,
        ...(container ? { container } : {}),
        ...(component !== null ? { componentQuantity: component } : {})
      }))
    },
    packageAmount: quantity,
    package: pkg
  });
  const skip = reason => finish('AMBIGUOUS', reason);
  const useStructured = (status, reason) => finish(status, reason, structured, {
    quantity: originalPackage.quantity, unit: originalPackage.unit, isWeighted
  });
  if (originalPackage?.isWeighted !== undefined && typeof originalPackage.isWeighted !== 'boolean') {
    return skip('Catalog has an invalid weighted-product indicator.');
  }
  if (isWeighted) {
    if (!structured || structured.family === 'count') {
      return finish('UNKNOWN', 'Weighted offer has no usable listed-price reference weight or volume.');
    }
    return useStructured('WEIGHTED_REFERENCE', 'Structured quantity is the listed-price reference.');
  }
  if (weightedWording.test(normalizedText(product.name))) {
    return skip('Product name indicates a weighted offer but the catalog does not flag it as weighted.');
  }
  if (ambiguous) return skip('Product name contains an unresolved multiplier, range or ambiguous quantity notation.');

  const facts = new Map();
  for (const fact of entries) {
    const existing = facts.get(fact.family);
    if (existing && existing.amountBase !== fact.amountBase) {
      return skip('Product name contains conflicting quantities for the same unit type.');
    }
    if (existing?.container && fact.container && existing.container !== fact.container) {
      return skip('Product name contains conflicting container types.');
    }
    if (!existing || fact.kind === 'MULTIPACK_TOTAL' || (!existing.container && fact.container)) {
      facts.set(fact.family, fact);
    }
  }

  const catalogFact = facts.get(structured?.family);
  const catalogContainer = containerType(originalPackage?.unit);
  if (catalogContainer && catalogFact?.container && catalogContainer !== catalogFact.container) {
    return skip('Structured package container disagrees with the container stated in the product name.');
  }
  const placeholderCount = structured?.family === 'count' && structured.amountBase === 1;
  if (catalogFact && catalogFact.amountBase !== structured.amountBase &&
      !placeholderCount && catalogFact.component !== structured.amountBase) {
    return skip('Structured package quantity disagrees with the quantity stated in the product name.');
  }

  // Prefer the requested dimension when the name supplies independent
  // evidence, e.g. one SKU contains six bottles and three liters in total.
  const family = requested?.family ?? structured?.family ??
    (facts.has('count') && facts.size === 1 ? 'count' : [...facts.keys()].find(key => key !== 'count'));
  const fact = facts.get(family);
  const hasNamedCount = facts.has('count');
  const requestedContainer = containerType(item?.quantity?.unit);
  if (requestedContainer) {
    const documentedContainer = fact?.container ?? catalogContainer;
    if (documentedContainer !== requestedContainer) {
      return finish('UNKNOWN', 'Requested countable form is not confirmed by the package data.');
    }
  }
  if (family === 'count' && placeholderCount && !hasNamedCount && truncatedCount) {
    return skip('Product name has a possible truncated count label.');
  }
  if (fact && family !== 'count') {
    if (structured && structured.family !== 'count' && structured.family !== family &&
        !catalogFact) {
      return skip('Structured and named package measurements use different unit types.');
    }
    if (fact.kind !== 'MULTIPACK_TOTAL' &&
        Math.max(facts.get('count')?.amountBase ?? 0, structured?.family === 'count' ? structured.amountBase : 0) > 1) {
      return skip('Product name does not say whether the measurement applies to each pack or the total.');
    }
  }
  if (structured && structured.family === family && (!fact || structured.amountBase === fact.amountBase)) {
    return useStructured(fact ? 'CATALOG_CONFIRMED' : 'CATALOG_ONLY',
      fact ? 'Explicit quantity wording agrees with structured package data.' : 'Used structured package data.');
  }
  if (fact) {
    return finish('NORMALIZED_FROM_NAME', 'Used explicit package information from the product name.',
      fact, { quantity: fact.amountBase, unit: fact.base, isWeighted: false });
  }
  return finish('UNKNOWN', structured
    ? 'Requested quantity and package units are incompatible.'
    : 'Missing or unsupported package quantity/unit.');
}

/** Check a requested physical quantity per countable item, separate from total size. */
export function corroborateUnitSize(product, item, amount, unit) {
  const unknown = { result: 'UNKNOWN', evidenceSource: 'NONE', evidence: '' };
  const expected = normalizeAmount(amount, unit);
  if (!expected || expected.family === 'count' || !containerType(item?.quantity?.unit)) return unknown;
  const count = interpretPackage(product, item, { family: 'count' });
  if (!count.packageAmount || count.package.isWeighted) return unknown;

  // Compare the total in its own unit family. The count check above already
  // confirms the requested container type independently.
  const measured = interpretPackage(product, { ...item, quantity: { amount, unit } }, expected);
  if (!measured.packageAmount || measured.package.isWeighted) return unknown;
  const named = measured.packageInterpretation.evidence.filter(entry => entry.unit === expected.base);
  const multipack = named.find(entry => entry.kind === 'MULTIPACK_TOTAL');
  if (!multipack && count.packageAmount.amountBase !== 1) return unknown;

  const observed = multipack?.componentQuantity ?? measured.packageAmount.amountBase;
  const text = multipack?.text ?? named[0]?.text;
  return {
    result: observed === expected.amountBase ? 'MET' : 'CONTRADICTED',
    evidenceSource: text ? 'NAME' : 'PACKAGE',
    evidence: text
      ? (product.name.includes(text) ? text : product.name)
      : `${measured.originalPackage.quantity} ${measured.originalPackage.unit}`
  };
}
