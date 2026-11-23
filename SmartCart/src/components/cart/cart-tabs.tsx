'use client';

import { ShoppingBasket, Store } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CartPanel } from '@/components/cart/cart-panel';
import { StoreComparison } from '@/components/stores/store-comparison';
import type { CartView, UiCartOperation } from '@/lib/client/api';
import { count } from '@/lib/client/format';
import { messages } from '@/lib/i18n/messages';

export function CartTabs({ cart, busy, onEdit }: { cart: CartView | null; busy: boolean; onEdit: (operation: UiCartOperation) => void }) {
  const t = messages.en;
  const items = cart?.items.length ?? 0;
  const completeStores = cart?.stores.filter(store => store.complete).length ?? 0;
  return (
    <Tabs defaultValue="cart" className="h-full min-h-0 gap-0">
      <div className="space-y-4 px-6 pt-6 pb-4">
        <div className="flex items-baseline justify-between gap-2 pe-8 lg:pe-0">
          <h2 className="font-display text-[1.75rem] font-semibold tracking-tight">{t.cartTitle}</h2>
          {items > 0 && <span className="text-sm text-muted-foreground">{count(items, t.item, t.items)}</span>}
        </div>
        <TabsList className="w-full">
          <TabsTrigger value="cart"><ShoppingBasket />{t.tabCart}</TabsTrigger>
          <TabsTrigger value="stores">
            <Store />{t.tabStores}
            {completeStores > 0 && <span className="rounded-full bg-accent px-1.5 text-xs leading-5 text-accent-foreground">{completeStores}</span>}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="cart" className="scrollbar-thin min-h-0 overflow-y-auto px-6 pb-10">
        <CartPanel cart={cart} busy={busy} onEdit={onEdit} />
      </TabsContent>
      <TabsContent value="stores" className="scrollbar-thin min-h-0 overflow-y-auto px-6 pb-10">
        <StoreComparison cart={cart} busy={busy} onEdit={onEdit} />
      </TabsContent>
    </Tabs>
  );
}
