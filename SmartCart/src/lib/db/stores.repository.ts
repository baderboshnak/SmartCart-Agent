import type { Db } from 'mongodb';
import { collections } from '@/lib/db/mongodb';
import type { StoreDocument } from '@/lib/shared/types';

export async function findStores(db: Db): Promise<StoreDocument[]> {
  return collections.stores(db).find({}).sort({ retailer: 1, storeId: 1 }).limit(500).toArray();
}

export async function findStoresByKeys(db: Db, keys: string[]): Promise<Map<string, StoreDocument>> {
  if (!keys.length) return new Map();
  const rows = await collections.stores(db).find({ _id: { $in: [...new Set(keys)] } }).toArray();
  return new Map(rows.map(row => [row._id, row]));
}
