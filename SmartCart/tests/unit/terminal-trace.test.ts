import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { timingSummary } from '@/lib/agent/agent';
import { createTerminalTrace, debugMode, describeError, DETAIL_MAX_CHARS, formatDetail, formatDuration, traceAgentEvent, traceVoiceEvent } from '@/lib/server/terminal-trace';
import { ModelError } from '@/lib/shared/errors';

describe('debug logging switch (SMARTCART_DEBUG)', () => {
  test('readable in development and off in production unless configured', () => {
    assert.equal(debugMode({ NODE_ENV: 'development' }), 'on');
    assert.equal(debugMode({ NODE_ENV: 'production' }), 'off');
    assert.equal(debugMode({}), 'off');
    assert.equal(debugMode({ NODE_ENV: 'production', SMARTCART_DEBUG: '1' }), 'on');
    assert.equal(debugMode({ NODE_ENV: 'production', SMARTCART_DEBUG: 'Full' }), 'full');
    for (const value of ['0', 'false', 'OFF', 'no']) assert.equal(debugMode({ NODE_ENV: 'development', SMARTCART_DEBUG: value }), 'off', value);
    assert.equal(debugMode({ NODE_ENV: 'development', SMARTCART_DEBUG: '  ' }), 'on', 'blank counts as unset');
  });
});

