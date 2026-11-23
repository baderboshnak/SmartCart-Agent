const ils = new Intl.NumberFormat('en-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function formatIls(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? ils.format(value) : '—';
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '';
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

/** Replace {name} placeholders in a UI string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) => (key in values ? String(values[key]) : match));
}

/** "1 item" / "3 items". */
export function count(amount: number, singular: string, plural: string): string {
  return `${amount} ${amount === 1 ? singular : plural}`;
}

/** Catalog snapshot days such as ["2026-11-16", "2026-11-17"] as "16 Nov 2026 and 17 Nov 2026". */
export function formatSnapshotDates(dates: string[]): string {
  const readable = dates
    .map(date => new Date(`${date}T00:00:00Z`))
    .filter(date => !Number.isNaN(date.getTime()))
    .map(date => day.format(date));
  return readable.length > 1 ? `${readable.slice(0, -1).join(', ')} and ${readable.at(-1)}` : (readable[0] ?? '');
}

/** "2000 ml" -> "2 l", "+1500 g" -> "+1.5 kg"; other labels are unchanged. */
export function friendlyAmount(label: string): string {
  const match = /^([+]?)(\d+(?:\.\d+)?) (ml|g)$/u.exec(label.trim());
  if (!match) return label;
  const [, sign, amount, unit] = match;
  const value = Number(amount);
  if (value < 1000) return label;
  const converted = Math.round((value / 1000) * 1000) / 1000;
  return `${sign}${converted} ${unit === 'ml' ? 'l' : 'kg'}`;
}

/** Rounded difference in shekels, safe from floating-point noise. */
export function priceDifference(a: number, b: number): number {
  return Math.round((a - b) * 100) / 100;
}
