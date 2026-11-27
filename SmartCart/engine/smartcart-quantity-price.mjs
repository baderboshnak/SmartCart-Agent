/**
 * SmartCart – Step 4: Quantity & Price Engine (Node.js ESM, no API / no dependencies)
 *
 * Usage:
 *   node smartcart-quantity-price.mjs match-results.json
 *   node smartcart-quantity-price.mjs match-results.json shopping-options.json
 *
 * Reads ONLY match-results.matches (never rejected/uncertain products).
 * Uses original pricing.listedPriceIls; ignores unreliable publishedUnitPriceIls.
 * A weighted product is an ESTIMATE, not a confirmed purchasable offer.
 * This is a single-SKU-per-option evaluator, NOT the full multi-item basket optimizer.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countsPackages, interpretPackage, normalizeRequestedQuantity, parseUnit } from './smartcart-package.mjs';
import { assertItemContext, exactStoreKey, hasConfirmedRequirements, offerId } from './smartcart-pipeline-context.mjs';
import { corroborateRequirement, corroborateSizeRequirement, isKnownBrand } from './smartcart-requirement-evidence.mjs';

const round = (n, digits = 3) => Number(n.toFixed(digits));
const ils = cents => round(cents / 100, 2);

function compareOptions(a, b, boundedQuantity) {
  return Number(a.totalPriceIls === null) - Number(b.totalPriceIls === null) ||
    (a.totalPriceIls ?? 0) - (b.totalPriceIls ?? 0) ||
    (a.overbuyBase ?? 0) - (b.overbuyBase ?? 0) ||
    (boundedQuantity
      ? (a.quantityToPurchase?.normalizedAmount ?? 0) - (b.quantityToPurchase?.normalizedAmount ?? 0) : 0) ||
    a.productName.localeCompare(b.productName);
}

function contradictsMatchProof(match, product, item) {
  return match.requirementChecks?.some(check => {
    const declared = item.constraintEvidence?.find(entry =>
      entry?.type === 'REQUIREMENT' && entry.value === check.requirement);
    const kind = isKnownBrand(check.requirement) ? 'BRAND' : (declared?.kind ?? check.kind ?? 'OTHER');
    const size = kind === 'OTHER' ? corroborateSizeRequirement(check.requirement, product, item) : null;
    const proof = size ?? corroborateRequirement(check.requirement, product, kind);
    return proof.conflict || proof.result === 'CONTRADICTED';
  });
}

function evaluateMatch(match, item, requested, hasSpecifiedQuantity, bound) {
  const p = match?.product;
  if (!p || typeof p !== 'object') return { reason: 'Match has no product object' };
  const id = offerId(p);
  if (!id) return { reason: 'Product has no stable identifier' };
  const skip = (reason, fields) => ({ productId: id, productName: p.name ?? '', reason, ...fields });
  if (typeof p.name !== 'string' || !p.name.trim()) return skip('Product has no name.');
  if (((bound || item.requirements?.length) && !hasConfirmedRequirements(match, item)) ||
      (match.identityStatus !== undefined && match.identityStatus !== 'MATCH')) {
    return skip('Product identity or mandatory requirements were not confirmed.');
  }
  if (item.requirements?.length && contradictsMatchProof(match, p, item)) {
    return skip('Catalog evidence contradicts the recorded mandatory requirement proof.');
  }
  const storeKey = exactStoreKey(p);
  if (!storeKey) return skip('Product has no exact store identifier.');
  const listedPrice = p.pricing?.listedPriceIls;
  const listedCents = Number.isFinite(listedPrice) ? Math.round(listedPrice * 100) : NaN;
  if (!Number.isSafeInteger(listedCents) || listedCents <= 0) {
    return skip('Missing or invalid listedPriceIls');
  }
  // "2 packs" or "3 units" of liter cartons is a number of whole sale packages: read the plain
  // sale package and buy that many, instead of comparing a count with liters or grams.
  const plain = interpretPackage(p, { ...item, quantity: { amount: 0, unit: 'unspecified' } }, null);
  const packagesWanted = hasSpecifiedQuantity &&
    countsPackages(item.quantity?.unit, plain.packageAmount, plain.package?.isWeighted ?? p.package?.isWeighted);
  const { package: pkg, packageAmount: pkgAmount, originalPackage, packageInterpretation } =
    packagesWanted ? plain : interpretPackage(p, item, requested);
  const packageAudit = { originalPackage, packageInterpretation };
  if (!pkgAmount) return skip(packageInterpretation.reason, packageAudit);
  const wanted = packagesWanted ? {
    ...pkgAmount, amountBase: requested.amountBase * pkgAmount.amountBase,
    maxAmountBase: requested.maxAmountBase === null ? null : requested.maxAmountBase * pkgAmount.amountBase
  } : requested;
  if (hasSpecifiedQuantity && pkgAmount.family !== wanted.family) {
    return skip('Requested quantity and package units are incompatible', packageAudit);
  }
  const isWeighted = pkg.isWeighted;
  if (isWeighted && !hasSpecifiedQuantity) {
    return skip('Weighted product needs an explicit requested weight or volume', packageAudit);
  }
  const target = hasSpecifiedQuantity ? wanted.amountBase : pkgAmount.amountBase;
  const targetTicks = Math.round(target * 1000);
  const packageTicks = Math.round(pkgAmount.amountBase * 1000);
  const maximum = wanted?.maxAmountBase ?? null;
  const maxTicks = maximum === null ? null : Math.round(maximum * 1000);
  if (!isWeighted && maxTicks !== null && packageTicks > maxTicks) {
    return skip('One fixed package exceeds the requested maximum quantity.', packageAudit);
  }
  let quantityTicks, packageCount, totalCents;
  if (isWeighted) {
    // Catalog quantity is a reference quantity used to express the price (e.g. 1 kg),
    // NOT necessarily a fixed package size. Calculate a pro-rated estimate only.
    quantityTicks = targetTicks;
    packageCount = null;
    const denominator = BigInt(packageTicks);
    const numerator = BigInt(listedCents) * BigInt(targetTicks);
    totalCents = Number((numerator + denominator / 2n) / denominator);
  } else {
    // Fixed packages: buy enough WHOLE packages, never fractional packs.
    packageCount = Number((BigInt(targetTicks) + BigInt(packageTicks) - 1n) / BigInt(packageTicks));
    quantityTicks = packageTicks * packageCount;
    totalCents = listedCents * packageCount;
  }
  const mixedOnly = !isWeighted && maxTicks !== null && quantityTicks > maxTicks;
  if (!mixedOnly && (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(quantityTicks))) {
    return skip('Price calculation overflow', packageAudit);
  }
  const quantityInBase = quantityTicks / 1000;
  const purchase = mixedOnly
    ? { packageCount: null, quantityToPurchase: null, overbuyBase: null, totalPriceIls: null }
    : {
      packageCount,
      quantityToPurchase: {
        amount: round(quantityInBase / parseUnit(pkg.unit).factor, 6),
        unit: pkg.unit,
        normalizedAmount: round(quantityInBase, 3),
        normalizedUnit: pkgAmount.base
      },
      overbuyBase: maxTicks === null ? round(Math.max(0, quantityInBase - target), 3) : 0,
      totalPriceIls: ils(totalCents)
    };
  let status = 'CALCULATED_FIXED_PACKAGES';
  let note = hasSpecifiedQuantity
    ? 'Whole package count calculated from the reconciled package size.'
    : 'No quantity specified: assumed one whole package.';
  if (isWeighted) {
    status = 'ESTIMATE_REQUIRES_QUANTITY_CONFIRMATION';
    note = maxTicks === null
      ? 'Price assumes the store sells exactly the requested quantity; availability, increments and weighing are unverified.'
      : 'Estimated at the lower bound of the requested quantity range. Availability, increments and weighing are unverified.';
  } else if (mixedOnly) {
    status = 'MIXED_PACKAGES_ONLY';
    note = 'A mixed package combination is needed to stay within the requested quantity range.';
  }
  const option = {
    productId: id,
    productCode: p.productCode ?? null,
    productName: p.name ?? '',
    retailer: p.retailer,
    chainId: p.chainId,
    subChainId: p.subChainId,
    storeId: p.storeId,
    storeKey,
    type: isWeighted ? 'WEIGHTED' : 'PACKAGED',
    status,
    package: pkg,
    ...packageAudit,
    ...purchase,
    listedPriceIls: listedPrice,
    priceUpdatedAt: p.priceUpdatedAt ?? null,
    snapshotDate: p.snapshotDate ?? null,
    identityStatus: match.identityStatus,
    requirementChecks: match.requirementChecks,
    preferencesMet: Array.isArray(match.preferencesMet) ? match.preferencesMet : [],
    note
  };
  return { option };
}

/**
 * Build offers for ONE requested item; keep supermarkets/stores separate.
 * Unknown/uncertain items from matching are NOT accepted automatically.
 */
