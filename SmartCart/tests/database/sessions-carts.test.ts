import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import type { MatchDecision } from '@engine/smartcart-matcher.mjs';
import { countRecentRuns, createAgentRun, finishAgentRun, getAgentRun } from '@/lib/db/agent-runs.repository';
import { getCart, getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { invalidateProducts, saveCachedDecisions } from '@/lib/db/match-cache.repository';
import { collections } from '@/lib/db/mongodb';
import {
  acquireRunLock, appendMessages, authenticateSession, createSession, MAX_STORED_MESSAGES, releaseRunLock, updateSessionState
} from '@/lib/db/sessions.repository';
import { ConflictError, RateLimitError, UnauthorizedError } from '@/lib/shared/errors';
import type { ChatMessage } from '@/lib/shared/types';
import { applyCartOperations } from '@/lib/shopping/cart-ops';
import { engineItemCore } from '@/lib/shopping/engine-items';
import { matchCacheKey, matchItemCandidates, matchItemKey, matchProductFingerprint } from '@/lib/shopping/matching';
import { readSessionCookie, requireSession, sessionCookieHeader } from '@/lib/server/session-cookie';
import { fixtureSearch, referenceItems } from '../helpers/fixtures';
import { createFakeMatcher, MATCHING_CODES } from '../helpers/fake-models';
import { createTestDatabase, databaseSkipReason, type TestDatabase } from '../helpers/test-db';

const message = (role: 'user' | 'assistant', content: string): ChatMessage =>
  ({ id: `msg_${Math.random().toString(36).slice(2)}`, role, content, kind: 'text', createdAt: new Date() });

describe('sessions, carts and runs in MongoDB', { skip: databaseSkipReason }, () => {
  let testDb: TestDatabase;
  before(async () => { testDb = await createTestDatabase(); });
  after(async () => { await testDb?.cleanup(); });

  test('25. the cart is persisted in MongoDB and survives reloads', async () => {
    const { session } = await createSession(testDb.db);
    const cart = await getOrCreateCart(testDb.db, session._id);
    assert.equal(cart.revision, 0);
    assert.equal((await getOrCreateCart(testDb.db, session._id))._id, cart._id, 'one cart per session');
    const { cart: next } = applyCartOperations(cart, [{ op: 'add_items', items: [{
      product: 'milk', searchTerms: ['חלב'], sourceText: '2 liters of 3% milk', requirements: ['3%'], preferences: [],
      constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%', value: '3%' }], quantity: { amount: 2, unit: 'l' }
    }] }]);
    const saved = await saveCart(testDb.db, session._id, cart.revision, mutableFields(next));
    assert.equal(saved.revision, 1);
    const reloaded = await getCart(testDb.db, session._id);
    assert.equal(reloaded?.items.length, 1);
    assert.deepEqual(reloaded?.items[0]?.requirements, ['3%']);
    assert.equal(reloaded?.itemsVersion, cart.itemsVersion + 1);
    assert.ok(reloaded?.expiresAt instanceof Date);
  });

  test('26. conversation messages and state are persisted in order and bounded', async () => {
    const { session } = await createSession(testDb.db);
    await appendMessages(testDb.db, session._id, [message('user', 'I want 2 liters of 3% milk'), message('assistant', 'Added milk.')]);
    await appendMessages(testDb.db, session._id, [message('user', 'Make it cheaper')]);
    await updateSessionState(testDb.db, session._id, { intent: 'SHOPPING', pendingClarification: { question: 'How many?', options: ['2'] } });
    const stored = await collections.sessions(testDb.db).findOne({ _id: session._id });
    assert.deepEqual(stored?.messages.map(entry => entry.content), ['I want 2 liters of 3% milk', 'Added milk.', 'Make it cheaper']);
    assert.equal(stored?.pendingClarification?.question, 'How many?');
    await appendMessages(testDb.db, session._id, Array.from({ length: MAX_STORED_MESSAGES + 5 }, (_, index) => message('user', `m${index}`)));
    const bounded = await collections.sessions(testDb.db).findOne({ _id: session._id });
    assert.equal(bounded?.messages.length, MAX_STORED_MESSAGES);
    assert.equal(bounded?.messages.at(-1)?.content, `m${MAX_STORED_MESSAGES + 4}`);
  });

  test('28. sessions are isolated: a cart is only reachable with its own secret token', async () => {
    const first = await createSession(testDb.db);
    const second = await createSession(testDb.db);
    assert.equal((await authenticateSession(testDb.db, first.session._id, first.token))._id, first.session._id);
    await assert.rejects(authenticateSession(testDb.db, first.session._id, second.token), UnauthorizedError);
    await assert.rejects(authenticateSession(testDb.db, '00000000-0000-4000-8000-000000000000', first.token), UnauthorizedError);
    assert.equal((await collections.sessions(testDb.db).findOne({ _id: first.session._id }))?.tokenHash.includes(first.token), false, 'only a hash is stored');

    const request = (cookie?: string) => new Request('http://localhost/api/cart', { headers: cookie ? { cookie } : {} });
    const header = sessionCookieHeader(first.session._id, first.token, request());
    assert.match(header, /HttpOnly/u);
    assert.match(header, /SameSite=Lax/u);
    const cookie = header.split(';')[0]!;
    assert.deepEqual(readSessionCookie(request(cookie)), { sessionId: first.session._id, token: first.token });
    assert.equal((await requireSession(testDb.db, request(cookie)))._id, first.session._id);
    const forged = `smartcart_session=${encodeURIComponent(`${first.session._id}.${second.token}`)}`;
    await assert.rejects(requireSession(testDb.db, request(forged)), UnauthorizedError);
    await assert.rejects(requireSession(testDb.db, request()), UnauthorizedError);

    const cartA = await getOrCreateCart(testDb.db, first.session._id);
    const cartB = await getOrCreateCart(testDb.db, second.session._id);
    assert.notEqual(cartA._id, cartB._id);
  });

  test('29. concurrent edits with the same revision: exactly one wins', async () => {
    const { session } = await createSession(testDb.db);
    const cart = await getOrCreateCart(testDb.db, session._id);
    const edit = (mode: 'cheapest' | 'preferences-first') =>
      saveCart(testDb.db, session._id, cart.revision, mutableFields(applyCartOperations(cart, [{ op: 'set_mode', mode }]).cart));
    const results = await Promise.allSettled([edit('cheapest'), edit('preferences-first')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof ConflictError);
    assert.equal((await getCart(testDb.db, session._id))?.revision, 1);
  });

  test('one agent run per session at a time; runs are recorded for rate limiting', async () => {
    const { session } = await createSession(testDb.db);
    await acquireRunLock(testDb.db, session._id, 'run_a', 60_000);
    await assert.rejects(acquireRunLock(testDb.db, session._id, 'run_b', 60_000), RateLimitError);
    await releaseRunLock(testDb.db, session._id, 'run_a');
    await acquireRunLock(testDb.db, session._id, 'run_b', 60_000);
    await releaseRunLock(testDb.db, session._id, 'run_b');
    await acquireRunLock(testDb.db, session._id, 'run_c', -1);
    await acquireRunLock(testDb.db, session._id, 'run_d', 60_000); // an expired lock can be taken over
    await releaseRunLock(testDb.db, session._id, 'run_d');

    const startedAt = new Date();
    await createAgentRun(testDb.db, {
      _id: 'run_record', sessionId: session._id, status: 'running', model: 'fake', startedAt, finishedAt: null, durationMs: null,
      modelTurns: 0, toolCalls: [], matcherModelCalls: 0, tokenUsage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 }, error: null
    });
    await finishAgentRun(testDb.db, 'run_record', {
      status: 'completed', finishedAt: new Date(), durationMs: 5, modelTurns: 2, matcherModelCalls: 3, error: null,
      toolCalls: [{ name: 'optimizeBasket', status: 'ok', durationMs: 4, summary: 'ok' }],
      tokenUsage: { promptTokens: 10, outputTokens: 5, thoughtTokens: 0, totalTokens: 15 }
    });
    const run = await getAgentRun(testDb.db, 'run_record');
    assert.equal(run?.status, 'completed');
    assert.equal(run?.tokenUsage.totalTokens, 15);
    assert.equal(await countRecentRuns(testDb.db, session._id, 60_000), 1);
  });

  test('matcher decisions are cached in MongoDB, reused without model calls, and invalidated per product', async () => {
    const [milk] = referenceItems();
    const candidates = fixtureSearch(['חלב']).slice(0, 40);
    const first = createFakeMatcher();
    const cold = await matchItemCandidates(engineItemCore(milk!), candidates, { db: testDb.db, callModel: first.callModel, model: 'fake-model', batchSize: 20 });
    assert.equal(cold.cachedDecisions, 0);
    assert.ok(first.stats.calls > 0);

    const second = createFakeMatcher();
    const warm = await matchItemCandidates(engineItemCore(milk!), candidates, { db: testDb.db, callModel: second.callModel, model: 'fake-model', batchSize: 20 });
    assert.equal(second.stats.calls, 0, 'fully cached');
    assert.equal(warm.cachedDecisions, candidates.length);
    assert.deepEqual(warm.results.matches.map(row => row.product._id), cold.results.matches.map(row => row.product._id));

    const otherQuantity = { ...engineItemCore(milk!), quantity: { amount: 5, unit: 'l' } };
    const third = createFakeMatcher();
    await matchItemCandidates(otherQuantity, candidates, { db: testDb.db, callModel: third.callModel, model: 'fake-model', batchSize: 20 });
    assert.equal(third.stats.calls, 0, 'a different amount in the same unit reuses decisions');

    const stricter = { ...engineItemCore(milk!), requirements: ['3%', 'Tnuva'], preferences: [], constraintEvidence: [
      { type: 'REQUIREMENT' as const, kind: 'OTHER' as const, sourceText: '3%', value: '3%' },
      { type: 'REQUIREMENT' as const, kind: 'BRAND' as const, sourceText: 'Tnuva', value: 'Tnuva' }
    ] };
    const fourth = createFakeMatcher();
    await matchItemCandidates(stricter, candidates, { db: testDb.db, callModel: fourth.callModel, model: 'fake-model', batchSize: 20 });
    assert.ok(fourth.stats.calls > 0, 'changed requirements are re-evaluated');

    const changedProduct = { ...candidates[0]!, name: `${candidates[0]!.name} changed` };
    const fifth = createFakeMatcher();
    const partial = await matchItemCandidates(engineItemCore(milk!), [changedProduct, ...candidates.slice(1)], { db: testDb.db, callModel: fifth.callModel, model: 'fake-model', batchSize: 20 });
    assert.equal(partial.cachedDecisions, candidates.length - 1, 'a changed product is re-evaluated');
    assert.ok(await invalidateProducts(testDb.db, [candidates[1]!._id]) >= 1);
  });

  test('decisions saved by the previous matcher are not reused, even under a current key', async () => {
    const item: EngineItem = { product: 'חלב', searchTerms: ['חלב'], requirements: [], preferences: [], quantity: { amount: 0, unit: 'unspecified' }, constraintEvidence: [] };
    const offers = fixtureSearch(['חלב']);
    const condensed = offers.find(product => product.name === 'חלב מרוכז ממותק 370 גר')!;
    const plain = offers.find(product => product.name === 'חלב תנובה 1% 1 לי')!;
    // What matcher v2 saved for "אני רוצה חלב" before the fix.
    const legacy = { id: condensed._id, status: 'MATCH', reason: 'Condensed milk is a form of milk.', identityStatus: 'MATCH', requirementChecks: [], preferencesMet: [] };
    const now = new Date();
    const saved = (itemKey: string) => ({
      _id: matchCacheKey(itemKey, condensed), productId: condensed._id, itemKey, productHash: matchProductFingerprint(condensed),
      model: 'fake-model-v2', decision: legacy as unknown as MatchDecision, createdAt: now, expiresAt: new Date(now.getTime() + 60_000)
    });
    const currentKey = matchItemKey(item, 'fake-model-v2');
    // One copy under its own v2 key, and one under today's key, as if a version bump had been forgotten.
    await saveCachedDecisions(testDb.db, [saved(matchItemKey(item, 'fake-model-v2', 'matcher-v2')), saved(currentKey)]);

    const matcher = createFakeMatcher({ identity: (_product, candidate) => candidate.name === plain.name });
    const outcome = await matchItemCandidates(item, [condensed, plain], { db: testDb.db, callModel: matcher.callModel, model: 'fake-model-v2' });
    assert.equal(outcome.cachedDecisions, 0, 'the v2 decision is not reused');
    assert.equal(matcher.stats.candidates, 2, 'condensed milk is checked again');
    assert.deepEqual(outcome.results.matches.map(row => row.product._id), [plain._id]);
    assert.deepEqual(outcome.results.rejected.map(row => row.product._id), [condensed._id]);
    const stored = await collections.matchCache(testDb.db).findOne({ _id: matchCacheKey(currentKey, condensed) });
    assert.equal(stored?.decision.relation, 'RELATED_DIFFERENT', 'the new decision replaced the legacy one');
  });

  test('a catalog refresh with new prices and dates reuses saved checks; a new name, manufacturer or package is checked again', async () => {
    const item = engineItemCore(referenceItems()[0]!);
    // The milk offers the controlled matcher accepts come first, then other milk offers up to 30.
    const milkOffers = fixtureSearch(['חלב']);
    const accepted = milkOffers.filter(product => MATCHING_CODES.milk!.has(product.productCode));
    const candidates = [...accepted, ...milkOffers.filter(product => !accepted.includes(product))].slice(0, 30);
    const check = async (products: CatalogRecord[]) => {
      const matcher = createFakeMatcher();
      const outcome = await matchItemCandidates(item, products, { db: testDb.db, callModel: matcher.callModel, model: 'fake-model-refresh', batchSize: 25 });
      return { outcome, stats: matcher.stats };
    };
    const cold = await check(candidates);
    assert.equal(cold.outcome.cachedDecisions, 0);
    assert.ok(accepted.length >= 3, `the fixture has accepted milk offers (${accepted.length})`);
    assert.ok(cold.outcome.results.matches.length > 0, 'some candidates match');

    // Every product gets a new price, price date and snapshot date, as in a real refresh.
    const refreshed = candidates.map(product => ({
      ...product,
      pricing: { ...product.pricing, listedPriceIls: Math.round((product.pricing.listedPriceIls + 1.1) * 100) / 100 },
      priceUpdatedAt: '2026-12-01T08:00:00',
      snapshotDate: '2026-12-02'
    }));
    const warm = await check(refreshed);
    assert.equal(warm.stats.calls, 0, 'no Gemini calls after a price and date refresh');
    assert.equal(warm.outcome.cachedDecisions, candidates.length);
    assert.deepEqual(warm.outcome.results.matches.map(row => row.product._id), cold.outcome.results.matches.map(row => row.product._id));
    const newPrice = new Map(refreshed.map(product => [product._id, product.pricing.listedPriceIls]));
    for (const row of warm.outcome.results.matches) {
      assert.equal(row.product.pricing.listedPriceIls, newPrice.get(row.product._id), 'prices come from the current record');
    }

    // Change three accepted offers, so the changes affect real matches.
    const [renamed, otherMaker, resized] = refreshed;
    const changed = [
      { ...renamed!, name: `${renamed!.name} 2` },
      { ...otherMaker!, manufacturer: { name: 'יצרן אחר', country: 'IL' } },
      { ...resized!, package: { ...resized!.package, quantity: resized!.package.quantity * 2 } },
      ...refreshed.slice(3)
    ];
    const partial = await check(changed);
    assert.equal(partial.stats.candidates, 3, 'only the three changed products go to Gemini');
    assert.equal(partial.outcome.cachedDecisions, candidates.length - 3);
  });
});
