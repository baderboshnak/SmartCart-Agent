import type { Db } from 'mongodb';
import { z } from 'zod';
import type { CallModel } from '@engine/smartcart-matcher.mjs';
import { isKnownBrand } from '@engine/smartcart-requirement-evidence.mjs';
import { getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { ConflictError, errorMessage, ValidationError } from '@/lib/shared/errors';
import { SHOPPING_MODES, type Cart, type ConstraintEvidence } from '@/lib/shared/types';
import { QuantitySchema } from '@/lib/agent/schemas';
import { applyCartOperations, type CartOperation } from '@/lib/shopping/cart-ops';
import { isCalculationFresh } from '@/lib/shopping/optimizer';
import { CartPipeline } from '@/lib/shopping/pipeline';
import { validateQuantity } from '@/lib/shopping/request-items';

const itemId = z.string().trim().min(1).max(64);

/** Direct customer edits from the cart UI. */
export const UiCartOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove_item'), itemId }),
  z.object({ op: z.literal('set_quantity'), itemId, quantity: QuantitySchema }),
  z.object({ op: z.literal('set_mode'), mode: z.enum(SHOPPING_MODES) }),
  z.object({ op: z.literal('select_store'), storeKey: z.string().trim().max(120).nullable() }),
  z.object({ op: z.literal('remove_constraint'), itemId, value: z.string().trim().min(1).max(60) }),
  z.object({ op: z.literal('toggle_constraint'), itemId, value: z.string().trim().min(1).max(60) }),
  z.object({ op: z.literal('recalculate') }),
  z.object({ op: z.literal('clear') })
]);

export const UiCartPatchSchema = z.object({
  expectedRevision: z.number().int().min(0),
  operation: UiCartOperationSchema
});

export type UiCartOperation = z.infer<typeof UiCartOperationSchema>;

function constraintsUpdate(cart: Cart, id: string, edit: (entries: ConstraintEvidence[]) => ConstraintEvidence[]): CartOperation {
  const item = cart.items.find(entry => entry.id === id);
  if (!item) throw new ValidationError('That item is no longer in the cart.');
  const evidence = edit(item.constraintEvidence);
  return {
    op: 'set_constraints',
    itemId: id,
    requirements: evidence.filter(entry => entry.type === 'REQUIREMENT').map(entry => entry.value),
    preferences: evidence.filter(entry => entry.type === 'PREFERENCE').map(entry => entry.value),
    constraintEvidence: evidence
  };
}

function toOperations(cart: Cart, operation: UiCartOperation): CartOperation[] {
  switch (operation.op) {
    case 'remove_item':
      return [{ op: 'remove_items', itemIds: [operation.itemId] }];
    case 'set_quantity':
      return [{ op: 'set_quantity', itemId: operation.itemId, quantity: validateQuantity(operation.quantity) }];
    case 'set_mode':
      return [{ op: 'set_mode', mode: operation.mode }];
    case 'select_store': {
      if (operation.storeKey) {
        const complete = isCalculationFresh(cart) ? cart.calculation!.result.storeComparisons.map(store => store.storeKey) : [];
        if (!complete.includes(operation.storeKey)) throw new ValidationError('That store has no complete verified basket.');
      }
      return [{ op: 'select_store', storeKey: operation.storeKey || null }];
    }
    case 'remove_constraint':
      return [constraintsUpdate(cart, operation.itemId, entries => {
        const next = entries.filter(entry => entry.value !== operation.value);
        if (next.length === entries.length) throw new ValidationError('That requirement or preference is not on the item.');
        return next;
      })];
    case 'toggle_constraint':
      return [constraintsUpdate(cart, operation.itemId, entries => {
        if (!entries.some(entry => entry.value === operation.value)) throw new ValidationError('That requirement or preference is not on the item.');
        return entries.map(entry => entry.value !== operation.value ? entry : {
          ...entry,
          type: entry.type === 'REQUIREMENT' ? 'PREFERENCE' : 'REQUIREMENT',
          kind: isKnownBrand(entry.value) ? 'BRAND' : entry.kind
        });
      })];
    case 'recalculate':
      return [];
    case 'clear':
      return [{ op: 'clear' }];
  }
}

/**
 * Apply one UI edit with optimistic concurrency, then recalculate and verify the
 * cart on the server. A failed recalculation leaves the edit saved and reports why.
 */
export async function applyUiCartEdit(db: Db, sessionId: string, input: z.infer<typeof UiCartPatchSchema>, deps: {
  matcher: { callModel: CallModel | null; model: string };
  signal?: AbortSignal;
}): Promise<{ cart: Cart; recalculationError: string | null }> {
  const cart = await getOrCreateCart(db, sessionId);
  if (cart.revision !== input.expectedRevision) throw new ConflictError();
  const operations = toOperations(cart, input.operation);
  let saved = cart;
  let needsCalculation = input.operation.op === 'recalculate';
  if (operations.length) {
    const { cart: next, calculationAffected } = applyCartOperations(cart, operations);
    saved = await saveCart(db, sessionId, cart.revision, mutableFields(next));
    needsCalculation = calculationAffected;
  }
  if (!needsCalculation || !saved.items.length) return { cart: saved, recalculationError: null };
  try {
    const pipeline = new CartPipeline({ db, matcher: deps.matcher, signal: deps.signal });
    const calculation = await pipeline.calculate(saved);
    saved = await saveCart(db, sessionId, saved.revision, { ...mutableFields(saved), calculation });
    return { cart: saved, recalculationError: null };
  } catch (error) {
    if (error instanceof ConflictError) return { cart: await getOrCreateCart(db, sessionId), recalculationError: null };
    return { cart: saved, recalculationError: errorMessage(error) };
  }
}
