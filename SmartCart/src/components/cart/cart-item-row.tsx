'use client';

import { useState } from 'react';
import { Check, Heart, Lock, Package, Pencil, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CartView, UiCartOperation } from '@/lib/client/api';
import { fill, formatIls, friendlyAmount } from '@/lib/client/format';
import { productEmoji } from '@/lib/client/product-emoji';
import { messages } from '@/lib/i18n/messages';
import { cn } from '@/lib/utils';

type Item = CartView['items'][number];
type Line = NonNullable<CartView['basket']>['lines'][number];

const t = messages.en;
const UNITS = ['units', 'g', 'kg', 'ml', 'l', 'bottle', 'can', 'loaf', 'bag', 'roll', 'capsule', 'unspecified'] as const;

function QuantityEditor({ item, onSave, onCancel, busy }: { item: Item; onSave: (amount: number, unit: string) => void; onCancel: () => void; busy: boolean }) {
  const [amount, setAmount] = useState(String(item.quantity.amount || 1));
  const [unit, setUnit] = useState<string>(item.quantity.unit);
  const numeric = Number(amount);
  const valid = unit === 'unspecified' || (Number.isFinite(numeric) && numeric > 0);
  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-surface p-2.5"
      onSubmit={event => {
        event.preventDefault();
        if (valid) onSave(unit === 'unspecified' ? 0 : numeric, unit);
      }}
    >
      <Input
        aria-label={t.amount}
        type="number"
        min="0"
        step="any"
        value={unit === 'unspecified' ? '' : amount}
        disabled={unit === 'unspecified'}
        onChange={event => setAmount(event.target.value)}
        className="h-9 w-24"
        autoFocus
      />
      <select
        aria-label={t.unit}
        value={unit}
        onChange={event => setUnit(event.target.value)}
        className="h-9 rounded-lg border border-input bg-card px-2.5 text-sm shadow-soft outline-none focus-visible:border-primary/50 focus-visible:ring-4 focus-visible:ring-ring/20"
      >
        {UNITS.map(option => <option key={option} value={option}>{option === 'unspecified' ? t.onePackage : option}</option>)}
      </select>
      <Button type="submit" size="sm" disabled={!valid || busy}><Check />{t.save}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t.cancel}</Button>
    </form>
  );
}

/** A tag the customer can tap to switch between "must have" and "nice to have", or remove. */
function Tag({ value, kind, state, busy, onToggle, onRemove }: {
  value: string;
  kind: 'must' | 'nice';
  state?: 'met' | 'missed';
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const Icon = kind === 'must' ? Lock : Heart;
  return (
    <span
      className={cn(
        'inline-flex items-center overflow-hidden rounded-full border text-[0.8rem] font-semibold transition',
        kind === 'must' && 'border-primary/25 bg-primary/8 text-primary',
        kind === 'nice' && state === 'met' && 'border-success/25 bg-success-soft text-success',
        kind === 'nice' && state === 'missed' && 'border-warning/40 bg-warning-soft text-gold-foreground',
        kind === 'nice' && !state && 'border-border bg-muted text-muted-foreground'
      )}
    >
      <button type="button" disabled={busy} title={t.toggleHint} onClick={onToggle} className="flex items-center gap-1 py-1 ps-2.5 pe-1 transition hover:bg-black/5 disabled:opacity-60">
        <Icon className="size-3" aria-hidden />
        <span className="sr-only">{kind === 'must' ? t.mustHave : t.niceToHave}:</span>
        <span dir="auto">{value}</span>
        {state === 'met' && <><Check className="size-3" strokeWidth={3} aria-hidden /><span className="sr-only">({t.wishMet})</span></>}
        {state === 'missed' && <><X className="size-3" strokeWidth={3} aria-hidden /><span className="sr-only">({t.wishMissed})</span></>}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={fill(t.removeTag, { value })}
        onClick={onRemove}
        className="py-1 ps-1 pe-2 opacity-55 transition hover:opacity-100 disabled:opacity-40"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

export function CartItemRow({ item, line, basketComplete, busy, onEdit }: {
  item: Item;
  line: Line | undefined;
  basketComplete: boolean;
  busy: boolean;
  onEdit: (operation: UiCartOperation) => void;
}) {
  const [editing, setEditing] = useState(false);
  const satisfied = new Set(line?.preferencesSatisfied ?? []);
  const toggle = (value: string) => onEdit({ op: 'toggle_constraint', itemId: item.id, value });
  const removeTag = (value: string) => onEdit({ op: 'remove_constraint', itemId: item.id, value });

  return (
    <li className="rounded-3xl border border-border/70 bg-card p-5 shadow-soft transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-surface text-2xl leading-none">
          {productEmoji(item.product)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p dir="auto" className="pt-0.5 text-[1.05rem] leading-snug font-semibold first-letter:uppercase">{item.product}</p>
            <div className="shrink-0 pt-0.5 text-end">
              {line ? <p className="text-[1.05rem] font-semibold tabular-nums">{formatIls(line.totalPriceIls)}</p>
                : basketComplete && item.alternativeGroup ? <Badge variant="outline">{t.alternativeNotChosen}</Badge>
                  : <span className="text-sm text-muted-foreground">—</span>}
            </div>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {item.quantityLabel}
            {item.origin.type === 'RECIPE' && <> · {t.recipe}: <span className="first-letter:uppercase">{item.origin.dish}</span></>}
          </p>
          {(item.requirements.length > 0 || item.preferences.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {item.requirements.map(value => (
                <Tag key={`r-${value}`} value={value} kind="must" busy={busy} onToggle={() => toggle(value)} onRemove={() => removeTag(value)} />
              ))}
              {item.preferences.map(value => (
                <Tag
                  key={`p-${value}`}
                  value={value}
                  kind="nice"
                  state={line ? (satisfied.has(value) ? 'met' : 'missed') : undefined}
                  busy={busy}
                  onToggle={() => toggle(value)}
                  onRemove={() => removeTag(value)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {line && (
        <div className="mt-4 space-y-2.5 rounded-2xl bg-surface p-3.5">
          {line.products.map(product => (
            <div key={product.productId} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p dir="rtl" className="truncate text-end text-[0.95rem] font-medium" title={product.name}>{product.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {product.packageCount} × {product.packageLabel} · {formatIls(product.unitPriceIls)} {t.each}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-foreground/80 tabular-nums">{formatIls(product.linePriceIls)}</span>
            </div>
          ))}
          <p className="flex items-start gap-1.5 border-t border-border/60 pt-2.5 text-[0.8rem] text-muted-foreground">
            <Package className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {fill(t.youGet, { purchased: friendlyAmount(line.purchasedLabel) })}
              {line.overbuyLabel && <> · {fill(t.extra, { amount: friendlyAmount(line.overbuyLabel.replace(/^\+/u, '')) })}</>}
            </span>
          </p>
        </div>
      )}

      {editing ? (
        <QuantityEditor
          item={item}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(amount, unit) => {
            setEditing(false);
            onEdit({ op: 'set_quantity', itemId: item.id, quantity: { amount, unit: unit as (typeof UNITS)[number] } });
          }}
        />
      ) : (
        <div className="mt-2.5 flex justify-end gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}><Pencil />{t.changeAmount}</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onEdit({ op: 'remove_item', itemId: item.id })}
          >
            <Trash2 />{t.remove}
          </Button>
        </div>
      )}
    </li>
  );
}
