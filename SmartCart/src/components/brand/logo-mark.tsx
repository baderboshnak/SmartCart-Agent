import { ShoppingBasket } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The SmartCart mark: a basket on deep emerald with a small gold spark. */
export function LogoMark({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-9 shrink-0 items-center justify-center rounded-[32%] bg-linear-to-br from-hero-1 to-hero-2 text-hero-foreground shadow-glow',
        className
      )}
    >
      <ShoppingBasket className={cn('size-[55%]', iconClassName)} strokeWidth={2.1} />
      <span className="absolute -end-0.5 -top-0.5 size-[30%] rounded-full border-2 border-background bg-gold" />
    </span>
  );
}
