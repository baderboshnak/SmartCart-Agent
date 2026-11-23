import type { Db } from 'mongodb';
import { collections } from '@/lib/db/mongodb';
import { newId, SESSION_TTL_MS } from '@/lib/db/sessions.repository';
import { ConflictError, NotFoundError } from '@/lib/shared/errors';
import { DEFAULT_MAX_PREMIUM_PCT, type Cart } from '@/lib/shared/types';

function emptyCart(sessionId: string, now: Date): Cart {
  return {
    _id: newId('cart'),
    sessionId,
    revision: 0,
    itemsVersion: 0,
    mode: 'balanced',
    maxPremiumPct: DEFAULT_MAX_PREMIUM_PCT,
    budget: null,
    items: [],
    recipePlans: [],
    selectedStoreKey: null,
    calculation: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS)
  };
}

export async function getCart(db: Db, sessionId: string): Promise<Cart | null> {
  return collections.carts(db).findOne({ sessionId });
}

/** Idempotently create the session's single cart. */
export async function getOrCreateCart(db: Db, sessionId: string): Promise<Cart> {
  const { _id, ...fields } = emptyCart(sessionId, new Date());
  const cart = await collections.carts(db).findOneAndUpdate(
    { sessionId },
    { $setOnInsert: { _id, ...fields } },
    { upsert: true, returnDocument: 'after' }
  );
  if (!cart) throw new NotFoundError('The cart could not be created.');
  return cart;
}

type MutableCartFields = Pick<Cart,
  'items' | 'itemsVersion' | 'mode' | 'maxPremiumPct' | 'budget' | 'recipePlans' | 'selectedStoreKey' | 'calculation'>;

/**
 * Optimistic concurrency: the write succeeds only if the stored revision still equals
 * expectedRevision. Every successful write increments the revision.
 */
export async function saveCart(db: Db, sessionId: string, expectedRevision: number, fields: MutableCartFields): Promise<Cart> {
  const now = new Date();
  const updated = await collections.carts(db).findOneAndUpdate(
    { sessionId, revision: expectedRevision },
    {
      $set: { ...fields, updatedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
      $inc: { revision: 1 }
    },
    { returnDocument: 'after' }
  );
  if (!updated) throw new ConflictError();
  return updated;
}

export function mutableFields(cart: Cart): MutableCartFields {
  const { items, itemsVersion, mode, maxPremiumPct, budget, recipePlans, selectedStoreKey, calculation } = cart;
  return { items, itemsVersion, mode, maxPremiumPct, budget, recipePlans, selectedStoreKey, calculation };
}
