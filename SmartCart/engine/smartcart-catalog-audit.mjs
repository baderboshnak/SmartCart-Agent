import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretPackage, normalizeAmount, parseUnit } from './smartcart-package.mjs';
import { exactStoreKey } from './smartcart-pipeline-context.mjs';
import { manufacturerName } from './smartcart-requirement-evidence.mjs';

const DAY_MS = 86_400_000;
// The production catalog lives in MongoDB (see scripts/audit-catalog.ts); pass a JSON export path here.
const DEFAULT_CATALOG = null;

function dateInMilliseconds(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(text)) return null;
  const day = text.slice(0, 10);
  const time = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(day) ? time : null;
}

function publishedBasis(text) {
  const basis = typeof text === 'string' ? text.trim() : '';
  const match = /^(\d+(?:[.,]\d+)?)\s*(\p{L}.*)$/u.exec(basis);
  const unit = (match?.[2] ?? basis).replace(/מ['’]ל/u, 'מ"ל');
  return normalizeAmount(match ? Number(match[1].replace(',', '.')) : 1, unit);
}

function noteSizeConflict(product) {
  const { packageInterpretation: audit, packageAmount: interpreted } = interpretPackage(product, {}, null);
  const original = normalizeAmount(product.package?.quantity, product.package?.unit);
  const normalized = audit.status === 'NORMALIZED_FROM_NAME' && original && interpreted &&
    (original.family !== interpreted.family || original.amountBase !== interpreted.amountBase);
  return { interpreted, conflict: audit.status === 'AMBIGUOUS' || Boolean(normalized) };
}

export function auditCatalog(products, {
  asOf = new Date().toISOString().slice(0, 10), staleDays = 30, maxExamples = 5
} = {}) {
  if (!Array.isArray(products)) throw new TypeError('Expected a JSON array of catalog records.');
  const asOfTime = dateInMilliseconds(asOf);
  if (asOfTime === null || asOf.length !== 10 || !Number.isSafeInteger(staleDays) || staleDays < 0 ||
      !Number.isSafeInteger(maxExamples) || maxExamples < 0) {
    throw new Error('Supply an audit date (YYYY-MM-DD), nonnegative stale-days, and nonnegative example limit.');
  }

  const issues = new Map();
  const issueNames = {
    missingId: 'confirmed', missingStoreIdentity: 'confirmed', duplicateId: 'confirmed',
    duplicateStoreCode: 'suspicious', invalidPrice: 'confirmed', missingPackageUnit: 'confirmed',
    invalidPackageQuantity: 'confirmed', unsupportedPackageUnit: 'suspicious',
    missingManufacturer: 'suspicious', possiblePackageConflict: 'suspicious',
    suspiciousPublishedUnitPrice: 'suspicious', weightedWithoutVerifiedRules: 'suspicious',
    missingOrInvalidPriceDate: 'suspicious', stalePrice: 'suspicious', futurePriceDate: 'suspicious'
  };
  const status = new Uint8Array(products.length);
  const stores = new Map();
  const retailers = new Map();
  const ids = new Map();
  const codes = new Map();
  const storeCodes = new Map();
  let publishedPricesChecked = 0;

  function flag(index, reason, details) {
    const product = products[index];
    const severity = issueNames[reason];
    const issue = issues.get(reason) ?? { severity, count: 0, examples: [] };
    issue.count++;
    if (issue.examples.length < maxExamples) {
      issue.examples.push({ index, productId: product?._id ?? null, name: product?.name ?? null, ...details });
    }
    issues.set(reason, issue);
    status[index] = Math.max(status[index], severity === 'confirmed' ? 2 : 1);
  }

  function count(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  function collect(map, key, index) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(index);
  }

  for (const [index, input] of products.entries()) {
    const product = input ?? {};
    const retailer = product.retailer ?? '(unknown)';
    const store = exactStoreKey(product);
    count(retailers, retailer);
    count(stores, store ?? '(unknown)');
    if (!store) flag(index, 'missingStoreIdentity');
    if (typeof product._id === 'string' && product._id.trim()) collect(ids, product._id, index);
    else flag(index, 'missingId');
    if (store && product.productCode != null && String(product.productCode).trim()) {
      const code = String(product.productCode).trim();
      collect(storeCodes, JSON.stringify([store, code]), index);
      if (!codes.has(code)) codes.set(code, new Set());
      codes.get(code).add(store);
    }

    const original = product.package;
    const price = product.pricing?.listedPriceIls;
    if (!String(manufacturerName(product) ?? '').trim()) flag(index, 'missingManufacturer');
    if (!Number.isFinite(price) || price <= 0) flag(index, 'invalidPrice');
    if (typeof original?.unit !== 'string' || !original.unit.trim()) flag(index, 'missingPackageUnit');
    else if (!parseUnit(original.unit)) flag(index, 'unsupportedPackageUnit', { unit: original.unit });
    if (!Number.isFinite(original?.quantity) || original.quantity <= 0) flag(index, 'invalidPackageQuantity');
    if (original?.isWeighted === true) flag(index, 'weightedWithoutVerifiedRules');

    const { interpreted, conflict } = noteSizeConflict(product);
    if (conflict) flag(index, 'possiblePackageConflict', { rawPackage: original });
    const published = product.pricing?.publishedUnitPriceIls;
    const basis = publishedBasis(product.pricing?.publishedUnitPriceBasis);
    if (basis && interpreted?.family === basis.family && Number.isFinite(price) && price > 0 &&
        Number.isFinite(published) && published > 0) {
      const expected = price * (basis.amountBase / interpreted.amountBase);
      publishedPricesChecked++;
      // Discount, rounding, or a different reference package can explain a discrepancy.
      if (Math.abs(published - expected) > Math.max(0.03, expected * 0.03)) {
        flag(index, 'suspiciousPublishedUnitPrice', { published, calculated: Number(expected.toFixed(4)) });
      }
    }

    const updated = dateInMilliseconds(product.priceUpdatedAt);
    if (updated === null) flag(index, 'missingOrInvalidPriceDate');
    else if (updated > asOfTime) flag(index, 'futurePriceDate');
    else if ((asOfTime - updated) / DAY_MS > staleDays) flag(index, 'stalePrice');
  }

  for (const indexes of ids.values()) {
    if (indexes.length > 1) for (const i of indexes) flag(i, 'duplicateId');
  }
  for (const indexes of storeCodes.values()) {
    if (indexes.length > 1) for (const i of indexes) flag(i, 'duplicateStoreCode');
  }
  const sorted = map => Object.fromEntries([...map].sort(([a], [b]) => String(a).localeCompare(String(b))));
  return {
    asOf, staleDays,
    records: products.length,
    perRetailer: sorted(retailers),
    perStore: sorted(stores),
    classification: {
      confirmedDataErrors: status.filter(level => level === 2).length,
      suspiciousRecords: status.filter(level => level === 1).length,
      acceptableRecords: status.filter(level => level === 0).length
    },
    publishedPricesChecked,
    productCodesInMultipleStores: [...codes.values()].filter(keys => keys.size > 1).length,
    issues: Object.fromEntries(Object.entries(issueNames).map(([name, severity]) =>
      [name, issues.get(name) ?? { severity, count: 0, examples: [] }]))
  };
}

async function main(args) {
  let catalog = DEFAULT_CATALOG;
  let asOf;
  let staleDays;
  let maxExamples;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') {
      console.log('node smartcart-catalog-audit.mjs [catalog.json] [--as-of YYYY-MM-DD] [--stale-days 30] [--examples 5]');
      return;
    }
    if (arg === '--as-of') asOf = args[++index] ?? '';
    else if (arg === '--stale-days') staleDays = Number(args[++index] ?? NaN);
    else if (arg === '--examples') maxExamples = Number(args[++index] ?? NaN);
    else if (arg.startsWith('--')) throw new Error(`Unknown argument ${arg}`);
    else catalog = arg;
  }
  if (!catalog) {
    console.log('Pass a catalog JSON path: node smartcart-catalog-audit.mjs catalog.json [--as-of YYYY-MM-DD]. ' +
      'To audit the MongoDB catalog, run npm run catalog:audit.');
    process.exitCode = 2;
    return;
  }
  const products = JSON.parse(await readFile(catalog, 'utf8'));
  console.log(JSON.stringify(auditCatalog(products, { asOf, staleDays, maxExamples }), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
