import type { Db } from 'mongodb';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { storeDisplayName, toProductDocument } from '@/lib/catalog/normalize';
import { COLLECTIONS } from '@/lib/db/mongodb';

type Row = Record<string, unknown>;
type Filter = Record<string, unknown>;
type Update = Record<string, Row>;
type Sort = Record<string, 1 | -1>;

const at = (row: unknown, path: string) => path.split('.').reduce<unknown>((value, key) => (value as Row | null)?.[key], row);
const scalar = (value: unknown) => value instanceof Date ? value.getTime() : value;

function compare(a: unknown, b: unknown): number {
  const left = scalar(a);
  const right = scalar(b);
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function matches(row: Row, filter: Filter): boolean {
  return Object.entries(filter).every(([key, criterion]) => {
    if (key === '$and') return (criterion as Filter[]).every(entry => matches(row, entry));
    if (key === '$or') return (criterion as Filter[]).some(entry => matches(row, entry));
    const value = at(row, key);
    const values = Array.isArray(value) ? value : [value];
    if (criterion === null) return value == null;
    if (typeof criterion !== 'object') return values.includes(criterion);
    return Object.entries(criterion).every(([operator, operand]) => {
      switch (operator) {
        case '$in': return values.some(entry => (operand as unknown[]).includes(entry));
        case '$regex': return values.some(entry => new RegExp(String(operand), 'u').test(String(entry)));
        case '$gt': return value !== undefined && compare(value, operand) > 0;
        case '$lt': return value !== undefined && compare(value, operand) < 0;
        default: throw new Error(`Unsupported fixture query operator ${operator}`);
      }
    });
  });
}

function apply(row: Row, update: Update) {
  Object.assign(row, structuredClone(update.$set ?? {}));
  for (const [key, increment] of Object.entries(update.$inc ?? {})) row[key] = Number(row[key]) + Number(increment);
  for (const [key, push] of Object.entries(update.$push ?? {})) {
    const { $each, $slice } = push as { $each: unknown[]; $slice?: number };
    const values = [...(row[key] as unknown[] ?? []), ...structuredClone($each)];
    row[key] = $slice === undefined ? values : $slice < 0 ? values.slice($slice) : values.slice(0, $slice);
  }
}

/** Implements the repository query subset for backend interaction tests. This is not MongoDB. */
export function fixtureDb(catalog: CatalogRecord[], options: { queryDelay?: () => Promise<void> } = {}) {
  const tables = new Map<string, Row[]>();
  const timing = { productQueriesMs: 0, cacheLookupMs: 0, productQueries: 0, cacheLookups: 0, cacheWrites: 0 };
  const products = catalog.map(product => toProductDocument(product, { sourceFile: 'offline-fixture', sourceSha256: 'offline', now: new Date(0) }) as unknown as Row);
  tables.set(COLLECTIONS.products, products);
  const stores = new Map<string, Row>();
  for (const product of catalog) {
    const storeKey = product._id.split(':').slice(0, 4).join(':');
    const store = stores.get(storeKey) ?? {
      _id: storeKey, storeKey, retailer: product.retailer, storeId: product.storeId,
      chainId: product.chainId, subChainId: product.subChainId,
      displayName: storeDisplayName(product.retailer, product.storeId),
      displayNameSource: 'DERIVED_FROM_RETAILER_AND_STORE_ID', productCount: 0, weightedProductCount: 0,
      snapshotDates: [], priceUpdatedAtRange: { min: null, max: null }, importedAt: new Date(0), updatedAt: new Date(0)
    };
    store.productCount = Number(store.productCount) + 1;
    if (product.package.isWeighted) store.weightedProductCount = Number(store.weightedProductCount) + 1;
    if (product.snapshotDate) store.snapshotDates = [...new Set([...(store.snapshotDates as string[]), product.snapshotDate])];
    stores.set(storeKey, store);
  }
  tables.set(COLLECTIONS.stores, [...stores.values()]);

  const timed = async <T>(name: string, work: () => T): Promise<T> => {
    const start = performance.now();
    if (options.queryDelay) await options.queryDelay();
    const result = work();
    if (name === COLLECTIONS.products) { timing.productQueries++; timing.productQueriesMs += performance.now() - start; }
    if (name === COLLECTIONS.matchCache) { timing.cacheLookups++; timing.cacheLookupMs += performance.now() - start; }
    return result;
  };

  return {
    timing, tables,
    db: {
      collection(name: string) {
        if (!tables.has(name)) tables.set(name, []);
        const rows = tables.get(name)!;
        const find = (filter: Filter) => rows.filter(row => matches(row, filter));
        return {
          async insertOne(row: Row) { rows.push(structuredClone(row)); },
          findOne: (filter: Filter) => timed(name, () => structuredClone(find(filter)[0] ?? null)),
          countDocuments: (filter: Filter = {}) => timed(name, () => find(filter).length),
          async findOneAndUpdate(filter: Filter, update: Update, settings: { upsert?: boolean } = {}) {
            let row = find(filter)[0];
            if (!row && settings.upsert) {
              row = structuredClone(update.$setOnInsert ?? {});
              rows.push(row);
            }
            if (!row) return null;
            apply(row, update);
            return structuredClone(row);
          },
          async updateOne(filter: Filter, update: Update) {
            const row = find(filter)[0];
            if (row) apply(row, update);
          },
          find(filter: Filter = {}, settings: { projection?: Record<string, number> } = {}) {
            let sort: Sort = {};
            let limit = Infinity;
            return {
              sort(value: Sort) { sort = value; return this; },
              limit(value: number) { limit = value; return this; },
              toArray() {
                return timed(name, () => find(filter).sort((left, right) => {
                  for (const [key, direction] of Object.entries(sort)) {
                    const difference = compare(at(left, key), at(right, key));
                    if (difference) return difference * direction;
                  }
                  return 0;
                }).slice(0, limit).map(source => {
                  const row = structuredClone(source);
                  for (const [key, flag] of Object.entries(settings.projection ?? {})) {
                    if (flag === 0) delete row[key];
                    else throw new Error(`Unsupported fixture projection on ${key}`);
                  }
                  return row;
                }));
              }
            };
          },
          async bulkWrite(operations: Array<{ replaceOne: { filter: Filter; replacement: Row } }>) {
            for (const { replaceOne } of operations) {
              const index = rows.findIndex(row => matches(row, replaceOne.filter));
              const replacement = structuredClone(replaceOne.replacement);
              if (index < 0) rows.push(replacement);
              else rows[index] = replacement;
            }
            if (name === COLLECTIONS.matchCache) timing.cacheWrites += operations.length;
          }
        };
      }
    } as unknown as Db
  };
}
