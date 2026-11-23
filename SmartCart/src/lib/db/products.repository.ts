import type { Db, Filter } from 'mongodb';
import { tokenize } from '@engine/smartcart-search.mjs';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { collections } from '@/lib/db/mongodb';
import { CATALOG_RECORD_PROJECTION, type ProductDocument } from '@/lib/catalog/normalize';
import { ValidationError } from '@/lib/shared/errors';

export const MAX_SEARCH_LIMIT = 2000;
const MAX_PHRASES = 12;
const MAX_WORDS_PER_PHRASE = 6;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Tokenize search phrases exactly as the original in-memory search engine does. */
export function searchPhrases(terms: string[]): string[][] {
  return terms
    .filter(term => typeof term === 'string')
    .map(term => tokenize(term))
    .filter(words => words.length > 0);
}

/**
 * Same semantics as engine/smartcart-search.mjs: every word of a phrase must equal a
 * name token, or prefix one when the word has at least 4 characters. Phrases are ORed.
 */
export function buildSearchFilter(phrases: string[][], storeKeys?: string[]): Filter<ProductDocument> {
  if (!phrases.length) throw new ValidationError('No usable search terms were provided.');
  if (phrases.length > MAX_PHRASES || phrases.some(words => words.length > MAX_WORDS_PER_PHRASE)) {
    throw new ValidationError(`Use at most ${MAX_PHRASES} search phrases of up to ${MAX_WORDS_PER_PHRASE} words.`);
  }
  const clauses = phrases.map(words => ({
    $and: words.map(word => word.length >= 4
      ? { searchTokens: { $regex: `^${escapeRegex(word)}` } }
      : { searchTokens: word })
  }));
  const filter: Filter<ProductDocument> = clauses.length === 1 ? clauses[0]! : { $or: clauses };
  return storeKeys?.length ? { $and: [filter, { storeKey: { $in: storeKeys } }] } : filter;
}

export interface ProductSearchResult {
  products: CatalogRecord[];
  totalMatched: number;
  truncated: boolean;
}

/** Bounded, projected search. Results are original catalog records in a stable order. */
export async function findProducts(db: Db, options: { terms: string[]; storeKeys?: string[]; limit: number }): Promise<ProductSearchResult> {
  const limit = Math.max(1, Math.min(options.limit, MAX_SEARCH_LIMIT));
  const filter = buildSearchFilter(searchPhrases(options.terms), options.storeKeys);
  const products = collections.products(db);
  const [totalMatched, rows] = await Promise.all([
    products.countDocuments(filter),
    products.find(filter, { projection: CATALOG_RECORD_PROJECTION }).sort({ _id: 1 }).limit(limit).toArray()
  ]);
  return { products: rows as unknown as CatalogRecord[], totalMatched, truncated: totalMatched > rows.length };
}

export async function findProductsByIds(db: Db, ids: string[]): Promise<Map<string, CatalogRecord>> {
  if (!ids.length) return new Map();
  const rows = await collections.products(db)
    .find({ _id: { $in: [...new Set(ids)] } }, { projection: CATALOG_RECORD_PROJECTION })
    .toArray();
  return new Map(rows.map(row => [row._id, row as unknown as CatalogRecord]));
}

/** Keyset pagination over one exact store. */
export async function findProductsByStore(db: Db, storeKey: string, options: { limit?: number; afterId?: string } = {}): Promise<CatalogRecord[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const filter: Filter<ProductDocument> = options.afterId
    ? { storeKey, _id: { $gt: options.afterId } }
    : { storeKey };
  const rows = await collections.products(db)
    .find(filter, { projection: CATALOG_RECORD_PROJECTION })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray();
  return rows as unknown as CatalogRecord[];
}

export async function findProductByCode(db: Db, productCode: string, storeKey?: string): Promise<CatalogRecord[]> {
  const filter: Filter<ProductDocument> = storeKey ? { storeKey, productCode } : { productCode };
  const rows = await collections.products(db).find(filter, { projection: CATALOG_RECORD_PROJECTION }).limit(50).toArray();
  return rows as unknown as CatalogRecord[];
}

export async function countProducts(db: Db, filter: Filter<ProductDocument> = {}): Promise<number> {
  return collections.products(db).countDocuments(filter);
}
