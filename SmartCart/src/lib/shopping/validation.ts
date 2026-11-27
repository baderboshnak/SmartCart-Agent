import { exactStoreKey } from '@engine/smartcart-pipeline-context.mjs';
import { countsPackages, interpretPackage, normalizeAmount, normalizeRequestedQuantity } from '@engine/smartcart-package.mjs';
import { corroborateRequirement, corroborateSizeRequirement, isKnownBrand } from '@engine/smartcart-requirement-evidence.mjs';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import type { Basket, BasketResult } from '@engine/smartcart-basket-optimizer.mjs';
import type { Budget, ShoppingMode, VerificationReport } from '@/lib/shared/types';

const cents = (ils: number) => Math.round(ils * 100);
const MAX_REPORTED_FAILURES = 50;

function isUnspecified(item: EngineItem): boolean {
  const unit = String(item.quantity?.unit ?? '').trim().toLowerCase();
  return item.quantity?.amount === 0 && item.quantity?.maxAmount === undefined && (unit === 'unspecified' || unit === '');
}

/** Every distinct complete basket in an optimizer result. */
export function basketsIn(result: BasketResult): Basket[] {
  const all = [
    result.recommendedBasket, result.cheapestCompleteBasket, result.balancedBasket, result.preferencesFirstBasket,
    ...result.storeComparisons.flatMap(store => [store.cheapest, store.preferencesFirst])
  ].filter((basket): basket is Basket => Boolean(basket));
  return [...new Set(all)];
}

export function productIdsIn(result: BasketResult): string[] {
  return [...new Set(basketsIn(result).flatMap(basket => basket.items.flatMap(line => line.products.map(product => product.productId))))];
}