export function buildQuantityPriceOptions(matchResults) {
  if (!matchResults || !matchResults.item || !Array.isArray(matchResults.matches)) {
    throw new TypeError('Expected match-results.json with item and matches array.');
  }
  const { context, item } = matchResults;
  if (context !== undefined) assertItemContext(context, item);
  const q = matchResults.item.quantity ?? {};
  const noAmount = q.maxAmount === undefined && q.amount === 0 &&
    ['unspecified', ''].includes(String(q.unit ?? '').trim().toLowerCase());
  const hasSpecifiedQuantity = !noAmount;
  const requested = hasSpecifiedQuantity ? normalizeRequestedQuantity(q) : null;
  if (hasSpecifiedQuantity && !requested) {
    throw new Error(`Unsupported requested quantity: ${JSON.stringify(q)}; cannot calculate prices safely.`);
  }
  const options = [], skipped = [];
  const seen = new Set();
  for (const match of matchResults.matches) {
    const id = offerId(match?.product);
    const key = id ? JSON.stringify([exactStoreKey(match.product), id]) : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const result = evaluateMatch(match, item, requested, hasSpecifiedQuantity, context !== undefined);
    if (result.option) options.push(result.option);
    else skipped.push(result);
  }
  const groups = new Map();
  for (const option of options) {
    if (!groups.has(option.storeKey)) groups.set(option.storeKey, {
      storeKey: option.storeKey, retailer: option.retailer, storeId: option.storeId,
      chainId: option.chainId, subChainId: option.subChainId,
      bestFixedPackage: null, bestWeightedEstimate: null, options: []
    });
    groups.get(option.storeKey).options.push(option);
  }
  const boundedQuantity = requested?.maxAmountBase != null;
  const stores = [...groups.values()].map(store => {
    store.options.sort((a, b) => compareOptions(a, b, boundedQuantity));
    store.bestFixedPackage = store.options.find(o => o.status === 'CALCULATED_FIXED_PACKAGES') ?? null;
    store.bestWeightedEstimate = store.options.find(o => o.type === 'WEIGHTED') ?? null;
    return store;
  }).sort((a, b) => String(a.retailer).localeCompare(String(b.retailer)) || String(a.storeId).localeCompare(String(b.storeId)));

  return {
    item,
    ...(context !== undefined ? { context } : {}),
    pricingPolicy: {
      currency: 'ILS',
      usedField: 'pricing.listedPriceIls',
      singleSkuPerOption: true,
      weightedQuantitiesVerified: false,
      note: 'Prices come from catalog snapshots, not live checkout; weighted quantities require store verification. No cross-store mixing.'
    },
    candidatesMatched: matchResults.matches.length,
    optionCount: options.length,
    skipped,
    stores
  };
}

async function main() {
  const [input = 'match-results.json', output = 'shopping-options.json'] = process.argv.slice(2);
  const result = buildQuantityPriceOptions(JSON.parse(await readFile(resolve(/*turbopackIgnore: true*/ input), 'utf8')));
  await writeFile(resolve(/*turbopackIgnore: true*/ output), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`Saved ${resolve(/*turbopackIgnore: true*/ output)} — ${result.optionCount} offers across ${result.stores.length} store(s); ${result.skipped.length} skipped.`);
  for (const store of result.stores) {
    console.log(`${store.retailer} (store ${store.storeId ?? 'unknown'}):`);
    const confirmed = store.bestFixedPackage, estimated = store.bestWeightedEstimate;
    console.log(confirmed
      ? `  Best fixed-package calculation: ${confirmed.productName} | ${confirmed.packageCount} pack(s) | ₪${confirmed.totalPriceIls}`
      : '  No individual fixed-package offer');
    if (estimated) console.log(`  Weighted ESTIMATE ONLY: ${estimated.productName} | ₪${estimated.totalPriceIls} (verify exact quantity)`);
  }
  if (result.skipped.length) console.log(`Note: ${result.skipped.length} matched items lacked usable price/quantity metadata; inspect shopping-options.json.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
