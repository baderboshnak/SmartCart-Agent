import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { COLLECTIONS } from '@/lib/db/mongodb';
import { appendMessages, createSession, MAX_STORED_MESSAGES } from '@/lib/db/sessions.repository';
import { fixtureDb } from './fixture-db';
import { fixtureCatalog } from './scenario-data';
import { benchmarkScenario, executeScenario } from './scenarios';
import { evaluateCase, type EvaluationSection } from './types';

const acceleratedTiming = { aiMs: 8, dbMs: 4 };
const longerTiming = { aiMs: 250, dbMs: 30 };
const longerSampleCount = 3;
const longerProfiles = new Set(['one-cold', 'five-cold', 'twenty-cold', 'five-warm', 'slow-db']);
const baseCatalog = fixtureCatalog();

interface Profile {
  id: string;
  title: string;
  products: number;
  samples: number;
  cache?: 'warm' | 'partial';
  customers?: number;
  addedOffers?: number;
  history?: boolean;
  slowDb?: boolean;
}

const profiles: Profile[] = [
  { id: 'one-cold', title: 'One product with an empty decision cache', products: 1, samples: 100 },
  { id: 'five-cold', title: 'Five products with an empty decision cache', products: 5, samples: 24 },
  { id: 'twenty-cold', title: 'Twenty products with an empty decision cache', products: 20, samples: 24 },
  { id: 'five-warm', title: 'Five products with all decisions cached', products: 5, samples: 24, cache: 'warm' },
  { id: 'five-partial', title: 'Five products with some decisions cached', products: 5, samples: 24, cache: 'partial' },
  { id: 'simultaneous', title: 'Six simultaneous customers with identical requests', products: 1, samples: 24, customers: 6 },
  { id: 'large-catalog', title: 'One product with hundreds of catalog candidates', products: 1, samples: 12, addedOffers: 480 },
  { id: 'slow-db', title: 'Five products with database query delays', products: 5, samples: 24, slowDb: true },
  { id: 'long-history', title: 'Five products with a full conversation history', products: 5, samples: 24, history: true }
];

function catalogFor(profile: Profile): CatalogRecord[] {
  if (!profile.addedOffers) return baseCatalog;
  const samples = baseCatalog.filter(row => row.productCode === '1100000');
  assert.equal(samples.length, 2, 'The catalog must include a milk offer in both stores.');
  const additional = Array.from({ length: profile.addedOffers }, (_, index) => {
    const row = samples[index % samples.length]!;
    const productCode = String(1_200_000 + index);
    return {
      ...row, productCode, _id: [row.retailer, row.chainId, row.subChainId, row.storeId, productCode].join(':'),
      name: `חלב מותג דוגמה ${index + 1} 1 ליטר`
    };
  });
  return [...baseCatalog, ...additional];
}

/** Observe real results from the repository's search cursor, excluding verification by offer ID. */
function observeRetrieval(storage: ReturnType<typeof fixtureDb>) {
  const offers = new Set<string>();
  const productCodes = new Set<string>();
  const collection = storage.db.collection.bind(storage.db);
  storage.db.collection = ((name: string) => {
    const result = collection(name);
    if (name !== COLLECTIONS.products) return result;
    const find = result.find.bind(result);
    result.find = ((filter: Record<string, unknown> = {}, options?: Parameters<typeof find>[1]) => {
      const cursor = find(filter, options);
      if ('_id' in filter) return cursor;
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => {
        const candidates = await toArray();
        for (const candidate of candidates) {
          offers.add(String(candidate._id));
          productCodes.add(String(candidate.productCode));
        }
        return candidates;
      };
      return cursor;
    }) as typeof result.find;
    return result;
  }) as typeof storage.db.collection;
  return { offers, productCodes };
}

