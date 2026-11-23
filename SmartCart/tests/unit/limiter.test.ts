import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getServerEnv } from '@/lib/env';
import { serverMatcherLimiter } from '@/lib/server/services';
import { ConfigurationError } from '@/lib/shared/errors';
import { createLimiter } from '@/lib/shopping/limiter';

/** Seeded random numbers, so the stress test is identical on every run. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Let a few promise callbacks run, so calls start and finish in mixed order. */
function hops(count: number): Promise<void> {
  let promise = Promise.resolve();
  for (let index = 0; index < count; index++) promise = promise.then(() => {});
  return promise;
}

/** Wait until every pending promise callback has run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('limit on calls running at once', () => {
  test('never runs more than the limit, even when new calls arrive as others finish', async () => {
    const random = seeded(20_261_121);
    const limiter = createLimiter(6);
    let running = 0;
    let peak = 0;
    let finished = 0;
    const stream = async () => {
      for (let index = 0; index < 200; index++) {
        await hops(Math.floor(random() * 3));
        await limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await hops(1 + Math.floor(random() * 3));
          running--;
          finished++;
        });
      }
    };
    for (let round = 0; round < 10; round++) await Promise.all(Array.from({ length: 12 }, stream));
    assert.equal(finished, 10 * 12 * 200);
    assert.equal(peak, 6, 'reaches the limit but never goes over it');
    assert.equal(limiter.active, 0);
    assert.equal(limiter.waiting, 0);
  });

  test('waiting calls start in arrival order; a newcomer waits behind them', async () => {
    const limiter = createLimiter(2);
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const call = (name: string) => limiter.run(() => new Promise<void>(resolve => {
      started.push(name);
      finish.set(name, resolve);
    }));
    const calls = ['a', 'b', 'c', 'd', 'e'].map(call);
    await settle();
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(limiter.waiting, 3);

    finish.get('b')!();
    await settle();
    assert.deepEqual(started, ['a', 'b', 'c']);

    const late = call('late');
    finish.get('a')!();
    finish.get('c')!();
    await settle();
    assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e'], 'd and e started before the newcomer');
    assert.equal(limiter.active, 2);
    assert.equal(limiter.waiting, 1);

    finish.get('d')!();
    finish.get('e')!();
    await settle();
    assert.equal(started.at(-1), 'late');
    finish.get('late')!();
    await Promise.all([...calls, late]);
    assert.equal(limiter.active, 0);
  });

  test('a failed call frees its slot for the next one', async () => {
    const limiter = createLimiter(1);
    const failing = limiter.run(async () => { throw new Error('model failed'); });
    const next = limiter.run(async () => 'ran');
    await assert.rejects(failing, /model failed/u);
    assert.equal(await next, 'ran');
    assert.equal(limiter.active, 0);
  });

  test('a cancelled call leaves the line without running; an already-cancelled call never starts', async () => {
    const limiter = createLimiter(1);
    let release!: () => void;
    const busy = limiter.run(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    let ran = false;
    const cancelled = limiter.run(async () => { ran = true; }, controller.signal);
    const next = limiter.run(async () => 'next');
    assert.equal(limiter.waiting, 2);

    controller.abort(new Error('customer pressed Stop'));
    await assert.rejects(cancelled, /customer pressed Stop/u);
    assert.equal(limiter.waiting, 1, 'the cancelled call left the line');
    release();
    assert.equal(await next, 'next', 'the next call took the freed slot');
    await busy;

    await assert.rejects(limiter.run(async () => { ran = true; }, controller.signal), /customer pressed Stop/u);
    assert.equal(ran, false);
    assert.equal(limiter.active, 0);
    assert.equal(limiter.waiting, 0);
  });

  test('rejects a limit that is not a whole number of at least 1', () => {
    for (const max of [0, -1, 1.5, Number.NaN]) assert.throws(() => createLimiter(max), RangeError);
  });
});

describe('the server-wide limit on checking calls', () => {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  function withEnv(values: Record<string, string | undefined>, check: () => void) {
    const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const apply = (entries: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    apply(values);
    try {
      check();
    } finally {
      apply(saved);
    }
  }

  test('SMARTCART_MATCH_CONCURRENCY defaults to 12 and accepts whole numbers from 1 to 64', () => {
    withEnv({ MONGODB_URI: uri, SMARTCART_MATCH_CONCURRENCY: undefined }, () => assert.equal(getServerEnv().SMARTCART_MATCH_CONCURRENCY, 12));
    withEnv({ MONGODB_URI: uri, SMARTCART_MATCH_CONCURRENCY: '20' }, () => assert.equal(getServerEnv().SMARTCART_MATCH_CONCURRENCY, 20));
    for (const invalid of ['0', '65', '2.5', 'many']) {
      withEnv({ MONGODB_URI: uri, SMARTCART_MATCH_CONCURRENCY: invalid }, () => assert.throws(
        () => getServerEnv(),
        (error: unknown) => error instanceof ConfigurationError && /SMARTCART_MATCH_CONCURRENCY/u.test(error.message)
      ));
    }
  });

  test('every request shares one server-wide limiter', () => {
    withEnv({ MONGODB_URI: uri, SMARTCART_MATCH_CONCURRENCY: '5' }, () => {
      const limiter = serverMatcherLimiter();
      assert.equal(limiter.max, 5);
      assert.equal(serverMatcherLimiter(), limiter, 'the same limiter every time');
    });
  });
});
