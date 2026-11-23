import { buildQuantityPriceOptions, type QuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import type { MatchResults } from '@engine/smartcart-matcher.mjs';
import type { EngineItem, ItemContext } from '@engine/engine-types.mjs';
import { retailerLabel } from '@/lib/catalog/normalize';

/** Package counts, unit conversion, prices and weighted exclusions for one item (engine Step 4). */
export function buildItemOptions(results: MatchResults, item: EngineItem, context: ItemContext): QuantityPriceOptions {
  return buildQuantityPriceOptions({ ...results, item, context });
}

export interface ItemOptionsSummary {
  stores: Array<{
    store: string;
    storeKey: string;
    fixedPackageOptions: number;
    cheapestSingleProduct: { name: string; packageCount: number | null; package: string; totalPriceIls: number | null } | null;
    weightedEstimate: { name: string; estimatedPriceIls: number | null } | null;
  }>;
  skippedReasons: Array<{ reason: string; count: number }>;
}

export function summarizeItemOptions(options: QuantityPriceOptions): ItemOptionsSummary {
  const reasons = new Map<string, number>();
  for (const skipped of options.skipped) reasons.set(skipped.reason, (reasons.get(skipped.reason) ?? 0) + 1);
  return {
    stores: options.stores.map(store => ({
      store: `${retailerLabel(store.retailer)} ${store.storeId}`,
      storeKey: store.storeKey,
      fixedPackageOptions: store.options.filter(option => option.status === 'CALCULATED_FIXED_PACKAGES').length,
      cheapestSingleProduct: store.bestFixedPackage ? {
        name: store.bestFixedPackage.productName,
        packageCount: store.bestFixedPackage.packageCount,
        package: `${store.bestFixedPackage.package.quantity} ${store.bestFixedPackage.package.unit}`,
        totalPriceIls: store.bestFixedPackage.totalPriceIls
      } : null,
      weightedEstimate: store.bestWeightedEstimate ? {
        name: store.bestWeightedEstimate.productName,
        estimatedPriceIls: store.bestWeightedEstimate.totalPriceIls
      } : null
    })),
    skippedReasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }))
  };
}
