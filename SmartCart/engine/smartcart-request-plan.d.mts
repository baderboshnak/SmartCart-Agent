import type { ConstraintEvidence, EngineQuantity } from './engine-types.mjs';

export interface ExtractedItemInput {
  sourceText: string;
  product: string;
  coreSearchTerm: string;
  searchTerms: string[];
  constraintEvidence: Array<{ type: string; kind: string; sourceText: string }>;
  quantity: { amount: number; unit: string; maxAmount?: number };
}

export interface ValidatedPlanItem {
  product: string;
  searchTerms: string[];
  sourceText: string;
  requirements: string[];
  preferences: string[];
  constraintEvidence: ConstraintEvidence[];
  quantity: EngineQuantity;
  choiceGroup?: string;
}

export function validateShoppingPlan(raw: unknown, userRequest: string): { userRequest: string; items: ValidatedPlanItem[] };
export function validateSourceInventory(raw: unknown, userRequest: string): Array<Omit<ValidatedPlanItem, 'product' | 'searchTerms'>>;
