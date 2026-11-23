'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/i18n/messages';
import { cn } from '@/lib/utils';

const MAX_LENGTH = 2000;

export function ChatInput({ onSend, onStop, running, disabled, voiceActive, onVoice }: {
  onSend: (text: string) => void;
  onStop: () => void;
  running: boolean;
  disabled?: boolean;
  voiceActive?: boolean;
  onVoice?: () => void;
}) {
  const t = messages.en;
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || running || disabled) return;
    onSend(text);
    setValue('');
  };

  return (
    <form
      className="flex items-end gap-2 rounded-[2rem] border border-border bg-card p-2 ps-5 shadow-lift transition focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-ring/15"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor="chat-input" className="sr-only">{t.inputLabel}</label>
      <textarea
        id="chat-input"
        ref={ref}
        dir="auto"
        rows={1}
        value={value}
        maxLength={MAX_LENGTH}
        disabled={disabled}
        placeholder={t.inputPlaceholder}
        className="max-h-44 min-h-12 flex-1 resize-none bg-transparent py-3 text-base leading-6 outline-none placeholder:text-muted-foreground/80 disabled:opacity-60"
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {onVoice && (
        <Button
          type="button"
          size="icon"
          variant={voiceActive ? 'default' : 'soft'}
          className={cn('size-12 rounded-full', voiceActive && 'animate-pulse')}
          disabled={disabled}
          onClick={onVoice}
          aria-pressed={voiceActive}
          aria-label={voiceActive ? t.voiceStop : t.voiceStart}
          title={voiceActive ? t.voiceStop : t.voiceStart}
        >
          <Mic className="size-[1.35rem]" />
        </Button>
      )}
      {running ? (
        <Button type="button" size="icon" variant="outline" className="size-12 rounded-full" onClick={onStop} aria-label={t.stop} title={t.stop}>
          <Square className="size-3.5 fill-current" />
        </Button>
      ) : (
        <Button type="submit" size="icon" className="size-12 rounded-full" disabled={!value.trim() || disabled} aria-label={t.send} title={t.send}>
          <ArrowUp className="size-[1.35rem]" strokeWidth={2.5} />
        </Button>
      )}
    </form>
  );
}