async function measure(profile: Profile, catalog: CatalogRecord[], timing?: typeof acceleratedTiming) {
  const scenario = benchmarkScenario(profile.products, `perf-${profile.id}`);
  const storage = fixtureDb(catalog, { queryDelay: timing && profile.slowDb ? () => delay(timing.dbMs) : undefined });
  const retrieved = observeRetrieval(storage);
  if (profile.cache) {
    const warmup = await executeScenario(scenario, { storage });
    assert.equal(warmup.view.status, 'COMPLETE');
    const documents = storage.tables.get(COLLECTIONS.matchCache) ?? [];
    assert.ok(documents.length > 1, 'Warm-up should write more than one validated decision.');
    if (profile.cache === 'partial') documents.splice(Math.floor(documents.length / 2));
  }
  const customers = profile.customers ?? 1;
  const sessionIds: string[] = [];
  for (let customer = 0; customer < customers; customer++) {
    const { session } = await createSession(storage.db);
    sessionIds.push(session._id);
    if (profile.history) await appendMessages(storage.db, session._id, Array.from({ length: MAX_STORED_MESSAGES }, (_, index) => ({
      id: `history-${index}`, role: index % 2 === 0 ? 'user' : 'assistant', kind: 'text', createdAt: new Date(index),
      content: index % 2 === 0 ? 'I am planning the groceries for this week.' : 'Tell me which items you need.'
    })));
  }
  retrieved.offers.clear();
  retrieved.productCodes.clear();
  const before = { ...storage.timing };
  const started = performance.now();
  const results = await Promise.all(sessionIds.map(sessionId => executeScenario(scenario, {
    storage, sessionId, think: timing ? () => delay(timing.aiMs) : undefined
  })));
  const elapsedMs = performance.now() - started;
  for (const result of results) {
    assert.equal(result.view.status, 'COMPLETE', result.observedToolErrors.join(' | ') || result.final.message.content);
    assert.deepEqual(result.actualProducts, scenario.expected.products);
    assert.ok(result.cart.calculation?.verification.passed);
    if (profile.cache === 'warm') {
      assert.equal(result.metrics.cacheHits, result.metrics.candidates);
      assert.equal(result.metrics.matcherCalls + result.metrics.intentReadingCalls, 0);
    } else if (profile.cache === 'partial') {
      assert.ok(result.metrics.cacheHits > 0 && result.metrics.cacheHits < result.metrics.candidates);
      assert.ok(result.metrics.matcherCalls > 0);
    } else if (customers === 1) {
      assert.equal(result.metrics.cacheHits, 0);
    }
    if (profile.history) assert.ok(result.metrics.sentHistoryMessages < MAX_STORED_MESSAGES);
    if (profile.addedOffers) assert.ok(result.metrics.candidates >= profile.addedOffers);
  }
  const stats = results.map(result => result.metrics);
  const sum = (key: keyof typeof stats[number]) => stats.reduce((total, result) => total + result[key], 0);
  const traced = (step: string) => results.flatMap(result => result.traces.filter(event => event.step === step));
  const duration = (step: string) => traced(step).reduce((total, event) => total + Number(event.details.durationMs ?? 0), 0);
  return {
    elapsedMs,
    catalogOffers: catalog.length, customers,
    retrievedCandidates: sum('candidates'), uniqueRetrievedOffers: retrieved.offers.size, uniqueRetrievedProducts: retrieved.productCodes.size,
    productsSentToMatcher: sum('productDecisions'), uniqueSelectedOffers: sum('uniqueSelectedOffers'),
    cacheHits: sum('cacheHits'), cacheMisses: sum('candidates') - sum('cacheHits'), cacheWrites: storage.timing.cacheWrites - before.cacheWrites,
    searchMs: duration('pipeline.search.completed'),
    matchingMs: duration('pipeline.match.completed'),
    quantityPricingMs: duration('pipeline.price.completed'),
    productQueryMs: storage.timing.productQueriesMs - before.productQueriesMs,
    productQueries: storage.timing.productQueries - before.productQueries,
    cacheLookupMs: storage.timing.cacheLookupMs - before.cacheLookupMs,
    cacheLookups: storage.timing.cacheLookups - before.cacheLookups,
    agentTurns: sum('agentTurns'), toolCalls: sum('toolCalls'), intentReadingCalls: sum('intentReadingCalls'), matcherCalls: sum('matcherCalls'),
    retries: traced('pipeline.match.retry').length + traced('agent.model.retryScheduled').length,
    simulatedAiWaitMs: sum('simulatedWaitMs') + sum('simulatedAgentWaitMs'),
    basketValidationMs: sum('validationMs'), optimizationMs: sum('optimizationMs'),
    maxConversationContextMessages: Math.max(...stats.map(result => result.sentHistoryMessages)),
    storedHistoryMessages: profile.history ? MAX_STORED_MESSAGES : 0
  };
}

type Sample = Awaited<ReturnType<typeof measure>>;

