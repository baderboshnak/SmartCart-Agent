'use client';

import {
  AlertTriangle, BadgeCheck, ChefHat, Heart, Info, Loader2, Lock, RefreshCw, Scale, ShieldAlert, ShoppingBasket,
  Sparkles, Store, Tag, Trash2, TrendingDown
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CartItemRow } from '@/components/cart/cart-item-row';
import type { CartView, UiCartOperation } from '@/lib/client/api';
import { fill, formatIls, formatSnapshotDates, priceDifference } from '@/lib/client/format';
import { productEmoji } from '@/lib/client/product-emoji';
import { messages } from '@/lib/i18n/messages';
import { cn } from '@/lib/utils';

const t = messages.en;
const MODES = ['balanced', 'cheapest', 'preferences-first'] as const;
const MODE_ICONS = { balanced: Scale, cheapest: Tag, 'preferences-first': Heart } as const;
const sectionTitle = 'text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase';

type Basket = NonNullable<CartView['basket']>;

function Notice({ tone, icon: Icon, title, children }: {
  tone: 'warning' | 'danger' | 'info';
  icon: typeof Info;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex gap-3 rounded-2xl border p-4',
        tone === 'danger' && 'border-destructive/25 bg-destructive/5',
        tone === 'warning' && 'border-warning/35 bg-warning-soft',
        tone === 'info' && 'border-border bg-info-soft'
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full',
          tone === 'danger' && 'bg-destructive/10 text-destructive',
          tone === 'warning' && 'bg-gold/20 text-gold-foreground',
          tone === 'info' && 'bg-card text-primary'
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 text-sm">
        <p className="font-semibold">{title}</p>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium opacity-75">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** The headline result: total, store, and how it compares with the next store. */
function BasketSummary({ cart, basket }: { cart: CartView; basket: Basket }) {
  const rival = cart.stores
    .filter(store => store.complete && store.storeKey !== basket.storeKey && typeof store.cheapestTotalIls === 'number')
    .sort((a, b) => a.cheapestTotalIls! - b.cheapestTotalIls!)[0];
  const difference = rival ? priceDifference(rival.cheapestTotalIls!, basket.totalPriceIls) : null;
  const comparison = rival && difference !== null
    ? difference > 0 ? fill(t.lessThan, { amount: formatIls(difference), store: rival.storeName })
      : difference < 0 ? fill(t.moreThan, { amount: formatIls(-difference), store: rival.storeName })
        : fill(t.samePrice, { store: rival.storeName })
    : null;

  return (
    <section className="relative overflow-hidden rounded-[1.75rem] bg-linear-to-br from-hero-1 to-hero-2 p-6 text-hero-foreground shadow-glow animate-in fade-in zoom-in-95 duration-300">
      <span aria-hidden className="pointer-events-none absolute -end-12 -top-14 size-44 rounded-full bg-white/10" />
      <span aria-hidden className="pointer-events-none absolute -start-10 -bottom-20 size-40 rounded-full bg-white/5" />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-[0.16em] uppercase opacity-85">
            <Sparkles className="size-3.5" />{basket.isRecommended ? t.bestBasket : t.chosenStore}
          </span>
          {cart.verification?.passed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold">
              <BadgeCheck className="size-3.5" />{t.verified}
            </span>
          )}
        </div>
        <p className="mt-3 font-display text-[3rem] leading-none font-semibold"><Money value={basket.totalPriceIls} /></p>
        <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold"><Store className="size-4 opacity-85" />{basket.storeName}</p>
        {comparison && (
          <p className={cn('mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold', difference! > 0 ? 'bg-gold text-hero-2' : 'bg-white/15')}>
            {difference! > 0 ? <TrendingDown className="size-3.5" /> : <Scale className="size-3.5" />}{comparison}
          </p>
        )}
        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-white/15 pt-3.5">
          <Stat label={t.statItems} value={String(basket.lines.length)} />
          <Stat label={t.statPreferences} value={basket.preferencesPossible ? `${basket.preferencesSatisfied}/${basket.preferencesPossible}` : '—'} />
          <Stat label={t.statPackages} value={String(basket.packageCount)} />
        </dl>
        {cart.selectedStoreUnavailable && <p className="mt-3 rounded-xl bg-white/12 px-3 py-2 text-xs">{t.selectedStoreUnavailable}</p>}
      </div>
    </section>
  );
}

function ModePicker({ cart, busy, onEdit }: { cart: CartView; busy: boolean; onEdit: (operation: UiCartOperation) => void }) {
  const budget = cart.budget
    ? fill(cart.budget.exclusive ? t.budgetUnder : t.budgetUpTo, { amount: formatIls(cart.budget.amountIls) })
    : null;
  return (
    <section aria-labelledby="mode-title" className="space-y-2.5">
      <h3 id="mode-title" className={sectionTitle}>{t.modeTitle}</h3>
      <ToggleGroup
        type="single"
        value={cart.mode}
        disabled={busy}
        aria-labelledby="mode-title"
        onValueChange={value => { if (value && value !== cart.mode) onEdit({ op: 'set_mode', mode: value as (typeof MODES)[number] }); }}
      >
        {MODES.map(mode => {
          const Icon = MODE_ICONS[mode];
          return <ToggleGroupItem key={mode} value={mode}><Icon />{t.modes[mode]}</ToggleGroupItem>;
        })}
      </ToggleGroup>
      <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>{fill(t.modeHelp[cart.mode], { pct: cart.maxPremiumPct })}{budget && <> <span className="font-semibold text-foreground/80">{budget}</span></>}</span>
      </p>
    </section>
  );
}

function EmptyCart() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-border px-6 py-12 text-center animate-in fade-in duration-300">
      <span className="relative flex size-16 items-center justify-center">
        <span aria-hidden className="absolute -inset-3 rounded-full bg-accent/60" />
        <span className="relative flex size-16 items-center justify-center rounded-full bg-card text-primary shadow-soft">
          <ShoppingBasket className="size-7" />
        </span>
      </span>
      <div className="space-y-1.5">
        <p className="font-display text-xl font-semibold">{t.emptyCartTitle}</p>
        <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted-foreground">{t.emptyCartBody}</p>
      </div>
    </div>
  );
}

