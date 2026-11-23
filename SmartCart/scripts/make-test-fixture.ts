/**
 * Extract the deterministic catalog subset used by offline tests.
 *   npx tsx scripts/make-test-fixture.ts --source <catalog.json> [--out tests/fixtures/catalog-sample.json]
 *
 * The subset holds EVERY offer whose name matches each fixture term, so searching
 * these terms over the subset returns exactly the same offers as the full catalog.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildCatalog, searchCatalog } from '@engine/smartcart-search.mjs';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { sha256 } from '@/lib/catalog/normalize';
import { parseArgs, runScript, stringFlag } from './lib/cli';

export const FIXTURE_TERMS = ['חלב', 'ביצים', 'לחם', 'מוצרלה', 'קמח', 'שמרים', 'רוטב עגבניות', 'רוטב פיצה', 'בצק לפיצה'];
// Offers referenced by the opt-in live QA scenarios.
const FIXTURE_CODES = ['7290110563462', '7290013121028', '7290000554600'];

runScript(async () => {
  const { flags } = parseArgs();
  const source = stringFlag(flags, 'source');
  const out = stringFlag(flags, 'out') ?? 'tests/fixtures/catalog-sample.json';
  if (!source) {
    console.log('Usage: npx tsx scripts/make-test-fixture.ts --source <catalog.json> [--out <path>]');
    return 2;
  }
  const buffer = await readFile(resolve(source));
  const products = JSON.parse(buffer.toString('utf8')) as CatalogRecord[];
  const catalog = buildCatalog(products);
  const ids = new Set<string>();
  const perTerm: Record<string, number> = {};
  for (const term of FIXTURE_TERMS) {
    const { results } = searchCatalog(catalog, { searchTerms: [term] });
    perTerm[term] = results.length;
    for (const record of results) ids.add(record._id);
  }
  for (const record of products) if (FIXTURE_CODES.includes(record.productCode)) ids.add(record._id);
  const subset = products.filter(record => ids.has(record._id)).sort((a, b) => a._id.localeCompare(b._id));
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(resolve(out), `[\n${subset.map(record => JSON.stringify(record)).join(',\n')}\n]\n`, 'utf8');
  const meta = {
    description: 'Every catalog offer matching each term, extracted from the full snapshot for deterministic tests.',
    sourceSha256: sha256(buffer),
    sourceRecords: products.length,
    records: subset.length,
    terms: perTerm,
    codes: FIXTURE_CODES,
    createdAt: new Date().toISOString()
  };
  await writeFile(resolve(out.replace(/\.json$/u, '.meta.json')), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(meta, null, 2));
});
