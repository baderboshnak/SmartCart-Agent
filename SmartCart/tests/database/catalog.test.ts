import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { importCatalog } from '@/lib/catalog/import';
import { verifyCatalog } from '@/lib/catalog/verify';
import { collections, pingDatabase } from '@/lib/db/mongodb';
import { INDEX_DEFINITIONS } from '@/lib/db/indexes';
import { countProducts, findProductByCode, findProducts, findProductsByIds, findProductsByStore } from '@/lib/db/products.repository';
import { findStores } from '@/lib/db/stores.repository';
import { catalogFixture, catalogFixtureSha256, fixtureSearch, STORES } from '../helpers/fixtures';
import { createTestDatabase, databaseSkipReason, type TestDatabase } from '../helpers/test-db';

const ids = (rows: Array<{ _id: string }>) => rows.map(row => row._id).sort();

describe('catalog in MongoDB Atlas', { skip: databaseSkipReason }, () => {
  let testDb: TestDatabase;
  let firstReport: Awaited<ReturnType<typeof importCatalog>>;

  before(async () => {
    testDb = await createTestDatabase();
    firstReport = await importCatalog(testDb.db, catalogFixture, { sourceFile: 'catalog-sample.json', sourceSha256: catalogFixtureSha256 });
  });
  after(async () => { await testDb?.cleanup(); });

  test('1. connects to MongoDB and uses an isolated test database', async () => {
    await pingDatabase(testDb.db);
    assert.match(testDb.db.databaseName, /^smartcart_test_/u);
    assert.notEqual(testDb.db.databaseName, process.env.MONGODB_DB_NAME);
    const names = new Set((await collections.products(testDb.db).indexes()).map(index => index.name));
    for (const definition of INDEX_DEFINITIONS.filter(entry => entry.collection === 'products')) assert.ok(names.has(definition.options.name), definition.options.name);
  });

  test('2. migrates every catalog record with its stores', async () => {
    assert.equal(firstReport.validRecords, catalogFixture.length);
    assert.equal(firstReport.inserted, catalogFixture.length);
    assert.equal(firstReport.rejected.length, 0);
    assert.equal(await countProducts(testDb.db), catalogFixture.length);
    const stores = await findStores(testDb.db);
    assert.deepEqual(stores.map(store => store._id).sort(), [STORES.ramiLevy, STORES.shufersal].sort());
    assert.equal(stores.reduce((sum, store) => sum + store.productCount, 0), catalogFixture.length);
    assert.match(stores[0]!.displayName, /store \d+/u);
  });

  test('3. rerunning the migration is idempotent', async () => {
    const before = await collections.products(testDb.db).find({}, { projection: { importedAt: 1, updatedAt: 1 } }).toArray();
    const rerun = await importCatalog(testDb.db, catalogFixture, { sourceFile: 'catalog-sample.json', sourceSha256: catalogFixtureSha256 });
    assert.deepEqual([rerun.inserted, rerun.updated, rerun.unchanged], [0, 0, catalogFixture.length]);
    assert.equal(await countProducts(testDb.db), catalogFixture.length);
    const afterRerun = await collections.products(testDb.db).find({}, { projection: { importedAt: 1, updatedAt: 1 } }).toArray();
    assert.deepEqual(afterRerun, before, 'unchanged offers are not rewritten');

    const changed = structuredClone(catalogFixture);
    changed[0]!.pricing.listedPriceIls = 1.23;
    const update = await importCatalog(testDb.db, changed, { sourceFile: 'catalog-sample.json', sourceSha256: 'changed' });
    assert.deepEqual([update.inserted, update.updated], [0, 1]);
    const [stored] = (await findProductsByIds(testDb.db, [changed[0]!._id])).values();
    assert.equal(stored!.pricing.listedPriceIls, 1.23);
    await importCatalog(testDb.db, catalogFixture, { sourceFile: 'catalog-sample.json', sourceSha256: catalogFixtureSha256 });
  });

  test('4. verification confirms counts, identities, prices and preserved fields', async () => {
    const report = await verifyCatalog(testDb.db, { sourceRecords: catalogFixture, searchTerms: ['חלב', 'ביצים', 'לחם', 'מוצרלה', 'מוצרלה מגורדת', '3%'] });
    assert.equal(report.passed, true, report.checks.filter(check => !check.passed).map(check => `${check.name}: ${check.details}`).join('\n'));
    assert.equal(report.counts.dbProducts, catalogFixture.length);
    assert.equal(report.counts.perStore[STORES.shufersal]! + report.counts.perStore[STORES.ramiLevy]!, catalogFixture.length);

    const withMissing = catalogFixture.slice(1);
    const mismatch = await verifyCatalog(testDb.db, { sourceRecords: withMissing, searchTerms: [] });
    assert.equal(mismatch.passed, false, 'an offer in MongoDB but not in the source is detected');
  });

  test('5/6. Hebrew search from MongoDB returns exactly what the original engine returns', async () => {
    for (const term of ['חלב', 'ביצים', 'לחם', 'מוצרלה', 'מוצרלה מגורדת', 'קמח', 'שמרים', 'רוטב עגבניות', 'חלב 3%', 'תנובה']) {
      const found = await findProducts(testDb.db, { terms: [term], limit: 2000 });
      assert.deepEqual(ids(found.products), ids(fixtureSearch([term])), term);
      assert.equal(found.totalMatched, fixtureSearch([term]).length);
    }
    const prefix = await findProducts(testDb.db, { terms: ['מוצרל'], limit: 2000 });
    assert.ok(prefix.products.every(product => product.name.includes('מוצרל')), 'four-letter words match name prefixes');
    const either = await findProducts(testDb.db, { terms: ['ביצים', 'שמרים'], limit: 2000 });
    assert.equal(either.totalMatched, fixtureSearch(['ביצים', 'שמרים']).length);
    const egg = (await findProducts(testDb.db, { terms: ['ביצים'], limit: 2000 })).products.find(product => product.productCode === '7290001201572')!;
    assert.deepEqual(egg.package, { quantity: 1, unit: 'unit', isWeighted: false });
    assert.equal('searchTokens' in egg, false, 'search fields are not returned with catalog records');
  });

  test('searches are bounded and report truncation instead of loading everything', async () => {
    const found = await findProducts(testDb.db, { terms: ['חלב'], limit: 25 });
    assert.equal(found.products.length, 25);
    assert.equal(found.truncated, true);
    assert.equal(found.totalMatched, fixtureSearch(['חלב']).length);
  });

  test('7. filters products by exact store and paginates one store', async () => {
    const shufersal = await findProducts(testDb.db, { terms: ['ביצים'], storeKeys: [STORES.shufersal], limit: 2000 });
    assert.ok(shufersal.products.length > 0);
    assert.ok(shufersal.products.every(product => product._id.startsWith(`${STORES.shufersal}:`)));
    assert.equal(shufersal.totalMatched, fixtureSearch(['ביצים']).filter(product => product._id.startsWith(STORES.shufersal)).length);

    const page1 = await findProductsByStore(testDb.db, STORES.ramiLevy, { limit: 50 });
    const page2 = await findProductsByStore(testDb.db, STORES.ramiLevy, { limit: 50, afterId: page1.at(-1)!._id });
    assert.equal(page1.length, 50);
    assert.ok(page2[0]!._id > page1.at(-1)!._id);
    const sameBarcode = await findProductByCode(testDb.db, '7290014692817');
    assert.deepEqual(sameBarcode.map(product => product.retailer).sort(), ['rami_levy', 'shufersal'], 'one barcode, two exact-store offers');
  });
});
