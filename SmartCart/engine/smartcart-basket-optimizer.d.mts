import type { ConstraintEvidence, EngineQuantity, PackageInterpretation, RequirementCheck, SellablePackage } from './engine-types.mjs';

export type BasketMode = 'balanced' | 'cheapest' | 'preferences-first';

export interface BasketProductLine {
  productId: string;
  productName: string;
  productCode: string | null;
  packageCount: number;
  package: SellablePackage;
  originalPackage: Record<string, unknown> | null;
  packageInterpretation: PackageInterpretation;
  identityStatus: string;
  requirementChecks: RequirementCheck[];
  priceUpdatedAt: string | null;
  snapshotDate: string | null;
  linePriceIls: number;
  listedUnitPriceIls: number;
  preferencesMet: string[];
}

export interface BasketItemLine {
  itemIndex: number;
  item: string;
  choiceGroup?: string;
  requestedQuantity: EngineQuantity;
  costCents: number;
  totalPriceIls: number;
  preferencesSatisfiedCount: number;
  preferencesSatisfied: string[];
  preferencesMissed: string[];
  packageCount: number;
  purchasedQuantity: { amount: number; unit: string };
  overbuy: { amount: number; unit: string } | null;
  products: BasketProductLine[];
}

export interface Basket {
  storeKey: string;
  retailer: string;
  chainId: string;
  subChainId: string;
  storeId: string;
  totalPriceIls: number;
  preferencesSatisfied: number;
  preferencesPossible: number;
  packageCount: number;
  items: BasketItemLine[];
  status: string;
}

export interface MissingItem {
  itemIndex: number;
  product: string;
  choiceGroup?: string;
  reason: string | null;
}

export interface BasketResult {
  settings: {
    mode: BasketMode;
    maxPremiumPct: number;
    budgetIls?: number;
    budgetExclusive?: boolean;
    [key: string]: unknown;
  };
  requestedItems: Array<{
    itemIndex: number;
    product: string;
    requirements: string[];
    preferences: string[];
    quantity: EngineQuantity;
    choiceGroup?: string;
    sourceText?: string;
    constraintEvidence?: ConstraintEvidence[];
  }>;
  storesCompared: number;
  completeStores: number;
  noCompleteBasket: boolean;
  cheapestCompleteBasket: Basket | null;
  balancedBasket: Basket | null;
  preferencesFirstBasket: Basket | null;
  recommendedBasket: Basket | null;
  balancedMaxPriceIls: number | null;
  storeComparisons: Array<{ storeKey: string; retailer: string; storeId: string; cheapest: Basket; preferencesFirst: Basket }>;
  excludedStores: Array<{
    storeKey: string;
    retailer: string;
    missingItems: MissingItem[];
    reason?: string;
    lowestCompletePriceIls?: number;
  }>;
  weightedEstimatesExcluded: Array<{
    itemIndex: number;
    product: string;
    storeKey: string;
    productName: string;
    estimatedPriceIls: number | null;
    status: string;
  }>;
  cheapestOverBudgetIls?: number;
  warning: string | null;
}

export function optimizeBaskets(
  itemFiles: unknown[],
  options?: { mode?: BasketMode; maxPremiumPct?: number; request?: unknown }
): BasketResult;
