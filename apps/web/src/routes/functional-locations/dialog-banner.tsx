import type { ReactNode } from 'react';
import { themeGradient } from '@/lib/theme-styles';

/**
 * The themed strip across the top of this page tree's dialogs, so a dialog
 * opened from a gradient band reads as part of the same screen. Full-bleed
 * inside `Dialog`'s p-6 panel (the negative margins undo that padding), which
 * is why it lives beside the dialogs rather than in `components/ui` — the
 * primitive's panel padding is the contract it relies on.
 */
export function DialogBanner({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: ReactNode }) {
  return (
    <div className="-mx-6 -mt-6 mb-5 flex items-center gap-3 rounded-t-[var(--radius-card)] px-6 py-4 text-white" style={themeGradient}>
      {icon && (
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/20">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="font-display truncate text-[1.125rem] font-semibold leading-tight">{title}</h2>
        {subtitle && <p className="truncate text-[0.8125rem] text-white/80">{subtitle}</p>}
      </div>
    </div>
  );
}

export const LocationGlyph = (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
  </svg>
);
