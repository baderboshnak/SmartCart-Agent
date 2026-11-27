import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Content } from '@google/genai';
import { matchProducts } from '@engine/smartcart-matcher.mjs';
import type { AgentModelRequest, ModelTurn } from '@/lib/agent/gemini';
import { isOverloadError, isTransientModelError } from '@/lib/agent/gemini';
import {
  allBusy, createPooledAgentModel, createPooledMatcher, ModelHealth, neutralizeSignatures,
  REST_AFTER_BUSY_MS, REST_AFTER_MISSING_MS, restAfter, SKIP_SIGNATURE
} from '@/lib/agent/model-pool';
import { getGeminiConfig, getVoiceConfig } from '@/lib/env';
import { getAgentModel, getMatcher } from '@/lib/server/services';
import { describeError } from '@/lib/server/terminal-trace';
import { ConfigurationError, ModelError } from '@/lib/shared/errors';
import { engineItemCore } from '@/lib/shopping/engine-items';
import { fixtureSearch, referenceItems } from '../helpers/fixtures';
import { createFakeMatcher, textTurn } from '../helpers/fake-models';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function request(contents: Content[] = [{ role: 'user', parts: [{ text: 'milk' }] }]): AgentModelRequest {
  return { systemInstruction: 'test', contents, tools: [], toolMode: 'AUTO', signal: new AbortController().signal };
}

/** A clock the tests move by hand. */
function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('model health', () => {
  test('a resting model moves to the end of the line until its rest is over', () => {
    const time = clock();
    const health = new ModelHealth(time.now);
    health.rest('a', 60_000);
    assert.deepEqual(health.order(['a', 'b', 'c']), ['b', 'c', 'a']);
    time.advance(60_001);
    assert.deepEqual(health.order(['a', 'b', 'c']), ['a', 'b', 'c']);
  });

  test('busy, slow and missing models rest; a bad request does not move to another model', () => {
    assert.equal(restAfter(httpError(503)), REST_AFTER_BUSY_MS);
    assert.equal(restAfter(httpError(429)), REST_AFTER_BUSY_MS);
    assert.equal(restAfter(new Error('x'), true), REST_AFTER_BUSY_MS);
    assert.equal(restAfter(httpError(404)), REST_AFTER_MISSING_MS);
    assert.equal(restAfter(new Error('wrapped'), false), null);
    assert.equal(restAfter(Object.assign(new Error('wrapped'), { cause: httpError(503) })), REST_AFTER_BUSY_MS);
    assert.equal(restAfter(httpError(400)), null);
  });

  test('"all models busy" is retried by the agent loop and by the engine matcher', async () => {
    const error = allBusy(httpError(503));
    assert.equal(isTransientModelError(error), true);
    assert.equal(isOverloadError(error), true);
    let calls = 0;
    const fake = createFakeMatcher();
    const result = await matchProducts({
      item: engineItemCore(referenceItems()[0]!), products: fixtureSearch(['חלב']).slice(0, 5), batchSize: 5, maxAttempts: 2,
      waitForRetry: async () => {},
      callModel: async args => { if (calls++ === 0) throw allBusy(httpError(503)); return fake.callModel(args); }
    });
    assert.equal(calls, 2, 'the engine retried after "all models busy"');
    assert.equal(result.totalCandidates, 5);
  });
});

