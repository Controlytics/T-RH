import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from './empty-state';
import { Pagination, type PaginationProps } from './pagination';
import type { StatusTone } from './status-badge';

/**
 * The shared data table (UI v3, 2026-09-21).
 *
 * Before this, 19 route files hand-rolled a <table> and 8 used this one — the
 * single biggest reason the product looked assembled. What those 19 needed
 * and this lacked is now here as OPTIONAL props, so every existing caller
 * renders as before with the new header band and nothing else:
 *
 *  - `TableHeader band`: the saturated header band of the mockups; `neutral`
 *    keeps the old grey for a table inside a tinted card.
 *  - `TableGroupRow`: the two-row grouped header of `screen-2.png`, with the
 *    two QUANTITY hues (temp burnt orange, rh green — the same `.tv-h-*`
 *    values the dashboard and charts use) and the theme band otherwise.
 *  - `TableHead sortable`: says its sort in `aria-sort` — an icon alone is
 *    invisible to a screen reader and to a test.
 *  - `TableRow accent`: the 3px left rail of `Alarms.png`, keyed on a status
 *    TONE so it cannot drift from the badge beside it. Drawn as an inset
 *    shadow, not a border, so the row's own rounded frame does not clip it.
 *  - `TableEmpty` / `TableFooter`: the empty state and the pagination INSIDE
 *    the frame, so a table never ends in a bare edge.
 */
/**
 * `grid` (2026-09-25): a 1px line around every cell and a zebra — `.tbl-grid`
 * in app.css, the readings table's structure — for a screen the operator
 * reads as a ledger (the Audit Trail: "table lines shoud be visibl").
 * `size="lg"` steps the table's base type to 15px; the screen's own cells
 * set their weights. Both default off, so the other callers are untouched.
 */
export function Table({
  // EVERY table is the Audit Trail's (2026-10-01, operator: "in all pages
  // where ever tables are there those should be shown like audit trail
  // table"): a line around every cell, a zebra, 15px. `grid={false}` /
  // `size="default"` opt a caller back out.
  grid = true, size = 'lg', className, ...props
}: React.HTMLAttributes<HTMLTableElement> & { grid?: boolean; size?: 'default' | 'lg' }) {
  return (
    <div className="relative w-full overflow-hidden rounded-[var(--radius-card)] border border-slate-200/70 bg-white shadow-[var(--elev-1)]">
      <div className="overflow-auto">
        <table
          data-grid={grid || undefined}
          className={cn('w-full caption-bottom', size === 'lg' ? 'text-[0.9375rem]' : 'text-sm', grid && 'tbl-grid border-collapse', className)}
          {...props}
        />
      </div>
    </div>
  );
}

export function TableHeader({
  band = 'gradient', className, style, ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & { band?: 'gradient' | 'neutral' }) {
  return (
    <thead
      data-band={band}
      className={cn(
        'sticky top-0 z-10',
        band === 'gradient' ? 'text-white' : 'border-b border-slate-200 bg-slate-50 text-slate-600',
        className,
      )}
      style={band === 'gradient' ? { background: 'var(--band-gradient)', ...style } : style}
      {...props}
    />
  );
}

const HUE: Record<'temp' | 'rh' | 'theme', string> = {
  temp: 'bg-[#c2410c]',
  rh: 'bg-[#15803d]',
  theme: '',
};

/** The upper row of a two-row header: one cell per column GROUP. */
export function TableGroupRow({ groups }: { groups: { label: string; span: number; hue?: 'temp' | 'rh' | 'theme' }[] }) {
  return (
    <tr>
      {groups.map((g) => (
        <th
          key={g.label}
          scope="colgroup"
          colSpan={g.span}
          data-hue={g.hue ?? 'theme'}
          className={cn(
            'h-10 px-4 text-center align-middle text-[0.6875rem] font-semibold uppercase tracking-[0.1em]',
            g.hue && g.hue !== 'theme' ? cn(HUE[g.hue], 'text-white') : 'border-b border-white/15',
          )}
        >
          {g.label}
        </th>
      ))}
    </tr>
  );
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

const RAIL: Record<StatusTone, string> = {
  ok: 'shadow-[inset_3px_0_0_0_var(--status-ok-dot)]',
  warn: 'shadow-[inset_3px_0_0_0_var(--status-warn-dot)]',
  danger: 'shadow-[inset_3px_0_0_0_var(--status-danger-dot)]',
  info: 'shadow-[inset_3px_0_0_0_var(--status-info-dot)]',
  idle: 'shadow-[inset_3px_0_0_0_var(--status-idle-dot)]',
};

export function TableRow({
  accent, className, ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { accent?: StatusTone }) {
  return (
    <tr
      data-accent={accent}
      className={cn(
        'border-b border-slate-100 transition-colors duration-150 hover:bg-[var(--surface-tint-1)]',
        accent && RAIL[accent],
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({
  sortable = false, sortDir = null, onSort, className, children, ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & {
  sortable?: boolean;
  sortDir?: 'asc' | 'desc' | null;
  onSort?: () => void;
}) {
  const ariaSort = sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : sortable ? 'none' : undefined;
  return (
    <th
      aria-sort={ariaSort}
      className={cn('h-12 px-4 text-left align-middle text-[0.6875rem] font-semibold uppercase tracking-[0.1em]', className)}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className="inline-flex items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80"
        >
          {children}
          <span aria-hidden className="text-[0.625rem] opacity-80">
            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '⇅'}
          </span>
        </button>
      ) : children}
    </th>
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3.5 align-middle text-slate-700', className)} {...props} />;
}

/** The empty state INSIDE the frame: one row spanning every column. */
export function TableEmpty({
  colSpan, title, description, action, icon,
}: { colSpan: number; title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <EmptyState compact title={title} description={description} action={action} icon={icon} />
      </td>
    </tr>
  );
}

/** The pagination INSIDE the frame, as the last row. */
export function TableFooter({ colSpan, className, ...pagination }: PaginationProps & { colSpan: number }) {
  return (
    <tfoot>
      <tr>
        <td colSpan={colSpan} className={cn('border-t border-slate-200 bg-slate-50/60 px-4 py-2', className)}>
          <Pagination {...pagination} />
        </td>
      </tr>
    </tfoot>
  );
}
