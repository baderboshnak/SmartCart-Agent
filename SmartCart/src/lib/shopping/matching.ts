import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from 'mongodb';
import { matchProducts, type CallModel, type MatchDecision, type MatchResults } from '@engine/smartcart-matcher.mjs';
import { containerType, parseUnit } from '@engine/smartcart-package.mjs';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import { canonicalJson, sha256 } from '@/lib/catalog/normalize';
import { getCachedDecisions, MATCH_CACHE_TTL_MS, saveCachedDecisions, type MatchCacheDocument } from '@/lib/db/match-cache.repository';

/**
 * Parallel batch streams per item. A single large item (for example 800 candidates,
 * 32 batches) can use every slot of its cart's limit instead of queueing in a few streams.
 */
export const DEFAULT_ITEM_CONCURRENCY = 12;

/** Bump when the matcher prompt or its deterministic validation changes. */
export const MATCH_CACHE_VERSION = 'matcher-v2';

export interface MatcherDeps {
  db: Db | null;
  callModel: CallModel;
  model: string;
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { processed: number; total: number }) => void;
}

export interface MatchOutcome {
  results: MatchResults;
  cachedDecisions: number;
  evaluated: number;
  modelCalls: number;
  durationMs: number;
}

/**
 * Cache key for decisions about one requested item. It covers everything the matcher
 * prompt uses to judge identity and requirements. The requested amount is excluded:
 * it does not change identity, and size requirements are re-verified deterministically.
 */
export function matchItemKey(item: EngineItem, model: string): string {
  const unit = item.quantity?.unit;
  const quantityShape = unit === 'unspecified' ? 'unspecified' : (containerType(unit) ?? parseUnit(unit)?.family ?? String(unit));
  return sha256(canonicalJson({
    version: MATCH_CACHE_VERSION,
    model,
    product: item.product,
    requirements: item.requirements,
    preferences: item.preferences,
    constraints: (item.constraintEvidence ?? []).map(({ type, kind, value, sourceText }) => ({ type, kind, value, sourceText })),
    quantityShape,
    range: item.quantity?.maxAmount !== undefined
  }));
}

/**
 * Fingerprint of the product fields the matcher judges: name, manufacturer and package.
 * Gemini sees only these plus the offer ID (which is a separate part of the cache key), and
 * the deterministic evidence checks read the same fields. Prices, price dates, the snapshot
 * date and import metadata are left out, so a catalog refresh that changes only those reuses
 * saved decisions. Prices still come from the current record, never from the cache.
 */
export function matchProductFingerprint(product: CatalogRecord): string {
  return sha256(canonicalJson({
    name: product.name,
    manufacturer: product.manufacturer ?? null,
    package: product.package ?? null
  }));
}

function partition<T>(values: T[], parts: number, batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += batchSize) batches.push(values.slice(start, start + batchSize));
  const groups: T[][] = Array.from({ length: Math.min(parts, batches.length) }, () => []);
  batches.forEach((batch, index) => groups[index % groups.length]!.push(...batch));
  return groups;
}

const noModel: CallModel = async () => {
  throw new Error('Internal error: cached decisions must not call the model.');
};

/**
 * Match candidates with the original engine matcher. Validated decisions are cached
 * in MongoDB and re-validated deterministically before reuse; uncached candidates are
 * evaluated in parallel partitions with bounded concurrency.
 */
export async function matchItemCandidates(item: EngineItem, candidates: CatalogRecord[], deps: MatcherDeps): Promise<MatchOutcome> {
  const started = Date.now();
  const itemKey = matchItemKey(item, deps.model);
  const fingerprints = new Map(candidates.map(product => [product._id, matchProductFingerprint(product)]));
  const cacheKey = (product: CatalogRecord) => sha256(`${itemKey}:${product._id}:${fingerprints.get(product._id)}`);
  const cached = deps.db ? await getCachedDecisions(deps.db, candidates.map(cacheKey)) : new Map<string, MatchCacheDocument>();

  const cachedProducts: CatalogRecord[] = [];
  const cachedDecisions: MatchDecision[] = [];
  let pending: CatalogRecord[] = [];
  for (const product of candidates) {
    const hit = cached.get(cacheKey(product));
    if (hit && hit.decision.id === product._id) {
      cachedProducts.push(product);
      cachedDecisions.push(hit.decision);
    } else {
      pending.push(product);
    }
  }

  const parts: MatchResults[] = [];
  let reused = 0;
  if (cachedProducts.length) {
    try {
      // matchProducts re-validates each cached decision against the current item and product.
      parts.push(await matchProducts({ item, products: cachedProducts, initialDecisions: cachedDecisions, callModel: noModel }));
      reused = cachedProducts.length;
    } catch {
      pending = [...cachedProducts, ...pending];
    }
  }

  let modelCalls = 0;
  const countingModel: CallModel = async args => {
    deps.signal?.throwIfAborted();
    modelCalls++;
    return deps.callModel(args);
  };
  const saved = new Set(cachedProducts.slice(0, reused).map(product => product._id));
  const byId = new Map(candidates.map(product => [product._id, product]));
  const persist = async (decisions: MatchDecision[]) => {
    if (!deps.db) return;
    const now = new Date();
    const fresh = decisions.filter(decision => !saved.has(decision.id) && byId.has(decision.id));
    for (const decision of fresh) saved.add(decision.id);
    await saveCachedDecisions(deps.db, fresh.map(decision => {
      const product = byId.get(decision.id)!;
      return {
        _id: cacheKey(product), productId: product._id, itemKey, productHash: fingerprints.get(product._id)!,
        model: deps.model, decision, createdAt: now, expiresAt: new Date(now.getTime() + MATCH_CACHE_TTL_MS)
      };
    }));
  };

  const batchSize = deps.batchSize ?? 25;
  const groups = partition(pending, Math.max(1, deps.concurrency ?? DEFAULT_ITEM_CONCURRENCY), batchSize);
  const processed = groups.map(() => 0);
  const report = () => deps.onProgress?.({ processed: reused + processed.reduce((sum, value) => sum + value, 0), total: candidates.length });
  report();
  const evaluated = await Promise.all(groups.map((products, index) => matchProducts({
    item,
    products,
    batchSize,
    maxAttempts: 4,
    callModel: countingModel,
    // The engine computes 100/200/400 ms backoff; real rate limits need longer pauses.
    waitForRetry: milliseconds => delay(milliseconds * 10, undefined, { signal: deps.signal }),
    onProgress: progress => {
      processed[index] = progress.processed;
      report();
    },
    onCheckpoint: async ({ decisions }) => persist(decisions)
  })));
  parts.push(...evaluated);

  const order = new Map(candidates.map((product, index) => [product._id, index]));
  const byOrder = (a: { product: CatalogRecord }, b: { product: CatalogRecord }) =>
    (order.get(a.product._id) ?? 0) - (order.get(b.product._id) ?? 0);
  const results: MatchResults = {
    item,
    totalCandidates: candidates.length,
    matches: parts.flatMap(part => part.matches).sort(byOrder),
    rejected: parts.flatMap(part => part.rejected).sort(byOrder),
    uncertain: parts.flatMap(part => part.uncertain).sort(byOrder)
  };
  return { results, cachedDecisions: reused, evaluated: pending.length, modelCalls, durationMs: Date.now() - started };
}
