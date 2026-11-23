/**
 * Create every SmartCart MongoDB index. Safe to rerun.
 *   npm run db:indexes [-- --db smartcart]
 */
import { ensureIndexes } from '@/lib/db/indexes';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

runScript(async () => {
  const { flags } = parseArgs();
  const { client, db, dbName } = await openScriptDatabase(stringFlag(flags, 'db'));
  try {
    const created = await ensureIndexes(db);
    console.log(`Indexes ensured in database "${dbName}":`);
    for (const { collection, name } of created) console.log(`  ${collection}.${name}`);
  } finally {
    await client.close();
  }
});