function verifyBasket(basket: Basket, items: EngineItem[], products: Map<string, CatalogRecord>, fail: (message: string) => void): number {
  let lines = 0;
  const where = `${basket.storeKey}`;
  if (exactStoreKey(basket) !== basket.storeKey) fail(`${where}: basket store identity is inconsistent.`);

  // Every requested item, or exactly one alternative per choice group, appears exactly once.
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = item.choiceGroup ?? `item-${index}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const seen = new Set<number>();
  for (const line of basket.items) {
    if (!Number.isInteger(line.itemIndex) || line.itemIndex < 0 || line.itemIndex >= items.length) fail(`${where}: unknown item index ${line.itemIndex}.`);
    if (seen.has(line.itemIndex)) fail(`${where}: item ${line.itemIndex} appears twice.`);
    seen.add(line.itemIndex);
  }
  for (const [group, indexes] of groups) {
    const present = indexes.filter(index => seen.has(index)).length;
    if (present !== 1) fail(`${where}: ${group} must be bought exactly once (found ${present}).`);
  }

  let basketCents = 0;
  let basketPackages = 0;
  let basketPreferences = 0;
  for (const line of basket.items) {
    const item = items[line.itemIndex];
    if (!item) continue;
    const label = `${where} / ${item.product}`;
    if (line.item !== item.product) fail(`${label}: line names a different product.`);
    if (!line.products.length) fail(`${label}: line has no products.`);
    const requested = isUnspecified(item) ? null : normalizeRequestedQuantity(item.quantity);
    if (!isUnspecified(item) && !requested) fail(`${label}: requested quantity is invalid.`);
    let lineCents = 0;
    let lineTicks = 0;
    let linePackages = 0;
    // "2 packs" or "3 units" of liter cartons is checked as a number of whole sale packages.
    let packageCountLine = Boolean(requested);
    for (const offer of line.products) {
      lines++;
      const record = products.get(offer.productId);
      if (!record) {
        fail(`${label}: product ${offer.productId} no longer exists in MongoDB.`);
        continue;
      }
      if (exactStoreKey(record) !== basket.storeKey) fail(`${label}: product ${offer.productId} belongs to another store.`);
      if (record.name !== offer.productName) fail(`${label}: product name differs from the catalog.`);
      if (record.package?.isWeighted === true || offer.package?.isWeighted === true) fail(`${label}: unverified weighted offer in a complete basket.`);
      if (!Number.isSafeInteger(offer.packageCount) || offer.packageCount < 1) fail(`${label}: invalid package count.`);
      const unitCents = cents(record.pricing.listedPriceIls);
      if (cents(offer.listedUnitPriceIls) !== unitCents) fail(`${label}: unit price ₪${offer.listedUnitPriceIls} differs from the catalog ₪${record.pricing.listedPriceIls}.`);
      if (cents(offer.linePriceIls) !== unitCents * offer.packageCount) fail(`${label}: line price is not unit price × package count.`);
      if (offer.identityStatus !== 'MATCH') fail(`${label}: product identity was not confirmed.`);

      // Recompute package reconciliation (for example, a 12-egg carton) from the catalog record.
      const plain = interpretPackage(record, { ...item, quantity: { amount: 0, unit: 'unspecified' } }, null);
      const packagesWanted = Boolean(requested) && countsPackages(item.quantity?.unit, plain.packageAmount, record.package?.isWeighted);
      if (!packagesWanted) packageCountLine = false;
      const reconciled = packagesWanted ? plain : interpretPackage(record, item, requested);
      if (!reconciled.package || reconciled.package.quantity !== offer.package.quantity || reconciled.package.unit !== offer.package.unit) {
        fail(`${label}: package ${offer.package.quantity} ${offer.package.unit} does not match the catalog interpretation.`);
      }
      const amount = normalizeAmount(offer.package.quantity, offer.package.unit);
      if (!amount) fail(`${label}: unusable package quantity.`);
      else if (requested && !packagesWanted && amount.family !== requested.family) fail(`${label}: package unit does not match the requested unit.`);
      else lineTicks += Math.round(amount.amountBase * 1000) * offer.packageCount;

      // Mandatory requirements: exactly one MET check each, independently re-corroborated.
      for (const requirement of item.requirements) {
        const checks = offer.requirementChecks.filter(check => check.requirement === requirement);
        if (checks.length !== 1 || checks[0]!.result !== 'MET') {
          fail(`${label}: requirement "${requirement}" is not confirmed.`);
          continue;
        }
        const declared = item.constraintEvidence?.find(entry => entry.type === 'REQUIREMENT' && entry.value === requirement);
        const kind = isKnownBrand(requirement) ? 'BRAND' : (declared?.kind ?? checks[0]!.kind ?? 'OTHER');
        const size = kind === 'OTHER' ? corroborateSizeRequirement(requirement, record, item) : null;
        const proof = size ?? corroborateRequirement(requirement, record, kind);
        if (proof.result !== 'MET' || ('conflict' in proof && proof.conflict)) {
          fail(`${label}: catalog evidence no longer proves "${requirement}".`);
        }
      }
      if (offer.requirementChecks.length !== item.requirements.length) fail(`${label}: unexpected requirement checks.`);
      if (!offer.preferencesMet.every(preference => item.preferences.includes(preference))) fail(`${label}: unknown preference claimed.`);
      lineCents += unitCents * offer.packageCount;
      linePackages += offer.packageCount;
    }

    if (lineCents !== line.costCents || lineCents !== cents(line.totalPriceIls)) fail(`${label}: line total does not equal the sum of its products.`);
    if (linePackages !== line.packageCount) fail(`${label}: package count is inconsistent.`);
    if (requested && packageCountLine) {
      if (linePackages < requested.amountBase) fail(`${label}: fewer packages than requested.`);
      if (requested.maxAmountBase !== null && linePackages > requested.maxAmountBase) fail(`${label}: more packages than the requested maximum.`);
    } else if (requested) {
      const minimum = Math.round(requested.amountBase * 1000);
      if (lineTicks < minimum) fail(`${label}: purchased quantity is below the requested amount.`);
      if (requested.maxAmountBase !== null && lineTicks > Math.round(requested.maxAmountBase * 1000)) fail(`${label}: purchased quantity exceeds the requested maximum.`);
    } else if (linePackages < 1) {
      fail(`${label}: no package purchased.`);
    }
    // A preference counts only when every selected package satisfies it.
    const satisfied = item.preferences.filter(preference => line.products.every(offer => offer.preferencesMet.includes(preference)));
    if (satisfied.length !== line.preferencesSatisfiedCount ||
        [...satisfied].sort().join('\u0000') !== [...line.preferencesSatisfied].sort().join('\u0000')) {
      fail(`${label}: satisfied preferences are inconsistent.`);
    }
    basketCents += lineCents;
    basketPackages += linePackages;
    basketPreferences += satisfied.length;
  }
  if (basketCents !== cents(basket.totalPriceIls)) fail(`${where}: basket total ₪${basket.totalPriceIls} does not equal the sum of its lines.`);
  if (basketPackages !== basket.packageCount) fail(`${where}: basket package count is inconsistent.`);
  if (basketPreferences !== basket.preferencesSatisfied) fail(`${where}: basket preference count is inconsistent.`);
  return lines;
}

/**
 * Independent server-side verification of an optimizer result against fresh MongoDB
 * records. The agent's or optimizer's own claims are not trusted.
 */
export function verifyBasketResult(input: {
  result: BasketResult;
  items: EngineItem[];
  products: Map<string, CatalogRecord>;
  mode: ShoppingMode;
  maxPremiumPct: number;
  budget: Budget | null;
}): VerificationReport {
  const failures: string[] = [];
  const fail = (message: string) => {
    if (failures.length < MAX_REPORTED_FAILURES) failures.push(message);
  };
  const { result, items, products, mode, maxPremiumPct, budget } = input;
  const baskets = basketsIn(result);
  let checkedLines = 0;
  for (const basket of baskets) {
    checkedLines += verifyBasket(basket, items, products, fail);
    if (budget) {
      const limit = cents(budget.amountIls) - (budget.exclusive ? 1 : 0);
      if (cents(basket.totalPriceIls) > limit) fail(`${basket.storeKey}: basket exceeds the budget.`);
    }
  }

  const variants = result.storeComparisons.flatMap(store => [store.cheapest, store.preferencesFirst]);
  const recommended = result.recommendedBasket;
  if (result.noCompleteBasket !== !recommended) fail('Completeness flag disagrees with the recommendation.');
  if (recommended && variants.length) {
    const cheapestCents = Math.min(...variants.map(basket => cents(basket.totalPriceIls)));
    if (!result.cheapestCompleteBasket || cents(result.cheapestCompleteBasket.totalPriceIls) !== cheapestCents) {
      fail('The cheapest basket is not the lowest-priced complete basket.');
    }
    const maxCents = Math.floor(cheapestCents * (1 + maxPremiumPct / 100) + 1e-7);
    const budgetCents = budget ? cents(budget.amountIls) - (budget.exclusive ? 1 : 0) : Number.MAX_SAFE_INTEGER;
    const balancedLimit = Math.min(maxCents, budgetCents);
    if (result.balancedMaxPriceIls !== null && cents(result.balancedMaxPriceIls) !== balancedLimit) {
      fail('The balanced price limit is not the cheapest total plus the premium.');
    }
    const bestPreferences = Math.max(...variants.map(basket => basket.preferencesSatisfied));
    const bestWithinLimit = Math.max(...variants.filter(basket => cents(basket.totalPriceIls) <= balancedLimit).map(basket => basket.preferencesSatisfied));
    if (mode === 'cheapest' && cents(recommended.totalPriceIls) !== cheapestCents) fail('Cheapest mode did not recommend the lowest total.');
    if (mode === 'preferences-first' && recommended.preferencesSatisfied !== bestPreferences) fail('Preferences-first mode did not maximize satisfied preferences.');
    // Balanced mode may choose an intermediate per-store variant that storeComparisons does not list,
    // so it must satisfy at least as many preferences as any listed variant within the limit.
    if (mode === 'balanced' && (cents(recommended.totalPriceIls) > balancedLimit || recommended.preferencesSatisfied < bestWithinLimit)) {
      fail('Balanced mode recommendation is outside the premium limit or misses available preferences.');
    }
  }

  return { passed: failures.length === 0, checkedBaskets: baskets.length, checkedLines, failures, checkedAt: new Date() };
}
