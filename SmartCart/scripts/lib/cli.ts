import type { Db, MongoClient } from 'mongodb';
import { connectMongo } from '@/lib/db/mongodb';
import { getServerEnv, loadEnvFileForScripts } from '@/lib/env';

/** Flags that never take a value, so they cannot swallow the next argument. */
const BOOLEAN_FLAGS = new Set(['dry-run', 'prune', 'allow-live', 'cleanup', 'remove-original']);

export function parseArgs(argv = process.argv.slice(2)): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[index + 1];
    if (inline !== undefined) flags.set(name, inline);
    else if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index++;
    } else flags.set(name, true);
  }
  return { flags, positional };
}

export function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The Atlas cluster can host unrelated databases. Scripts only write to
 * databases whose names start with "smartcart".
 */
export function assertSmartCartDatabaseName(name: string): void {
  if (!/^smartcart(?:[_-][A-Za-z0-9_-]+)?$/u.test(name)) {
    throw new Error(`Refusing to use database "${name}". SmartCart scripts only use databases named smartcart or smartcart_*.`);
  }
}

export async function openScriptDatabase(dbOverride?: string): Promise<{ client: MongoClient; db: Db; dbName: string }> {
  loadEnvFileForScripts();
  const env = getServerEnv();
  const dbName = dbOverride ?? env.MONGODB_DB_NAME;
  assertSmartCartDatabaseName(dbName);
  const client = await connectMongo(env.MONGODB_URI);
  return { client, db: client.db(dbName), dbName };
}

export function runScript(main: () => Promise<number | void>): void {
  main().then(code => {
    process.exitCode = typeof code === 'number' ? code : 0;
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
