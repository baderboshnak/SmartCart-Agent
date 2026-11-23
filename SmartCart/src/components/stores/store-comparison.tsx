'use client';

import { AlertTriangle, Check, Crown, Sparkles, Store, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import type { CartView, UiCartOperation } from '@/lib/client/api';
import { fill, formatIls, priceDifference } from '@/lib/client/format';
import { messages } from '@/lib/i18n/messages';
import { cn } from '@/lib/utils';

const t = messages.en;
type StoreView = CartView['stores'][number];

/** "Rami Levy · store 039" -> "RL". */
function initials(storeName: string): string {
  const brand = storeName.split('·')[0]?.trim() ?? storeName;
  return brand.split(/\s+/u).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join('') || '?';
}

function StoreCard({ store, cheapest, highest, busy, onEdit }: {
  store: StoreView;
  cheapest: number | null;
  highest: number | null;
  busy: boolean;
  onEdit: (operation: UiCartOperation) => void;
}) {
  const complete = store.complete && typeof store.cheapestTotalIls === 'number';
  const total = store.cheapestTotalIls ?? 0;
  const isCheapest = complete && cheapest !== null && priceDifference(total, cheapest) === 0;
  const difference = complete && cheapest !== null ? priceDifference(total, cheapest) : 0;
  const width = complete && highest ? Math.max(12, (total / highest) * 100) : 0;

  return (
    <li className={cn('rounded-3xl border bg-card p-5 shadow-soft transition', store.isSelected ? 'border-primary/40 ring-4 ring-primary/10' : 'border-border/70')}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent font-display text-base font-semibold text-accent-foreground">
          {initials(store.storeName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{store.storeName}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {store.isRecommended && <Badge variant="gold"><Crown />{t.recommended}</Badge>}
            {store.isSelected && <Badge variant="success"><Check />{t.selected}</Badge>}
            {!store.complete && <Badge variant="warning"><AlertTriangle />{t.incomplete}</Badge>}
          </div>
        </div>
        {complete && <p className="font-display text-[1.7rem] leading-none font-semibold"><Money value={total} /></p>}
      </div>

      {complete ? (
        <>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className={cn('h-full rounded-full transition-[width] duration-500', isCheapest ? 'bg-gold' : 'bg-primary/45')} style={{ width: `${width}%` }} />
          </div>
          <p className={cn('mt-2 flex items-center gap-1.5 text-xs font-semibold', isCheapest ? 'text-gold-foreground' : 'text-muted-foreground')}>
            {isCheapest ? <><Trophy className="size-3.5" />{t.cheapestStore}</> : fill(t.moreThanCheapest, { amount: formatIls(difference) })}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-surface p-2.5">
              <dt className="text-xs text-muted-foreground">{t.lowestPrice}</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatIls(store.cheapestTotalIls)}</dd>
            </div>
            <div className="rounded-xl bg-surface p-2.5">
              <dt className="text-xs text-muted-foreground">{t.withWishes}</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                {formatIls(store.preferencesFirstTotalIls)}
                {!!store.preferencesPossible && (
                  <span className="ms-1 text-xs font-normal text-muted-foreground">({store.preferencesFirstSatisfied}/{store.preferencesPossible})</span>
                )}
              </dd>
            </div>
          </dl>
          {!store.isSelected && (
            <Button variant="outline" className="mt-3 w-full" disabled={busy} onClick={() => onEdit({ op: 'select_store', storeKey: store.storeKey })}>
              <Store />{t.useStore}
            </Button>
          )}
        </>
      ) : (
        <ul className="mt-3 space-y-1 rounded-xl bg-warning-soft p-3 text-xs text-foreground/75">
          {store.missingItems.map(item => (
            <li key={`${item.itemId}-${item.product}`}><span dir="auto" className="font-semibold text-foreground">{item.product}</span>: {item.reason}</li>
          ))}
          {store.note && <li>{store.note}</li>}
        </ul>
      )}
    </li>
  );
}

export function StoreComparison({ cart, busy, onEdit }: { cart: CartView | null; busy: boolean; onEdit: (operation: UiCartOperation) => void }) {
  if (!cart || !cart.stores.length) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-border px-6 py-12 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-accent text-accent-foreground"><Store className="size-6" /></span>
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">{cart?.status === 'NEEDS_CALCULATION' ? t.needsCalculation : t.storesEmpty}</p>
      </div>
    );
  }
  const totals = cart.stores.filter(store => store.complete && typeof store.cheapestTotalIls === 'number').map(store => store.cheapestTotalIls!);
  const cheapest = totals.length ? Math.min(...totals) : null;
  const highest = totals.length ? Math.max(...totals) : null;
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{t.storesIntro}</p>
      <ul className="space-y-3">
        {cart.stores.map(store => <StoreCard key={store.storeKey} store={store} cheapest={cheapest} highest={highest} busy={busy} onEdit={onEdit} />)}
      </ul>
      {cart.basket && !cart.basket.isRecommended && (
        <Button variant="ghost" className="w-full" disabled={busy} onClick={() => onEdit({ op: 'select_store', storeKey: null })}>
          <Sparkles />{t.showRecommendation}
        </Button>
      )}
      {cart.balancedMaxPriceIls !== null && cart.mode === 'balanced' && (
        <p className="text-xs text-muted-foreground">{fill(t.balancedNote, { amount: formatIls(cart.balancedMaxPriceIls) })}</p>
      )}
    </div>
  );
}
