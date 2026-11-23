'use client';

import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('grid w-full auto-cols-fr grid-flow-col items-stretch gap-1 rounded-2xl bg-muted p-1', className)}
      {...props}
    />
  );
}

export function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-xs font-semibold text-muted-foreground transition-all duration-200 outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-50 data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-soft [&_svg]:size-3.5 [&_svg]:shrink-0',
        className
      )}
      {...props}
    />
  );
}
