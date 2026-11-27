import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GoogleGenAI, type FunctionCall, type Session, type UsageMetadata } from '@google/genai';
import { parseLanguage } from '@/lib/i18n/language';
import { buildLiveConfig, VOICE_TOOL_NAME } from '@/lib/voice/live-config';
import fixtures from './approved-voice-fixtures.json';
import { reportDirectory } from './report';
import type { EvaluationCase, EvaluationSection } from './types';

const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;
const MAX_INPUT_SECONDS = 9;
const MAX_OUTPUT_SECONDS = 14;
const MAX_SESSION_MS = 25_000;
const VOICE_RESERVATION_USD = 0.014;
type Fixture = typeof fixtures[number];

interface VoiceOptions {
  apiKey: string;
  model: string;
  authorize(id: string, reservedUsd: number): boolean;
  complete(id: string, observedUsd: number): void;
}

function pcmFixture(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a local WAV fixture.');
  }
  let pcm: Buffer | undefined;
  let rate = 0;
  for (let cursor = 12; cursor + 8 <= wav.length;) {
    const name = wav.toString('ascii', cursor, cursor + 4);
    const size = wav.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    if (start + size > wav.length) throw new Error('Incomplete WAV chunk.');
    if (name === 'fmt ' && size >= 16) {
      if (wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16) {
        throw new Error('Expected mono, 16-bit PCM test audio.');
      }
      rate = wav.readUInt32LE(start + 4);
    }
    if (name === 'data') pcm = wav.subarray(start, start + size);
    cursor = start + size + (size % 2);
  }
  if (!pcm || pcm.length < 2 || pcm.length % 2 || rate < 8_000 || rate > 48_000) throw new Error('Unexpected WAV audio.');
  const samples = pcm.length / 2;
  if (samples / rate > MAX_INPUT_SECONDS) throw new Error('The audio fixture exceeds the approved duration.');
  const outputSamples = Math.floor(samples * INPUT_RATE / rate);
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index++) {
    const position = index * rate / INPUT_RATE;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples - 1);
    const ratio = position - left;
    output.writeInt16LE(Math.round(pcm.readInt16LE(left * 2) * (1 - ratio) + pcm.readInt16LE(right * 2) * ratio), index * 2);
  }
  return output;
}

async function readFixture(fixture: Fixture): Promise<Buffer> {
  const path = resolve(reportDirectory, 'approved-voice-inputs', `${fixture.id}.wav`);
  return pcmFixture(await readFile(path));
}

export async function inspectApprovedVoiceFixtures() {
  return Promise.all(fixtures.map(async fixture => ({ id: fixture.id, seconds: (await readFixture(fixture)).length / (2 * INPUT_RATE) })));
}

function tokens(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
}

function estimateVoiceUsd(usage: UsageMetadata[]) {
  let micros = 0;
  for (const row of usage) {
    const hasFullTotal = row.totalTokenCount !== undefined;
    if (!hasFullTotal || row.promptTokenCount === undefined) return undefined;
    const input = tokens(row.promptTokenCount) + tokens(row.toolUsePromptTokenCount);
    const output = Math.max(tokens(row.totalTokenCount) - input, tokens(row.responseTokenCount) + tokens(row.thoughtsTokenCount));
    const audioIn = row.promptTokensDetails?.filter(part => part.modality === 'AUDIO').reduce((sum, part) => sum + tokens(part.tokenCount), 0) ?? input;
    const audioOut = row.responseTokensDetails?.filter(part => part.modality === 'AUDIO').reduce((sum, part) => sum + tokens(part.tokenCount), 0) ?? output;
    micros += audioIn * 3 + Math.max(0, input - audioIn) * 0.75 + audioOut * 12 + Math.max(0, output - audioOut) * 4.50;
  }
  return usage.length ? micros / 1_000_000 : undefined;
}

function comparable(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(/[\u0591-\u05bd\u05bf-\u05c7\u064b-\u065f]/gu, '')
    .replace(/[٠-٩۰-۹]/gu, char => String(char.charCodeAt(0) % 16)).replace(/[أإآ]/gu, 'ا');
}

