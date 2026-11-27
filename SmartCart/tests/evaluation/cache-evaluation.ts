import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MATCHER_FINGERPRINT, READING_DECLARATION } from '@engine/smartcart-matcher.mjs';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import { getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { type MatchCacheDocument, MATCH_CACHE_TTL_MS } from '@/lib/db/match-cache.repository';
import { COLLECTIONS } from '@/lib/db/mongodb';
import { createSession } from '@/lib/db/sessions.repository';
import { applyUiCartEdit } from '@/lib/shopping/cart-service';
import { MATCH_CACHE_VERSION, matchCacheKey, matchItemCandidates, matchItemKey } from '@/lib/shopping/matching';
import { createFakeMatcher } from '../helpers/fake-models';
import { cartItem, fixtureSearch } from '../helpers/fixtures';
import { recordCase } from './backend-case';
import { fixtureDb } from './fixture-db';
import type { EvaluationCase, EvaluationSection } from './types';

const expected = (retrieved: number, hits: number, matcherCalls: number, intentReadingCalls: number, cacheWrites: number, productsSent = retrieved - hits) => ({
  productsRetrieved: retrieved, cacheHits: hits, cacheMisses: retrieved - hits, productsSent,
  matcherCalls, intentReadingCalls, cacheWrites
});

export async function runCache(): Promise<EvaluationSection> {
  const cases: EvaluationCase[] = [];
  const fixture = fixtureDb([]);
  const documents = () => (fixture.tables.get(COLLECTIONS.matchCache) ?? []) as unknown as MatchCacheDocument[];
  const documentFor = (id: string) => documents().find(entry => entry._id === id);
  const model = `eval-cache-${randomUUID()}`;
  const productCodes = new Set(['7290000042015', '7290004131074']);
  const variants = fixtureSearch(['חלב']).filter(product => productCodes.has(product.productCode));
  // Pick one offer per code. Different supermarket offers have different IDs.
  const products = [...productCodes].map(code => {
    const record = variants.find(product => product.productCode === code);
    assert.ok(record, `Missing required catalog fixture ${code}`);
    return record;
  });
  const plain: EngineItem = { product: 'milk', searchTerms: ['חלב'], requirements: [], preferences: [], quantity: { amount: 1, unit: 'l' } };
  const itemKey = matchItemKey(plain, model);
  const key = (product: CatalogRecord) => matchCacheKey(itemKey, product);
  const a = await createSession(fixture.db);
  const aCart = await getOrCreateCart(fixture.db, a.session._id);
  const original = { ...aCart, items: [cartItem({ product: 'milk', searchTerms: ['חלב'], quantity: { amount: 1, unit: 'l' } })] };
  const savedCart = await saveCart(fixture.db, a.session._id, aCart.revision, mutableFields(original));
  let baseline: MatchCacheDocument[] = [];

  async function check(item = plain, candidates = products, modelName = model, synchronize?: () => Promise<void>) {
    const started = performance.now();
    const writes = fixture.timing.cacheWrites;
    const fake = createFakeMatcher({ identity: () => true });
    const result = await matchItemCandidates(item, candidates, {
      db: fixture.db, model: modelName, batchSize: 8, concurrency: 1,
      callModel: async args => {
        if (args.declaration.name === READING_DECLARATION.name) await synchronize?.();
        return fake.callModel(args);
      }
    });
    return {
      productsRetrieved: candidates.length,
      cacheHits: result.cachedDecisions,
      cacheMisses: candidates.length - result.cachedDecisions,
      productsSent: fake.stats.candidates, matcherCalls: fake.stats.calls, intentReadingCalls: fake.stats.readings,
      cacheWrites: fixture.timing.cacheWrites - writes, processingMs: performance.now() - started,
      matches: result.results.matches.map(entry => ({ id: entry.product._id, priceIls: entry.product.pricing.listedPriceIls }))
    };
  }
  type Check = Awaited<ReturnType<typeof check>>;

  async function scenario(id: string, title: string, request: string, want: ReturnType<typeof expected>, execute: () => Promise<Check>, extra?: (actual: Check) => void) {
    await recordCase(cases, { id: `cache-${id}`, title, request, expected: want, category: 'cache', component: 'matching cache' }, execute, result => {
      const { processingMs, matches, ...counts } = result;
      assert.deepEqual(counts, want);
      assert.ok(processingMs >= 0);
      extra?.(result);
    });
    const last = cases.at(-1)!;
    if (last.actual) last.metrics = last.actual as Record<string, unknown>;
  }

  const cold = expected(2, 0, 1, 1, 2);
  const warm = expected(2, 2, 0, 0, 0);
  await scenario('cold', 'User A with an empty cache', 'I want milk', cold, async () => {
    const result = await check();
    baseline = structuredClone(documents());
    return result;
  }, () => {
    assert.equal(baseline.length, 2);
    assert.ok(baseline.every(entry => entry.expiresAt.getTime() - entry.createdAt.getTime() === MATCH_CACHE_TTL_MS));
  });
  await scenario('repeat', 'User A repeats the request', 'I want milk', warm, () => check());
  await scenario('start-over', 'Start Over creates a fresh session and retains shared decisions', 'Start Over, then I want milk', warm, async () => {
    const fresh = await createSession(fixture.db);
    const freshCart = await getOrCreateCart(fixture.db, fresh.session._id);
    assert.notEqual(fresh.session._id, a.session._id);
    assert.equal(freshCart.items.length, 0);
    assert.equal(documents().length, 2);
    return check();
  });
  await scenario('cross-user', 'User B reuses checks across sessions', 'I want milk', warm, async () => {
    const b = await createSession(fixture.db);
    assert.notEqual(b.session._id, a.session._id);
    const known = JSON.stringify(documents());
    for (const privateValue of [a.session._id, b.session._id, a.token, b.token]) assert.ok(!known.includes(privateValue));
    return check();
  });
  await scenario('clear', 'Clearing a cart retains shared decisions', 'Clear my cart, then add milk', warm, async () => {
    const result = await applyUiCartEdit(fixture.db, a.session._id, { expectedRevision: savedCart.revision, operation: { op: 'clear' } }, {
      matcher: { model, callModel: null }
    });
    assert.equal(result.cart.items.length, 0);
    assert.equal(documents().length, 2);
    return check();
  });
  await scenario('language', 'Equivalent translation uses its own key when product wording differs', 'אני רוצה חלב', cold, () => check({ ...plain, product: 'חלב' }));
  await scenario('fat', 'A different fat requirement requires fresh checks', 'I want 3% milk', cold, () => check({ ...plain, requirements: ['3%'] }));
  await scenario('brand', 'A specific brand requires fresh checks', 'I want Tnuva milk', cold, () => check({ ...plain, requirements: ['Tnuva'] }));
  const repriced = products.map(product => ({ ...product, pricing: { ...product.pricing, listedPriceIls: 12.34 } }));
  await scenario('price', 'Price changes reuse identity and return the latest price', 'I want milk after a price change', warm, () => check(plain, repriced), result => {
    assert.deepEqual(result.matches.map(match => match.priceIls), [12.34, 12.34]);
  });
  const renamed = [{ ...products[0]!, name: `${products[0]!.name} New label` }, products[1]!];
  await scenario('name', 'A name change rechecks only the edited offer', 'I want milk after an offer was renamed', expected(2, 1, 1, 0, 1), () => check(plain, renamed));
  const resized = [{ ...products[0]!, package: { ...products[0]!.package, quantity: 2 } }, products[1]!];
  await scenario('package', 'A relevant package change rechecks only the edited offer', 'I want milk after a package update', expected(2, 1, 1, 0, 1), () => check(plain, resized));

  function replaceNamespace(previousVersion: string, incorrect = false) {
    assert.equal(baseline.length, products.length, 'The cold check must produce the fixture decisions.');
    assert.ok(MATCH_CACHE_VERSION.endsWith(MATCHER_FINGERPRINT.slice(0, 16)));
    const oldItemKey = matchItemKey(plain, model, previousVersion);
    assert.notEqual(itemKey, oldItemKey);
    for (const product of products) {
      const record = baseline.find(entry => entry.productId === product._id)!;
      const currentIndex = documents().findIndex(entry => entry._id === key(product));
      assert.notEqual(currentIndex, -1);
      const oldKey = matchCacheKey(oldItemKey, product);
      documents().splice(currentIndex, 1, { ...structuredClone(record), _id: oldKey, itemKey: oldItemKey,
        decision: incorrect ? { ...record.decision, status: 'NO_MATCH' } : record.decision });
    }
  }

  await scenario('prompt', 'Entries under a historical prompt fingerprint miss the current cache', 'Repeat a milk request after a matcher prompt update', expected(2, 0, 1, 0, 2), () => {
    replaceNamespace('matcher-v3:prior-prompt');
    return check();
  });
  await scenario('schema', 'Entries under a historical response schema fingerprint miss the current cache', 'Repeat a milk request after a response schema update', expected(2, 0, 1, 0, 2), () => {
    replaceNamespace('matcher-v3:prior-response-schema');
    return check();
  });
  await scenario('expiry', 'Expired decisions are ignored', 'I want milk after 14 days', expected(2, 1, 1, 0, 1), () => {
    documentFor(key(products[0]!))!.expiresAt = new Date(0);
    return check();
  });
  await scenario('malformed', 'A corrupt current decision cannot bypass validation', 'I want milk with a corrupt cached verdict', expected(2, 0, 1, 0, 2), () => {
    // Keep the document ID and other fields valid to exercise decision revalidation.
    documentFor(key(products[0]!))!.decision.requirementChecks = undefined as never;
    return check();
  }, result => assert.equal(result.matches.length, 2));
  await scenario('old-bad', 'Incorrect decisions in a previous cache version are never used', 'I want milk after matcher validation changed', expected(2, 0, 1, 0, 2), () => {
    replaceNamespace('matcher-v2', true);
    return check();
  }, result => assert.equal(result.matches.length, 2));

  await scenario('privacy', 'Cache records omit raw source text, session identifiers and session tokens', 'Add milk with a synthetic private note', cold, async () => {
    const privateText = 'offline-sensitive-fixture-marker';
    const result = await check({ ...plain, sourceText: `Get milk for ${privateText}` }, products, `${model}-privacy`);
    const serialized = JSON.stringify(documents());
    for (const value of [a.session._id, a.token, privateText]) assert.ok(!serialized.includes(value));
    return result;
  });

  await recordCase(cases, {
    id: 'cache-concurrent', title: 'Concurrent cold customers share in-flight decisions',
    request: 'Two customers ask for the same milk simultaneously', category: 'cache', component: 'matching cache',
    expected: { productsRetrieved: 4, cacheHits: 0, cacheMisses: 4, productsSent: 2, matcherCalls: 1, intentReadingCalls: 1, cacheWrites: 2 }
  }, async () => {
    const started = performance.now();
    const coldModel = `${model}-concurrent`;
    const beforeWrites = fixture.timing.cacheWrites;
    let release!: () => void;
    const sharedStart = new Promise<void>(resolve => { release = resolve; });
    let arrived = 0;
    // Two cold readers observe the same empty snapshot before either saves its result.
    const synchronize = async () => {
      if (++arrived === 2) release();
      await sharedStart;
    };
    const safety = setTimeout(release, 50);
    try {
      const [first, second] = await Promise.all([check(plain, products, coldModel, synchronize), check(plain, products, coldModel, synchronize)]);
      return {
        productsRetrieved: first.productsRetrieved + second.productsRetrieved,
        cacheHits: first.cacheHits + second.cacheHits, cacheMisses: first.cacheMisses + second.cacheMisses,
        productsSent: first.productsSent + second.productsSent, matcherCalls: first.matcherCalls + second.matcherCalls,
        intentReadingCalls: first.intentReadingCalls + second.intentReadingCalls, cacheWrites: fixture.timing.cacheWrites - beforeWrites,
        processingMs: performance.now() - started
      };
    } finally {
      clearTimeout(safety);
    }
  }, actual => {
    assert.equal(actual.matcherCalls, 1, `Expected one shared batch, observed ${actual.matcherCalls}. Simultaneous misses are not coalesced.`);
    assert.equal(actual.intentReadingCalls, 1);
    assert.equal(actual.cacheWrites, 2);
  });
  cases.at(-1)!.metrics = cases.at(-1)!.actual as Record<string, unknown> | undefined;

  return {
    name: 'Shared matching cache', mode: 'MOCK', cases,
    metrics: { ttlDays: MATCH_CACHE_TTL_MS / 86_400_000, lookupCalls: fixture.timing.cacheLookups, totalWrites: fixture.timing.cacheWrites, storage: 'isolated in-process collection adapter' },
    notes: [
      'Actual cache repository, matcher, session creation and cart clear run against a fresh in-process collection adapter. Counts use controlled catalog candidates; MongoDB query execution and network latency are evaluated separately.',
      'The cache key excludes user and session IDs. It includes requested product wording, constraints, quantity shape, model, matcher fingerprint, exact store offer identity, and relevant product fields.',
      'Cross-language requests with different stored product wording miss this cache. If the agent emits identical matching inputs, both sessions share the same key.',
      'Prompt and schema migration tests seed older fingerprint namespaces. They exercise current lookups without changing production prompt or schema files.',
      'Mock cache records contain no synthetic session identifiers or tokens. Validated model results can include request qualifiers and explanatory text; this is not a comprehensive privacy audit.'
    ]
  };
}
