import type { CatalogRecord } from './engine-types.mjs';

export function tokenize(value: unknown): string[];
export function buildCatalog(products: unknown[]): Array<{ product: CatalogRecord; words: string[] }>;
export function searchCatalog(
  catalog: unknown[],
  options: { searchTerms: string | string[] }
): { searchTerms: string[]; totalCandidates: number; results: CatalogRecord[] };
