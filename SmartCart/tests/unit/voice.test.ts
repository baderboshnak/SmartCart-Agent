import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { base64ToPcm16, concatFloat32, downsample, floatToPcm16, pcm16ToBase64, pcm16ToFloat } from '@/lib/client/audio';
import { RateLimitError } from '@/lib/shared/errors';
import { buildLiveConfig, VOICE_TOOL_NAME } from '@/lib/voice/live-config';
import { normalizeSpokenRequest } from '@/lib/voice/normalize-speech';
import { buildTokenConfig, checkVoiceRateLimit } from '@/lib/voice/token';
import { validateDirectItems } from '@/lib/shopping/request-items';
import type { ChatMessage } from '@/lib/shared/types';

describe('spoken requests become checkable text', () => {
  test('number words and "percent" become digits and %', () => {
    assert.equal(normalizeSpokenRequest('two liters of three percent milk, preferably Tnuva, and twelve eggs'),
      '2 liters of 3% milk, preferably Tnuva, and 12 eggs');
    assert.equal(normalizeSpokenRequest('five hundred grams of shredded mozzarella'), '500 grams of shredded mozzarella');
    assert.equal(normalizeSpokenRequest('one point five liters of milk'), '1.5 liters of milk');
    assert.equal(normalizeSpokenRequest('twenty-five percent cream'), '25% cream');
    assert.equal(normalizeSpokenRequest('3 per cent milk'), '3% milk');
    assert.equal(normalizeSpokenRequest('two hundred and fifty grams'), '250 grams');
  });

  test('Hebrew and Arabic percentages', () => {
    assert.equal(normalizeSpokenRequest('2 ליטר חלב שלושה אחוז'), '2 ליטר חלב 3%');
    assert.equal(normalizeSpokenRequest('חלב 3 אחוזים'), 'חלב 3%');
    assert.equal(normalizeSpokenRequest('حليب ثلاثة بالمئة'), 'حليب 3%');
    assert.equal(normalizeSpokenRequest('حليب ٣ في المئة'), 'حليب 3%');
  });

  test('ordinary text is unchanged', () => {
    assert.equal(normalizeSpokenRequest('I want a dozen eggs and some bread'), 'I want a dozen eggs and some bread');
    assert.equal(normalizeSpokenRequest('Make it cheaper'), 'Make it cheaper');
    assert.equal(normalizeSpokenRequest('Remove the eggs, and only Tnuva milk'), 'Remove the eggs, and only Tnuva milk');
  });

  test('the normalized request passes the agent\'s strict item check', () => {
    const message = normalizeSpokenRequest('I want two liters of three percent milk');
    const items = validateDirectItems({
      requestText: '2 liters of 3% milk',
      items: [{ sourceText: '2 liters of 3% milk', product: 'milk', coreSearchTerm: 'חלב', quantity: { amount: 2, unit: 'l' },
        constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' }] }]
    }, message);
    assert.deepEqual(items[0]!.requirements, ['3%']);
  });
});

describe('browser audio conversion', () => {
  test('PCM16 round trip through base64 keeps the samples', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const pcm = floatToPcm16(samples);
    assert.deepEqual([...pcm], [0, 16384, -16384, 32767, -32768, 8192]);
    const decoded = base64ToPcm16(pcm16ToBase64(pcm));
    assert.deepEqual([...decoded], [...pcm]);
    const back = pcm16ToFloat(decoded);
    assert.ok(Math.abs(back[1]! - 0.5) < 0.001 && back[4] === -1);
    assert.deepEqual([...floatToPcm16(new Float32Array([2, -3]))], [32767, -32768], 'clipped');
  });

  test('downsampling 48 kHz to 16 kHz averages groups of three samples', () => {
    const input = new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6, 0.9]);
    const output = downsample(input, 48_000, 16_000);
    assert.equal(output.length, 2);
    assert.ok(Math.abs(output[0]! - 0.3) < 1e-6 && Math.abs(output[1]! - 0.6) < 1e-6);
    assert.equal(downsample(input, 16_000, 16_000), input);
    assert.deepEqual([...concatFloat32([new Float32Array([1]), new Float32Array([2, 3])])], [1, 2, 3]);
  });
});

describe('voice session security', () => {
  test('the token is single-use, short-lived and locked to SmartCart\'s voice settings', () => {
    const config = buildLiveConfig();
    const now = Date.parse('2026-11-21T10:00:00Z');
    const token = buildTokenConfig('gemini-3.8-live', config, now);
    assert.equal(token.uses, 1);
    assert.equal(token.newSessionExpireTime, '2026-11-21T10:01:00.000Z');
    assert.equal(token.expireTime, '2026-11-21T10:30:00.000Z');
    assert.equal(token.liveConnectConstraints?.model, 'gemini-3.8-live');
    assert.equal(token.liveConnectConstraints?.config, config);
    assert.equal(token.lockAdditionalFields, undefined, 'every Live setting stays locked');
  });

  test('the voice model can only hand requests to the shopping agent', () => {
    const config = buildLiveConfig();
    const declarations = config.tools?.flatMap(tool => 'functionDeclarations' in tool ? tool.functionDeclarations ?? [] : []) ?? [];
    assert.deepEqual(declarations.map(declaration => declaration.name), [VOICE_TOOL_NAME]);
    assert.deepEqual(config.responseModalities, ['AUDIO']);
    assert.ok(config.inputAudioTranscription && config.outputAudioTranscription, 'both sides are transcribed for the chat');
    assert.match(String(config.systemInstruction), /Never invent products, prices/u);
  });

  test('saved chat history is bounded reference context in the locked setup', () => {
    const messages: ChatMessage[] = Array.from({ length: 14 }, (_, index) => ({
      id: String(index), role: 'user', kind: 'text', content: `Request ${index}`, createdAt: new Date()
    }));
    messages.push(
      { id: 'long', role: 'assistant', kind: 'text', content: 'x'.repeat(800), createdAt: new Date() },
      { id: 'error', role: 'assistant', kind: 'error', content: 'Internal error', createdAt: new Date() }
    );

    const config = buildLiveConfig(messages);
    const token = buildTokenConfig('gemini-3.8-live', config);
    const instructions = String(token.liveConnectConstraints?.config?.systemInstruction);
    const history = JSON.parse(instructions.slice(instructions.lastIndexOf('\n') + 1));

    assert.match(instructions, /Use it only to resolve references in new speech/u);
    assert.equal(history.length, 12);
    assert.deepEqual(history[0], { role: 'user', text: 'Request 3' });
    assert.deepEqual(history.at(-1), { role: 'assistant', text: 'x'.repeat(600) });
  });

  test('voice sessions are rate limited per shopping session', () => {
    const session = `session-${Math.random()}`;
    const start = Date.now();
    for (let index = 0; index < 20; index++) checkVoiceRateLimit(session, start + index);
    assert.throws(() => checkVoiceRateLimit(session, start + 21), RateLimitError);
    assert.doesNotThrow(() => checkVoiceRateLimit(session, start + 11 * 60 * 1000), 'the window resets');
  });
});
