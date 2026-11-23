import type { Basket } from '@engine/smartcart-basket-optimizer.mjs';
import { storeDisplayName } from '@/lib/catalog/normalize';
import type { Budget, Cart, CartItem, ItemDiagnostics, Quantity, ShoppingMode } from '@/lib/shared/types';
import { formatQuantity } from '@/lib/shopping/cart-ops';
import { isCalculationFresh, selectBasket } from '@/lib/shopping/optimizer';

export type CartStatus = 'EMPTY' | 'NEEDS_CALCULATION' | 'COMPLETE' | 'NO_COMPLETE_BASKET' | 'VERIFICATION_FAILED';

export interface CartLineView {
  itemId: string;
  product: string;
  requestedLabel: string;
  purchasedLabel: string;
  overbuyLabel: string | null;
  totalPriceIls: number;
  preferencesSatisfied: string[];
  preferencesMissed: string[];
  products: Array<{
    productId: string;
    name: string;
    packageCount: number;
    packageLabel: string;
    unitPriceIls: number;
    linePriceIls: number;
    preferencesMet: string[];
    requirementChecks: Array<{ requirement: string; result: string; evidence: string }>;
  }>;
}

export interface CartView {
  revision: number;
  itemsVersion: number;
  mode: ShoppingMode;
  maxPremiumPct: number;
  budget: Budget | null;
  status: CartStatus;
  items: Array<{
    id: string;
    product: string;
    quantity: Quantity;
    quantityLabel: string;
    requirements: string[];
    preferences: string[];
    sourceText: string | null;
    alternativeGroup: string | null;
    origin: CartItem['origin'];
  }>;
  basket: null | {
    storeKey: string;
    storeName: string;
    totalPriceIls: number;
    preferencesSatisfied: number;
    preferencesPossible: number;
    packageCount: number;
    isRecommended: boolean;
    lines: CartLineView[];
  };
  stores: Array<{
    storeKey: string;
    storeName: string;
    complete: boolean;
    cheapestTotalIls: number | null;
    preferencesFirstTotalIls: number | null;
    preferencesFirstSatisfied: number | null;
    preferencesPossible: number | null;
    isRecommended: boolean;
    isSelected: boolean;
    missingItems: Array<{ itemId: string | null; product: string; reason: string }>;
    note: string | null;
  }>;
  missingItems: Array<{ itemId: string | null; product: string; reason: string }>;
  weightedEstimates: Array<{ itemId: string | null; product: string; storeName: string; productName: string; estimatedPriceIls: number | null }>;
  recipePlans: Array<{ id: string; dish: string; servings: number; servingsSource: string; ingredients: Array<{ name: string; quantityLabel: string; optional: boolean; inCart: boolean }> }>;
  diagnostics: ItemDiagnostics[];
  verification: { passed: boolean; failures: string[] } | null;
  catalog: { snapshotDates: string[]; priceUpdatedAtRange: { min: string | null; max: string | null } } | null;
  balancedMaxPriceIls: number | null;
  calculatedAt: string | null;
  selectedStoreUnavailable: boolean;
}

const storeNameOf = (storeKey: string) => {
  const [retailer = storeKey, , , storeId = ''] = storeKey.split(':');
  return storeDisplayName(retailer, storeId);
};

function lineView(basket: Basket, itemIds: string[]): CartLineView[] {
  return basket.items.map(line => ({
    itemId: itemIds[line.itemIndex] ?? '',
    product: line.item,
    requestedLabel: formatQuantity(line.requestedQuantity),
    purchasedLabel: line.purchasedQuantity.unit === 'unspecified purchase'
      ? `${line.packageCount} package${line.packageCount === 1 ? '' : 's'}`
      : `${line.purchasedQuantity.amount} ${line.purchasedQuantity.unit}`,
    overbuyLabel: line.overbuy && line.overbuy.amount > 0 ? `+${line.overbuy.amount} ${line.overbuy.unit}` : null,
    totalPriceIls: line.totalPriceIls,
    preferencesSatisfied: line.preferencesSatisfied,
    preferencesMissed: line.preferencesMissed,
    products: line.products.map(product => ({
      productId: product.productId,
      name: product.productName,
      packageCount: product.packageCount,
      packageLabel: `${product.package.quantity} ${product.package.unit}`,
      unitPriceIls: product.listedUnitPriceIls,
      linePriceIls: product.linePriceIls,
      preferencesMet: product.preferencesMet,
      requirementChecks: product.requirementChecks.map(check => ({ requirement: check.requirement, result: check.result, evidence: check.evidence }))
    }))
  }));
}

