export const REQUEST_UNITS: string[];

export interface ShoppingDetail {
  kind: 'QUALIFIER' | 'EXCLUSIVE' | 'PREFERENCE_CUE' | 'NUMBER';
  text: string;
}

export function shoppingDetailsIn(text: string): ShoppingDetail[];
export function assertGroceryRequest(request: string): void;
export function assertProductPhrase(item: unknown, index: number): void;
export function assertRequestedQuantity(item: unknown, index: number): void;
export function validateRequestEvidence(request: string, items: unknown[]): unknown[];
export function assertShoppingPlanCoverage(plan: unknown): unknown;
