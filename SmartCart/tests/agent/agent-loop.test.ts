import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { GenerateContentResponse } from '@google/genai';
import { describeGeminiError, isOverloadError, toModelTurn, type AgentModel } from '@/lib/agent/gemini';
import { runAgentLoop, type AgentTool } from '@/lib/agent/loop';
import { ModelError, ValidationError } from '@/lib/shared/errors';
import { READING_DECLARATION } from '@engine/smartcart-matcher.mjs';
import { matchItemCandidates, type MatchRetry } from '@/lib/shopping/matching';
import { fixtureSearch, referenceItems } from '../helpers/fixtures';
import { functionCallTurn, lastToolResponses, scriptedModel, textTurn } from '../helpers/fake-models';
import { engineItemCore } from '@/lib/shopping/engine-items';

const limits = { retryDelayMs: 5, modelTimeoutMs: 2_000, runTimeoutMs: 20_000 };

function recordingTools(log: string[], options: { slow?: boolean } = {}): AgentTool[] {
  const make = (name: string, schema: z.ZodType, execute: AgentTool['execute'], timeoutMs = 1_000): AgentTool =>
    ({ name, description: name, label: name, argsSchema: schema, timeoutMs, execute });
  return [
    make('searchProducts', z.object({ query: z.array(z.string()).min(1) }), (async (args: { query: string[] }) => {
      log.push(`searchProducts:${args.query.join(',')}`);
      return { data: { totalMatched: 3 }, summary: '3 products' };
    }) as never),
    make('updateCart', z.object({ operations: z.array(z.object({ op: z.string() })).min(1) }), (async (args: { operations: Array<{ op: string }> }) => {
      log.push(`updateCart:${args.operations.map(operation => operation.op).join(',')}`);
      return { data: { changes: ['ok'] }, summary: 'updated' };
    }) as never),
    make('optimizeBasket', z.object({}), (async (_args: unknown, context: { signal: AbortSignal; progress: (message: string) => void }) => {
      log.push('optimizeBasket');
      context.progress('Comparing complete baskets');
      if (options.slow) await new Promise(resolve => setTimeout(resolve, 5_000));
      return { data: { recommended: 'Rami Levy ₪67.26' }, summary: '₪67.26' };
    }) as never, 300),
    make('requestClarification', z.object({ question: z.string().min(5), options: z.array(z.string()).optional() }), (async (args: { question: string; options?: string[] }) => {
      log.push('requestClarification');
      return { data: { asked: true }, summary: 'asked', clarification: { question: args.question, options: args.options ?? [] } };
    }) as never)
  ];
}

const run = (model: AgentModel, tools: AgentTool[], extra: Parameters<typeof runAgentLoop>[0]['limits'] = {}) => runAgentLoop({
  model, tools, signal: new AbortController().signal, limits: { ...limits, ...extra },
  systemInstruction: () => 'system', contents: [{ role: 'user', parts: [{ text: 'I want milk' }] }]
});

describe('21. tool selection and the plan-act-observe loop', () => {
  test('executes the tools the model selects, in order, and returns the final answer', async () => {
    const log: string[] = [];
    const model = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'add_items' }] } }]),
      request => {
        assert.deepEqual(lastToolResponses(request).map(entry => entry.response.ok), [true]);
        return functionCallTurn([{ name: 'optimizeBasket', args: {} }]);
      },
      request => {
        const [response] = lastToolResponses(request);
        assert.deepEqual((response!.response.result as { recommended: string }).recommended, 'Rami Levy ₪67.26');
        return textTurn('Rami Levy: ₪67.26');
      }
    ]);
    const outcome = await run(model, recordingTools(log));
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.text, 'Rami Levy: ₪67.26');
    assert.deepEqual(log, ['updateCart:add_items', 'optimizeBasket']);
    assert.equal(outcome.modelTurns, 3);
    assert.equal(outcome.usage.totalTokens, 120 + 120 + 130);
    assert.deepEqual(outcome.toolCalls.map(call => call.name), ['updateCart', 'optimizeBasket']);
  });

  test('runs parallel calls from one turn and answers every call in order', async () => {
    const log: string[] = [];
    const model = scriptedModel([
      functionCallTurn([{ name: 'searchProducts', args: { query: ['חלב'] } }, { name: 'searchProducts', args: { query: ['ביצים'] } }]),
      request => {
        assert.equal(lastToolResponses(request).length, 2);
        return textTurn('Found both.');
      }
    ]);
    const outcome = await run(model, recordingTools(log));
    assert.deepEqual(log, ['searchProducts:חלב', 'searchProducts:ביצים']);
    assert.equal(outcome.status, 'completed');
  });

  test('a clarification ends the run without another model turn', async () => {
    const log: string[] = [];
    const model = scriptedModel([functionCallTurn([{ name: 'requestClarification', args: { question: 'How many people are you cooking for?', options: ['2', '4'] } }])]);
    const outcome = await run(model, recordingTools(log));
    assert.equal(outcome.status, 'clarification');
    assert.deepEqual(outcome.clarification, { question: 'How many people are you cooking for?', options: ['2', '4'] });
    assert.equal(model.requests.length, 1);
  });
});

