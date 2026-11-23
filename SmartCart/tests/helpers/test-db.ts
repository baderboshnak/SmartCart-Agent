import { randomBytes } from 'node:crypto';
import type { Db, MongoClient } from 'mongodb';
import { importCatalog } from '@/lib/catalog/import';
import { ensureIndexes } from '@/lib/db/indexes';
import { connectMongo } from '@/lib/db/mongodb';
import { loadEnvFileForScripts } from '@/lib/env';
import { catalogFixture, catalogFixtureSha256 } from './fixtures';

const TEST_DB_PATTERN = /^smartcart_test_[a-z0-9_]+$/u;

export interface TestDatabase {
  client: MongoClient;
  db: Db;
  name: string;
  cleanup: () => Promise<void>;
}

loadEnvFileForScripts();

/** Database tests run only when MONGODB_URI is configured. */
export const databaseSkipReason = process.env.MONGODB_URI ? false : 'MONGODB_URI is not set; database tests are skipped.';

/**
 * A disposable, uniquely named database on the configured cluster. Tests never touch
 * the application database: the name must match smartcart_test_* and differ from MONGODB_DB_NAME.
 */
export async function createTestDatabase(options: { seed?: boolean } = {}): Promise<TestDatabase> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set.');
  const name = `smartcart_test_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  if (!TEST_DB_PATTERN.test(name) || name === process.env.MONGODB_DB_NAME) throw new Error(`Unsafe test database name ${name}.`);
  const client = await connectMongo(uri);
  const db = client.db(name);
  await ensureIndexes(db);
  if (options.seed) {
    await importCatalog(db, catalogFixture, { sourceFile: 'catalog-sample.json', sourceSha256: catalogFixtureSha256 });
  }
  return {
    client,
    db,
    name,
    async cleanup() {
      if (!TEST_DB_PATTERN.test(db.databaseName) || db.databaseName === process.env.MONGODB_DB_NAME) {
        throw new Error(`Refusing to drop ${db.databaseName}.`);
      }
      await db.dropDatabase();
      await client.close();
    }
  };
}
