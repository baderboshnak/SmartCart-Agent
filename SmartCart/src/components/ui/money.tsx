import { cn } from '@/lib/utils';

const ils = new Intl.NumberFormat('en-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A large price with a smaller shekel sign, for headline totals. */
export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return <span className={className}>—</span>;
  return (
    <span className={cn('tabular-nums', className)}>
      {ils.formatToParts(value).map((part, index) => part.type === 'currency'
        ? <span key={index} className="me-[0.06em] align-[0.3em] font-sans text-[0.62em] font-semibold">{part.value}</span>
        : <span key={index}>{part.value}</span>)}
    </span>
  );
}