describe('22. tool allowlist and argument validation', () => {
  test('invalid arguments and unknown tools are rejected and reported back to the model', async () => {
    const log: string[] = [];
    const model = scriptedModel([
      functionCallTurn([
        { name: 'searchProducts', args: { query: [] } },
        { name: 'deleteAllCarts', args: {} },
        { name: 'updateCart', args: { operations: 'all of them' } }
      ]),
      request => {
        const responses = lastToolResponses(request);
        assert.deepEqual(responses.map(entry => entry.response.ok), [false, false, false]);
        assert.match(String(responses[0]!.response.error), /Invalid arguments/u);
        assert.match(String(responses[1]!.response.error), /Unknown tool/u);
        return functionCallTurn([{ name: 'searchProducts', args: { query: ['חלב'] } }]);
      },
      textTurn('Recovered.')
    ]);
    const outcome = await run(model, recordingTools(log));
    assert.deepEqual(log, ['searchProducts:חלב'], 'only the valid call executed');
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.toolCalls.filter(call => call.status === 'error').length, 3);
  });

  test('a tool validation error reaches the model, which can fix its arguments', async () => {
    let attempts = 0;
    const tool: AgentTool = {
      name: 'updateCart', description: 'update', label: 'Updating', argsSchema: z.object({ requestText: z.string() }), timeoutMs: 1_000,
      execute: (async (args: { requestText: string }) => {
        attempts++;
        if (!args.requestText.includes('3%')) throw new ValidationError('Item 1 omits or misclassifies "3%" as a requirement.');
        return { data: { ok: true }, summary: 'added' };
      }) as never
    };
    const model = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { requestText: '2 liters of milk' } }]),
      request => {
        assert.match(String(lastToolResponses(request)[0]!.response.error), /3%/u);
        return functionCallTurn([{ name: 'updateCart', args: { requestText: '2 liters of 3% milk' } }]);
      },
      textTurn('Added 3% milk.')
    ]);
    const outcome = await run(model, [tool]);
    assert.equal(attempts, 2);
    assert.equal(outcome.text, 'Added 3% milk.');
  });
});

describe('23. loop stopping limits', () => {
  test('stops after the maximum model turns and forces a text answer', async () => {
    const model = scriptedModel(Array.from({ length: 20 }, () => functionCallTurn([{ name: 'searchProducts', args: { query: ['חלב'] } }])));
    let finalMode = '';
    const wrapped: AgentModel = {
      name: 'wrapped',
      generate: async request => {
        finalMode = request.toolMode;
        return request.toolMode === 'NONE' ? textTurn('Here is what I found so far.') : model.generate(request);
      }
    };
    const outcome = await run(wrapped, recordingTools([]), { maxModelTurns: 4 });
    assert.equal(outcome.status, 'limit_reached');
    assert.equal(outcome.modelTurns, 4);
    assert.equal(finalMode, 'NONE');
    assert.equal(outcome.text, 'Here is what I found so far.');
  });

  test('stops calling tools when the tool-call budget is used up', async () => {
    const log: string[] = [];
    const model: AgentModel = {
      name: 'greedy',
      generate: async request => request.toolMode === 'NONE'
        ? textTurn('Budget reached.')
        : functionCallTurn(Array.from({ length: 3 }, () => ({ name: 'searchProducts', args: { query: ['חלב'] } })))
    };
    const outcome = await run(model, recordingTools(log), { maxToolCalls: 4, maxModelTurns: 10 });
    assert.equal(log.length, 4);
    assert.equal(outcome.text, 'Budget reached.');
  });

  test('limits the number of calls executed from a single turn', async () => {
    const log: string[] = [];
    const model = scriptedModel([
      functionCallTurn(Array.from({ length: 5 }, () => ({ name: 'searchProducts', args: { query: ['חלב'] } }))),
      textTurn('ok')
    ]);
    await run(model, recordingTools(log), { maxCallsPerTurn: 2 });
    assert.equal(log.length, 2);
  });
});

