import type { ValidatedPlanItem } from '@engine/smartcart-request-plan.mjs';
import { newId } from '@/lib/db/sessions.repository';
import { ValidationError } from '@/lib/shared/errors';
import type { Budget, Cart, CartItem, ConstraintEvidence, Quantity, RecipePlan, ShoppingMode } from '@/lib/shared/types';
import type { NewItemFields } from '@/lib/shopping/request-items';

export const MAX_CART_ITEMS = 40;

export type CartOperation =
  | { op: 'add_items'; items: ValidatedPlanItem[]; messageId?: string }
  | {
      op: 'add_recipe';
      plan: { dish: string; servings: number; servingsSource: 'EXPLICIT' | 'ASSUMED'; requestText: string; notes?: string };
      ingredients: Array<NewItemFields & { name: string; optional: boolean; note?: string }>;
    }
  | { op: 'remove_items'; itemIds: string[] }
  | { op: 'set_quantity'; itemId: string; quantity: Quantity }
  | { op: 'set_constraints'; itemId: string; requirements: string[]; preferences: string[]; constraintEvidence: ConstraintEvidence[] }
  | { op: 'set_search_terms'; itemId: string; searchTerms: string[] }
  | { op: 'set_mode'; mode: ShoppingMode; maxPremiumPct?: number }
  | { op: 'set_budget'; budget: Budget | null }
  | { op: 'select_store'; storeKey: string | null }
  | { op: 'clear' };

export function formatQuantity(quantity: Quantity): string {
  if (quantity.unit === 'unspecified') return 'one package';
  const unit = quantity.unit === 'units' ? (quantity.amount === 1 && quantity.maxAmount === undefined ? 'unit' : 'units') : quantity.unit;
  return quantity.maxAmount !== undefined ? `${quantity.amount}–${quantity.maxAmount} ${unit}` : `${quantity.amount} ${unit}`;
}

export function describeItem(item: Pick<CartItem, 'product' | 'quantity' | 'requirements' | 'preferences'>): string {
  const parts = [`${item.product} (${formatQuantity(item.quantity)})`];
  if (item.requirements.length) parts.push(`required: ${item.requirements.join(', ')}`);
  if (item.preferences.length) parts.push(`preferred: ${item.preferences.join(', ')}`);
  return parts.join('; ');
}

function findItem(cart: Cart, itemId: string): CartItem {
  const item = cart.items.find(entry => entry.id === itemId);
  if (!item) throw new ValidationError(`No cart item has id ${itemId}. Call getCurrentCart for current item ids.`);
  return item;
}

/** Drop choice groups that no longer have two alternatives. */
function normalizeGroups(items: CartItem[]): CartItem[] {
  const sizes = new Map<string, number>();
  for (const item of items) if (item.choiceGroup) sizes.set(item.choiceGroup, (sizes.get(item.choiceGroup) ?? 0) + 1);
  return items.map(item => {
    if (!item.choiceGroup || (sizes.get(item.choiceGroup) ?? 0) >= 2) return item;
    const { choiceGroup: _removed, ...rest } = item;
    return rest;
  });
}

/**
 * Apply validated operations to a copy of the cart. Any change that can alter the
 * basket increments itemsVersion, which marks the stored calculation as stale.
 */