describe('terminal summaries and saved debug formatting', () => {
  test('summary mode prints each major phase once and then the outcome', t => {
    const lines: string[] = [];
    t.mock.method(console, 'info', (...args: unknown[]) => { lines.push(String(args[0])); });
    const trace = createTerminalTrace('agent', 'off');
    trace('request.received');
    trace('request.validated', { via: 'voice' });
    trace.detail('customer message', 'אני רוצה חלב');
    for (let index = 1; index <= 40; index++) {
      trace('agent.model.turn.started');
      trace('pipeline.match.started');
      trace('pipeline.match.progress', { processed: index, total: 40 });
      trace('model.attempt.started', { role: 'matcher', modelCall: index });
    }
    trace('pipeline.match.completed', { matched: 5, rejected: 34, uncertain: 1 });
    trace('cart.updated', { items: 1, status: 'COMPLETE' });
    trace('agent.completed', { kind: 'text' });
    trace('stream.finished');
    assert.equal(lines.length, 4);
    const prefix = lines[0]!.match(/^\[smartcart agent [0-9a-f-]{12}\] /u)?.[0];
    assert.ok(prefix);
    assert.ok(lines.every(line => line.startsWith(prefix)));
    const messages = lines.map(line => line.slice(prefix.length));
    assert.deepEqual(messages.slice(0, 3), ['Voice request received', 'Planning with Gemini', 'Checking product matches']);
    assert.match(messages[3]!, /^Answered in .* · 1 cart item · verified basket · 40 product candidates checked$/u);
  });

  test('readable detail mode keeps repeated model turns and tools, with compact batch outcomes', t => {
    const lines: string[] = [];
    t.mock.method(console, 'info', (line: string) => { lines.push(line); });
    const trace = createTerminalTrace('agent', 'on');
    trace('request.validated', { via: 'voice', voiceId: '6a99ad9f-8bf' });
    for (const turn of [1, 2]) {
      trace('agent.model.turn.started', { turn });
      traceAgentEvent(trace, { type: 'tool.started', runId: 'r', callId: `call_${turn}`, tool: 'searchProducts', label: 'Searching the stores' });
      trace.detail('tool searchProducts: called with', { query: ['חלב'] });
      trace('model.attempt.started', { role: 'matcher', modelCall: turn });
      trace('pipeline.match.progress', { processed: turn * 25, total: 50 });
      trace('model.attempt.succeeded', { role: 'matcher', model: 'matcher-model', modelCall: turn, attempt: 1, durationMs: 150 });
    }
    const output = lines.join('\n');
    assert.match(output, /Voice request received.*voice Id=6a99ad9f-8bf/u);
    assert.equal(lines.filter(line => /turn=[12]/u.test(line)).length, 2);
    assert.equal(lines.filter(line => /call Id=call_[12]/u.test(line)).length, 2);
    assert.equal(lines.filter(line => line.includes('matcher-model') && line.includes('150 ms')).length, 2);
    assert.match(output, /tool searchProducts: called with.*חלב/u);
    assert.doesNotMatch(output, /processed=/u);
  });

  test('Live reports heard and spoken turns with shared ID and elapsed time', t => {
    const lines: string[] = [];
    t.mock.method(console, 'info', (line: string) => { lines.push(line); });
    const voiceId = '6a99ad9f-8bf2-47b2-9123-50a6be8b98e6';
    traceVoiceEvent(voiceId, 'exchange finished', 1_500, { heard: 'אני רוצה חלב', said: 'מצאתי חלב' }, 'on');
    traceVoiceEvent(voiceId, 'exchange finished', 1_600, { heard: 'not traced' }, 'off');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\[smartcart live 6a99ad9f-8bf\] \+1\.5 s exchange finished/u);
    assert.match(lines[0]!, /Heard: אני רוצה חלב/u);
    assert.match(lines[0]!, /Said: מצאתי חלב/u);
  });

  test('expected session bootstrap is quiet and other request failures show their code', t => {
    const warning = t.mock.method(console, 'warn', (..._args: unknown[]) => {});
    createTerminalTrace('session', 'off')('request.failed', { code: 'NO_SESSION' }, 'warn');
    assert.equal(warning.mock.callCount(), 0);
    createTerminalTrace('voice', 'off')('request.failed', { code: 'RATE_LIMITED' }, 'warn');
    assert.equal(warning.mock.callCount(), 1);
    assert.match(String(warning.mock.calls[0]?.arguments[0]), /Request failed in .* · RATE_LIMITED$/u);
  });

  test('objects are indented below the heading; errors keep their message, status and cause', () => {
    const provider = Object.assign(new Error('{"error":{"code":503,"message":"The model is overloaded."}}'), { status: 503 });
    const text = formatDetail('H', { failure: new ModelError('Gemini request failed', { cause: provider }) }, false);
    assert.match(text, /^H\n {4}│ \{/u);
    assert.match(text, /ModelError: Gemini request failed/u);
    assert.match(text, /"status": ?503/u);
    assert.match(text, /The model is overloaded/u);
  });

  test('small objects and lists stay on one line; big ones are spread out', () => {
    assert.equal(formatDetail('H', { query: ['חלב 3%'] }, false), 'H: {"query":["חלב 3%"]}');
    const big = formatDetail('H', { products: Array.from({ length: 12 }, (_, index) => `product number ${index}`) }, false);
    assert.match(big, /^H\n {4}│ \{\n {4}│ {3}"products": \[\n {4}│ {5}"product number 0",/u);
  });

  test('unexpected errors show where they were thrown; provider errors do not', () => {
    assert.ok((describeError(new TypeError('items is undefined')) as { where?: string[] }).where?.length);
    assert.equal((describeError(Object.assign(new Error('HTTP 503'), { status: 503 })) as { where?: string[] }).where, undefined);
  });

  test('long terminal content is shortened; secrets and cycles are handled', () => {
    const long = 'x'.repeat(DETAIL_MAX_CHARS + 50);
    assert.match(formatDetail('H', long, false), /… 50 more characters in logs\/smartcart\.log$/u);
    assert.ok(formatDetail('H', long, true).includes(long));
    assert.doesNotMatch(formatDetail('H', { key: 'AIzaSyA1234567890abcdefghijklmnop' }, false), /AIza/u);
    assert.equal(formatDetail('H', '', false), 'H: (empty)');
    const cart: Record<string, unknown> = { name: 'cart' };
    cart.self = cart;
    assert.match(formatDetail('H', cart, false), /"self": ?"\[shown above\]"/u);
  });

  test('durations read as ms under a second and seconds above', () => {
    assert.equal(formatDuration(0), '0 ms');
    assert.equal(formatDuration(850), '850 ms');
    assert.equal(formatDuration(1_500), '1.5 s');
    assert.equal(formatDuration(12_345), '12.3 s');
  });

  test('each run ends with where its time went', () => {
    assert.deepEqual(timingSummary(10_000, 6_000, 3, [
      { name: 'updateCart', status: 'ok', durationMs: 120, summary: '' },
      { name: 'optimizeBasket', status: 'ok', durationMs: 2_500, summary: '' },
      { name: 'optimizeBasket', status: 'ok', durationMs: 1_200, summary: 'finalization' }
    ]), { totalMs: 10_000, geminiMs: 6_000, geminiTurns: 3, toolsMs: 3_820, tools: 'updateCart 120 ms, optimizeBasket ×2 3.7 s', otherMs: 180 });
    assert.deepEqual(timingSummary(500, 0, 0, []), { totalMs: 500, geminiMs: 0, geminiTurns: 0, toolsMs: 0, otherMs: 500 });
  });

  test('the debug trace receives answers, questions with options, and failure messages', () => {
    const details: Array<[string, unknown]> = [];
    const trace = Object.assign(() => {}, { mode: 'on' as const, detail: (step: string, content: unknown) => { details.push([step, content]); } });
    traceAgentEvent(trace, { type: 'agent.completed', runId: 'r', message: { id: 'm1', content: 'בטח', kind: 'text' } });
    traceAgentEvent(trace, { type: 'agent.completed', runId: 'r', message: { id: 'm2', content: 'Which one?', kind: 'clarification', options: ['A', 'B'] } });
    traceAgentEvent(trace, { type: 'agent.failed', runId: 'r', error: { code: 'RATE_LIMITED', message: 'Still working.' } });
    assert.deepEqual(details, [
      ['answer for the customer', 'בטח'],
      ['question for the customer', { text: 'Which one?', options: ['A', 'B'] }],
      ['message shown to the customer', 'Still working.']
    ]);
  });
});
