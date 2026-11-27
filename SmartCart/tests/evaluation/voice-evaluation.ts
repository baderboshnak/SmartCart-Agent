import assert from 'node:assert/strict';
import { Live, LiveServerMessage, type FunctionResponse, type LiveConnectParameters, type Session } from '@google/genai';
import { VoiceSession, type VoiceCallbacks, type VoiceState } from '@/lib/client/voice-session';
import { VOICE_TOOL_NAME } from '@/lib/voice/constants';
import { buildLiveConfig } from '@/lib/voice/live-config';
import { recordCase } from './backend-case';
import type { EvaluationCase, EvaluationSection } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const flush = async () => { await new Promise<void>(done => setImmediate(done)); };

/** Run the real VoiceSession with browser/audio boundaries and Gemini's socket replaced. */
async function withVoice<T>(
  execute: (voice: Awaited<ReturnType<typeof voiceFixture>>) => T | Promise<T>,
  settings: { request?: VoiceCallbacks['onToolRequest']; microphoneDenied?: boolean; tokenRejected?: boolean } = {}
): Promise<T> {
  const fixture = await voiceFixture(settings);
  try { return await execute(fixture); } finally { await fixture.restore(); }
}

async function voiceFixture(settings: { request?: VoiceCallbacks['onToolRequest']; microphoneDenied?: boolean; tokenRejected?: boolean }) {
  const stats = { tokenRequests: 0, connections: 0, closed: 0, audioSent: 0, playbackStopped: 0, tracksStopped: 0 };
  let callbacks: LiveConnectParameters['callbacks'] | undefined;
  let model: string | undefined;
  let setup: LiveConnectParameters['config'];
  let worklet: { port: { onmessage?: (event: { data: Float32Array }) => void } } | undefined;
  const states: VoiceState[] = [], errors: string[] = [], replies: FunctionResponse[][] = [];
  const requests: unknown[][] = [];
  const captions: Array<{ user: string; assistant: string }> = [];
  const exchanges: Array<{ userText: string; assistantText: string; usedTool: boolean }> = [];
  const original = Live.prototype.connect;
  const restore: Array<() => void> = [];
  const override = (key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restore.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  };

  class FixtureAudioContext {
    sampleRate = 16_000;
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {}
    async close() {}
    createMediaStreamSource() { return this.createGain(); }
    createGain() { return { gain: { value: 1 }, connect: (target: unknown) => target }; }
    createBuffer() { return { duration: 0.1, getChannelData: () => new Float32Array(128) }; }
    createBufferSource() {
      return { connect() {}, start() {}, stop() { stats.playbackStopped++; } };
    }
  }
  class FixtureWorklet {
    port: { onmessage?: (event: { data: Float32Array }) => void; close(): void } = { close() {} };
    constructor() { worklet = this; }
    connect(target: unknown) { return target; }
    disconnect() {}
  }

  override('AudioContext', FixtureAudioContext);
  override('AudioWorkletNode', FixtureWorklet);
  override('navigator', { mediaDevices: { async getUserMedia() {
    if (settings.microphoneDenied) throw new Error('Simulated microphone denied');
    return { getTracks: () => [{ stop() { stats.tracksStopped++; } }] };
  } } });
  override('fetch', async (input: unknown, init: RequestInit) => {
    assert.equal(input, '/api/voice/token', 'Offline voice fixture accepts only the application token endpoint');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    stats.tokenRequests++;
    if (settings.tokenRejected) return Response.json({ error: { message: 'Token unavailable' } }, { status: 503 });
    return Response.json({ token: 'synthetic-token', model: 'gemini-3.8-live', debug: false, config: buildLiveConfig() });
  });
  Live.prototype.connect = async params => {
    stats.connections++;
    callbacks = params.callbacks;
    model = params.model;
    setup = params.config;
    return {
      close() { stats.closed++; },
      sendToolResponse(data: { functionResponses: FunctionResponse[] }) { replies.push(structuredClone(data.functionResponses)); },
      sendRealtimeInput() { stats.audioSent++; }
    } as unknown as Session;
  };
  restore.push(() => { Live.prototype.connect = original; });

  const voice = new VoiceSession({
    onState(state) { states.push(state); },
    onCaption(caption) { captions.push(caption); },
    async onToolRequest(...args) { requests.push(args); return settings.request?.(...args) ?? '1 loaf, ₪6.90, Fixture Supermarket'; },
    onExchangeComplete(exchange) { exchanges.push(exchange); },
    onError(error) { errors.push(error); }
  });
  try { await voice.start(); } catch (error) {
    for (const unset of restore.reverse()) unset();
    throw error;
  }
  return {
    voice, stats, states, errors, replies, requests, captions, exchanges, model, setup,
    feed: (message: Pick<LiveServerMessage, 'serverContent' | 'toolCall'>) => callbacks?.onmessage(Object.assign(new LiveServerMessage(), message)),
    capture: () => worklet?.port.onmessage?.({ data: new Float32Array(1600) }),
    disconnected: (event: { reason: string; code: number }) => callbacks?.onclose?.(event as CloseEvent),
    networkError: () => callbacks?.onerror?.({ message: 'Synthetic offline fault' } as ErrorEvent),
    async restore() {
      try { await voice.stop(); } finally { for (const unset of restore.reverse()) unset(); }
    }
  };
}

