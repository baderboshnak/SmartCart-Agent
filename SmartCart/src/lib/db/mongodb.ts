import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { getServerEnv } from '@/lib/env';
import { DatabaseUnavailableError, errorMessage } from '@/lib/shared/errors';
import type { AgentRunDocument, Cart, ShoppingSession, StoreDocument } from '@/lib/shared/types';
import type { MatchCacheDocument } from '@/lib/db/match-cache.repository';
import type { ProductDocument } from '@/lib/catalog/normalize';

export const COLLECTIONS = {
  products: 'products',
  stores: 'stores',
  sessions: 'shopping_sessions',
  carts: 'carts',
  agentRuns: 'agent_runs',
  matchCache: 'match_cache'
} as const;

interface MongoCache {
  client?: MongoClient;
  connecting?: Promise<MongoClient>;
}

// One pooled client per server process. The global survives dev hot reloads.
const globalStore = globalThis as typeof globalThis & { __smartcartMongo?: MongoCache };
const cache: MongoCache = (globalStore.__smartcartMongo ??= {});

export function createMongoClient(uri: string): MongoClient {
  return new MongoClient(uri, {
    appName: 'smartcart',
    maxPoolSize: 20,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 10_000,
    retryWrites: true,
    retryReads: true
  });
}

export async function connectMongo(uri: string): Promise<MongoClient> {
  const client = createMongoClient(uri);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw new DatabaseUnavailableError(`Cannot connect to MongoDB Atlas: ${errorMessage(error)}`, { cause: error });
  }
}

/** The shared application client. Never falls back to local data. */
export async function getMongoClient(): Promise<MongoClient> {
  if (cache.client) return cache.client;
  cache.connecting ??= connectMongo(getServerEnv().MONGODB_URI)
    .then(client => {
      cache.client = client;
      return client;
    })
    .finally(() => {
      cache.connecting = undefined;
    });
  return cache.connecting;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getServerEnv().MONGODB_DB_NAME);
}

export async function closeMongoClient(): Promise<void> {
  const client = cache.client;
  cache.client = undefined;
  await client?.close();
}

export async function pingDatabase(db: Db): Promise<void> {
  try {
    await db.command({ ping: 1 });
  } catch (error) {
    throw new DatabaseUnavailableError(`MongoDB ping failed: ${errorMessage(error)}`, { cause: error });
  }
}

/** Typed collection accessors keep collection names in one place. */
export const collections = {
  products: (db: Db): Collection<ProductDocument> => db.collection<ProductDocument>(COLLECTIONS.products),
  stores: (db: Db): Collection<StoreDocument> => db.collection<StoreDocument>(COLLECTIONS.stores),
  sessions: (db: Db): Collection<ShoppingSession> => db.collection<ShoppingSession>(COLLECTIONS.sessions),
  carts: (db: Db): Collection<Cart> => db.collection<Cart>(COLLECTIONS.carts),
  agentRuns: (db: Db): Collection<AgentRunDocument> => db.collection<AgentRunDocument>(COLLECTIONS.agentRuns),
  matchCache: (db: Db): Collection<MatchCacheDocument> => db.collection<MatchCacheDocument>(COLLECTIONS.matchCache)
};

export type AnyDocument = Document;
