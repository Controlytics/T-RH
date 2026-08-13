import { cn } from '@/lib/cn';

export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-border-tint bg-surface shadow-soft">
      <div className="overflow-auto">
        <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
      </div>
    </div>
  );
}

/**
 * Solid themed band. --ui-table-head is derived to clear 4.5:1 against white; the
 * 600-level gradient start does NOT (2.94-3.77:1 across the presets), which is why
 * it is a separate token. See lib/theme-surfaces.ts.
 */
export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-[var(--ui-table-head)]', className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

/**
 * Rows alternate between the two theme tints. Hover lands on the heavier tint so
 * the pointer still gives feedback — a row that hovered to white would break the
 * tinted surface (and is exactly what the app.css hover overrides prevent on the
 * pages that don't use this primitive).
 */
export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border-tint transition-colors duration-150',
        'odd:bg-surface even:bg-surface-alt',
        'hover:bg-surface-alt',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-14 px-5 text-left align-middle font-semibold text-white text-xs uppercase tracking-wider',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-5 py-4 align-middle text-slate-700', className)} {...props} />;
}