function tool(request: string | undefined, language: string, id = 'voice-tool') {
  return { toolCall: { functionCalls: [{ id, name: VOICE_TOOL_NAME, args: { request, language } }] } };
}

export async function runVoice(): Promise<EvaluationSection> {
  const cases: EvaluationCase[] = [];
  const check = <T,>(id: string, title: string, expected: unknown, execute: () => T | Promise<T>, verify: (actual: T) => void) =>
    recordCase(cases, { id: `voice-${id}`, title, request: title, category: 'voice', expected, component: 'browser VoiceSession' }, execute, verify);

  await check('start', 'Start a voice session and capture microphone audio', 'A same-origin token request, audio setup and an offline frame sent', () =>
    withVoice(fixture => {
      fixture.capture();
      return { stats: { ...fixture.stats }, states: [...fixture.states], model: fixture.model, output: fixture.setup?.responseModalities };
    }), actual => {
      assert.equal(actual.stats.tokenRequests, 1);
      assert.equal(actual.stats.connections, 1);
      assert.equal(actual.stats.audioSent, 1);
      assert.equal(actual.model, 'gemini-3.8-live');
      assert.deepEqual(actual.output, ['AUDIO']);
      assert.deepEqual(actual.states, ['connecting', 'listening']);
    });

  for (const voice of [{ text: 'תוסיף לחם', language: 'Hebrew', code: 'he' }, { text: 'Add bread', language: 'English', code: 'en' }, { text: 'ضيف خبز', language: 'Arabic', code: 'ar' }]) {
    const basketAnswer = '1 loaf, ₪6.90, Fixture Supermarket';
    await check(`handoff-${voice.code}`, `Pass through a ${voice.language} transcription and preserve the basket response`, {
      request: voice.text, language: voice.code, basketAnswer
    }, () => withVoice(async fixture => {
      fixture.feed({ serverContent: { inputTranscription: { text: voice.text } } });
      // An omitted request field must fall back to the buffered transcription.
      fixture.feed(tool(undefined, voice.language));
      await flush();
      fixture.feed({ serverContent: { outputTranscription: { text: basketAnswer }, turnComplete: true } });
      return { requests: fixture.requests, replies: fixture.replies, captions: fixture.captions, exchanges: fixture.exchanges };
    }), actual => {
      assert.deepEqual(actual.requests, [[voice.text, voice.code, undefined]]);
      assert.equal(actual.replies[0]?.[0]?.response?.answer, basketAnswer);
      assert.equal(actual.exchanges[0]?.userText, voice.text);
      assert.equal(actual.exchanges[0]?.assistantText, basketAnswer);
      assert.equal(actual.exchanges[0]?.usedTool, true);
    });
  }

  await check('interrupt', 'Interrupt model speech while audio is queued', { playbackStopped: 1 }, () => withVoice(fixture => {
    fixture.feed({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAAAA==' } }] } } });
    fixture.feed({ serverContent: { interrupted: true } });
    return { playbackStopped: fixture.stats.playbackStopped };
  }), actual => assert.equal(actual.playbackStopped, 1));

  await check('duplicate', 'Deliver the same provider tool-call ID twice', { forwardedToAgent: 1, replies: 1 }, () => withVoice(async fixture => {
    fixture.feed(tool('Add bread', 'English', 'duplicate-01'));
    await flush();
    fixture.feed(tool('Add bread', 'English', 'duplicate-01'));
    await flush();
    return { forwardedToAgent: fixture.requests.length, replies: fixture.replies.length };
  }), actual => assert.deepEqual(actual, { forwardedToAgent: 1, replies: 1 }, 'Duplicate delivery was forwarded twice and may repeat a cart mutation.'));

  await check('wrong-spoken-basket', 'Reject a spoken paraphrase that changes the checked product count and price', {
    shoppingAnswer: '1 loaf, ₪6.90, Fixture Supermarket', spokenContains: ['1 loaf', '₪6.90']
  }, () => withVoice(async fixture => {
    fixture.feed(tool('Buy one loaf', 'English'));
    await flush();
    fixture.feed({ serverContent: { outputTranscription: { text: 'I found 3 loaves for ₪90.' }, turnComplete: true } });
    return { shoppingAnswer: fixture.replies[0]?.[0]?.response?.answer, shownTranscript: fixture.exchanges[0]?.assistantText ?? '' };
  }), actual => {
    assert.equal(actual.shoppingAnswer, '1 loaf, ₪6.90, Fixture Supermarket');
    assert.match(actual.shownTranscript, /1 loaf.*₪6\.90/u, 'The voice layer displayed a provider paraphrase that contradicted the shopping answer.');
  });

  await check('disconnect', 'Receive an unexpected Live connection close', 'Report the reason, stop the microphone, close the session and return to idle', () =>
    withVoice(async fixture => {
      fixture.disconnected({ code: 1011, reason: 'Synthetic disconnect' });
      await flush();
      return { errors: fixture.errors, closed: fixture.stats.closed, micStopped: fixture.stats.tracksStopped, state: fixture.states.at(-1) };
    }), actual => assert.deepEqual(actual, { errors: ['The voice session ended: Synthetic disconnect'], closed: 1, micStopped: 1, state: 'idle' }));

  await check('network-error', 'Handle a Live connection error', 'Report the error and return to idle', () => withVoice(async fixture => {
    fixture.networkError();
    await flush();
    return { errors: fixture.errors, state: fixture.states.at(-1) };
  }), actual => assert.deepEqual(actual, { errors: ['The voice connection had an error.'], state: 'idle' }));

  await check('token-error', 'Fail to initialize a voice session when its token request is rejected', 'No connection, an explanatory error and idle state', () =>
    withVoice(async fixture => {
      await flush();
      return { connections: fixture.stats.connections, errors: fixture.errors, state: fixture.states.at(-1) };
    }, { tokenRejected: true }), actual => assert.deepEqual(actual, { connections: 0, errors: ['Token unavailable'], state: 'idle' }));

  await check('microphone-error', 'Deny microphone access', 'No token or socket request and a microphone permission message', () => withVoice(fixture => ({
    tokens: fixture.stats.tokenRequests, connections: fixture.stats.connections, errors: fixture.errors
  }), { microphoneDenied: true }), actual => {
    assert.equal(actual.tokens, 0);
    assert.equal(actual.connections, 0);
    assert.match(actual.errors[0]!, /Microphone access was blocked/u);
  });

  await check('long-shopping', 'Keep the voice exchange open while shopping work is pending', 'Thinking and no early response, then the full answer', async () => {
    const pending = deferred<string>();
    return withVoice(async fixture => {
      fixture.feed(tool('Find bread', 'English'));
      fixture.feed({ serverContent: { turnComplete: true } });
      await flush();
      const early = { state: fixture.states.at(-1), replies: fixture.replies.length, exchanges: fixture.exchanges.length };
      pending.resolve('1 loaf, ₪6.90');
      await flush();
      return { early, answer: fixture.replies[0]?.[0]?.response?.answer };
    }, { request: () => pending.promise });
  }, actual => assert.deepEqual(actual, { early: { state: 'thinking', replies: 0, exchanges: 0 }, answer: '1 loaf, ₪6.90' }));

  await check('cancel', 'Stop voice while a shopping request is still pending', 'Close voice and suppress the late reply', async () => {
    const pending = deferred<string>();
    return withVoice(async fixture => {
      fixture.feed(tool('Find bread', 'English'));
      await fixture.voice.stop();
      pending.resolve('Late result');
      await flush();
      return { closed: fixture.stats.closed, replies: fixture.replies.length, stopped: fixture.stats.tracksStopped, state: fixture.states.at(-1) };
    }, { request: () => pending.promise });
  }, actual => assert.deepEqual(actual, { closed: 1, replies: 0, stopped: 1, state: 'idle' }));

  cases.push({ id: 'voice-live-quality', title: 'Speech recognition, pronunciation and real Live latency', category: 'voice', status: 'requires-live',
    component: 'Gemini Live provider', expected: 'Provider-level speech and spoken timing from a controlled real voice session' });
  return { name: 'Voice integration', mode: 'MOCK', cases, metrics: { externalAiRequests: 0 }, notes: [
    'The application VoiceSession runs against a synthetic browser audio layer, token endpoint response and Live socket. Transcribed text and provider messages are scripted.',
    'Voice cancellation discards late socket replies. This unit exercises the browser socket lifecycle; it does not establish that an already forwarded shopping request is aborted on the server.'
  ] };
}
