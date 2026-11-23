import type { AnyBulkWriteOperation, Db } from 'mongodb';
import { collections } from '@/lib/db/mongodb';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import type { StoreDocument } from '@/lib/shared/types';
import {
  CatalogRecordSchema, canonicalJson, contentHash, offerIdentity, storeDisplayName, storeKeyOf, toProductDocument,
  type ProductDocument
} from '@/lib/catalog/normalize';

export interface RejectedRecord {
  index: number;
  id: string | null;
  reasons: string[];
}

export interface ImportReport {
  sourceFile: string;
  sourceSha256: string;
  dryRun: boolean;
  sourceRecords: number;
  validRecords: number;
  rejected: RejectedRecord[];
  duplicateIdenticalRecords: number;
  conflictingDuplicateIds: string[];
  inserted: number;
  updated: number;
  unchanged: number;
  pruned: number;
  dbOffersNotInSource: number;
  stores: Array<{ storeKey: string; productCount: number }>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface ValidatedCatalog {
  records: CatalogRecord[];
  rejected: RejectedRecord[];
  duplicateIdenticalRecords: number;
  conflictingDuplicateIds: string[];
}

/** Validate records, enforce the composite identity, and resolve duplicates without guessing. */
export function validateCatalogRecords(input: unknown): ValidatedCatalog {
  if (!Array.isArray(input)) throw new TypeError('The product catalog must be a JSON array of offers.');
  const rejected: RejectedRecord[] = [];
  const byId = new Map<string, { record: CatalogRecord; json: string; index: number }>();
  const conflicting = new Set<string>();
  let duplicateIdenticalRecords = 0;

  input.forEach((raw, index) => {
    const parsed = CatalogRecordSchema.safeParse(raw);
    const rawId = typeof (raw as { _id?: unknown })?._id === 'string' ? (raw as { _id: string })._id : null;
    if (!parsed.success) {
      rejected.push({ index, id: rawId, reasons: parsed.error.issues.map(issue => `${issue.path.join('.') || 'record'}: ${issue.message}`) });
      return;
    }
    // Store the original object so no source field is dropped or reshaped.
    const record = raw as CatalogRecord;
    const identity = offerIdentity(record);
    if (record._id !== identity) {
      rejected.push({ index, id: record._id, reasons: [`_id must equal retailer:chainId:subChainId:storeId:productCode (${identity}).`] });
      return;
    }
    const json = canonicalJson(record);
    const existing = byId.get(record._id);
    if (!existing) {
      byId.set(record._id, { record, json, index });
    } else if (existing.json === json) {
      duplicateIdenticalRecords++;
    } else {
      conflicting.add(record._id);
    }
  });

  for (const id of conflicting) {
    const entry = byId.get(id);
    byId.delete(id);
    rejected.push({ index: entry?.index ?? -1, id, reasons: ['Conflicting records share this offer identity; none were imported.'] });
  }
  return {
    records: [...byId.values()].map(entry => entry.record),
    rejected,
    duplicateIdenticalRecords,
    conflictingDuplicateIds: [...conflicting]
  };
}

function storeDocuments(records: CatalogRecord[], now: Date, previous: Map<string, Date>): StoreDocument[] {
  const groups = new Map<string, CatalogRecord[]>();
  for (const record of records) {
    const key = storeKeyOf(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups].map(([storeKey, group]) => {
    const first = group[0]!;
    const dates = group.map(record => record.priceUpdatedAt).filter((value): value is string => typeof value === 'string').sort();
    return {
      _id: storeKey,
      retailer: first.retailer,
      chainId: first.chainId,
      subChainId: first.subChainId,
      storeId: first.storeId,
      displayName: storeDisplayName(first.retailer, first.storeId),
      displayNameSource: 'DERIVED_FROM_RETAILER_AND_STORE_ID',
      productCount: group.length,
      weightedProductCount: group.filter(record => record.package.isWeighted).length,
      snapshotDates: [...new Set(group.map(record => record.snapshotDate).filter((value): value is string => typeof value === 'string'))].sort(),
      priceUpdatedAtRange: { min: dates[0] ?? null, max: dates.at(-1) ?? null },
      importedAt: previous.get(storeKey) ?? now,
      updatedAt: now
    };
  });
}

/**
 * Idempotent upsert of catalog offers. Unchanged offers are skipped by content hash,
 * so rerunning the same source performs no writes to products.
 */
export async function importCatalog(db: Db, input: unknown, options: {
  sourceFile: string;
  sourceSha256: string;
  batchSize?: number;
  dryRun?: boolean;
  prune?: boolean;
  onProgress?: (processed: number, total: number) => void;
}): Promise<ImportReport> {
  const startedAt = new Date();
  const { batchSize = 1000, dryRun = false, prune = false } = options;
  const validated = validateCatalogRecords(input);
  const products = collections.products(db);
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (let start = 0; start < validated.records.length; start += batchSize) {
    const batch = validated.records.slice(start, start + batchSize);
    const existing = new Map((await products
      .find({ _id: { $in: batch.map(record => record._id) } }, { projection: { 'catalog.contentHash': 1, importedAt: 1 } })
      .toArray()).map(doc => [doc._id, doc]));
    const operations: AnyBulkWriteOperation<ProductDocument>[] = [];
    const now = new Date();
    for (const record of batch) {
      const previous = existing.get(record._id);
      if (previous?.catalog?.contentHash === contentHash(record)) {
        unchanged++;
        continue;
      }
      const document = toProductDocument(record, {
        sourceFile: options.sourceFile, sourceSha256: options.sourceSha256, now, importedAt: previous?.importedAt
      });
      operations.push({ replaceOne: { filter: { _id: record._id }, replacement: document, upsert: true } });
      if (previous) updated++;
      else inserted++;
    }
    if (operations.length && !dryRun) await products.bulkWrite(operations, { ordered: false });
    options.onProgress?.(Math.min(start + batch.length, validated.records.length), validated.records.length);
  }

  const storeKeys = [...new Set(validated.records.map(storeKeyOf))];
  const sourceIds = new Set(validated.records.map(record => record._id));
  let dbOffersNotInSource = 0;
  let pruned = 0;
  const staleIds: string[] = [];
  for await (const doc of products.find({ storeKey: { $in: storeKeys } }, { projection: { _id: 1 } })) {
    if (!sourceIds.has(doc._id)) staleIds.push(doc._id);
  }
  dbOffersNotInSource = staleIds.length;
  if (prune && staleIds.length && !dryRun) {
    pruned = (await products.deleteMany({ _id: { $in: staleIds } })).deletedCount;
  }

  const now = new Date();
  const stores = collections.stores(db);
  const previousStores = new Map((await stores.find({ _id: { $in: storeKeys } }, { projection: { importedAt: 1 } }).toArray())
    .map(doc => [doc._id, doc.importedAt]));
  const storeDocs = storeDocuments(validated.records, now, previousStores);
  if (!dryRun && storeDocs.length) {
    await stores.bulkWrite(storeDocs.map(doc => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })));
  }

  const finishedAt = new Date();
  return {
    sourceFile: options.sourceFile,
    sourceSha256: options.sourceSha256,
    dryRun,
    sourceRecords: Array.isArray(input) ? input.length : 0,
    validRecords: validated.records.length,
    rejected: validated.rejected,
    duplicateIdenticalRecords: validated.duplicateIdenticalRecords,
    conflictingDuplicateIds: validated.conflictingDuplicateIds,
    inserted,
    updated,
    unchanged,
    pruned,
    dbOffersNotInSource,
    stores: storeDocs.map(doc => ({ storeKey: doc._id, productCount: doc.productCount })),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime()
  };
}