export function applyCartOperations(cart: Cart, operations: CartOperation[], now = new Date()): {
  cart: Cart;
  changes: string[];
  calculationAffected: boolean;
  addedItemIds: string[];
} {
  let next: Cart = { ...cart, items: [...cart.items], recipePlans: [...cart.recipePlans] };
  const changes: string[] = [];
  const addedItemIds: string[] = [];
  let calculationAffected = false;

  const replaceItem = (itemId: string, patch: Partial<CartItem>) => {
    findItem(next, itemId);
    next.items = next.items.map(item => (item.id === itemId ? { ...item, ...patch } : item));
  };

  for (const operation of operations) {
    switch (operation.op) {
      case 'add_items': {
        const groups = new Map<string, string>();
        for (const validated of operation.items) {
          const choiceGroup = validated.choiceGroup
            ? (groups.get(validated.choiceGroup) ?? groups.set(validated.choiceGroup, newId('grp')).get(validated.choiceGroup))
            : undefined;
          const item: CartItem = {
            id: newId('itm'),
            product: validated.product,
            searchTerms: validated.searchTerms,
            requirements: validated.requirements,
            preferences: validated.preferences,
            constraintEvidence: validated.constraintEvidence,
            quantity: validated.quantity,
            sourceText: validated.sourceText,
            ...(choiceGroup ? { choiceGroup } : {}),
            origin: { type: 'DIRECT', ...(operation.messageId ? { messageId: operation.messageId } : {}) },
            addedAt: now
          };
          next.items.push(item);
          addedItemIds.push(item.id);
          changes.push(`Added ${describeItem(item)}${choiceGroup ? ' as an alternative' : ''}.`);
        }
        calculationAffected = true;
        break;
      }
      case 'add_recipe': {
        const recipePlanId = newId('rcp');
        const recipe: RecipePlan = {
          id: recipePlanId,
          ...operation.plan,
          ingredients: [],
          createdAt: now
        };
        for (const ingredient of operation.ingredients) {
          let itemId: string | undefined;
          if (!ingredient.optional) {
            const item: CartItem = {
              id: newId('itm'),
              product: ingredient.product,
              searchTerms: ingredient.searchTerms,
              requirements: ingredient.requirements,
              preferences: ingredient.preferences,
              constraintEvidence: ingredient.constraintEvidence,
              quantity: ingredient.quantity,
              origin: { type: 'RECIPE', recipePlanId, dish: operation.plan.dish },
              addedAt: now
            };
            next.items.push(item);
            addedItemIds.push(item.id);
            itemId = item.id;
          }
          recipe.ingredients.push({
            name: ingredient.name, quantity: ingredient.quantity, optional: ingredient.optional,
            ...(ingredient.note ? { note: ingredient.note } : {}), ...(itemId ? { itemId } : {})
          });
        }
        next.recipePlans.push(recipe);
        const optional = recipe.ingredients.filter(entry => entry.optional).map(entry => entry.name);
        changes.push(`Added ${recipe.ingredients.length - optional.length} ingredients for ${recipe.dish} (${recipe.servings} servings${recipe.servingsSource === 'ASSUMED' ? ', assumed' : ''}).` +
          (optional.length ? ` Optional, not added: ${optional.join(', ')}.` : ''));
        calculationAffected = true;
        break;
      }
      case 'remove_items': {
        const removed = operation.itemIds.map(id => findItem(next, id));
        const ids = new Set(operation.itemIds);
        next.items = normalizeGroups(next.items.filter(item => !ids.has(item.id)));
        next.recipePlans = next.recipePlans.map(plan => ({
          ...plan,
          ingredients: plan.ingredients.map(ingredient => {
            if (!ingredient.itemId || !ids.has(ingredient.itemId)) return ingredient;
            const { itemId: _removed, ...rest } = ingredient;
            return rest;
          })
        }));
        for (const item of removed) changes.push(`Removed ${item.product}.`);
        calculationAffected = true;
        break;
      }
      case 'set_quantity': {
        const item = findItem(next, operation.itemId);
        replaceItem(operation.itemId, { quantity: operation.quantity });
        changes.push(`Changed ${item.product} from ${formatQuantity(item.quantity)} to ${formatQuantity(operation.quantity)}.`);
        calculationAffected = true;
        break;
      }
      case 'set_constraints': {
        const item = findItem(next, operation.itemId);
        replaceItem(operation.itemId, {
          requirements: operation.requirements,
          preferences: operation.preferences,
          constraintEvidence: operation.constraintEvidence
        });
        changes.push(`Updated ${item.product}: required [${operation.requirements.join(', ') || 'none'}], preferred [${operation.preferences.join(', ') || 'none'}].`);
        calculationAffected = true;
        break;
      }
      case 'set_search_terms': {
        const item = findItem(next, operation.itemId);
        replaceItem(operation.itemId, { searchTerms: operation.searchTerms });
        changes.push(`Search terms for ${item.product}: ${operation.searchTerms.join(', ')}.`);
        calculationAffected = true;
        break;
      }
      case 'set_mode': {
        const premium = operation.maxPremiumPct ?? next.maxPremiumPct;
        if (!Number.isFinite(premium) || premium < 0 || premium > 100) throw new ValidationError('maxPremiumPct must be between 0 and 100.');
        next = { ...next, mode: operation.mode, maxPremiumPct: premium };
        changes.push(`Shopping mode: ${operation.mode}${operation.mode === 'balanced' ? ` (up to ${premium}% above the cheapest complete basket)` : ''}.`);
        calculationAffected = true;
        break;
      }
      case 'set_budget': {
        next = { ...next, budget: operation.budget };
        changes.push(operation.budget ? `Budget: ${operation.budget.exclusive ? 'under' : 'at most'} ₪${operation.budget.amountIls}.` : 'Budget removed.');
        calculationAffected = true;
        break;
      }
      case 'select_store': {
        next = { ...next, selectedStoreKey: operation.storeKey };
        changes.push(operation.storeKey ? `Selected store ${operation.storeKey}.` : 'Showing the recommended store.');
        break;
      }
      case 'clear': {
        next = { ...next, items: [], recipePlans: [], selectedStoreKey: null, budget: null };
        changes.push('Cleared the cart.');
        calculationAffected = true;
        break;
      }
    }
  }
  if (next.items.length > MAX_CART_ITEMS) throw new ValidationError(`A cart can hold at most ${MAX_CART_ITEMS} items.`);
  if (calculationAffected) next = { ...next, itemsVersion: cart.itemsVersion + 1 };
  if (!next.items.length) next = { ...next, calculation: null };
  return { cart: next, changes, calculationAffected, addedItemIds };
}
