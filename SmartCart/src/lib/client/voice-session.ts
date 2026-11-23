import type { FunctionCall, FunctionResponse, LiveServerMessage, Session } from '@google/genai';
import { concatFloat32, downsample, floatToPcm16, pcm16ToBase64, pcm16ToFloat, base64ToPcm16 } from '@/lib/client/audio';
import { VOICE_INPUT_RATE, VOICE_OUTPUT_RATE, VOICE_TOOL_NAME } from '@/lib/voice/constants';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface VoiceCallbacks {
  onState: (state: VoiceState) => void;
  /** Live captions of the current exchange. */
  onCaption: (caption: { user: string; assistant: string }) => void;
  /** Run the shopping agent for a spoken request; resolves with the verified answer text. */
  onToolRequest: (request: string) => Promise<string>;
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

/**
 * One voice conversation with Gemini Live, directly from the browser. The server only
 * issues a short-lived, locked token; shopping work always goes through the agent.
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

  constructor(private readonly callbacks: VoiceCallbacks) {}

  async start(): Promise<void> {
    this.callbacks.onState('connecting');
    // Audio contexts are created during the click so browsers allow playback.
    this.playbackContext = new AudioContext({ sampleRate: VOICE_OUTPUT_RATE });
    this.captureContext = new AudioContext();
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
      const response = await fetch('/api/voice/token', { method: 'POST', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? 'Could not start a voice session.');
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: data.token, httpOptions: { apiVersion: 'v1alpha' } });
      this.session = await ai.live.connect({
        model: data.model,
        config: data.config,
        callbacks: {
          onmessage: message => this.handleMessage(message),
          onerror: () => this.fail('The voice connection had an error.'),
          onclose: event => {
            if (!this.stopped) this.fail(`The voice session ended${event?.reason ? `: ${event.reason}` : '.'}`);
          }
        }
      });
      await Promise.all([this.playbackContext.resume(), this.captureContext.resume()]);
      await this.startCapture();
      if (!this.stopped) this.callbacks.onState('listening');
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not start a voice session.');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { this.session?.close(); } catch { /* already closed */ }
    this.session = null;
    this.stopPlayback();
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    await Promise.allSettled([this.captureContext?.close(), this.playbackContext?.close()]);
    this.callbacks.onState('idle');
  }

  private fail(message: string) {
    if (this.stopped) return;
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
    this.userText = '';
    this.assistantText = '';
    this.usedTool = false;
  }

  private handleMessage(message: LiveServerMessage) {
    const content = message.serverContent;
    if (content?.interrupted) this.stopPlayback();
    if (content?.inputTranscription?.text) {
      this.openExchange();
      this.userText += content.inputTranscription.text;
      this.callbacks.onCaption({ user: this.userText.trim(), assistant: this.assistantText.trim() });
    }
    if (content?.outputTranscription?.text) {
      this.openExchange();
      this.assistantText += content.outputTranscription.text;
      this.callbacks.onCaption({ user: this.userText.trim(), assistant: this.assistantText.trim() });
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) this.play(part.inlineData.data);
    }
    if (message.toolCall?.functionCalls?.length) void this.runTools(message.toolCall.functionCalls);
    // The model's turn also ends right after it calls the tool; report the exchange
    // only once the spoken answer is complete.
    if (content?.turnComplete && !this.toolRunning && this.exchangeOpen) {
      this.exchangeOpen = false;
      this.callbacks.onExchangeComplete({ userText: this.userText.trim(), assistantText: this.assistantText.trim(), usedTool: this.usedTool });
    }
  }

  private async runTools(calls: FunctionCall[]) {
    this.openExchange();
    this.usedTool = true;
    this.toolRunning = true;
    this.callbacks.onState('thinking');
    const functionResponses: FunctionResponse[] = [];
    for (const call of calls) {
      if (call.name !== VOICE_TOOL_NAME) {
        functionResponses.push({ id: call.id, name: call.name, response: { error: 'Unknown tool.' } });
        continue;
      }
      const request = String((call.args as { request?: unknown } | undefined)?.request ?? '').trim() || this.userText.trim();
      try {
        const answer = await this.callbacks.onToolRequest(request);
        functionResponses.push({ id: call.id, name: call.name, response: { answer } });
      } catch (error) {
        functionResponses.push({ id: call.id, name: call.name, response: { error: error instanceof Error ? error.message : 'The shopping agent failed.' } });
      }
    }
    this.toolRunning = false;
    if (this.stopped || !this.session) return;
    this.session.sendToolResponse({ functionResponses });
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
