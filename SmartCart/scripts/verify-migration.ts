/**
 * Verify the MongoDB catalog.
 *   npm run db:verify -- --source "smartcart_products_DB(2).json"   (full comparison with the JSON)
 *   npm run db:verify                                               (database-only consistency checks)
 * Exits with code 1 when any check fails.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyCatalog } from '@/lib/catalog/verify';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

runScript(async () => {
  const { flags } = parseArgs();
  const source = stringFlag(flags, 'source');
  const sourceRecords = source ? JSON.parse(await readFile(resolve(source), 'utf8')) : undefined;
  const { client, db, dbName } = await openScriptDatabase(stringFlag(flags, 'db'));
  try {
    const report = await verifyCatalog(db, { sourceRecords });
    console.log(`Catalog verification for database "${dbName}"${source ? ` against ${source}` : ' (database-only checks)'}`);
    for (const entry of report.checks) console.log(`  ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}: ${entry.details}`);
    console.log(JSON.stringify(report.counts, null, 2));
    console.log(report.passed ? 'All checks passed.' : 'Verification FAILED.');
    return report.passed ? 0 : 1;
  } finally {
    await client.close();
  }
});
