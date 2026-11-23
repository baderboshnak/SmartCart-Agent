import { Fragment, type ReactNode } from 'react';
import { ChevronRight, CloudAlert, Mic, RotateCw } from 'lucide-react';
import { LogoMark } from '@/components/brand/logo-mark';
import { StepList } from '@/components/chat/agent-activity';
import { Button } from '@/components/ui/button';
import type { ClientMessage } from '@/lib/client/api';
import { count } from '@/lib/client/format';
import { messages } from '@/lib/i18n/messages';

const t = messages.en;

function inline(text: string): ReactNode[] {
  // **bold** only; everything else stays plain text (no HTML is ever injected).
  return text.split(/(\*\*[^*]+\*\*)/gu).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong>
      : <Fragment key={index}>{part}</Fragment>);
}

/** Minimal, safe rendering of the assistant's markdown-like answers. */
function RichText({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    blocks.push(
      <ul key={`list-${blocks.length}`} className="my-1 list-disc space-y-1 ps-5 marker:text-primary">
        {list.map((item, index) => <li key={index}>{inline(item)}</li>)}
      </ul>
    );
    list = [];
  };
  for (const line of content.split('\n')) {
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/u.exec(line);
    if (bullet) {
      list.push(bullet[1]!);
      continue;
    }
    flush();
    const heading = /^\s*#{1,4}\s+(.*)$/u.exec(line);
    if (heading) blocks.push(<p key={blocks.length} className="mt-1 font-semibold">{inline(heading[1]!)}</p>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    else blocks.push(<div key={blocks.length} className="h-1.5" />);
  }
  flush();
  return <div className="space-y-1.5">{blocks}</div>;
}

export function MessageBubble({ message, onOption, onRetry, disabled }: {
  message: ClientMessage;
  onOption: (text: string) => void;
  /** Offered on the latest failed answer: sends the customer's last message again. */
  onRetry?: () => void;
  disabled?: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end animate-in fade-in slide-in-from-bottom-1 duration-300">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <div dir="auto" className="rounded-3xl rounded-se-md bg-linear-to-br from-hero-1 to-hero-2 px-5 py-3 text-base leading-relaxed whitespace-pre-wrap text-hero-foreground shadow-glow">
            {message.content}
          </div>
          {message.via === 'voice' && (
            <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground"><Mic className="size-3" aria-hidden />{t.spoken}</span>
          )}
        </div>
      </div>
    );
  }

  const isError = message.kind === 'error';
  return (
    <div className="flex gap-3 animate-in fade-in slide-in-from-bottom-1 duration-300">
      {isError
        ? <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warning-soft text-gold-foreground"><CloudAlert className="size-5" /></span>
        : <LogoMark className="size-10" />}
      <div className="min-w-0 max-w-[88%] flex-1 space-y-2">
        {isError ? (
          <div className="rounded-3xl rounded-ss-md border border-warning/40 bg-warning-soft px-5 py-4">
            <p className="font-semibold">{t.errorTitle}</p>
            <p dir="auto" className="mt-1 text-[0.95rem] leading-relaxed text-foreground/80">{message.content}</p>
            {onRetry && (
              <Button size="sm" variant="outline" className="mt-3" disabled={disabled} onClick={onRetry}>
                <RotateCw />{t.tryAgain}
              </Button>
            )}
          </div>
        ) : (
          <div dir="auto" className="rounded-3xl rounded-ss-md border border-border/70 bg-card px-5 py-4 text-base leading-relaxed shadow-soft">
            <RichText content={message.content} />
          </div>
        )}
        {message.kind === 'clarification' && !!message.options?.length && (
          <div className="flex flex-wrap gap-2">
            {message.options.map(option => (
              <button
                key={option}
                type="button"
                disabled={disabled}
                onClick={() => onOption(option)}
                dir="auto"
                className="rounded-full border border-primary/30 bg-card px-3.5 py-1.5 text-sm font-semibold text-primary shadow-soft transition hover:-translate-y-px hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                {option}
              </button>
            ))}
          </div>
        )}
        {!!message.steps?.length && (
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-full px-2.5 py-1 text-sm font-medium text-muted-foreground transition select-none hover:bg-accent/60 hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" />
              {t.howIDidIt} · {count(message.steps.length, t.step, t.steps)}
            </summary>
            <div className="mt-2 rounded-2xl border border-border/70 bg-card/70 p-4"><StepList steps={message.steps} /></div>
          </details>
        )}
      </div>
    </div>
  );
}