describe('24. timeouts and recovery', () => {
  test('a model call that hangs is retried and the run recovers', async () => {
    let calls = 0;
    const model: AgentModel = {
      name: 'flaky',
      generate: async request => {
        calls++;
        if (calls === 1) return new Promise(() => {}); // never resolves; the loop's timeout aborts it
        return request.toolMode === 'NONE' ? textTurn('late') : textTurn('Recovered after a timeout.');
      }
    };
    const outcome = await run(model, recordingTools([]), { modelTimeoutMs: 100 });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.text, 'Recovered after a timeout.');
    assert.equal(calls, 2);
  });

  test('transient model errors are retried; permanent errors fail the run clearly', async () => {
    let calls = 0;
    const transient: AgentModel = {
      name: 'rate-limited',
      generate: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('429 Resource exhausted'), { status: 429 });
        return textTurn('ok after retries');
      }
    };
    assert.equal((await run(transient, recordingTools([]))).text, 'ok after retries');

    const permanent: AgentModel = { name: 'broken', generate: async () => { throw new ModelError('API key not valid'); } };
    const outcome = await run(permanent, recordingTools([]));
    assert.equal(outcome.status, 'failed');
    assert.match(String(outcome.error?.message), /API key not valid/u);
  });

  test('a tool that exceeds its timeout returns an error to the model, which continues', async () => {
    const log: string[] = [];
    const model = scriptedModel([
      functionCallTurn([{ name: 'optimizeBasket', args: {} }]),
      request => {
        assert.match(String(lastToolResponses(request)[0]!.response.error), /timed out/u);
        return textTurn('The calculation took too long; please try again.');
      }
    ]);
    const outcome = await run(model, recordingTools(log, { slow: true }));
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.toolCalls[0]!.status, 'error');
  });

  test('the whole run has a deadline and client cancellation stops it', async () => {
    const slow: AgentModel = { name: 'slow', generate: () => new Promise(resolve => setTimeout(() => resolve(textTurn('too late')), 2_000)) };
    const timedOut = await run(slow, recordingTools([]), { runTimeoutMs: 150, modelTimeoutMs: 5_000 });
    assert.equal(timedOut.status, 'failed');
    assert.match(String(timedOut.error?.message), /took longer/u);

    const controller = new AbortController();
    const pending = runAgentLoop({
      model: slow, tools: recordingTools([]), signal: controller.signal, limits, systemInstruction: () => 's', contents: []
    });
    setTimeout(() => controller.abort(), 50);
    assert.equal((await pending).status, 'cancelled');
  });
});

describe('31. invalid Gemini responses', () => {
  test('model output parsing keeps thought signatures, drops thought text and rejects blocked prompts', () => {
    const response = {
      candidates: [{ content: { role: 'model', parts: [
        { text: 'internal reasoning', thought: true },
        { functionCall: { name: 'optimizeBasket', args: {} }, thoughtSignature: 'sig-123' }
      ] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 3 }
    } as unknown as GenerateContentResponse;
    const turn = toModelTurn(response);
    assert.equal(turn.text, '');
    assert.deepEqual(turn.functionCalls, [{ name: 'optimizeBasket', args: {} }]);
    assert.equal((turn.content.parts![1] as { thoughtSignature?: string }).thoughtSignature, 'sig-123');
    assert.deepEqual(turn.usage, { promptTokens: 10, outputTokens: 5, thoughtTokens: 3, totalTokens: 15 });
    assert.throws(() => toModelTurn({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } } as unknown as GenerateContentResponse), /blocked: SAFETY/u);
  });

  test('provider errors become clear messages; overload is detected for longer backoff', () => {
    const overloaded = Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'), { status: 503 });
    assert.equal(describeGeminiError(overloaded), 'The Gemini model is temporarily overloaded. Please try again in a moment.');
    assert.equal(isOverloadError(new ModelError('wrapped', { cause: overloaded })), true);
    assert.equal(isOverloadError(Object.assign(new Error('bad request'), { status: 400 })), false);
    assert.match(describeGeminiError(Object.assign(new Error('{"error":{"message":"Invalid JSON payload"}}'), { status: 400 })), /rejected the request: Invalid JSON payload/u);
    assert.match(describeGeminiError(Object.assign(new Error('not found'), { status: 404 })), /GEMINI_MODEL/u);
  });

  test('a function call with non-object arguments is rejected, not executed', async () => {
    const log: string[] = [];
    const model = scriptedModel([
      { ...functionCallTurn([{ name: 'searchProducts', args: {} }]), functionCalls: [{ name: 'searchProducts', args: 'חלב' as never }] },
      textTurn('ok')
    ]);
    const outcome = await run(model, recordingTools(log));
    assert.deepEqual(log, []);
    assert.equal(outcome.toolCalls[0]!.status, 'error');
  });

  test('an empty model answer completes with no text so the caller can use a verified fallback', async () => {
    const outcome = await run(scriptedModel([textTurn('')]), recordingTools([]));
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.text, '');
  });

  test('the matcher retries malformed decisions and never invents a match', async () => {
    const [milk] = referenceItems();
    const candidates = fixtureSearch(['חלב']).slice(0, 10);
    // The request is read once before the batches; these checks are about the batch answers.
    const reading = { wanted: 'Plain milk.', notWanted: [] };
    let calls = 0;
    await assert.rejects(matchItemCandidates(engineItemCore(milk!), candidates, {
      db: null, model: 'fake', batchSize: 10, concurrency: 1,
      callModel: async ({ declaration }) => {
        if (declaration.name === READING_DECLARATION.name) return reading;
        calls++;
        return { decisions: [{ id: 'invented-product', identity: 'MATCH', requirementChecks: [], reason: '', preferencesMet: [] }] };
      }
    }), /did not return a valid decision/u);
    assert.equal(calls, 4, 'bounded retries');

    let first = true;
    const retries: MatchRetry[] = [];
    const recovered = await matchItemCandidates(engineItemCore(milk!), candidates, {
      db: null, model: 'fake', batchSize: 10, concurrency: 1,
      onRetry: retry => retries.push(retry),
      callModel: async ({ prompt, declaration }) => {
        if (declaration.name === READING_DECLARATION.name) return reading;
        if (first) { first = false; return { nonsense: true }; }
        const ids = JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + 11)).map((row: { id: string }) => row.id);
        return { decisions: ids.map((id: string) => ({ id, candidate: 'unsure', identityEvidence: '', relation: 'UNCLEAR', identity: 'UNCERTAIN', requirementChecks: [{ requirement: '3%', kind: 'OTHER', result: 'UNKNOWN', evidenceSource: 'NONE', evidence: '' }], preferencesMet: [] })) };
      }
    });
    assert.equal(recovered.results.matches.length, 0);
    assert.equal(recovered.results.uncertain.length + recovered.results.rejected.length, candidates.length);
    assert.equal(retries.length, 1, 'the unusable answer is reported once');
    assert.equal(retries[0]!.attempt, 1);
    assert.equal(retries[0]!.missing, candidates.length);
    assert.ok(retries[0]!.reason.length > 0, 'with the engine\'s reason');
  });
});

