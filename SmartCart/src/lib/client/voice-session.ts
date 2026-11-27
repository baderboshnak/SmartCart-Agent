import type { FunctionCall, FunctionResponse, LiveServerMessage, Session } from '@google/genai';
import { concatFloat32, downsample, floatToPcm16, pcm16ToBase64, pcm16ToFloat, base64ToPcm16 } from '@/lib/client/audio';
import { parseLanguage, type Language } from '@/lib/i18n/language';
import { VOICE_INPUT_RATE, VOICE_OUTPUT_RATE, VOICE_TOOL_NAME } from '@/lib/voice/constants';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface VoiceCallbacks {
  onState: (state: VoiceState) => void;
  /** Live captions of the current exchange. */
  onCaption: (caption: { user: string; assistant: string }) => void;
  /** Run the shopping agent for a spoken request, answering in the language the voice model heard; resolves with the verified answer text. */
  onToolRequest: (request: string, language?: Language, voiceId?: string) => Promise<string>;
  /** A finished exchange. usedTool is false for small talk that never reached the agent. */
  onExchangeComplete: (exchange: { userText: string; assistantText: string; usedTool: boolean }) => void;
  onError: (message: string) => void;
}

// Posts each block of microphone samples to the main thread.
const CAPTURE_WORKLET = `
class SmartCartCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('smartcart-capture', SmartCartCapture);`;

export function voiceSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioWorkletNode !== 'undefined' && window.isSecureContext;
}

type VoiceTraceData = Record<string, string | number | boolean | null | undefined>;

const TRACE_FIELD_LIMIT = 4_000;
const TRACE_BATCH_LIMIT = 32;
// Reserve space for the JSON envelope and UUID.
const TRACE_BATCH_BYTES = 48 * 1024 - 100;
const TRACE_QUEUE_LIMIT = 128;
const TRACE_FLUSH_DELAY_MS = 250;
const traceEncoder = new TextEncoder();

/**
 * One voice conversation with Gemini Live, directly from the browser. The server issues a
 * short-lived, locked token and receives diagnostics in debug mode. Shopping uses the agent.
 */
export class VoiceSession {
  private session: Session | null = null;
  private stream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private userText = '';
  private assistantText = '';
  private exchangeOpen = false;
  private usedTool = false;
  private toolRunning = false;
  private stopped = false;
  /** The server turns this on with the token when SMARTCART_DEBUG is on. */
  private debug = false;
  private voiceId?: string;
  private traceToken?: string;
  private traceStartedAt = 0;
  private traceQueue: Array<{ json: string; bytes: number }> = [];
  private traceTimer?: ReturnType<typeof setTimeout>;
  private traceSending = false;
  private exchangeNumber = 0;
  /** The language code Gemini Live reported for the customer's speech in this exchange. */
  private heardLanguage = '';
  /** When this exchange started (performance.now()), for the debug timings. */
  private exchangeStartedAt = 0;
  /** Whether Gemini Live's audio for the current reply has started (logged once). */
  private speaking = false;
  /**
   * Tool-call IDs already run. Live can deliver the same call twice, and running it again
   * would repeat a cart change ("add bread" twice).
   */
  private readonly toolCallIds = new Set<string>();
  /** Shopping-agent answers still being made, by request, so a repeated request waits for its answer. */
  private readonly runningRequests = new Map<string, Promise<string>>();
  /**
   * The shopping agent's answers in this exchange. They are checked against the cart; Live's
   * spoken words are a paraphrase that can change a count or a price, so the chat shows these.
   */
  private agentAnswers: string[] = [];

  constructor(private readonly callbacks: VoiceCallbacks) {}

  /** Debug mode only. Record lifecycle events and text without logging audio or the Live token. */
  private log(event: string, details?: VoiceTraceData, level: 'info' | 'warn' | 'error' = 'info', elapsedMs = this.traceElapsed()) {
    if (!this.debug) return;
    const data: VoiceTraceData = { ...(this.exchangeOpen ? { exchange: this.exchangeNumber } : {}), ...details };
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string') continue;
      const text = this.traceToken ? value.replaceAll(this.traceToken, '[redacted]') : value;
      data[key] = text.length > TRACE_FIELD_LIMIT ? `${text.slice(0, TRACE_FIELD_LIMIT - 1)}…` : text;
    }
    const hasData = Object.values(data).some(value => value !== undefined);
    console[level](`[voice] ${event}${hasData ? ` ${JSON.stringify(data)}` : ''}`);
    if (!this.voiceId) return;

