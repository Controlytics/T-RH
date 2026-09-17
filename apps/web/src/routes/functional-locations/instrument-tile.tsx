import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

/**
 * One instrument on a location page: its code large, the name under it when
 * the name differs, and a rule down the left edge in the site's own colour —
 * identity, not status. No live state is shown here (operator, 2026-09-17:
 * "remove live status"); the Instruments page is where an instrument's
 * reporting state lives.
 *
 * The code links to the instrument. `tag` is for the Block page's read-only
 * list, where each tile names the Area that actually holds it; `action` is the
 * Unlink control on the editable list.
 */
export function InstrumentTile({
  id, code, name, tag, action, className,
}: {
  id: string;
  code: string;
  name: string;
  tag?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative flex items-center justify-between gap-2 overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white py-2.5 pl-4 pr-3',
        'shadow-[var(--elev-1)] transition-colors hover:border-slate-300',
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: 'linear-gradient(to bottom, var(--theme-gradient-from), var(--theme-gradient-to))' }}
      />
      <div className="min-w-0">
        <Link
          to={`/instruments/${id}`}
          className="block truncate font-mono text-[0.9375rem] font-semibold text-slate-900 hover:text-[var(--theme-primary,#2a78d6)] focus:outline-none focus-visible:underline"
        >
          {code}
        </Link>
        {name !== code && <p className="truncate text-xs text-slate-500">{name}</p>}
        {tag && (
          <span className="mt-1.5 inline-flex items-center rounded-[var(--radius-pill)] bg-teal-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-teal-800 ring-1 ring-inset ring-teal-600/20">
            {tag}
          </span>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
