import { cn } from '@/lib/cn';

/**
 * Tone drives the gradient. `module` follows the current page's palette; the
 * other three carry MEANING and so are fixed hues — a status must not change
 * colour because the user navigated to a different module.
 */
const TONES = {
  module: 'from-[var(--mod-from)] to-[var(--mod-to)]',
  positive: 'from-emerald-600 to-teal-600',
  warning: 'from-amber-600 to-orange-600',
  danger: 'from-rose-600 to-red-600',
} as const;

export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  tone?: keyof typeof TONES;
  icon?: React.ReactNode;
}

/**
 * Full-colour gradient stat tile — the headline number on a page.
 *
 * White text on a 600-level gradient only clears the 3:1 LARGE-text threshold,
 * not the 4.5:1 body threshold, so the value is deliberately large + bold and the
 * label is uppercase/tracked at 90% opacity. Do not put body-size prose on this
 * surface; put it under the tile.
 */
export function StatTile({ label, value, tone = 'module', icon, className, ...rest }: StatTileProps) {
  return (
    <div
      className={cn(
        'rounded-2xl p-4 bg-gradient-to-br text-white shadow-lg',
        'transition-transform duration-200 hover:-translate-y-0.5',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-3xl font-bold leading-none font-mono-tab">{value}</div>
        {icon ? <div className="opacity-80 shrink-0">{icon}</div> : null}
      </div>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider opacity-90">{label}</div>
    </div>
  );
}
