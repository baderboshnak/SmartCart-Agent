import type { Db } from 'mongodb';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import { findProducts } from '@/lib/db/products.repository';
import { retailerLabel, storeKeyOf } from '@/lib/catalog/normalize';
import { manufacturerName } from '@engine/smartcart-requirement-evidence.mjs';

/** Candidates per requested item sent to matching. Larger result sets are reported as truncated. */
export const ITEM_CANDIDATE_LIMIT = 800;

export interface SearchOutcome {
  terms: string[];
  candidates: CatalogRecord[];
  totalMatched: number;
  truncated: boolean;
  perStore: Record<string, number>;
  durationMs: number;
}

export interface CompactProduct {
  id: string;
  name: string;
  manufacturer: string | null;
  package: string;
  weighted: boolean;
  priceIls: number;
  store: string;
  storeKey: string;
}

export function compactProduct(record: CatalogRecord): CompactProduct {
  const unit = record.package?.unit ?? '?';
  return {
    id: record._id,
    name: record.name,
    manufacturer: manufacturerName(record) || null,
    package: `${record.package?.quantity ?? '?'} ${unit}`,
    weighted: record.package?.isWeighted === true,
    priceIls: record.pricing.listedPriceIls,
    store: `${retailerLabel(record.retailer)} ${record.storeId}`,
    storeKey: storeKeyOf(record)
  };
}

/** Full-recall candidate retrieval for one requested item, read from MongoDB. */
export async function searchItemCandidates(db: Db, item: EngineItem, options: { storeKeys?: string[]; limit?: number } = {}): Promise<SearchOutcome> {
  const started = Date.now();
  const found = await findProducts(db, {
    terms: item.searchTerms,
    storeKeys: options.storeKeys,
    limit: options.limit ?? ITEM_CANDIDATE_LIMIT
  });
  const perStore: Record<string, number> = {};
  for (const record of found.products) {
    const label = `${retailerLabel(record.retailer)} ${record.storeId}`;
    perStore[label] = (perStore[label] ?? 0) + 1;
  }
  return {
    terms: item.searchTerms,
    candidates: found.products,
    totalMatched: found.totalMatched,
    truncated: found.truncated,
    perStore,
    durationMs: Date.now() - started
  };
}

/** Bounded catalog exploration for questions such as availability. */
export async function exploreProducts(db: Db, terms: string[], options: { storeKeys?: string[]; limit?: number } = {}): Promise<{ totalMatched: number; results: CompactProduct[] }> {
  const found = await findProducts(db, { terms, storeKeys: options.storeKeys, limit: Math.min(options.limit ?? 15, 30) });
  return { totalMatched: found.totalMatched, results: found.products.map(compactProduct) };
}
