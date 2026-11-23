import { optimizeBaskets, type Basket, type BasketResult } from '@engine/smartcart-basket-optimizer.mjs';
import type { QuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import type { Cart, ShoppingMode } from '@/lib/shared/types';
import type { EnginePlan } from '@/lib/shopping/engine-items';

/** Complete single-store baskets in all modes (engine Step 5). */
export function optimizeCart(files: QuantityPriceOptions[], plan: EnginePlan, mode: ShoppingMode, maxPremiumPct: number): BasketResult {
  return optimizeBaskets(files, { mode, maxPremiumPct, request: plan });
}

export function isCalculationFresh(cart: Cart): boolean {
  return Boolean(cart.calculation && cart.calculation.itemsVersion === cart.itemsVersion && cart.items.length);
}

/**
 * The basket shown to the customer: the recommendation, or the customer's chosen
 * complete store evaluated with the active mode.
 */
export function selectBasket(cart: Cart): { basket: Basket | null; isRecommended: boolean; selectedStoreAvailable: boolean } {
  const calculation = cart.calculation;
  if (!calculation || calculation.status !== 'COMPLETE' || !isCalculationFresh(cart)) {
    return { basket: null, isRecommended: false, selectedStoreAvailable: false };
  }
  const result = calculation.result;
  const recommended = result.recommendedBasket;
  if (!cart.selectedStoreKey) return { basket: recommended, isRecommended: true, selectedStoreAvailable: true };
  const store = result.storeComparisons.find(entry => entry.storeKey === cart.selectedStoreKey);
  if (!store) return { basket: recommended, isRecommended: true, selectedStoreAvailable: false };
  let basket: Basket;
  if (calculation.mode === 'cheapest') basket = store.cheapest;
  else if (calculation.mode === 'preferences-first') basket = store.preferencesFirst;
  else {
    const limit = result.balancedMaxPriceIls;
    basket = limit !== null && store.preferencesFirst.totalPriceIls <= limit ? store.preferencesFirst : store.cheapest;
  }
  const isRecommended = Boolean(recommended && recommended.storeKey === basket.storeKey && recommended.totalPriceIls === basket.totalPriceIls);
  return { basket, isRecommended, selectedStoreAvailable: true };
}

export function modeLabel(mode: ShoppingMode): string {
  return mode === 'cheapest' ? 'Cheapest' : mode === 'preferences-first' ? 'Preferences first' : 'Balanced';
}
