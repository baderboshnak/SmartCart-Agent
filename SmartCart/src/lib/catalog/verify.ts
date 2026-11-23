import type { Db } from 'mongodb';
import { buildCatalog, searchCatalog, tokenize } from '@engine/smartcart-search.mjs';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { collections } from '@/lib/db/mongodb';
import { INDEX_DEFINITIONS } from '@/lib/db/indexes';
import { findProductByCode, findProducts, findProductsByIds, MAX_SEARCH_LIMIT } from '@/lib/db/products.repository';
import { validateCatalogRecords } from '@/lib/catalog/import';
import { canonicalJson, contentHash, storeKeyOf, toCatalogRecord } from '@/lib/catalog/normalize';

/** Representative Hebrew searches: short exact tokens, prefixes, multi-word phrases, brands and numbers. */
export const VERIFICATION_SEARCH_TERMS = [
  'חלב', 'ביצים', 'לחם', 'מוצרלה', 'מוצרלה מגורדת', 'גבינה', 'גבינה צהובה', 'קוטג', 'יוגורט', 'חמאה', 'שמנת',
  'קמח', 'סוכר', 'מלח', 'שמן', 'שמן זית', 'אורז', 'פסטה', 'קפה', 'תה', 'שוקולד', 'במבה', 'עגבניות', 'מלפפון',
  'עוף', 'חזה עוף', 'טונה', 'רוטב עגבניות', 'קטשופ', 'מים', 'מיץ', 'תנובה', 'טרה', 'יטבתה', '3%', '1 ליטר',
  '500 גרם', 'לחמניות', 'פיתות', 'חומוס', 'טחינה', 'דבש', 'שקדים', 'בצק', 'שמרים', 'אבקת אפייה', 'קקאו',
  'ללא גלוטן', 'ללא לקטוז', 'משקה שיבולת שועל', 'ביצים XL', 'נייר טואלט', 'שמפו', 'פרוס'
];

export interface VerificationCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface CatalogVerificationReport {
  passed: boolean;
  checks: VerificationCheck[];
  counts: {
    dbProducts: number;
    sourceRecords: number | null;
    perStore: Record<string, number>;
    perRetailer: Record<string, number>;
    weighted: number;
    withManufacturerName: number;
  };
}

const sortedEqual = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/**
 * Verify the MongoDB catalog. With source records, every offer is compared field by
 * field and search results are compared with the original in-memory engine.
 */