function handoffPreserves(fixture: Fixture, request: string): boolean {
  const text = comparable(request);
  if (fixture.language === 'he') return /(?:2|שתי|שני)\s*חבילות/u.test(text) && /ביצים/u.test(text) &&
    /(?:2|שני|שתי)\s*בקבוק/u.test(text) && /חלב/u.test(text);
  if (fixture.language === 'ar') return /(?:2\s*علب|علبت[اي]ن|علبتين|اثنتين)/u.test(text) && /تون[ةه]/u.test(text) && /(?:بالماء|في الماء|مع الماء)/u.test(text);
  return /(?:2|two) bags?/u.test(text) && /basmati/u.test(text) && /rice/u.test(text);
}

function speechPreserves(fixture: Fixture, speech: string): boolean {
  const text = comparable(speech);
  if (!handoffPreserves(fixture, text)) return false;
  if (fixture.language === 'he') return /רמי\s*לוי/u.test(text) && /(?:42[.,]80?\b|42.*80|ארבעים\s+ושניי?ם.*שמונים)/u.test(text);
  if (fixture.language === 'ar') return /رامي\s*ليف[يى]/u.test(text) && /(?:\b12\b|اثن[اوي]\s+عشر)/u.test(text);
  return /shufersal|shoofer\s*sal/iu.test(text) && /\b(?:18|eighteen)\b/u.test(text);
}

