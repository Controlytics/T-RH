import { cn } from '@/lib/cn';

/**
 * STATUS variants (destructive / success / warning) are SOLID-FILLED with white
 * text. On the old white surfaces a 100-level tint with 700-level text read
 * clearly; on a tinted row it does not — a pale pill on a pale row is the one
 * thing treatment B risked, and a solid fill is the compensation. Measured white
 * contrast: red-700 6.2:1, emerald-700 5.5:1, amber-700 5.0:1 — all clear AA.
 *
 * NEUTRAL variants (default / secondary / outline) stay light. They label counts
 * and categories rather than state, and turning every chip on every page into a
 * dark block reads as noise, not colour.
 *
 * Colour is never the only signal: callers pass a glyph and a word inside the
 * badge. Don't remove those on the grounds that the colour says it already.
 */
const variants = {
  // NOT bg-slate-100: the compatibility layer maps that to --color-surface-alt,
  // which is exactly TableRow's even-row tint — a neutral badge in an even row
  // would lose its fill entirely and show only its outline. Badges live in tables
  // more than anywhere else. 25% is distinct from both row tints; slate-700 on it
  // measured 6.97-7.90:1. Now a WHITE face: once the tints deepened to 22%/34%
  // the 55% border-tint was too dark to leave unvalidated, and white is distinct
  // from both row tints at ANY depth (slate-700 on white = 10.35:1).
  default: 'bg-surface-raised text-slate-700 border border-[var(--ui-from)]/40',
  secondary: 'bg-surface-raised text-slate-700 border border-[var(--ui-from)]/40',
  outline: 'text-slate-700 border-2 border-slate-300 bg-surface-raised',
  destructive: 'bg-red-700 text-white border border-red-800',
  success: 'bg-emerald-700 text-white border border-emerald-800',
  warning: 'bg-amber-700 text-white border border-amber-800',
} as const;

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof variants;
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold transition-all duration-200',
        'shadow-sm',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