export async function verifyCatalog(db: Db, options: { sourceRecords?: unknown; searchTerms?: string[] } = {}): Promise<CatalogVerificationReport> {
  const checks: VerificationCheck[] = [];
  const check = (name: string, passed: boolean, details: string) => checks.push({ name, passed, details });
  const products = collections.products(db);

  const perStore: Record<string, number> = {};
  const perRetailer: Record<string, number> = {};
  const dbDocs = new Map<string, Record<string, unknown>>();
  let weighted = 0;
  let withManufacturerName = 0;
  let tokenMismatches = 0;
  let centsMismatches = 0;
  let hashMismatches = 0;
  let storeKeyMismatches = 0;
  for await (const doc of products.find({})) {
    const record = toCatalogRecord(doc as unknown as Record<string, unknown>);
    dbDocs.set(doc._id, doc as unknown as Record<string, unknown>);
    perStore[doc.storeKey] = (perStore[doc.storeKey] ?? 0) + 1;
    perRetailer[doc.retailer] = (perRetailer[doc.retailer] ?? 0) + 1;
    if (doc.package?.isWeighted) weighted++;
    if (doc.manufacturer?.name?.trim()) withManufacturerName++;
    const tokens = tokenize(doc.name);
    if (!sortedEqual(doc.searchTokens ?? [], [...new Set(tokens)]) || doc.normalizedName !== tokens.join(' ')) tokenMismatches++;
    if (doc.pricing?.listedPriceCents !== Math.round(doc.pricing.listedPriceIls * 100)) centsMismatches++;
    if (doc.catalog?.contentHash !== contentHash(record)) hashMismatches++;
    if (doc.storeKey !== storeKeyOf(doc) || doc._id !== `${storeKeyOf(doc)}:${doc.productCode}`) storeKeyMismatches++;
  }
  check('derived search tokens', tokenMismatches === 0, `${tokenMismatches} documents with tokens that differ from tokenize(name).`);
  check('integer price cents', centsMismatches === 0, `${centsMismatches} documents with inconsistent listedPriceCents.`);
  check('content hashes', hashMismatches === 0, `${hashMismatches} documents whose stored hash differs from their content.`);
  check('offer identity', storeKeyMismatches === 0, `${storeKeyMismatches} documents with an _id or storeKey that differs from retailer:chain:subchain:store[:code].`);

  const duplicateGroups = await products.aggregate([
    { $group: { _id: { r: '$retailer', c: '$chainId', s: '$subChainId', st: '$storeId', p: '$productCode' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'groups' }
  ]).toArray();
  const duplicates = Number(duplicateGroups[0]?.groups ?? 0);
  check('no duplicate offers', duplicates === 0, `${duplicates} duplicate offer identities.`);

  const indexNames = new Set((await products.indexes()).map(index => index.name));
  const expected = INDEX_DEFINITIONS.filter(definition => definition.collection === 'products').map(definition => definition.options.name);
  const missingIndexes = expected.filter(name => !indexNames.has(name));
  check('product indexes', missingIndexes.length === 0, missingIndexes.length ? `Missing: ${missingIndexes.join(', ')}` : `All ${expected.length} product indexes exist.`);

  const stores = await collections.stores(db).find({}).toArray();
  const storeMismatch = stores.filter(store => perStore[store._id] !== store.productCount).map(store => store._id);
  const unlistedStores = Object.keys(perStore).filter(key => !stores.some(store => store._id === key));
  check('stores collection', storeMismatch.length === 0 && unlistedStores.length === 0,
    `${stores.length} store documents; ${storeMismatch.length} with wrong counts; ${unlistedStores.length} product stores without a store document.`);

  let sourceCount: number | null = null;
  if (options.sourceRecords !== undefined) {
    const source = validateCatalogRecords(options.sourceRecords);
    sourceCount = Array.isArray(options.sourceRecords) ? options.sourceRecords.length : 0;
    check('source validation', source.rejected.length === 0 && source.conflictingDuplicateIds.length === 0,
      `${source.records.length} valid, ${source.rejected.length} rejected, ${source.duplicateIdenticalRecords} identical duplicates.`);
    const sourceStores = new Set(source.records.map(storeKeyOf));
    const dbInSourceStores = [...dbDocs.values()].filter(doc => sourceStores.has(String(doc.storeKey)));
    check('product count', dbInSourceStores.length === source.records.length,
      `MongoDB has ${dbInSourceStores.length} offers for the source stores; the source has ${source.records.length}.`);
    const expectedPerStore: Record<string, number> = {};
    for (const record of source.records) expectedPerStore[storeKeyOf(record)] = (expectedPerStore[storeKeyOf(record)] ?? 0) + 1;
    const storeDiffs = Object.entries(expectedPerStore).filter(([key, count]) => perStore[key] !== count);
    check('per-store counts', storeDiffs.length === 0,
      storeDiffs.length ? storeDiffs.map(([key, count]) => `${key}: expected ${count}, found ${perStore[key] ?? 0}`).join('; ')
        : Object.entries(expectedPerStore).map(([key, count]) => `${key}=${count}`).join(', '));

    let missing = 0;
    let fieldDiffs = 0;
    const examples: string[] = [];
    for (const record of source.records) {
      const doc = dbDocs.get(record._id);
      if (!doc) {
        missing++;
        if (examples.length < 5) examples.push(`missing ${record._id}`);
        continue;
      }
      if (canonicalJson(toCatalogRecord(doc)) !== canonicalJson(record)) {
        fieldDiffs++;
        if (examples.length < 5) examples.push(`fields differ for ${record._id}`);
      }
    }
    check('every offer imported', missing === 0, `${missing} source offers are missing from MongoDB. ${examples.filter(e => e.startsWith('missing')).join(', ')}`);
    check('fields preserved exactly', fieldDiffs === 0,
      `${fieldDiffs} offers differ in identity, name, manufacturer, package, pricing, dates or source fields. ${examples.filter(e => e.startsWith('fields')).join(', ')}`);
    const sourceIds = new Set(source.records.map(record => record._id));
    const extra = dbInSourceStores.filter(doc => !sourceIds.has(String(doc._id))).length;
    check('no unexpected offers', extra === 0, `${extra} MongoDB offers in the source stores are absent from the source.`);
    const sourceWeighted = source.records.filter(record => record.package.isWeighted).length;
    const sourceManufacturers = source.records.filter(record => record.manufacturer?.name?.trim()).length;
    check('weighted products', sourceWeighted === weighted, `source ${sourceWeighted}, MongoDB ${weighted}.`);
    check('manufacturer information', sourceManufacturers === withManufacturerName, `source ${sourceManufacturers}, MongoDB ${withManufacturerName} offers with a manufacturer name.`);

    const engineCatalog = buildCatalog(source.records);
    const terms = options.searchTerms ?? VERIFICATION_SEARCH_TERMS;
    const searchDiffs: string[] = [];
    let compared = 0;
    for (const term of terms) {
      const expectedIds = searchCatalog(engineCatalog, { searchTerms: [term] }).results.map(record => record._id);
      const found = await findProducts(db, { terms: [term], limit: MAX_SEARCH_LIMIT });
      compared++;
      const actualIds = found.products.map(record => record._id);
      if (found.totalMatched !== expectedIds.length || !sortedEqual(expectedIds, actualIds)) {
        searchDiffs.push(`${term}: engine ${expectedIds.length}, MongoDB ${found.totalMatched}`);
      }
    }
    check('search equivalence with the original engine', searchDiffs.length === 0,
      searchDiffs.length ? searchDiffs.join('; ') : `${compared} Hebrew searches returned identical offer sets.`);

    const sample = source.records.filter((_, index) => index % Math.max(1, Math.floor(source.records.length / 25)) === 0).slice(0, 25);
    const byIds = await findProductsByIds(db, sample.map(record => record._id));
    const retrievalOk = sample.every(record => canonicalJson(byIds.get(record._id)) === canonicalJson(record));
    const byCode = sample[0] ? await findProductByCode(db, sample[0].productCode, storeKeyOf(sample[0])) : [];
    check('retrieval by id and code', retrievalOk && (!sample[0] || byCode.some(record => record._id === sample[0]!._id)),
      `${sample.length} sampled offers retrieved by id; product-code lookup ${byCode.length ? 'succeeded' : 'returned nothing'}.`);
  }

  return {
    passed: checks.every(entry => entry.passed),
    checks,
    counts: { dbProducts: dbDocs.size, sourceRecords: sourceCount, perStore, perRetailer, weighted, withManufacturerName }
  };
}

export type { CatalogRecord };
