/**
 * One-time (and safely repeatable) import of the JSON product catalog into MongoDB Atlas.
 *   npm run db:migrate -- --source "smartcart_products_DB(2).json" [--db smartcart] [--dry-run] [--prune]
 *
 * - Validates every record and its composite offer identity.
 * - Upserts by _id (retailer:chainId:subChainId:storeId:productCode); unchanged records are skipped.
 * - Writes a JSON report to reports/.
 * The source file is never modified.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { importCatalog } from '@/lib/catalog/import';
import { sha256 } from '@/lib/catalog/normalize';
import { ensureIndexes } from '@/lib/db/indexes';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

runScript(async () => {
  const { flags } = parseArgs();
  const source = stringFlag(flags, 'source');
  if (!source) {
    console.log('Usage: npm run db:migrate -- --source <catalog.json> [--db smartcart] [--dry-run] [--prune]');
    return 2;
  }
  const dryRun = flags.has('dry-run');
  const prune = flags.has('prune');
  const buffer = await readFile(resolve(source));
  const sourceSha256 = sha256(buffer);
  const records: unknown = JSON.parse(buffer.toString('utf8'));
  const { client, db, dbName } = await openScriptDatabase(stringFlag(flags, 'db'));
  try {
    console.log(`Source ${basename(source)} (${buffer.length} bytes, sha256 ${sourceSha256})`);
    console.log(`Target database "${dbName}"${dryRun ? ' (dry run: no writes)' : ''}`);
    if (!dryRun) await ensureIndexes(db);
    let lastPrinted = 0;
    const report = await importCatalog(db, records, {
      sourceFile: basename(source), sourceSha256, dryRun, prune,
      onProgress: (processed, total) => {
        if (processed - lastPrinted >= 5000 || processed === total) {
          lastPrinted = processed;
          console.log(`  processed ${processed}/${total}`);
        }
      }
    });
    console.log(JSON.stringify({
      sourceRecords: report.sourceRecords,
      validRecords: report.validRecords,
      rejected: report.rejected.length,
      duplicateIdenticalRecords: report.duplicateIdenticalRecords,
      conflictingDuplicateIds: report.conflictingDuplicateIds.length,
      inserted: report.inserted,
      updated: report.updated,
      unchanged: report.unchanged,
      dbOffersNotInSource: report.dbOffersNotInSource,
      pruned: report.pruned,
      stores: report.stores,
      durationMs: report.durationMs
    }, null, 2));
    for (const rejected of report.rejected.slice(0, 20)) {
      console.warn(`Rejected record #${rejected.index} (${rejected.id ?? 'no id'}): ${rejected.reasons.join('; ')}`);
    }
    if (!dryRun) {
      await mkdir('reports', { recursive: true });
      const stamp = report.finishedAt.replace(/[:.]/gu, '-');
      const path = resolve('reports', `migration-${dbName}-${stamp}.json`);
      await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.log(`Report saved: ${path}`);
    }
    return report.rejected.length || report.conflictingDuplicateIds.length ? 2 : 0;
  } finally {
    await client.close();
  }
});