describe('agent model with backups', () => {
  test('a busy main model hands the turn to a backup, then rests while the backup keeps working', async () => {
    const health = new ModelHealth();
    const seen: string[] = [];
    const model = createPooledAgentModel({
      models: ['main', 'backup'], health,
      generate: async name => { seen.push(name); if (name === 'main') throw httpError(503); return textTurn(`from ${name}`); }
    });
    assert.equal((await model.generate(request())).text, 'from backup');
    assert.equal((await model.generate(request())).text, 'from backup');
    assert.deepEqual(seen, ['main', 'backup', 'backup'], 'the resting main model is skipped on the next turn');
    assert.ok(health.isResting('main'), 'main rests after the overload');
    assert.deepEqual(model.turnsBy, ['backup', 'backup']);
    assert.match(model.name, /main \(\+1 backups\)/u);
  });

  test('a model that does not answer in time is replaced by the next one', async () => {
    const model = createPooledAgentModel({
      models: ['slow', 'fast'], health: new ModelHealth(), attemptTimeoutMs: 50,
      generate: async name => name === 'slow' ? new Promise<ModelTurn>(() => {}) : textTurn('fast answer')
    });
    assert.equal((await model.generate(request())).text, 'fast answer');
  });

  test('a rejected request is not sent to other models', async () => {
    const seen: string[] = [];
    const model = createPooledAgentModel({
      models: ['main', 'backup'], health: new ModelHealth(),
      generate: async name => { seen.push(name); throw httpError(400); }
    });
    await assert.rejects(model.generate(request()), /HTTP 400/u);
    assert.deepEqual(seen, ['main']);
  });

  test('when every model is busy the error says so and stays retryable', async () => {
    const model = createPooledAgentModel({
      models: ['a', 'b', 'c', 'd'], health: new ModelHealth(), maxModelsPerTurn: 3,
      generate: async () => { throw httpError(503); }
    });
    await assert.rejects(model.generate(request()), (error: unknown) =>
      error instanceof Error && /All available Gemini models are overloaded/u.test(error.message) && isTransientModelError(error));
  });

  test('debug mode prints Gemini\'s own error text per model, which model answered, and a summary when all fail', async () => {
    const details: Array<{ step: string; content: unknown }> = [];
    const trace = Object.assign(() => {}, { mode: 'on' as const, detail: (step: string, content: unknown) => { details.push({ step, content }); } });
    const overloaded = Object.assign(new Error('{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}'), { status: 503 });

    const model = createPooledAgentModel({
      models: ['main', 'backup'], health: new ModelHealth(), trace,
      generate: async name => {
        if (name === 'main') throw new ModelError('The Gemini model is temporarily overloaded.', { cause: overloaded });
        return textTurn('from backup');
      }
    });
    assert.equal((await model.generate(request())).model, 'backup', 'the reply says which model wrote it');
    const failed = details.find(entry => /^Gemini agent call to main failed \(temporarily_unavailable\) after \d+ ms$/u.test(entry.step));
    assert.match(JSON.stringify(describeError(failed?.content)), /The model is overloaded\./u, 'Gemini\'s own words, not only ours');

    const all = createPooledAgentModel({ models: ['a', 'b'], health: new ModelHealth(), trace, generate: async () => { throw overloaded; } });
    await assert.rejects(all.generate(request()));
    assert.deepEqual(details.at(-1), {
      step: 'no Gemini model could answer this agent turn',
      content: { a: '503 The model is overloaded.', b: '503 The model is overloaded.' }
    });
  });

  test('switching models replaces the previous model\'s thought signatures', async () => {
    const received: Content[][] = [];
    let mainBusy = false;
    const model = createPooledAgentModel({
      models: ['main', 'backup'], health: new ModelHealth(),
      generate: async (name, req) => {
        received.push(req.contents);
        if (name === 'main' && mainBusy) throw httpError(503);
        return textTurn(name);
      }
    });
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'milk' }] },
      { role: 'model', parts: [{ text: 'thinking', thought: true }, { functionCall: { name: 'updateCart', args: {} }, thoughtSignature: 'sig-from-main' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'updateCart', response: {} } }] }
    ];
    await model.generate(request(history));
    assert.equal(received[0], history, 'the same model gets its history untouched');
    mainBusy = true;
    await model.generate(request(history));
    const sent = received.at(-1)!;
    const modelParts = sent[1]!.parts!;
    assert.equal(modelParts.length, 1, "the other model's thoughts are dropped");
    assert.equal(modelParts[0]!.thoughtSignature, SKIP_SIGNATURE);
    assert.deepEqual(neutralizeSignatures([history[0]!]), [history[0]!], 'customer turns are unchanged');
  });
});