describe('debug logging of each agent step', () => {
  test('prints what Gemini decided, each tool\'s arguments and result, rejected arguments and an empty reply', async () => {
    const details: Array<{ step: string; content: unknown; level?: string }> = [];
    const trace = Object.assign(() => {}, {
      mode: 'on' as const,
      detail: (step: string, content: unknown, level?: string) => { details.push({ step, content, level }); }
    });
    const model = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations: [] } }]),
      functionCallTurn([{ name: 'searchProducts', args: { query: ['חלב'] } }]),
      { ...textTurn(''), finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call.', model: 'gemini-x' }
    ]);
    const outcome = await runAgentLoop({
      model, tools: recordingTools([]), signal: new AbortController().signal, limits, trace,
      systemInstruction: () => 'system', contents: [{ role: 'user', parts: [{ text: 'I want milk' }] }]
    });
    assert.equal(outcome.status, 'completed');

    const decided = details.find(entry => /^turn 1: Gemini replied after \d+ ms$/u.test(entry.step));
    assert.deepEqual((decided?.content as { toolCalls: unknown }).toolCalls, [{ tool: 'updateCart', arguments: { operations: [] } }]);
    const rejected = details.find(entry => entry.step === 'tool updateCart: Gemini\'s arguments were rejected');
    assert.equal(rejected?.level, 'warn');
    assert.match(String((rejected?.content as { problem: string }).problem), /operations/u);
    assert.deepEqual(details.find(entry => entry.step === 'tool searchProducts: called with')?.content, { query: ['חלב'] });
    const result = details.find(entry => /^tool searchProducts: done in \d+ ms$/u.test(entry.step));
    assert.deepEqual(result?.content, { summary: '3 products', result: { totalMatched: 3 } });
    const empty = details.find(entry => /^turn 3: Gemini returned an empty reply after \d+ ms$/u.test(entry.step));
    assert.equal(empty?.level, 'warn');
    assert.deepEqual(empty?.content, {
      model: 'gemini-x', finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call.', tokens: { in: 100, out: 30, thinking: 0 }
    });
  });

  test('the time spent waiting for Gemini is counted, a failed turn included', async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 50));
    const model = scriptedModel([
      async () => { await wait(); return functionCallTurn([{ name: 'searchProducts', args: { query: ['חלב'] } }]); },
      async () => { await wait(); return textTurn('done'); }
    ]);
    const outcome = await run(model, recordingTools([]));
    assert.equal(outcome.status, 'completed');
    assert.ok(outcome.modelMs >= 60, `two 50 ms turns took ${outcome.modelMs} ms`);

    const broken: AgentModel = { name: 'broken', generate: async () => { await wait(); throw new Error('bad request'); } };
    const failed = await run(broken, recordingTools([]));
    assert.equal(failed.status, 'failed');
    assert.ok(failed.modelMs >= 30, `the failed turn counts (${failed.modelMs} ms)`);
  });
});
