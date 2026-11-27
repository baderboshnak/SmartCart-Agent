import type { CatalogRecord } from './engine-types.mjs';

export function tokenize(value: unknown): string[];
/** False for a phrase with Arabic letters: catalog names are Hebrew, so it can never match. */
export function isCatalogSearchTerm(term: unknown): boolean;
/** Other singular and plural forms of a Hebrew search word: name-word prefixes and whole words. */
export function hebrewWordForms(word: string): { prefixes: string[]; exact: string[] };
export function wordMatches(nameWord: string, term: string): boolean;
export function buildCatalog(products: unknown[]): Array<{ product: CatalogRecord; words: string[] }>;
export function searchCatalog(
  catalog: unknown[],
  options: { searchTerms: string | string[] }
): { searchTerms: string[]; totalCandidates: number; results: CatalogRecord[] };
