import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from 'mongodb';
import {
  MATCHER_FINGERPRINT, matchProducts, readShoppingRequest, type CallModel, type MatchDecision, type MatchResults, type RequestReading
} from '@engine/smartcart-matcher.mjs';
import { containerType, parseUnit } from '@engine/smartcart-package.mjs';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import { canonicalJson, sha256 } from '@/lib/catalog/normalize';
import { getCachedDecisions, MATCH_CACHE_TTL_MS, saveCachedDecisions, type MatchCacheDocument } from '@/lib/db/match-cache.repository';

/**
 * Parallel batch streams per item. A single large item (for example 800 candidates,
 * 32 batches) can use every slot of its cart's limit instead of queueing in a few streams.
 */
export const DEFAULT_ITEM_CONCURRENCY = 12;

/**
 * Part of every cache key. MATCHER_FINGERPRINT changes with the matcher's instructions,
 * answer format and validation version, so decisions made under older matching rules
 * (such as v2 accepting condensed milk for "milk") are never looked up again.
 */
export const MATCH_CACHE_VERSION = `matcher-v3:${MATCHER_FINGERPRINT.slice(0, 16)}`;

/** The engine computes 100/200/400 ms backoff; real rate limits need longer pauses. */
const RETRY_PAUSE_FACTOR = 10;
/** A provider-requested pause is honored up to this long; the agent run has its own deadline. */
const MAX_PROVIDER_PAUSE_MS = 60_000;
const retryPause = (milliseconds: number, providerDelayMs?: number) =>
  Math.max(milliseconds * RETRY_PAUSE_FACTOR, Math.min(providerDelayMs ?? 0, MAX_PROVIDER_PAUSE_MS));

// Readings by item key, so this server process asks Gemini once per distinct request.
const readings = new Map<string, RequestReading>();
const MAX_READINGS = 500;
// Readings and decisions Gemini is making right now. When two customers ask for the same item
// at the same moment, the second waits for these instead of paying for the same answers again.
// A reading in flight settles to undefined when it fails, so a waiting request reads the item itself.
const readingsInFlight = new Map<string, Promise<RequestReading | null | undefined>>();
const decisionsInFlight = new Map<string, Promise<MatchDecision | null>>();

/** Wait for another request's answer, unless this request is cancelled first. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Claim the cache keys this request will decide. finish() releases any it did not decide. */
function claimDecisions(keys: string[]) {
  const claims = new Map<string, { promise: Promise<MatchDecision | null>; resolve: (decision: MatchDecision | null) => void }>();
  for (const key of keys) {
    let resolve!: (decision: MatchDecision | null) => void;
    const promise = new Promise<MatchDecision | null>(done => { resolve = done; });
    decisionsInFlight.set(key, promise);
    claims.set(key, { promise, resolve });
  }
  const settle = (key: string, decision: MatchDecision | null) => {
    const claim = claims.get(key);
    if (!claim) return;
    claims.delete(key);
    if (decisionsInFlight.get(key) === claim.promise) decisionsInFlight.delete(key);
    claim.resolve(decision);
  };
  return { decided: settle, finish: () => [...claims.keys()].forEach(key => settle(key, null)) };
}

/**
 * One reading per request, made before Gemini sees any candidate. Without it each batch reads
 * the request itself, and a batch of search results with no real match tends to accept the
 * closest ones (condensed milk for "milk"). A failed reading falls back to that per-batch reading.
 */
async function readingFor(itemKey: string, item: EngineItem, callModel: CallModel, deps: MatcherDeps): Promise<RequestReading | null> {
  const known = readings.get(itemKey);
  if (known) {
    deps.onReading?.({ reading: known, reused: true });
    return known;
  }
  const running = readingsInFlight.get(itemKey);
  if (running) {
    // Another request is reading the same item. If that reading failed, read it here instead.
    const reading = await waitFor(running, deps.signal);
    if (reading !== undefined) {
      deps.onReading?.({ reading, reused: true });
      return reading;
    }
  }
  const attempt = readShoppingRequest({ item, callModel });
  const shared = attempt.catch(() => undefined);
  readingsInFlight.set(itemKey, shared);
  try {
    const reading = await attempt;
    if (reading) {
      if (readings.size >= MAX_READINGS) readings.delete(readings.keys().next().value!);
      readings.set(itemKey, reading);
    }
    deps.onReading?.({ reading, reused: false });
    return reading;
  } catch (error) {
    deps.signal?.throwIfAborted();
    deps.onReading?.({ reading: null, reused: false, error });
    return null;
  } finally {
    if (readingsInFlight.get(itemKey) === shared) readingsInFlight.delete(itemKey);
  }
}

export interface MatcherDeps {
  db: Db | null;
  callModel: CallModel;
  model: string;
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { processed: number; total: number }) => void;
  /** A batch is asked again: Gemini's answer missed or broke decisions, or the call failed. */
  onRetry?: (retry: MatchRetry) => void;
  /** Gemini's reading of the request, shared by every batch; null when it could not be read. */
  onReading?: (event: { reading: RequestReading | null; reused: boolean; error?: unknown }) => void;
}

export interface MatchRetry {
  /** The attempt that failed (the next one is attempt + 1). */
  attempt: number;
  /** Products in the batch still without a valid decision. */
  missing: number;
  /** Why the attempt failed, such as the first invalid decision or the call's error. */
  reason: string;
  /** Pause before the next attempt, after a failed call. */
  waitMs?: number;
}

