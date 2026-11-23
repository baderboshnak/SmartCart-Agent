import type { EngineItem, ItemContext, PackageInterpretation, RequirementCheck, SellablePackage } from './engine-types.mjs';

export interface PurchaseOption {
  productId: string;
  productCode: string | null;
  productName: string;
  retailer: string;
  chainId: string;
  subChainId: string;
  storeId: string;
  storeKey: string;
  type: 'PACKAGED' | 'WEIGHTED';
  status: 'CALCULATED_FIXED_PACKAGES' | 'ESTIMATE_REQUIRES_QUANTITY_CONFIRMATION' | 'MIXED_PACKAGES_ONLY';
  package: SellablePackage;
  originalPackage: Record<string, unknown> | null;
  packageInterpretation: PackageInterpretation;
  packageCount: number | null;
  quantityToPurchase: { amount: number; unit: string; normalizedAmount: number; normalizedUnit: string } | null;
  overbuyBase: number | null;
  totalPriceIls: number | null;
  listedPriceIls: number;
  priceUpdatedAt: string | null;
  snapshotDate: string | null;
  identityStatus: string;
  requirementChecks: RequirementCheck[];
  preferencesMet: string[];
  note: string;
}

export interface StoreOptions {
  storeKey: string;
  retailer: string;
  storeId: string;
  chainId: string;
  subChainId: string;
  bestFixedPackage: PurchaseOption | null;
  bestWeightedEstimate: PurchaseOption | null;
  options: PurchaseOption[];
}

export interface QuantityPriceOptions {
  item: EngineItem;
  context?: ItemContext;
  pricingPolicy: Record<string, unknown>;
  candidatesMatched: number;
  optionCount: number;
  skipped: Array<{ productId?: string; productName?: string; reason: string }>;
  stores: StoreOptions[];
}

export function buildQuantityPriceOptions(matchResults: unknown): QuantityPriceOptions;
