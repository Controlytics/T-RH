import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The strip across the top of a dialog (promoted from
 * routes/functional-locations on 2026-09-21 for UI v3 — every dialog gets one).
 *
 * Full-bleed inside `Dialog`'s p-6 panel: the negative margins undo that
 * padding, which is the one contract this component relies on. `danger`
 * paints the status-danger ground for a destructive act, so the colour and
 * the title say the same thing.
 */
export function DialogBanner({
  title, subtitle, icon, tone = 'theme',
}: { title: string; subtitle?: string; icon?: ReactNode; tone?: 'theme' | 'danger' }) {
  return (
    <div
      data-testid="dialog-banner"
      data-tone={tone}
      className={cn(
        '-mx-6 -mt-6 mb-5 flex items-center gap-3 rounded-t-[var(--radius-card)] px-6 py-4 text-white',
        tone === 'danger' && 'bg-[var(--status-danger-dot)]',
      )}
      style={tone === 'theme' ? { background: 'var(--band-gradient)' } : undefined}
    >
      {icon && (
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/20">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="truncate text-[1.125rem] font-semibold leading-tight">{title}</h2>
        {subtitle && <p className="truncate text-[0.8125rem] text-white/80">{subtitle}</p>}
      </div>
    </div>
  );
}