/** The customer-facing cart. Contains catalog data and calculations, never secrets. */
export function toCartView(cart: Cart): CartView {
  const fresh = isCalculationFresh(cart);
  const calculation = fresh ? cart.calculation : null;
  const status: CartStatus = !cart.items.length ? 'EMPTY' : !calculation ? 'NEEDS_CALCULATION' : calculation.status;
  const itemIds = calculation?.itemIds ?? [];
  const selection = selectBasket(cart);
  const result = calculation?.result;
  const recommendedKey = result?.recommendedBasket?.storeKey ?? null;
  const itemName = (index: number) => cart.items.find(item => item.id === itemIds[index])?.product ?? result?.requestedItems[index]?.product ?? 'item';

  const complete = (result?.storeComparisons ?? []).map(store => ({
    storeKey: store.storeKey,
    storeName: storeNameOf(store.storeKey),
    complete: true,
    cheapestTotalIls: store.cheapest.totalPriceIls,
    preferencesFirstTotalIls: store.preferencesFirst.totalPriceIls,
    preferencesFirstSatisfied: store.preferencesFirst.preferencesSatisfied,
    preferencesPossible: store.preferencesFirst.preferencesPossible,
    isRecommended: store.storeKey === recommendedKey,
    isSelected: selection.basket?.storeKey === store.storeKey,
    missingItems: [],
    note: null
  }));
  const excluded = (result?.excludedStores ?? []).map(store => ({
    storeKey: store.storeKey,
    storeName: storeNameOf(store.storeKey),
    complete: false,
    cheapestTotalIls: null,
    preferencesFirstTotalIls: null,
    preferencesFirstSatisfied: null,
    preferencesPossible: null,
    isRecommended: false,
    isSelected: false,
    missingItems: store.missingItems.map(missing => ({
      itemId: itemIds[missing.itemIndex] ?? null,
      product: itemName(missing.itemIndex),
      reason: missing.reason ?? 'Not available'
    })),
    note: store.reason ?? null
  }));

  // An item is missing everywhere when every compared store lacks it.
  const missingEverywhere = new Map<number, string>();
  if (result && !result.storeComparisons.length && result.excludedStores.length) {
    const counts = new Map<number, number>();
    for (const store of result.excludedStores) for (const missing of store.missingItems) counts.set(missing.itemIndex, (counts.get(missing.itemIndex) ?? 0) + 1);
    for (const [index, count] of counts) if (count === result.excludedStores.length) missingEverywhere.set(index, 'No exact store has a confirmed fixed-price package.');
  }
  for (const diagnostic of calculation?.itemDiagnostics ?? []) {
    const index = itemIds.indexOf(diagnostic.itemId);
    if (diagnostic.candidates === 0 && index !== -1) missingEverywhere.set(index, 'No catalog products matched the search.');
  }

  return {
    revision: cart.revision,
    itemsVersion: cart.itemsVersion,
    mode: cart.mode,
    maxPremiumPct: cart.maxPremiumPct,
    budget: cart.budget,
    status,
    items: cart.items.map(item => ({
      id: item.id,
      product: item.product,
      quantity: item.quantity,
      quantityLabel: formatQuantity(item.quantity),
      requirements: item.requirements,
      preferences: item.preferences,
      sourceText: item.sourceText ?? null,
      alternativeGroup: item.choiceGroup ?? null,
      origin: item.origin
    })),
    basket: selection.basket ? {
      storeKey: selection.basket.storeKey,
      storeName: storeNameOf(selection.basket.storeKey),
      totalPriceIls: selection.basket.totalPriceIls,
      preferencesSatisfied: selection.basket.preferencesSatisfied,
      preferencesPossible: selection.basket.preferencesPossible,
      packageCount: selection.basket.packageCount,
      isRecommended: selection.isRecommended,
      lines: lineView(selection.basket, itemIds)
    } : null,
    stores: [...complete, ...excluded],
    missingItems: [...missingEverywhere].map(([index, reason]) => ({ itemId: itemIds[index] ?? null, product: itemName(index), reason })),
    weightedEstimates: (result?.weightedEstimatesExcluded ?? []).slice(0, 12).map(estimate => ({
      itemId: itemIds[estimate.itemIndex] ?? null,
      product: estimate.product,
      storeName: storeNameOf(estimate.storeKey),
      productName: estimate.productName,
      estimatedPriceIls: estimate.estimatedPriceIls
    })),
    recipePlans: cart.recipePlans.map(plan => ({
      id: plan.id,
      dish: plan.dish,
      servings: plan.servings,
      servingsSource: plan.servingsSource,
      ingredients: plan.ingredients.map(ingredient => ({
        name: ingredient.name,
        quantityLabel: formatQuantity(ingredient.quantity),
        optional: ingredient.optional,
        inCart: Boolean(ingredient.itemId && cart.items.some(item => item.id === ingredient.itemId))
      }))
    })),
    diagnostics: calculation?.itemDiagnostics ?? [],
    verification: calculation ? { passed: calculation.verification.passed, failures: calculation.verification.failures.slice(0, 5) } : null,
    catalog: calculation?.catalog ?? null,
    balancedMaxPriceIls: result?.balancedMaxPriceIls ?? null,
    calculatedAt: calculation?.calculatedAt ? new Date(calculation.calculatedAt).toISOString() : null,
    selectedStoreUnavailable: Boolean(cart.selectedStoreKey && fresh && !selection.selectedStoreAvailable)
  };
}

