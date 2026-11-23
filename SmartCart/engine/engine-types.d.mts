// Shared structural types for the JavaScript engines in this folder.
// The engines are plain ESM modules; these declarations describe the shapes
// that the TypeScript application reads and writes.

export type ConstraintType = 'REQUIREMENT' | 'PREFERENCE';
export type ConstraintKind = 'BRAND' | 'OTHER';

export interface ConstraintEvidence {
  type: ConstraintType;
  kind: ConstraintKind;
  sourceText: string;
  value: string;
}

export interface EngineQuantity {
  amount: number;
  unit: string;
  maxAmount?: number;
}

/** One requested shopping line as the engines consume it. */
export interface EngineItem {
  product: string;
  searchTerms: string[];
  requirements: string[];
  preferences: string[];
  quantity: EngineQuantity;
  constraintEvidence?: ConstraintEvidence[];
  sourceText?: string;
  choiceGroup?: string;
}

/** An original catalog offer record (fields preserved from the source catalog). */
export interface CatalogRecord {
  _id: string;
  retailer: string;
  chainId: string;
  subChainId: string;
  storeId: string;
  productCode: string;
  name: string;
  manufacturer?: { name?: string; country?: string; [key: string]: unknown };
  package: { quantity: number; unit?: string; isWeighted: boolean };
  pricing: {
    listedPriceIls: number;
    publishedUnitPriceIls?: number;
    publishedUnitPriceBasis?: string;
  };
  priceUpdatedAt?: string;
  snapshotDate?: string;
  source?: { itemType?: string; allowDiscount?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ItemContext {
  requestFingerprint: string;
  itemFingerprint: string;
  itemIndex: number;
  itemCount: number;
  budgetIls?: number;
  budgetExclusive?: boolean;
}

export interface RequirementCheck {
  requirement: string;
  kind: ConstraintKind;
  result: 'MET' | 'CONTRADICTED' | 'UNKNOWN';
  evidenceSource: 'NAME' | 'MANUFACTURER' | 'PACKAGE' | 'NONE';
  evidence: string;
}

export interface PackageInterpretation {
  status: string;
  reason: string;
  evidence: Array<{ text: string; quantity: number; unit: string; kind: string; container?: string; componentQuantity?: number }>;
}

export interface SellablePackage {
  quantity: number;
  unit: string;
  isWeighted: boolean;
}
