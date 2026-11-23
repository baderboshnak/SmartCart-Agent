/**
 * Read-only data-quality audit of the MongoDB catalog (reuses the engine audit).
 *   npm run catalog:audit [-- --as-of 2026-11-19 --examples 3]
 */
import { auditCatalog } from '@engine/smartcart-catalog-audit.mjs';
import { CATALOG_RECORD_PROJECTION } from '@/lib/catalog/normalize';
import { collections } from '@/lib/db/mongodb';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

runScript(async () => {
  const { flags } = parseArgs();
  const { client, db } = await openScriptDatabase(stringFlag(flags, 'db'));
  try {
    // An offline audit may read every record; the application never does.
    const records = await collections.products(db).find({}, { projection: CATALOG_RECORD_PROJECTION }).sort({ _id: 1 }).toArray();
    const report = auditCatalog(records, {
      asOf: stringFlag(flags, 'as-of'),
      maxExamples: Number(stringFlag(flags, 'examples') ?? 3)
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
});