function summarize(samples: Sample[]) {
  const ordered = samples.map(sample => sample.elapsedMs).sort((left, right) => left - right);
  const percentile = (value: number) => ordered[Math.ceil(ordered.length * value) - 1]!;
  const keys = Object.keys(samples[0]!) as (keyof Sample)[];
  const average = Object.fromEntries(keys.map(key => [key, samples.reduce((total, sample) => total + sample[key], 0) / samples.length]));
  return {
    samples: samples.length, average,
    p50Ms: percentile(0.5),
    ...(samples.length >= 20 ? { p95Ms: percentile(0.95) } : {}),
    ...(samples.length >= 100 ? { p99Ms: percentile(0.99) } : {})
  };
}

export async function runPerformance(): Promise<EvaluationSection> {
  assert.equal(process.env.SMARTCART_EVAL_OFFLINE, '1', 'Use the offline guard preload.');
  const cases = [];
  const controls = new Map<string, ReturnType<typeof summarize>>();
  for (const profile of profiles) {
    cases.push(await evaluateCase({
      id: `perf-${profile.id}`, title: profile.title, category: 'performance', component: 'shopping agent and pipeline',
      request: benchmarkScenario(profile.products, profile.id).turns[0]!.message,
      expected: { basket: 'COMPLETE', products: profile.products, samplesPerVariant: profile.samples }
    }, async () => {
      const catalog = catalogFor(profile);
      const backendOnly: Sample[] = [];
      const simulated: Sample[] = [];
      for (let index = 0; index < profile.samples; index++) {
        backendOnly.push(await measure(profile, catalog));
        simulated.push(await measure(profile, catalog, acceleratedTiming));
      }
      const longer: Sample[] = [];
      if (longerProfiles.has(profile.id)) {
        for (let index = 0; index < longerSampleCount; index++) longer.push(await measure(profile, catalog, longerTiming));
      }
      const actual = { backendOnly: summarize(backendOnly), simulated: summarize(simulated),
        ...(longer.length ? { longerSimulated: summarize(longer) } : {}) };
      controls.set(profile.id, actual.backendOnly);
      return { actual, metrics: actual };
    }));
  }
  const small = controls.get('one-cold');
  const large = controls.get('large-catalog');
  const cold = controls.get('five-cold');
  const warm = controls.get('five-warm');
  const concurrent = controls.get('simultaneous');
  const findings = [
    ...(small && large ? [`The single-product median with no injected delay rose from ${small.p50Ms.toFixed(1)} to ${large.p50Ms.toFixed(1)} ms when retrieved offers grew from ${small.average.retrievedCandidates} to ${large.average.retrievedCandidates}. Matcher batches went from ${small.average.matcherCalls} to ${large.average.matcherCalls}.`] : []),
    ...(cold && warm ? [`A warm five-product cart still performed ${warm.average.productQueries} product queries per run. Matcher calls fell from ${cold.average.matcherCalls} to ${warm.average.matcherCalls}.`] : []),
    ...(concurrent ? [`Six simultaneous identical requests with an empty decision cache sent an average of ${concurrent.average.productsSentToMatcher} candidate decisions for ${concurrent.average.uniqueRetrievedOffers} unique offers, showing duplicate matching work during overlapping misses.`] : [])
  ];
  return {
    name: 'Offline backend performance', mode: 'MOCK', cases,
    metrics: { acceleratedTiming, longerTiming, longerSampleCount, externalAiRequests: 0 },
    notes: [
      'Uses production agent, repositories, matching/cache, optimization and verification against the in-memory database fixture. These measurements describe application work and synthetic waits, with no inference about MongoDB Atlas latency or Gemini throughput.',
      'Each group includes a backend-only control and a matching set of runs with short 8 ms model waits. Selected groups also model 250 ms per call to show how sequential and overlapping waits change the result. The slow database profile injects 4 ms or 30 ms per fixture query. Timeline starts after fixture and session setup.',
      'Wall-clock percentiles use nearest rank. p95 needs at least 20 samples and p99 at least 100. Concurrent samples measure completion of the whole six-customer group.',
      'Per-stage timings and simulated AI waits are sums across calls, some of which overlap. The backend-only control avoids subtracting overlapping waits from wall time. Intent readings can reuse process-local state even with a fresh decision cache.',
      ...findings
    ]
  };
}