async function liveProbe(options: VoiceOptions, fixture: Fixture, pcm: Buffer) {
  let session: Session | undefined;
  let closed = false;
  let finishReason = 'session timeout';
  let finish!: () => void;
  let setup!: () => void;
  let sentAnswer = false;
  let submittedAudio = false;
  let outputBytes = 0;
  let afterAnswer = '';
  let heard = '';
  let heardLanguage = '';
  let said = '';
  const toolCalls: FunctionCall[] = [];
  const usage: UsageMetadata[] = [];
  const started = performance.now();
  const finished = new Promise<void>(done => { finish = done; });
  const setupComplete = new Promise<void>(done => { setup = done; });
  const end = (reason: string) => {
    if (closed) return;
    closed = true;
    finishReason = reason;
    session?.close();
    finish();
  };
  const deadline = setTimeout(() => end('session timeout'), MAX_SESSION_MS);
  let grace: NodeJS.Timeout | undefined;
  const ai = new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { apiVersion: 'v1beta' } });
  try {
    const connection = ai.live.connect({
      model: options.model,
      config: { ...buildLiveConfig(), maxOutputTokens: 350 },
      callbacks: {
        onmessage(message) {
          if (closed) return;
          if (message.setupComplete) setup();
          if (message.usageMetadata?.totalTokenCount) usage.push(message.usageMetadata);
          const content = message.serverContent;
          heard += content?.inputTranscription?.text ?? '';
          heardLanguage = content?.inputTranscription?.languageCode ?? heardLanguage;
          const spoken = content?.outputTranscription?.text ?? '';
          said += spoken;
          if (sentAnswer) afterAnswer += spoken;
          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) outputBytes += Buffer.from(part.inlineData.data, 'base64').length;
          }
          if (outputBytes > OUTPUT_RATE * 2 * MAX_OUTPUT_SECONDS) { end('audio output limit'); return; }
          for (const call of message.toolCall?.functionCalls ?? []) {
            toolCalls.push(call);
            if (sentAnswer || toolCalls.length > 1) { end('duplicate tool call'); return; }
            if (!session || call.name !== VOICE_TOOL_NAME) { end('unexpected tool call'); return; }
            try {
              session.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: { answer: fixture.answer } }] });
              sentAnswer = true;
            } catch { end('tool response transmission failed'); return; }
          }
          if (content?.turnComplete && submittedAudio && (afterAnswer.trim() || !toolCalls.length)) {
            grace ??= setTimeout(() => end('turn completed'), 300);
          }
        },
        onerror(event) { end(`Gemini Live error: ${String(event.message ?? 'unknown').replaceAll(options.apiKey, '[redacted]').slice(0, 250)}`); },
        onclose(event) { end(`Gemini Live closed ${event.code}: ${event.reason?.replaceAll(options.apiKey, '[redacted]').slice(0, 250) ?? ''}`); }
      }
    });
    void connection.then(open => { if (closed) open.close(); }).catch(() => {});
    session = (await Promise.race([connection, finished.then(() => undefined)]));
    await Promise.race([setupComplete, finished]);
    if (session && !closed) {
      const chunkBytes = INPUT_RATE * 2 / 10;
      for (let offset = 0; offset < pcm.length && !closed; offset += chunkBytes) {
        session.sendRealtimeInput({ audio: { data: pcm.subarray(offset, offset + chunkBytes).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
        await delay(100);
      }
      if (!closed) {
        submittedAudio = true;
        session.sendRealtimeInput({ audioStreamEnd: true });
      }
    }
    await finished;
  } catch (error) {
    end((error instanceof Error ? error.message : String(error)).replaceAll(options.apiKey, '[redacted]').slice(0, 400));
  } finally {
    clearTimeout(deadline);
    if (grace) clearTimeout(grace);
    if (!closed) end('session closed');
  }
  const first = toolCalls[0];
  const args = first?.args as { request?: unknown; language?: unknown } | undefined;
  const request = typeof args?.request === 'string' ? args.request : '';
  const audit = [];
  if (finishReason !== 'turn completed') audit.push(finishReason);
  if (!heard.trim()) audit.push('Gemini emitted no input transcript.');
  if (toolCalls.length !== 1 || first?.name !== VOICE_TOOL_NAME || !sentAnswer) audit.push('Expected exactly one successful shopping-agent handoff.');
  if (typeof args?.language !== 'string' || parseLanguage(args.language) !== fixture.language) audit.push('The forwarded language differs from the audio fixture.');
  if (!handoffPreserves(fixture, request)) audit.push('The tool request lost an item, quantity, container or qualifier.');
  if (!speechPreserves(fixture, afterAnswer)) audit.push('The final spoken transcript did not preserve the checked products, quantities, store and total.');
  const estimatedUsd = estimateVoiceUsd(usage);
  if (estimatedUsd !== undefined) options.complete(fixture.id, estimatedUsd);
  return { actual: { heard: heard.trim(), heardLanguage, toolCalls, sentFixtureAnswer: sentAnswer, said: said.trim(),
      afterTool: afterAnswer.trim(), finishReason, usage, estimatedUsd }, logs: audit,
    durationMs: performance.now() - started, status: (audit.length ? 'fail' : 'pass') as 'fail' | 'pass',
    metrics: { audioInputSeconds: pcm.length / (INPUT_RATE * 2), audioOutputSeconds: outputBytes / (OUTPUT_RATE * 2), estimatedUsd }
  };
}

export async function runApprovedVoiceTests(options: VoiceOptions): Promise<EvaluationSection> {
  if (process.env.SMARTCART_EVAL_OFFLINE === '1') throw new Error('Local network guard prevents live voice sessions.');
  const cases: EvaluationCase[] = [];
  for (const fixture of fixtures) {
    const record = { id: fixture.id, title: fixture.id.replaceAll('-', ' '), request: fixture.request,
      expected: fixture.expectedFacts, category: `${fixture.language} audio`, component: 'Gemini Live audio and shopping-agent handoff' };
    let pcm: Buffer;
    try { pcm = await readFixture(fixture); }
    catch (error) {
      cases.push({ ...record, status: 'skip', actual: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!options.authorize(fixture.id, VOICE_RESERVATION_USD)) {
      cases.push({ ...record, status: 'skip', actual: 'The reservation did not fit within the approved budget.' });
      continue;
    }
    try { cases.push({ ...record, ...await liveProbe(options, fixture, pcm) }); }
    catch (error) {
      cases.push({ ...record, status: 'fail', actual: (error instanceof Error ? error.message : String(error)).replaceAll(options.apiKey, '[redacted]') });
    }
    console.log(`${fixture.id} ${cases.at(-1)?.status}`);
  }
  return { name: 'Three short real voice sessions', mode: 'LIVE', cases,
    metrics: { model: options.model, maxInputSeconds: MAX_INPUT_SECONDS, maxOutputSeconds: MAX_OUTPUT_SECONDS,
      maxSessionMs: MAX_SESSION_MS, maxReservedUsdPerSession: VOICE_RESERVATION_USD }, notes: [
      'These sessions streamed local Windows-generated speech to Gemini Live with the production voice prompt and shopping tool declaration.',
      'The shopping tool returned an independently specified fixture answer so the voice handoff and spoken facts could be checked separately from text planning.',
      'Spoken facts were checked against the model output transcript. Microphone hardware and speech across accents were outside this probe.',
      'Provider responses without complete usage retain the original reservation.'
    ] };
}