export function CartPanel({ cart, busy, onEdit }: { cart: CartView | null; busy: boolean; onEdit: (operation: UiCartOperation) => void }) {
  if (!cart) {
    return <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t.loadingCart}</div>;
  }
  if (cart.status === 'EMPTY') return <EmptyCart />;

  const basket = cart.basket;
  const lines = new Map((basket?.lines ?? []).map(line => [line.itemId, line]));
  const hasTags = cart.items.some(item => item.requirements.length > 0 || item.preferences.length > 0);
  const recalculate = () => onEdit({ op: 'recalculate' });
  const snapshot = cart.catalog?.snapshotDates.length ? fill(t.snapshotDates, { dates: formatSnapshotDates(cart.catalog.snapshotDates) }) : '';

  return (
    <div className="space-y-6">
      {basket && <BasketSummary cart={cart} basket={basket} />}

      {cart.status === 'NEEDS_CALCULATION' && (
        <Notice tone="warning" icon={RefreshCw} title={t.needsCalculationTitle}>
          <p className="text-foreground/75">{t.needsCalculation}</p>
          <Button size="sm" className="mt-1" disabled={busy} onClick={recalculate}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t.recalculate}
          </Button>
        </Notice>
      )}

      {cart.status === 'NO_COMPLETE_BASKET' && (
        <Notice tone="warning" icon={AlertTriangle} title={t.noCompleteBasketTitle}>
          <p className="text-foreground/75">{t.noCompleteBasket}</p>
          {cart.stores.filter(store => !store.complete).map(store => (
            <p key={store.storeKey} className="text-xs text-foreground/75">
              <span className="font-semibold text-foreground">{fill(t.missingAt, { store: store.storeName })}</span>{' '}
              {store.missingItems.map(item => item.product).join(', ') || store.note}
            </p>
          ))}
        </Notice>
      )}

      {cart.status === 'VERIFICATION_FAILED' && (
        <Notice tone="danger" icon={ShieldAlert} title={t.verificationFailedTitle}>
          <p className="text-foreground/75">{t.verificationFailed}</p>
          {cart.verification?.failures.slice(0, 2).map(failure => <p key={failure} className="text-xs text-muted-foreground">{failure}</p>)}
          <Button size="sm" variant="outline" className="mt-1" disabled={busy} onClick={recalculate}><RefreshCw />{t.recalculate}</Button>
        </Notice>
      )}

      <ModePicker cart={cart} busy={busy} onEdit={onEdit} />

      <section aria-labelledby="items-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
          <h3 id="items-title" className={sectionTitle}>{t.itemsTitle}</h3>
          {hasTags && (
            <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-semibold text-primary"><Lock className="size-3" />{t.mustHave}</span>
              <span className="inline-flex items-center gap-1 font-semibold"><Heart className="size-3" />{t.niceToHave}</span>
              <span>· {t.tagHint}</span>
            </p>
          )}
        </div>
        <ul className="space-y-3">
          {cart.items.map(item => (
            <CartItemRow key={item.id} item={item} line={lines.get(item.id)} basketComplete={Boolean(basket)} busy={busy} onEdit={onEdit} />
          ))}
        </ul>
      </section>

      {cart.missingItems.length > 0 && (
        <Notice tone="warning" icon={AlertTriangle} title={t.missingEverywhereTitle}>
          {cart.missingItems.map(item => (
            <p key={`${item.itemId}-${item.product}`} className="text-xs text-foreground/75">
              <span dir="auto" className="font-semibold text-foreground">{item.product}</span>: {item.reason}
            </p>
          ))}
        </Notice>
      )}

      {cart.recipePlans.map(plan => (
        <section key={plan.id} className="rounded-2xl border border-border/70 bg-card p-4 shadow-soft">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-rose/12 text-tint-rose"><ChefHat className="size-5" /></span>
            <div className="min-w-0">
              <p className={sectionTitle}>{t.recipe}</p>
              <p className="font-semibold first-letter:uppercase">
                {plan.dish} · {plan.servings} {t.servings}{plan.servingsSource === 'ASSUMED' ? ` (${t.assumed})` : ''}
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-1.5 text-sm">
            {plan.ingredients.map(ingredient => (
              <li key={ingredient.name} className="flex items-center justify-between gap-3">
                <span className={cn('flex min-w-0 items-center gap-2', !ingredient.inCart && 'text-muted-foreground')}>
                  <span aria-hidden>{productEmoji(ingredient.name)}</span>
                  <span className="truncate first-letter:uppercase">{ingredient.name}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {ingredient.quantityLabel}{ingredient.optional ? ` · ${t.optionalNotAdded}` : ingredient.inCart ? '' : ` · ${t.removedFromCart}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">{t.recipeEstimate}</p>
        </section>
      ))}

      {cart.weightedEstimates.length > 0 && (
        <details className="group rounded-2xl border border-border/70 bg-card p-4 text-xs text-muted-foreground shadow-soft">
          <summary className="cursor-pointer text-sm font-semibold text-foreground select-none">{t.weightedTitle} ({cart.weightedEstimates.length})</summary>
          <ul className="mt-3 space-y-1.5">
            {cart.weightedEstimates.map(estimate => (
              <li key={`${estimate.storeName}-${estimate.productName}`}>
                <span dir="rtl">{estimate.productName}</span> · {estimate.storeName} · {t.about} {formatIls(estimate.estimatedPriceIls)}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="space-y-3 border-t border-border/70 pt-4">
        <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{fill(t.snapshotNote, { dates: snapshot })}</span>
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={() => { if (window.confirm(t.clearConfirm)) onEdit({ op: 'clear' }); }}
        >
          <Trash2 />{t.clear}
        </Button>
      </div>
    </div>
  );
}
