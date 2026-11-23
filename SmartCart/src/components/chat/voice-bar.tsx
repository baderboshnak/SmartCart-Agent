import { Loader2, Mic, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { VoiceState } from '@/lib/client/voice-session';
import { messages } from '@/lib/i18n/messages';

const t = messages.en;

/** Rings while listening, sound bars while speaking, a spinner while connecting or working. */
function VoiceOrb({ state }: { state: VoiceState }) {
  return (
    <span
      data-state={state}
      aria-hidden
      className="voice-orb flex size-12 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-hero-1 to-hero-2 text-hero-foreground shadow-glow"
    >
      {state === 'speaking' ? (
        <span className="flex h-5 items-center gap-[3px]">
          {[0, 1, 2, 3, 4].map(index => (
            <span key={index} className="wave-bar h-full w-[3px] rounded-full bg-current" style={{ animationDelay: `${index * 0.12}s` }} />
          ))}
        </span>
      ) : state === 'listening' ? <Mic className="size-5" /> : <Loader2 className="size-5 animate-spin" />}
    </span>
  );
}

/** Voice status and live captions while a voice session is open. */
export function VoiceBar({ state, caption, onStop }: { state: VoiceState; caption: { user: string; assistant: string }; onStop: () => void }) {
  return (
    <div className="flex items-start gap-3.5 rounded-3xl border border-primary/20 bg-card p-3.5 shadow-lift animate-in fade-in slide-in-from-bottom-2 duration-300" aria-live="polite">
      <VoiceOrb state={state} />
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-semibold">{t.voiceStates[state]}</p>
        <p className="text-xs text-muted-foreground">{t.voiceHints[state]}</p>
        {(caption.user || caption.assistant) && (
          <div className="mt-2.5 space-y-1.5 rounded-2xl bg-surface p-3 text-sm leading-relaxed">
            {caption.user && <p dir="auto"><span className="font-semibold text-muted-foreground">{t.voiceYou}: </span>{caption.user}</p>}
            {caption.assistant && <p dir="auto"><span className="font-semibold text-primary">{t.appName}: </span>{caption.assistant}</p>}
          </div>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={onStop}><X />{t.voiceStop}</Button>
    </div>
  );
}
