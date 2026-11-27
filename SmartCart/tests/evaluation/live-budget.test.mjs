import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveBudget } from './live-budget.mjs';
import { offlineNetworkStats } from './offline-guard.mjs';

const plan = { prompt: 'Synthetic prompt', declaration: { name: 'submit', parameters: { type: 'object' } } };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const goodGeneration = () => response({
  usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 80 },
  candidates: [{ content: { parts: [{ functionCall: { name: 'submit', args: { ok: true } } }] } }]
});

function fakeBudget(limits, request) {
  // Retain the installed transport blocker while exercising the budget with an injected response source.
  const saved = process.env.SMARTCART_EVAL_OFFLINE;
  delete process.env.SMARTCART_EVAL_OFFLINE;
  try {
    return createLiveBudget({ model: 'gemini-3.5-flash-lite', apiKey: 'synthetic-test-key', limits, request });
  } finally {
    process.env.SMARTCART_EVAL_OFFLINE = saved;
  }
}

test('the preload blocks external Gemini traffic before a connection', async () => {
  const before = offlineNetworkStats().blockedAttempts;
  await assert.rejects(fetch('https://generativelanguage.googleapis.com/guard-test'), { code: 'SMARTCART_OFFLINE_NETWORK' });
  assert.equal(offlineNetworkStats().blockedAttempts, before + 1);
  assert.throws(() => createLiveBudget({ model: 'gemini-3.5-flash-lite', apiKey: 'synthetic' }), /offline evaluation guard/u);
});

test('preflight and generation share the attempt limit and generation is capped', async () => {
  const sent = [];
  const budget = fakeBudget({ maxAttempts: 2, maxOutputTokens: 50 }, async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return url.endsWith(':countTokens') ? response({ totalTokens: 60 }) : goodGeneration();
  });
  assert.deepEqual(await budget.callModel(plan), { ok: true });
  await assert.rejects(budget.callModel(plan), /attempt budget/u);
  assert.equal(budget.stats().attempts, 2);
  assert.equal(budget.stats().outputTokens, 20);
  assert.equal(sent[1].body.generationConfig.maxOutputTokens, 50);
  assert.equal(sent[1].body.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object');
});

test('too many input tokens aborts after preflight and before generation', async () => {
  const budget = fakeBudget({ maxInputTokens: 350 }, async url => {
    assert.ok(url.endsWith(':countTokens'));
    return response({ totalTokens: 500 });
  });
  await assert.rejects(budget.callModel(plan), /input token limit/u);
  assert.equal(budget.stats().generationAttempts, 0);
  assert.equal(budget.stats().attempts, 1);
  assert.equal(budget.stats().stoppedForBudget, true);
});

test('open agent turns and forced matcher calls share one request budget', async () => {
  const sent = [];
  const budget = fakeBudget({ maxAttempts: 4, maxOutputTokens: 60, maxOutputPerAttempt: 40 }, async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return url.endsWith(':countTokens') ? response({ totalTokens: 60 }) : goodGeneration();
  });
  const turn = await budget.generateContent({
    contents: [{ role: 'user', parts: [{ text: 'Pick a tool.' }] }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.2 }
  });
  assert.equal(turn.candidates[0].content.parts[0].functionCall.name, 'submit');
  await budget.callModel(plan);
  await assert.rejects(budget.generateContent({}), /attempt budget/u);
  assert.equal(sent[1].body.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.equal(sent[1].body.generationConfig.maxOutputTokens, 40);
  assert.equal(sent[3].body.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.deepEqual([budget.stats().attempts, budget.stats().generationAttempts, budget.stats().countAttempts], [4, 2, 2]);
});

test('cost reserve stops expensive generation and failed generation retains reservations', async () => {
  const tight = fakeBudget({ maxCostUsd: 0.00001 }, async url => {
    assert.ok(url.endsWith(':countTokens'));
    return response({ totalTokens: 60 });
  });
  await assert.rejects(tight.callModel(plan), /estimated cost limit/u);
  assert.equal(tight.stats().generationAttempts, 0);
  const interrupted = fakeBudget({}, async url => url.endsWith(':countTokens')
    ? response({ totalTokens: 60 }) : new Response(null, { status: 503 }));
  await assert.rejects(interrupted.callModel(plan), /HTTP 503/u);
  await assert.rejects(interrupted.callModel(plan), /HTTP 503/u);
  assert.equal(interrupted.stats().attempts, 2);
  assert.equal(interrupted.stats().reservedWithoutUsage, 1);
});