export interface MatchOutcome {
  results: MatchResults;
  cachedDecisions: number;
  /** Decisions another request was making at the same moment, reused instead of asked again. */
  sharedDecisions: number;
  evaluated: number;
  modelCalls: number;
  durationMs: number;
}

/**
 * Cache key for decisions about one requested item. It covers everything the matcher
 * prompt uses to judge identity and requirements. The requested amount is excluded:
 * it does not change identity, and size requirements are re-verified deterministically.
 */
export function matchItemKey(item: EngineItem, model: string, version: string = MATCH_CACHE_VERSION): string {
  const unit = item.quantity?.unit;
  const quantityShape = unit === 'unspecified' ? 'unspecified' : (containerType(unit) ?? parseUnit(unit)?.family ?? String(unit));
  return sha256(canonicalJson({
    version,
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

/** The cache document ID for one product under one item key. */
export function matchCacheKey(itemKey: string, product: CatalogRecord): string {
  return sha256(`${itemKey}:${product._id}:${matchProductFingerprint(product)}`);
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
  const keys = new Map(candidates.map(product => [product._id, matchCacheKey(itemKey, product)]));
  const cacheKey = (product: CatalogRecord) => keys.get(product._id)!;
  const cached = deps.db ? await getCachedDecisions(deps.db, candidates.map(cacheKey)) : new Map<string, MatchCacheDocument>();

  const cachedProducts: CatalogRecord[] = [];
  const cachedDecisions: MatchDecision[] = [];
  const uncached: CatalogRecord[] = [];
  for (const product of candidates) {
    const hit = cached.get(cacheKey(product));
    if (hit && hit.decision.id === product._id) {
      cachedProducts.push(product);
      cachedDecisions.push(hit.decision);
    } else {
      uncached.push(product);
    }
  }
  // Decisions another request is making right now are awaited instead of asked for again.
  // The rest are claimed before the next await, so a request arriving now waits for them.
  const shared = uncached.filter(product => decisionsInFlight.has(cacheKey(product)));
  const sharedAnswers = Promise.all(shared.map(product => decisionsInFlight.get(cacheKey(product))!));
  const sharedIds = new Set(shared.map(product => product._id));
  let pending = uncached.filter(product => !sharedIds.has(product._id));
  const claim = claimDecisions(pending.map(cacheKey));

  try {
    const parts: MatchResults[] = [];
    let reused = 0;
    let sharedReused = 0;
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
      for (const decision of decisions) {
        const product = byId.get(decision.id);
        if (product) claim.decided(cacheKey(product), decision);
      }
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
    const processed: number[] = [];
    const report = () => deps.onProgress?.({
      processed: reused + sharedReused + processed.reduce((sum, value) => sum + value, 0), total: candidates.length
    });
    const evaluate = async (products: CatalogRecord[]): Promise<MatchResults[]> => {
      if (!products.length) return [];
      const reading = await readingFor(itemKey, item, countingModel, deps);
      const groups = partition(products, Math.max(1, deps.concurrency ?? DEFAULT_ITEM_CONCURRENCY), batchSize);
      const offset = processed.length;
      processed.push(...groups.map(() => 0));
      report();
      return Promise.all(groups.map((group, index) => matchProducts({
        item,
        products: group,
        batchSize,
        maxAttempts: 4,
        callModel: countingModel,
        reading,
        waitForRetry: (milliseconds, providerDelayMs) => delay(retryPause(milliseconds, providerDelayMs), undefined, { signal: deps.signal }),
        onProgress: progress => {
          processed[offset + index] = progress.processed;
          if (progress.retry) {
            deps.onRetry?.({
              attempt: progress.retry, missing: progress.missing ?? 0, reason: progress.error ?? 'unknown',
              ...(progress.retryDelayMs !== undefined ? { waitMs: retryPause(progress.retryDelayMs, progress.providerDelayMs) } : {})
            });
          }
          report();
        },
        onCheckpoint: async ({ decisions }) => persist(decisions)
      })));
    };

    report();
    const [evaluated, answers] = await Promise.all([evaluate(pending), waitFor(sharedAnswers, deps.signal)]);
    parts.push(...evaluated);

    // The other request's decisions are re-validated like cached ones. Any it did not
    // finish (it failed or was cancelled) are decided here.
    const reusable = shared.filter((_, index) => answers[index]);
    let leftover = shared.filter((_, index) => !answers[index]);
    if (reusable.length) {
      try {
        parts.push(await matchProducts({
          item, products: reusable, initialDecisions: reusable.map(product => answers[shared.indexOf(product)]!), callModel: noModel
        }));
        sharedReused = reusable.length;
        report();
      } catch {
        leftover = [...reusable, ...leftover];
      }
    }
    parts.push(...await evaluate(leftover));

    const order = new Map(candidates.map((product, index) => [product._id, index]));
    const byOrder = (a: { product: CatalogRecord }, b: { product: CatalogRecord }) =>
      (order.get(a.product._id) ?? 0) - (order.get(b.product._id) ?? 0);
    const results: MatchResults = {
      item,
      totalCandidates: candidates.length,
      requestReadings: [...new Set(parts.flatMap(part => part.requestReadings ?? []))].slice(0, 3),
      matches: parts.flatMap(part => part.matches).sort(byOrder),
      rejected: parts.flatMap(part => part.rejected).sort(byOrder),
      uncertain: parts.flatMap(part => part.uncertain).sort(byOrder)
    };
    return {
      results, cachedDecisions: reused, sharedDecisions: sharedReused, evaluated: pending.length + leftover.length,
      modelCalls, durationMs: Date.now() - started
    };
  } finally {
    claim.finish();
  }
}
