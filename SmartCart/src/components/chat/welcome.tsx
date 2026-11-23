import { ArrowUpRight, BadgeCheck, Cake, CheckCircle2, Keyboard, Languages, MessageSquareText, Mic, Pizza, ScanSearch, ShoppingBasket, Sparkles } from 'lucide-react';
import { messages } from '@/lib/i18n/messages';
import { cn } from '@/lib/utils';

const SUGGESTION_STYLES = [
  { icon: ShoppingBasket, tile: 'bg-tint-green/12 text-tint-green' },
  { icon: Pizza, tile: 'bg-tint-amber/14 text-tint-amber' },
  { icon: Cake, tile: 'bg-tint-rose/12 text-tint-rose' },
  { icon: Languages, tile: 'bg-tint-sky/12 text-tint-sky' }
];
const STEP_ICONS = [MessageSquareText, ScanSearch, BadgeCheck];
// A playful row of groceries at the top of the hero. Purely decorative.
const TILES = [
  { emoji: '🥛', tilt: '-rotate-6', delay: '0s' },
  { emoji: '🥚', tilt: 'rotate-3', delay: '0.6s' },
  { emoji: '🍞', tilt: '-rotate-2', delay: '1.2s' },
  { emoji: '🧀', tilt: 'rotate-6', delay: '1.8s' },
  { emoji: '🍅', tilt: '-rotate-3', delay: '2.4s' }
];

const sectionTitle = 'text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase';

export function Welcome({ onPick, onVoice, disabled }: { onPick: (text: string) => void; onVoice?: () => void; disabled?: boolean }) {
  const t = messages.en;
  return (
    <div className="flex flex-col gap-10 pb-4">
      <section className="relative overflow-hidden rounded-[2rem] bg-linear-to-br from-hero-1 to-hero-2 px-5 py-8 text-center text-hero-foreground shadow-glow sm:px-12 sm:py-14 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <span aria-hidden className="pointer-events-none absolute -end-24 -top-28 size-80 rounded-full bg-white/10" />
        <span aria-hidden className="pointer-events-none absolute -start-20 -bottom-36 size-80 rounded-full bg-white/6" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-4 sm:gap-5">
          <div aria-hidden className="flex items-center gap-2 sm:gap-3.5">
            {TILES.map(tile => (
              <span key={tile.emoji} className={cn('float-soft flex size-11 items-center justify-center rounded-2xl bg-card text-[1.4rem] shadow-lift sm:size-14 sm:text-[1.75rem]', tile.tilt)} style={{ animationDelay: tile.delay }}>
                {tile.emoji}
              </span>
            ))}
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3.5 py-1.5 text-sm font-semibold">
            <Sparkles className="size-4 text-gold" />{t.welcomeEyebrow}
          </span>
          <h1 className="font-display text-[1.95rem] leading-[1.06] font-semibold tracking-tight text-balance sm:text-[3.2rem]">{t.welcomeTitle}</h1>
          <p className="max-w-xl text-[0.95rem] leading-relaxed text-pretty text-hero-foreground/85 sm:text-lg">{t.welcomeBody}</p>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3 pt-1">
            {onVoice && (
              <button
                type="button"
                onClick={onVoice}
                disabled={disabled}
                className="inline-flex items-center gap-2.5 rounded-full bg-card py-2 ps-2 pe-5 text-base font-semibold text-foreground shadow-lift transition hover:-translate-y-0.5 focus-visible:ring-4 focus-visible:ring-white/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="flex size-9 items-center justify-center rounded-full bg-linear-to-br from-hero-1 to-hero-2 text-hero-foreground"><Mic className="size-[1.1rem]" /></span>
                {t.voiceStart}
              </button>
            )}
            <span className="inline-flex items-center gap-2 text-sm font-medium text-hero-foreground/80"><Keyboard className="size-4" />{t.orType}</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="examples-title" className="space-y-4 animate-in fade-in slide-in-from-bottom-2 delay-100 duration-500 fill-mode-both">
        <h2 id="examples-title" className={sectionTitle}>{t.examplesTitle}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {t.suggestions.map((suggestion, index) => {
            const style = SUGGESTION_STYLES[index % SUGGESTION_STYLES.length]!;
            const Icon = style.icon;
            return (
              <button
                key={suggestion.text}
                type="button"
                disabled={disabled}
                onClick={() => onPick(suggestion.text)}
                className="group flex items-start gap-4 rounded-3xl border border-border/70 bg-card p-5 text-start shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lift focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
              >
                <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-2xl', style.tile)}>
                  <Icon className="size-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{suggestion.title}</span>
                  <span dir="auto" className="mt-1 block text-[0.95rem] leading-relaxed text-muted-foreground">{suggestion.text}</span>
                </span>
                <ArrowUpRight className="mt-0.5 size-5 shrink-0 text-muted-foreground transition group-hover:text-primary rtl:-scale-x-100" />
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="how-title" className="space-y-4 animate-in fade-in slide-in-from-bottom-2 delay-200 duration-500 fill-mode-both">
        <h2 id="how-title" className={sectionTitle}>{t.howTitle}</h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {t.howSteps.map((step, index) => {
            const Icon = STEP_ICONS[index] ?? BadgeCheck;
            return (
              <li key={step.title} className="rounded-3xl border border-border/70 bg-card/80 p-5 shadow-soft">
                <div className="flex items-center justify-between">
                  <span className="flex size-9 items-center justify-center rounded-full bg-linear-to-br from-hero-1 to-hero-2 text-sm font-bold text-hero-foreground">{index + 1}</span>
                  <Icon className="size-5 text-primary" />
                </div>
                <p className="mt-4 text-[1.05rem] font-semibold">{step.title}</p>
                <p className="mt-1.5 text-[0.95rem] leading-relaxed text-muted-foreground">{step.body}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-[0.95rem] text-muted-foreground">
        {t.trust.map(text => (
          <li key={text} className="flex items-center gap-2"><CheckCircle2 className="size-[1.1rem] text-success" />{text}</li>
        ))}
      </ul>
    </div>
  );
}
