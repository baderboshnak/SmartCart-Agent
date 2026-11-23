import type { Db } from 'mongodb';
import type { MatchDecision } from '@engine/smartcart-matcher.mjs';
import { collections } from '@/lib/db/mongodb';

export const MATCH_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A validated matcher decision for one key: the item's constraints, the offer, the product
 * fields the matcher judges (name, manufacturer, package) and the model. A price or date
 * change keeps the key. Cached decisions are re-validated deterministically before reuse.
 */
export interface MatchCacheDocument {
  _id: string;
  productId: string;
  itemKey: string;
  /** Fingerprint of the product's name, manufacturer and package (matchProductFingerprint). */
  productHash: string;
  model: string;
  decision: MatchDecision;
  createdAt: Date;
  expiresAt: Date;
}

export async function getCachedDecisions(db: Db, keys: string[]): Promise<Map<string, MatchCacheDocument>> {
  if (!keys.length) return new Map();
  const rows = await collections.matchCache(db).find({ _id: { $in: keys }, expiresAt: { $gt: new Date() } }).toArray();
  return new Map(rows.map(row => [row._id, row]));
}

export async function saveCachedDecisions(db: Db, entries: MatchCacheDocument[]): Promise<void> {
  if (!entries.length) return;
  await collections.matchCache(db).bulkWrite(
    entries.map(entry => ({ replaceOne: { filter: { _id: entry._id }, replacement: entry, upsert: true } })),
    { ordered: false }
  );
}

export async function invalidateProducts(db: Db, productIds: string[]): Promise<number> {
  if (!productIds.length) return 0;
  return (await collections.matchCache(db).deleteMany({ productId: { $in: productIds } })).deletedCount;
}
