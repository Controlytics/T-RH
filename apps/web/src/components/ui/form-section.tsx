import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A group of fields under a gradient plate (UI v3, 2026-09-21).
 *
 * Every config, create and edit form is composed of these. The plate carries
 * the title and the section's own action (a Test connection, an Add row)
 * and NO description — this application's forms carry labels, not prose
 * (operator, repeatedly). Two columns on `md` and up, one below; `columns={1}`
 * for a section whose fields are wide (a textarea, a key list).
 */
export function FormSection({
  title, icon, actions, columns = 2, children, className,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  columns?: 1 | 2;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn('overflow-hidden rounded-[var(--radius-card)] border border-slate-200/70 bg-white shadow-[var(--elev-1)]', className)}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-white" style={{ background: 'var(--band-gradient)' }}>
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/20">{icon}</span>}
          <h2 id={id} className="truncate text-[1rem] font-semibold leading-tight">{title}</h2>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div
        data-testid="form-section-grid"
        data-columns={columns}
        className={cn('grid gap-4 p-5', columns === 2 ? 'md:grid-cols-2' : 'grid-cols-1')}
      >
        {children}
      </div>
    </section>
  );
}
