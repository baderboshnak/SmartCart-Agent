import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tokenize } from '@engine/smartcart-search.mjs';
import type { CatalogRecord } from '@engine/engine-types.mjs';

const identifier = z.string().trim().min(1).max(64).refine(value => !value.includes(':'), 'must not contain ":"');
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;

/** Validates one source offer. The original record object is what gets stored. */
export const CatalogRecordSchema = z.object({
  _id: z.string().trim().min(1).max(300),
  retailer: identifier,
  chainId: identifier,
  subChainId: identifier,
  storeId: identifier,
  productCode: identifier,
  name: z.string().trim().min(1).max(500),
  manufacturer: z.object({ name: z.string().optional(), country: z.string().optional() }).loose().optional(),
  package: z.object({
    quantity: z.number().refine(Number.isFinite, 'must be a finite number'),
    unit: z.string().optional(),
    isWeighted: z.boolean()
  }).loose(),
  pricing: z.object({
    listedPriceIls: z.number().positive().max(1_000_000).refine(twoDecimals, 'must have at most two decimal places'),
    publishedUnitPriceIls: z.number().optional(),
    publishedUnitPriceBasis: z.string().optional()
  }).loose(),
  priceUpdatedAt: z.string().optional(),
  snapshotDate: z.string().optional(),
  source: z.object({}).loose().optional()
}).loose();

/** Fields the import adds. They are excluded when original records are read back. */
export const DERIVED_FIELDS = ['storeKey', 'normalizedName', 'searchTokens', 'catalog', 'dataQuality', 'importedAt', 'updatedAt'] as const;

/** Exclusion projection that returns exactly the original catalog record. */
export const CATALOG_RECORD_PROJECTION: Record<string, 0> = {
  ...Object.fromEntries(DERIVED_FIELDS.map(field => [field, 0])),
  'pricing.listedPriceCents': 0
};

export interface ProductDocument extends CatalogRecord {
  storeKey: string;
  normalizedName: string;
  searchTokens: string[];
  pricing: CatalogRecord['pricing'] & { listedPriceCents: number };
  catalog: { sourceFile: string; sourceSha256: string; contentHash: string };
  dataQuality?: string[];
  importedAt: Date;
  updatedAt: Date;
}

export const RETAILER_LABELS: Record<string, string> = {
  shufersal: 'Shufersal',
  rami_levy: 'Rami Levy'
};

export function retailerLabel(retailer: string): string {
  return RETAILER_LABELS[retailer] ?? retailer.replace(/_/gu, ' ').replace(/\b\p{L}/gu, letter => letter.toUpperCase());
}

/** Display names are derived from known identifiers. Addresses are never invented. */
export function storeDisplayName(retailer: string, storeId: string): string {
  return `${retailerLabel(retailer)} · store ${storeId}`;
}

export function storeKeyOf(record: Pick<CatalogRecord, 'retailer' | 'chainId' | 'subChainId' | 'storeId'>): string {
  return [record.retailer, record.chainId, record.subChainId, record.storeId].map(part => String(part).trim()).join(':');
}

export function offerIdentity(record: Pick<CatalogRecord, 'retailer' | 'chainId' | 'subChainId' | 'storeId' | 'productCode'>): string {
  return `${storeKeyOf(record)}:${String(record.productCode).trim()}`;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(ordered(value));
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash of the original record content; used for idempotent imports and migration checks. */
export function contentHash(record: unknown): string {
  return sha256(canonicalJson(record));
}

export function searchFields(name: string): { normalizedName: string; searchTokens: string[] } {
  const tokens = tokenize(name);
  return { normalizedName: tokens.join(' '), searchTokens: [...new Set(tokens)] };
}

const SUPPORTED_UNITS = new Set(['g', 'kg', 'ml', 'l', 'unit', 'units']);

function dataQuality(record: CatalogRecord): string[] {
  const flags: string[] = [];
  if (typeof record.package.unit !== 'string' || !record.package.unit.trim()) flags.push('MISSING_PACKAGE_UNIT');
  else if (!SUPPORTED_UNITS.has(record.package.unit)) flags.push('UNSUPPORTED_PACKAGE_UNIT');
  if (!(record.package.quantity > 0)) flags.push('INVALID_PACKAGE_QUANTITY');
  if (!record.manufacturer?.name?.trim()) flags.push('MISSING_MANUFACTURER_NAME');
  if (record.package.isWeighted) flags.push('WEIGHTED_PRICE_REFERENCE');
  return flags;
}

export function toProductDocument(
  record: CatalogRecord,
  meta: { sourceFile: string; sourceSha256: string; now: Date; importedAt?: Date }
): ProductDocument {
  const original = structuredClone(record);
  const flags = dataQuality(record);
  return {
    ...original,
    storeKey: storeKeyOf(record),
    ...searchFields(record.name),
    pricing: { ...original.pricing, listedPriceCents: Math.round(record.pricing.listedPriceIls * 100) },
    catalog: { sourceFile: meta.sourceFile, sourceSha256: meta.sourceSha256, contentHash: contentHash(record) },
    ...(flags.length ? { dataQuality: flags } : {}),
    importedAt: meta.importedAt ?? meta.now,
    updatedAt: meta.now
  };
}

/** Strip derived fields to recover the original catalog record. */
export function toCatalogRecord(document: Record<string, unknown>): CatalogRecord {
  const record: Record<string, unknown> = { ...document };
  for (const field of DERIVED_FIELDS) delete record[field];
  if (record.pricing && typeof record.pricing === 'object') {
    const { listedPriceCents: _ignored, ...pricing } = record.pricing as Record<string, unknown>;
    record.pricing = pricing;
  }
  return record as CatalogRecord;
}
