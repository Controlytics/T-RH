import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Input } from './input';

/**
 * Search, filters and the screen's trailing actions in ONE row (UI v3,
 * 2026-09-21). Three screens hand-built this row before; the differences
 * between them were nobody's decision.
 *
 * The search box carries a distinct `name` and a label, because an unnamed
 * text input beside a password field is what Chrome fills the username into.
 * `flex-nowrap` on wide viewports — a row allowed to wrap puts the toolbar
 * back on two lines, the layout the operator asked to have joined.
 */
export function Toolbar({
  search, filters, trailing, className,
}: {
  search?: { name: string; value: string; onChange: (v: string) => void; placeholder?: string; label: string };
  filters?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-slate-200/70 bg-white px-4 py-3 shadow-[var(--elev-1)] md:flex-nowrap',
        className,
      )}
    >
      {search && (
        <div className="relative min-w-0 flex-1 basis-64">
          <svg aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
          </svg>
          <Input
            name={search.name}
            aria-label={search.label}
            placeholder={search.placeholder}
            autoComplete="off"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            className="pl-9"
          />
        </div>
      )}
      {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
      {trailing && <div className="ml-auto flex shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  );
}
