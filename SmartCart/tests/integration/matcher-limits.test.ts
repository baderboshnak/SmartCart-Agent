import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallModel } from '@engine/smartcart-matcher.mjs';
import { createLimiter, type Limiter } from '@/lib/shopping/limiter';
import { CartPipeline, DEFAULT_MAX_CONCURRENT_MODEL_CALLS } from '@/lib/shopping/pipeline';
import { referenceItems } from '../helpers/fixtures';
import { createFakeMatcher } from '../helpers/fake-models';
import { createTestDatabase, databaseSkipReason, type TestDatabase } from '../helpers/test-db';

describe('Gemini checking calls running at once', { skip: databaseSkipReason }, () => {
  let testDb: TestDatabase;
  before(async () => { testDb = await createTestDatabase({ seed: true }); });
  after(async () => { await testDb?.cleanup(); });

  const everyCart = { running: 0, peak: 0 };

  /**
   * One cart's matcher, wrapped like getMatcher(): every call waits for a slot in the
   * server-wide limit. Each call takes 150 ms and is counted while it runs.
   */
  function cartMatcher(name: string, server: Limiter, signal?: AbortSignal) {
    const fake = createFakeMatcher();
    const cart = { running: 0, peak: 0 };
    const callModel: CallModel = args => server.run(async () => {
      everyCart.running++;
      cart.running++;
      everyCart.peak = Math.max(everyCart.peak, everyCart.running);
      cart.peak = Math.max(cart.peak, cart.running);
      try {
        await delay(150);
        return await fake.callModel(args);
      } finally {
        everyCart.running--;
        cart.running--;
      }
    }, signal);
    return { matcher: { callModel, model: `limits-${name}-${Date.now()}` }, cart, fake };
  }

  test(`one cart runs at most ${DEFAULT_MAX_CONCURRENT_MODEL_CALLS} checks at once, and a big item can use them all`, async () => {
    everyCart.peak = 0;
    // The server allows more than one cart's limit, so the cart limit is what holds.
    const { matcher, cart, fake } = cartMatcher('single', createLimiter(DEFAULT_MAX_CONCURRENT_MODEL_CALLS * 2));
    const pipeline = new CartPipeline({ db: testDb.db, matcher });
    await Promise.all(referenceItems().map(item => pipeline.match(item)));
    assert.ok(fake.stats.calls > DEFAULT_MAX_CONCURRENT_MODEL_CALLS, `enough work to fill the limit (${fake.stats.calls} calls)`);
    assert.equal(cart.peak, DEFAULT_MAX_CONCURRENT_MODEL_CALLS);
  });

  test('the server-wide limit holds across carts, and each cart keeps its own limit', async () => {
    everyCart.peak = 0;
    const serverLimit = DEFAULT_MAX_CONCURRENT_MODEL_CALLS + 4;
    const server = createLimiter(serverLimit);
    const carts = [cartMatcher('first', server), cartMatcher('second', server)];
    const pipelines = carts.map(({ matcher }) => new CartPipeline({ db: testDb.db, matcher }));
    await Promise.all(pipelines.flatMap(pipeline => referenceItems().map(item => pipeline.match(item))));
    assert.ok(everyCart.peak > DEFAULT_MAX_CONCURRENT_MODEL_CALLS, `the two carts ran checks at the same time (${everyCart.peak} at once)`);
    assert.ok(everyCart.peak <= serverLimit, `never more than the server limit (${everyCart.peak} at once)`);
    for (const { cart } of carts) assert.ok(cart.peak <= DEFAULT_MAX_CONCURRENT_MODEL_CALLS, `a cart ran ${cart.peak} at once`);
    assert.equal(server.active, 0);
    assert.equal(server.waiting, 0);
  });

  test('a cancelled cart leaves the server line at once, and none of its waiting checks run', async () => {
    const server = createLimiter(1);
    let release!: () => void;
    const otherCustomer = server.run(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const { matcher, fake } = cartMatcher('cancelled', server, controller.signal);
    const pipeline = new CartPipeline({ db: testDb.db, matcher, signal: controller.signal });
    const milk = pipeline.match(referenceItems()[0]!);
    for (let attempt = 0; attempt < 250 && server.waiting === 0; attempt++) await delay(20);
    assert.ok(server.waiting > 0, 'the cart is waiting for a server slot');

    controller.abort(new Error('customer pressed Stop'));
    await assert.rejects(milk, /customer pressed Stop/u);
    assert.equal(server.waiting, 0, 'the cancelled cart left the line');
    assert.equal(fake.stats.calls, 0, 'none of its checks reached Gemini');
    release();
    await otherCustomer;
    assert.equal(server.active, 0);
  });
});