describe('product checks spread across models', () => {
  const args = { prompt: 'p', declaration: { name: 'f', description: 'd', parameters: {} } } as never;

  test('calls rotate over the checking models; backups wait until both are busy', async () => {
    const health = new ModelHealth();
    const used: string[] = [];
    const busy = new Set<string>();
    const matcher = createPooledMatcher({
      models: ['lite-a', 'lite-b'], backups: ['backup'], health,
      call: name => async () => { if (busy.has(name)) throw httpError(503); return { model: name }; },
      onAnswered: name => used.push(name)
    });
    for (let index = 0; index < 4; index++) await matcher(args);
    assert.deepEqual(used, ['lite-a', 'lite-b', 'lite-a', 'lite-b'], 'work is divided evenly');

    busy.add('lite-a');
    used.length = 0;
    for (let index = 0; index < 3; index++) await matcher(args);
    assert.deepEqual(used, ['lite-b', 'lite-b', 'lite-b'], 'the busy model rests and the other takes its share');
    assert.ok(health.isResting('lite-a'));

    busy.add('lite-b');
    health.rest('lite-b', REST_AFTER_BUSY_MS);
    used.length = 0;
    await matcher(args);
    assert.deepEqual(used, ['backup'], 'a backup answers when every checking model is busy');
  });

  test('a model the key cannot use rests for 30 minutes', async () => {
    const health = new ModelHealth();
    const matcher = createPooledMatcher({
      models: ['retired', 'lite'], backups: [], health,
      call: name => async () => { if (name === 'retired') throw httpError(404); return {}; }
    });
    await matcher(args);
    await matcher(args);
    assert.ok(health.isResting('retired'));
    assert.deepEqual(health.order(['retired', 'lite']), ['lite', 'retired']);
  });
});

describe('shopping and voice model configuration', () => {
  function withEnv(values: Record<string, string | undefined>, check: () => void) {
    const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const apply = (entries: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    apply(values);
    try { check(); } finally { apply(saved); }
  }
  const base = { MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017', GEMINI_API_KEY: 'test-key' };

  test('the agent and matcher share 3.5 Flash-Lite, and Live uses its voice model', () => {
    withEnv({ ...base, GEMINI_MODEL: undefined, GEMINI_LIVE_MODEL: undefined }, () => {
      assert.equal(getAgentModel().name, 'gemini-3.5-flash-lite');
      assert.equal(getMatcher().model, 'gemini-3.5-flash-lite');
      assert.equal(getVoiceConfig().liveModel, 'gemini-3.8-live');
    });
  });

  test('only the shared shopping selector applies, even with obsolete settings in the environment', () => {
    withEnv({ ...base, GEMINI_MODEL: '  gemini-3.5-flash-lite  ', GEMINI_BACKUP_MODELS: 'obsolete-agent',
      SMARTCART_MATCH_MODEL: 'obsolete-checker', SMARTCART_MATCH_BACKUP_MODELS: 'obsolete-backup' }, () => {
      assert.deepEqual(getGeminiConfig(), { apiKey: 'test-key', model: 'gemini-3.5-flash-lite' });
      assert.equal(getAgentModel().name, 'gemini-3.5-flash-lite');
      assert.equal(getMatcher().model, 'gemini-3.5-flash-lite');
    });
  });

  test('GEMINI_MODEL accepts one generateContent model', () => {
    withEnv({ ...base, GEMINI_MODEL: 'gemini-3.8-live' }, () =>
      assert.throws(() => getGeminiConfig(), (error: unknown) => error instanceof ConfigurationError && /generateContent/u.test(error.message)));
    withEnv({ ...base, GEMINI_MODEL: 'model-a,model-b' }, () =>
      assert.throws(() => getGeminiConfig(), /must name one model/u));
  });
});
