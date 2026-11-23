import { createItemContext } from '@engine/smartcart-pipeline-context.mjs';
import type { EngineItem, ItemContext } from '@engine/engine-types.mjs';
import type { Cart, CartItem } from '@/lib/shared/types';

export interface EnginePlan {
  userRequest: string;
  items: EngineItem[];
  budgetIls?: number;
  budgetExclusive?: boolean;
  [key: string]: unknown;
}

/** The engine fields of one cart line, without position-dependent choice groups. */
export function engineItemCore(item: CartItem): EngineItem {
  return {
    product: item.product,
    searchTerms: item.searchTerms,
    requirements: item.requirements,
    preferences: item.preferences,
    quantity: item.quantity,
    constraintEvidence: item.constraintEvidence,
    ...(item.sourceText ? { sourceText: item.sourceText } : {})
  };
}

/**
 * Convert cart lines to engine items. The optimizer expects alternatives to be
 * consecutive and labelled `choice-<index of the first alternative>`.
 */
export function toEngineItems(items: CartItem[]): EngineItem[] {
  const groupSizes = new Map<string, number>();
  for (const item of items) {
    if (item.choiceGroup) groupSizes.set(item.choiceGroup, (groupSizes.get(item.choiceGroup) ?? 0) + 1);
  }
  const firstIndex = new Map<string, number>();
  return items.map((item, index) => {
    const group = item.choiceGroup && (groupSizes.get(item.choiceGroup) ?? 0) >= 2 ? item.choiceGroup : undefined;
    if (group && !firstIndex.has(group)) firstIndex.set(group, index);
    return { ...engineItemCore(item), ...(group ? { choiceGroup: `choice-${firstIndex.get(group)}` } : {}) };
  });
}

export function buildEnginePlan(cart: Pick<Cart, '_id' | 'items' | 'budget'>): { plan: EnginePlan; contexts: ItemContext[] } {
  const plan: EnginePlan = {
    userRequest: `SmartCart cart ${cart._id}`,
    items: toEngineItems(cart.items),
    ...(cart.budget ? { budgetIls: cart.budget.amountIls, budgetExclusive: cart.budget.exclusive } : {})
  };
  return { plan, contexts: plan.items.map((_, index) => createItemContext(plan, index)) };
}
