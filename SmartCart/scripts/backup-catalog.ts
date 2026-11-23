/**
 * Back up the JSON catalog outside the project, then optionally remove the original.
 *   npx tsx scripts/backup-catalog.ts --source "smartcart_products_DB(2).json" --dest "C:/Users/<you>/SmartCart-backups/catalog" [--remove-original]
 *
 * The original is removed only after the copy's SHA-256 matches the source and
 * MongoDB verification passes against the source.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { sha256 } from '@/lib/catalog/normalize';
import { verifyCatalog } from '@/lib/catalog/verify';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

runScript(async () => {
  const { flags } = parseArgs();
  const source = stringFlag(flags, 'source');
  const dest = stringFlag(flags, 'dest');
  if (!source || !dest) {
    console.log('Usage: npx tsx scripts/backup-catalog.ts --source <catalog.json> --dest <folder outside the project> [--remove-original]');
    return 2;
  }
  const sourcePath = resolve(source);
  const destDir = resolve(dest);
  if (!relative(process.cwd(), destDir).startsWith('..')) {
    throw new Error('The backup folder must be outside the active project folder.');
  }
  const original = await readFile(sourcePath);
  const sourceHash = sha256(original);
  await mkdir(destDir, { recursive: true });
  const target = join(destDir, basename(sourcePath));
  await copyFile(sourcePath, target);
  const copyHash = sha256(await readFile(target));
  if (copyHash !== sourceHash) throw new Error('Backup copy hash does not match the source. The original was kept.');

  const records = JSON.parse(original.toString('utf8')) as unknown[];
  const manifest = {
    file: basename(sourcePath),
    bytes: (await stat(target)).size,
    sha256: copyHash,
    records: records.length,
    backedUpAt: new Date().toISOString(),
    note: 'Original SmartCart product catalog. MongoDB Atlas (database smartcart, collection products) is now the runtime source.'
  };
  await writeFile(`${target}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Backup verified: ${target} (sha256 ${copyHash})`);

  if (!flags.has('remove-original')) return 0;
  const { client, db, dbName } = await openScriptDatabase(stringFlag(flags, 'db'));
  try {
    const report = await verifyCatalog(db, { sourceRecords: records, searchTerms: ['חלב', 'ביצים', 'לחם'] });
    if (!report.passed) {
      for (const entry of report.checks.filter(check => !check.passed)) console.error(`FAIL ${entry.name}: ${entry.details}`);
      throw new Error(`MongoDB database "${dbName}" does not match the catalog. The original was kept.`);
    }
  } finally {
    await client.close();
  }
  await rm(sourcePath);
  console.log(`Removed the original from the project: ${sourcePath}`);
  return 0;
});
