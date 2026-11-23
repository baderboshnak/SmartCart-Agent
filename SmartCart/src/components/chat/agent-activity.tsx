import { Check, Loader2, X } from 'lucide-react';
import { LogoMark } from '@/components/brand/logo-mark';
import type { ActivityStep } from '@/lib/client/api';
import { formatDuration } from '@/lib/client/format';
import { messages } from '@/lib/i18n/messages';
import { cn } from '@/lib/utils';

const t = messages.en;

/** The agent's real backend steps as a timeline, in plain words. */
export function StepList({ steps, live }: { steps: ActivityStep[]; live?: boolean }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, index) => {
        const percent = step.total ? Math.min(100, Math.round(((step.processed ?? 0) / step.total) * 100)) : null;
        const detail = step.status === 'running' ? step.message : step.summary;
        const last = index === steps.length - 1;
        return (
          <li key={step.callId} className="relative flex gap-3">
            {!last && <span aria-hidden className="absolute start-3.5 top-8 -bottom-3 w-px bg-border" />}
            <span
              className={cn(
                'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border',
                step.status === 'running' && 'border-primary/30 bg-accent text-primary',
                step.status === 'ok' && 'border-success/25 bg-success-soft text-success',
                step.status === 'error' && 'border-destructive/25 bg-destructive/10 text-destructive'
              )}
            >
              {step.status === 'running' && <Loader2 className="size-3.5 animate-spin" aria-label="In progress" />}
              {step.status === 'ok' && <Check className="size-3.5" strokeWidth={3} aria-label="Done" />}
              {step.status === 'error' && <X className="size-3.5" strokeWidth={3} aria-label="Failed" />}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[0.95rem] font-semibold">{t.toolLabels[step.tool] ?? step.label}</span>
                {step.durationMs !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{formatDuration(step.durationMs)}</span>}
              </div>
              {detail && (
                <p dir="auto" className={cn('mt-0.5 line-clamp-2 text-sm leading-relaxed', step.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                  {detail}
                </p>
              )}
              {live && step.status === 'running' && percent !== null && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-linear-to-r from-primary to-primary-strong transition-[width] duration-500" style={{ width: `${percent}%` }} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TypingDots() {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map(index => (
        <span key={index} className="typing-dot size-1.5 rounded-full bg-primary" style={{ animationDelay: `${index * 0.15}s` }} />
      ))}
    </span>
  );
}

/** Live view of the agent's real backend activity during a run. */
export function AgentActivity({ steps }: { steps: ActivityStep[] }) {
  return (
    <div className="flex gap-3 animate-in fade-in duration-300" aria-live="polite">
      <LogoMark className="size-10" />
      <div className="min-w-0 flex-1 rounded-3xl rounded-ss-md border border-border/70 bg-card p-5 shadow-soft">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="shimmer-text font-semibold">{t.workingTitle}</span>
          <TypingDots />
        </div>
        {steps.length ? <StepList steps={steps} live /> : <p className="text-[0.95rem] text-muted-foreground">{t.workingStart}</p>}
      </div>
    </div>
  );
}
