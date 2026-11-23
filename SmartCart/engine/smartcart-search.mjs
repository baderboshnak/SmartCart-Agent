
/**
 * SmartCart — local JSON Search Engine (NO MongoDB).
 *
 * Works with the existing smartcart-matcher.mjs:
 *   node smartcart-matcher.mjs search shopping-request.json catalog.json
 *
 * Or run this file on its own:
 *   node smartcart-search.mjs shopping-request.json catalog.json
 *
 * Searches ONLY product.name. It does NOT use attributes, manufacturer,
 * requirements, preferences, prices, scoring, or a result limit.
 * Product matching is a separate step performed by Gemini.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createItemContext, exactStoreKey, offerId } from './smartcart-pipeline-context.mjs';
import { assertShoppingPlanCoverage } from './smartcart-plan-validation.mjs';

/** Shared by the in-memory engine and the MongoDB `searchTokens` field. */
export function tokenize(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\p{Cf}]/gu, '')
    // Handle names like "חלב3%" as the words "חלב" and "3".
    .replace(/([\p{L}])([\p{N}])/gu, '$1 $2')
    .replace(/([\p{N}])([\p{L}])/gu, '$1 $2');

  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Index the JSON records in memory. Keep original records unchanged. */
export function buildCatalog(products) {
  if (!Array.isArray(products)) {
    throw new TypeError('The catalog JSON must contain an array of products.');
  }
  return products
    .filter(product => product && typeof product.name === 'string' && product.name.trim())
    .map(product => ({ product, words: tokenize(product.name) }));
}

/**
 * A search phrase matches when every word in it appears in the product name.
 * A word may also match the START of a longer product-name word, but only for
 * queries with at least 4 characters (to avoid excessive short-word matches).
 * Multiple search phrases are alternatives (OR), maximizing recall.
 */
function phraseMatches(nameWords, phraseWords) {
  return phraseWords.every(term => nameWords.some(word =>
    word === term || (term.length >= 4 && word.startsWith(term))
  ));
}

/** Return ALL matching products, without scores, ranking, or a fixed limit. */
export function searchCatalog(catalog, { searchTerms } = {}) {
  const terms = typeof searchTerms === 'string' ? [searchTerms] : searchTerms;
  if (!Array.isArray(terms)) {
    throw new TypeError('searchTerms must be a string or array of strings.');
  }

  const queries = terms
    .filter(term => typeof term === 'string')
    .map(tokenize)
    .filter(words => words.length);

  if (!queries.length) throw new Error('No usable search terms provided.');

  // Accept either a prebuilt index or the original JSON product array.
  const index = catalog.length && catalog[0]?.words && catalog[0]?.product
    ? catalog
    : buildCatalog(catalog);

  const results = [];
  const seen = new Map();

  for (const row of index) {
    if (!queries.some(query => phraseMatches(row.words, query))) continue;

    // Preserve separate store offers even if they have the same productCode.
    const id = offerId(row.product);
    if (id) {
      const key = JSON.stringify([exactStoreKey(row.product), id]);
      const records = seen.get(key) ?? new Set();
      const record = JSON.stringify(row.product);
      if (records.has(record)) continue;
      records.add(record);
      seen.set(key, records);
    }
    results.push(row.product); // Entire original object, price/store info intact.
  }

  return {
    searchTerms: terms,
    totalCandidates: results.length,
    results
  };
}

async function main() {
  const [requestFile, catalogFile, itemArg = '0'] = process.argv.slice(2);
  if (!requestFile || !catalogFile) {
    console.log('Usage: node smartcart-search.mjs shopping-request.json catalog.json [itemIndex]');
    return;
  }

  const itemIndex = Number(itemArg);
  if (!Number.isInteger(itemIndex) || itemIndex < 0) {
    throw new Error('itemIndex must be a nonnegative integer.');
  }

  const request = JSON.parse(await readFile(requestFile, 'utf8'));
  assertShoppingPlanCoverage(request);
  const item = request.items?.[itemIndex];
  if (!item) throw new Error(`No shopping item at index ${itemIndex}.`);

  const products = JSON.parse(await readFile(catalogFile, 'utf8'));
  const found = searchCatalog(buildCatalog(products), {
    searchTerms: item.searchTerms
  });

  const output = {
    itemIndex,
    context: createItemContext(request, itemIndex),
    searchTerms: found.searchTerms,
    totalCandidates: found.totalCandidates,
    results: found.results
  };

  await writeFile('search-results.json', JSON.stringify(output, null, 2), 'utf8');
  console.log(`Products in JSON file: ${products.length}`);
  console.log(`Search candidates: ${found.totalCandidates}`);
  console.log('Saved: search-results.json');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