    const line = { event, elapsedMs, ...(hasData ? { data } : {}) };
    let json = JSON.stringify(line);
    let bytes = traceEncoder.encode(json).length + 1;
    if (bytes > TRACE_BATCH_BYTES) {
      json = JSON.stringify({ event, elapsedMs });
      bytes = traceEncoder.encode(json).length + 1;
    }
    if (this.traceQueue.length === TRACE_QUEUE_LIMIT) this.traceQueue.shift();
    this.traceQueue.push({ json, bytes });
    if (this.traceTimer === undefined && !this.traceSending) {
      this.traceTimer = setTimeout(() => this.flushTrace(), TRACE_FLUSH_DELAY_MS);
    }
  }

  private traceElapsed(): number {
    return Math.round(performance.now() - this.traceStartedAt);
  }

  /** Send one batch at a time so browser events reach the server in order. */
  private flushTrace(): void {
    clearTimeout(this.traceTimer);
    this.traceTimer = undefined;
    if (this.traceSending || !this.voiceId || !this.traceQueue.length) return;

    let bytes = 0;
    let count = 0;
    for (const entry of this.traceQueue) {
      if (count === TRACE_BATCH_LIMIT || bytes + entry.bytes > TRACE_BATCH_BYTES) break;
      count++;
      bytes += entry.bytes;
    }
    const entries = this.traceQueue.splice(0, count).map(entry => entry.json);
    this.traceSending = true;
    void fetch('/api/voice/trace', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: `{"voiceId":${JSON.stringify(this.voiceId)},"events":[${entries.join(',')}]}`,
      keepalive: true,
      signal: AbortSignal.timeout?.(6_000)
    }).catch(() => {
      // The trace is best effort and must never interrupt a voice conversation.
    }).finally(() => {
      this.traceSending = false;
      if (this.traceQueue.length) this.flushTrace();
    });
  }

  async start(): Promise<void> {
    this.traceStartedAt = performance.now();
    this.callbacks.onState('connecting');
    // Audio contexts are created during the click so browsers allow playback.
    this.playbackContext = new AudioContext({ sampleRate: VOICE_OUTPUT_RATE });
    this.captureContext = new AudioContext();
    const requestedMicAt = this.traceElapsed();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch {
      await this.stop();
      this.callbacks.onError('Microphone access was blocked. Allow it in your browser settings and try again.');
      return;
    }
    try {
      this.voiceId = globalThis.crypto?.randomUUID?.();
      const requestedTokenAt = this.traceElapsed();
      const response = await fetch('/api/voice/token', {
        method: 'POST',
        credentials: 'same-origin',
        headers: this.voiceId ? { 'X-SmartCart-Voice-ID': this.voiceId } : undefined
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? 'Could not start a voice session.');
      this.debug = data?.debug === true;
      if (this.debug) {
        this.traceToken = typeof data.token === 'string' ? data.token : undefined;
        this.log('voice session starting', undefined, 'info', 0);
        this.log('microphone access requested', undefined, 'info', requestedMicAt);
        this.log('microphone access granted', { durationMs: requestedTokenAt - requestedMicAt }, 'info', requestedTokenAt);
        this.log('voice token requested', undefined, 'info', requestedTokenAt);
        this.log('voice token received', { model: data.model, durationMs: this.traceElapsed() - requestedTokenAt });
      }
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: data.token, httpOptions: { apiVersion: 'v1alpha' } });
      const connectStartedAt = this.traceElapsed();
      this.log('connecting to Gemini Live', { model: data.model }, 'info', connectStartedAt);
      this.session = await ai.live.connect({
        model: data.model,
        config: data.config,
        callbacks: {
          onmessage: message => this.handleMessage(message),
          onerror: event => {
            this.log('connection error', { message: event?.message || 'none given' }, 'error');
            this.fail('The voice connection had an error.');
          },
          onclose: event => {
            this.log('connection closed', { code: event?.code, reason: event?.reason || 'none given', byYou: this.stopped }, this.stopped ? 'info' : 'warn');
            if (!this.stopped) this.fail(`The voice session ended${event?.reason ? `: ${event.reason}` : '.'}`);
          }
        }
      });
      this.log('connected to Gemini Live', { model: data.model, durationMs: this.traceElapsed() - connectStartedAt });
      await Promise.all([this.playbackContext.resume(), this.captureContext.resume()]);
      await this.startCapture();
      this.log('microphone capture started');
      if (!this.stopped) this.callbacks.onState('listening');
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not start a voice session.');
    }
  }

  async stop(): Promise<void> {
    const firstStop = !this.stopped;
    this.stopped = true;
    if (firstStop) {
      this.log('voice session stopping', this.exchangeOpen ? this.exchangeTranscript() : undefined);
      this.flushTrace();
    }
    try { this.session?.close(); } catch { /* already closed */ }
    this.session = null;
    this.stopPlayback();
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    await Promise.allSettled([this.captureContext?.close(), this.playbackContext?.close()]);
    if (firstStop) {
      this.log('voice session stopped');
      this.flushTrace();
    }
    this.callbacks.onState('idle');
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.log('voice stopped because of an error', { message }, 'error');
    this.callbacks.onError(message);
    void this.stop();
  }

  private async startCapture() {
    const context = this.captureContext!;
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = context.createMediaStreamSource(this.stream!);
    this.worklet = new AudioWorkletNode(context, 'smartcart-capture');
    this.worklet.port.onmessage = event => this.capture(event.data as Float32Array);
    // A silent output keeps the worklet running without playing the microphone back.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(this.worklet).connect(mute).connect(context.destination);
  }

  /** Send about 100 ms of microphone audio at a time, as 16 kHz PCM. */
  private capture(frame: Float32Array) {
    if (!this.session || this.stopped) return;
    const rate = this.captureContext!.sampleRate;
    this.pending.push(frame);
    this.pendingSamples += frame.length;
    if (this.pendingSamples < rate / 10) return;
    const samples = downsample(concatFloat32(this.pending), rate, VOICE_INPUT_RATE);
    this.pending = [];
    this.pendingSamples = 0;
    this.session.sendRealtimeInput({ audio: { data: pcm16ToBase64(floatToPcm16(samples)), mimeType: `audio/pcm;rate=${VOICE_INPUT_RATE}` } });
  }

  private openExchange() {
    if (this.exchangeOpen) return;
    this.exchangeOpen = true;
    this.exchangeNumber++;
    this.userText = '';
    this.assistantText = '';
    this.usedTool = false;
    this.agentAnswers = [];
    this.heardLanguage = '';
    this.exchangeStartedAt = performance.now();
    this.speaking = false;
  }

  /** What the chat shows for Gemini's side: the checked shopping answer when there is one. */
  private shownAnswer(): string {
    return this.agentAnswers.length ? this.agentAnswers.join('\n\n') : this.assistantText.trim();
  }

  /** Milliseconds since Gemini Live first heard (or answered) in this exchange. */
  private sinceStart(): number {
    return Math.round(performance.now() - this.exchangeStartedAt);
  }

  private exchangeTranscript(): VoiceTraceData {
    return {
      heard: this.userText.trim(), heardAs: this.heardLanguage || undefined,
      said: this.assistantText.trim(), usedShoppingAgent: this.usedTool,
      ...(this.agentAnswers.length ? { shown: this.shownAnswer() } : {})
    };
  }

  private handleMessage(message: LiveServerMessage) {
    const content = message.serverContent;
    if (content?.interrupted) {
      this.log('you interrupted, so playback stopped', this.exchangeOpen ? { sinceStartMs: this.sinceStart() } : undefined);
      this.stopPlayback();
    }
    if (message.goAway) this.log('Gemini Live will close the connection soon', { timeLeft: message.goAway.timeLeft ?? 'unknown' }, 'warn');
    if (content?.inputTranscription?.text) {
      this.openExchange();
      this.userText += content.inputTranscription.text;
      if (content.inputTranscription.languageCode) this.heardLanguage = content.inputTranscription.languageCode;
      this.callbacks.onCaption({ user: this.userText.trim(), assistant: this.assistantText.trim() });
    }
    if (content?.outputTranscription?.text) {
      this.openExchange();
      this.assistantText += content.outputTranscription.text;
      this.callbacks.onCaption({ user: this.userText.trim(), assistant: this.assistantText.trim() });
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      if (this.exchangeOpen && !this.speaking) {
        this.speaking = true;
        this.log('Gemini Live started speaking', { sinceStartMs: this.sinceStart() });
      }
      this.play(part.inlineData.data);
    }
    if (message.toolCall?.functionCalls?.length) void this.runTools(message.toolCall.functionCalls);
    // The model's turn also ends right after it calls the tool; report the exchange
    // only once the spoken answer is complete.
    if (content?.turnComplete && !this.toolRunning && this.exchangeOpen) {
      this.log('exchange finished', { ...this.exchangeTranscript(), totalMs: this.sinceStart() });
      this.exchangeOpen = false;
      this.callbacks.onExchangeComplete({ userText: this.userText.trim(), assistantText: this.shownAnswer(), usedTool: this.usedTool });
    }
  }

  private async runTools(received: FunctionCall[]) {
    const calls = received.filter(call => !call.id || !this.toolCallIds.has(call.id));
    if (!calls.length) {
      this.log('Gemini Live sent a tool call again; it was run once', { ids: received.map(call => call.id ?? '?').join(', ') }, 'warn');
      return;
    }
    for (const call of calls) if (call.id) this.toolCallIds.add(call.id);
    this.openExchange();
    this.usedTool = true;
    this.toolRunning = true;
    this.callbacks.onState('thinking');
    const functionResponses: FunctionResponse[] = [];
    for (const call of calls) {
      if (call.name !== VOICE_TOOL_NAME) {
        this.log('Gemini Live asked for an unknown tool', { name: call.name }, 'warn');
        functionResponses.push({ id: call.id, name: call.name, response: { error: 'Unknown tool.' } });
        continue;
      }
      const args = (call.args ?? {}) as { request?: unknown; language?: unknown };
      const request = String(args.request ?? '').trim() || this.userText.trim();
      this.log('Gemini Live asked the shopping agent', {
        request, language: String(args.language ?? 'not given'), heardAs: this.heardLanguage || undefined, sinceStartMs: this.sinceStart()
      });
      this.flushTrace();
      const agentStarted = performance.now();
      const agentMs = () => Math.round(performance.now() - agentStarted);
      const language = parseLanguage(args.language) ?? undefined;
      // The same request while its answer is still being made (Live re-asked with a new ID)
      // waits for that answer instead of changing the cart a second time.
      const requestKey = `${language ?? ''}\u0000${request}`;
      const running = this.runningRequests.get(requestKey);
      try {
        const pendingAnswer = running ?? this.callbacks.onToolRequest(request, language, this.debug ? this.voiceId : undefined);
        if (!running) {
          this.runningRequests.set(requestKey, pendingAnswer);
          void pendingAnswer.catch(() => undefined).finally(() => {
            if (this.runningRequests.get(requestKey) === pendingAnswer) this.runningRequests.delete(requestKey);
          });
        }
        const answer = await pendingAnswer;
        this.log(running ? 'reused the answer of the same request still running' : 'shopping agent returned an answer', { answer, agentMs: agentMs() });
        if (!running) this.agentAnswers.push(answer);
        functionResponses.push({ id: call.id, name: call.name, response: { answer } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The shopping agent failed.';
        this.log('the shopping agent failed', { error: message, agentMs: agentMs() }, 'warn');
        functionResponses.push({ id: call.id, name: call.name, response: { error: message } });
      }
    }
    this.toolRunning = false;
    if (this.stopped || !this.session) return;
    // The next audio is the spoken answer; log when it starts.
    this.speaking = false;
    this.session.sendToolResponse({ functionResponses });
    this.log('shopping agent results sent to Gemini Live', { results: functionResponses.length });
    this.callbacks.onState(this.sources.size ? 'speaking' : 'listening');
  }

  private play(base64: string) {
    const context = this.playbackContext;
    if (!context || this.stopped) return;
    const samples = pcm16ToFloat(base64ToPcm16(base64));
    if (!samples.length) return;
    const buffer = context.createBuffer(1, samples.length, VOICE_OUTPUT_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.03, this.nextPlayTime);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.sources.add(source);
    this.callbacks.onState('speaking');
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size && !this.toolRunning && !this.stopped) this.callbacks.onState('listening');
    };
  }

  /** Barge-in: the customer started talking, so stop the queued answer. */
  private stopPlayback() {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.nextPlayTime = 0;
  }
}