function basketForAgent(basket: Basket | null, itemIds: string[]) {
  if (!basket) return null;
  return {
    store: storeNameOf(basket.storeKey),
    storeKey: basket.storeKey,
    totalIls: basket.totalPriceIls,
    preferencesSatisfied: `${basket.preferencesSatisfied}/${basket.preferencesPossible}`,
    lines: basket.items.map(line => ({
      itemId: itemIds[line.itemIndex],
      item: line.item,
      requested: formatQuantity(line.requestedQuantity),
      purchased: `${line.purchasedQuantity.amount} ${line.purchasedQuantity.unit}`,
      overbuy: line.overbuy && line.overbuy.amount > 0 ? `${line.overbuy.amount} ${line.overbuy.unit}` : null,
      products: line.products.map(product => `${product.packageCount} × ${product.productName} (${product.package.quantity} ${product.package.unit}) = ₪${product.linePriceIls}`),
      totalIls: line.totalPriceIls,
      preferencesMet: line.preferencesSatisfied,
      preferencesMissed: line.preferencesMissed
    }))
  };
}

/** Compact, verified cart state for the agent. */
export function summarizeCartForAgent(cart: Cart) {
  const fresh = isCalculationFresh(cart);
  const calculation = fresh ? cart.calculation : null;
  const selection = selectBasket(cart);
  return {
    revision: cart.revision,
    mode: cart.mode,
    maxPremiumPct: cart.maxPremiumPct,
    budget: cart.budget,
    items: cart.items.map(item => ({
      itemId: item.id,
      product: item.product,
      quantity: formatQuantity(item.quantity),
      requirements: item.requirements,
      preferences: item.preferences,
      ...(item.choiceGroup ? { alternativeGroup: item.choiceGroup } : {}),
      origin: item.origin.type === 'RECIPE' ? `recipe: ${item.origin.dish}` : 'direct request'
    })),
    calculation: !cart.items.length ? 'EMPTY' : !calculation ? 'STALE_OR_MISSING: call optimizeBasket before quoting prices' : {
      status: calculation.status,
      verificationPassed: calculation.verification.passed,
      shownBasket: basketForAgent(selection.basket, calculation.itemIds),
      shownBasketIsRecommended: selection.isRecommended
    },
    recipePlans: cart.recipePlans.map(plan => ({ dish: plan.dish, servings: plan.servings, servingsSource: plan.servingsSource }))
  };
}

/** Verified calculation details for optimizeBasket, compareStores and explainRecommendation. */
export function summarizeCalculationForAgent(cart: Cart) {
  const calculation = isCalculationFresh(cart) ? cart.calculation : null;
  if (!calculation) return { status: cart.items.length ? 'STALE_OR_MISSING' : 'EMPTY' };
  const { result, itemIds } = calculation;
  const totals = (basket: Basket | null) => basket ? { store: storeNameOf(basket.storeKey), totalIls: basket.totalPriceIls, preferences: `${basket.preferencesSatisfied}/${basket.preferencesPossible}` } : null;
  return {
    status: calculation.status,
    mode: calculation.mode,
    verification: { passed: calculation.verification.passed, failures: calculation.verification.failures.slice(0, 3) },
    recommended: basketForAgent(result.recommendedBasket, itemIds),
    alternatives: {
      cheapest: totals(result.cheapestCompleteBasket),
      balanced: totals(result.balancedBasket),
      preferencesFirst: totals(result.preferencesFirstBasket),
      balancedMaxPriceIls: result.balancedMaxPriceIls
    },
    stores: [
      ...result.storeComparisons.map(store => ({
        store: storeNameOf(store.storeKey), storeKey: store.storeKey, complete: true,
        cheapestIls: store.cheapest.totalPriceIls,
        preferencesFirstIls: store.preferencesFirst.totalPriceIls,
        preferencesFirst: `${store.preferencesFirst.preferencesSatisfied}/${store.preferencesFirst.preferencesPossible}`
      })),
      ...result.excludedStores.map(store => ({
        store: storeNameOf(store.storeKey), storeKey: store.storeKey, complete: false,
        missing: store.missingItems.map(missing => `${missing.product}: ${missing.reason}`),
        ...(store.reason ? { reason: store.reason } : {})
      }))
    ],
    weightedEstimatesExcluded: result.weightedEstimatesExcluded.length,
    items: calculation.itemDiagnostics.map(diagnostic => ({
      itemId: diagnostic.itemId,
      product: diagnostic.product,
      candidates: diagnostic.candidates,
      ...(diagnostic.truncated ? { truncatedFrom: diagnostic.totalMatched } : {}),
      matched: diagnostic.matched,
      uncertain: diagnostic.uncertain,
      rejected: diagnostic.rejected,
      ...(diagnostic.uncertainExamples.length ? { uncertainExamples: diagnostic.uncertainExamples } : {})
    })),
    ...(result.warning ? { warning: result.warning } : {}),
    note: 'Prices are catalog snapshots, not live stock, promotions, delivery fees or checkout totals.'
  };
}
