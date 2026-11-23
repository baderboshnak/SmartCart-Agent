import type { CreateIndexesOptions, Db, IndexSpecification } from 'mongodb';
import { COLLECTIONS } from '@/lib/db/mongodb';

interface IndexDefinition {
  collection: string;
  key: IndexSpecification;
  options: CreateIndexesOptions & { name: string };
  purpose: string;
}

export const INDEX_DEFINITIONS: IndexDefinition[] = [
  {
    collection: COLLECTIONS.products,
    key: { retailer: 1, chainId: 1, subChainId: 1, storeId: 1, productCode: 1 },
    options: { name: 'offer_identity_unique', unique: true },
    purpose: 'Stable unique offer identity: retailer + chain + subchain + store + product code.'
  },
  {
    collection: COLLECTIONS.products,
    key: { searchTokens: 1, storeKey: 1 },
    options: { name: 'search_tokens_store' },
    purpose: 'Hebrew token and prefix search, optionally restricted to exact stores.'
  },
  {
    collection: COLLECTIONS.products,
    key: { storeKey: 1, productCode: 1 },
    options: { name: 'store_product_code' },
    purpose: 'Products of one exact store, paginated or by product code.'
  },
  {
    collection: COLLECTIONS.products,
    key: { productCode: 1 },
    options: { name: 'product_code' },
    purpose: 'The same barcode across stores.'
  },
  {
    collection: COLLECTIONS.stores,
    key: { retailer: 1, storeId: 1 },
    options: { name: 'retailer_store' },
    purpose: 'Stores by retailer.'
  },
  {
    collection: COLLECTIONS.sessions,
    key: { expiresAt: 1 },
    options: { name: 'session_expiry_ttl', expireAfterSeconds: 0 },
    purpose: 'Anonymous sessions expire after inactivity.'
  },
  {
    collection: COLLECTIONS.sessions,
    key: { updatedAt: -1 },
    options: { name: 'session_updated' },
    purpose: 'Recent session lookups and maintenance.'
  },
  {
    collection: COLLECTIONS.carts,
    key: { sessionId: 1 },
    options: { name: 'cart_session_unique', unique: true },
    purpose: 'One authoritative cart per shopping session.'
  },
  {
    collection: COLLECTIONS.carts,
    key: { expiresAt: 1 },
    options: { name: 'cart_expiry_ttl', expireAfterSeconds: 0 },
    purpose: 'Carts expire with their sessions.'
  },
  {
    collection: COLLECTIONS.carts,
    key: { updatedAt: -1 },
    options: { name: 'cart_updated' },
    purpose: 'Recently updated carts.'
  },
  {
    collection: COLLECTIONS.agentRuns,
    key: { sessionId: 1, startedAt: -1 },
    options: { name: 'run_session_started' },
    purpose: 'Per-session run history and rate limiting.'
  },
  {
    collection: COLLECTIONS.agentRuns,
    key: { expiresAt: 1 },
    options: { name: 'run_expiry_ttl', expireAfterSeconds: 0 },
    purpose: 'Operational run metadata is retained for 30 days.'
  },
  {
    collection: COLLECTIONS.matchCache,
    key: { expiresAt: 1 },
    options: { name: 'match_cache_ttl', expireAfterSeconds: 0 },
    purpose: 'Cached matcher decisions expire after 14 days.'
  },
  {
    collection: COLLECTIONS.matchCache,
    key: { productId: 1 },
    options: { name: 'match_cache_product' },
    purpose: 'Invalidate cached decisions for a changed product.'
  }
];

/** createIndex is idempotent for identical definitions. */
export async function ensureIndexes(db: Db): Promise<Array<{ collection: string; name: string }>> {
  const created: Array<{ collection: string; name: string }> = [];
  for (const definition of INDEX_DEFINITIONS) {
    const name = await db.collection(definition.collection).createIndex(definition.key, definition.options);
    created.push({ collection: definition.collection, name });
  }
  return created;
}
