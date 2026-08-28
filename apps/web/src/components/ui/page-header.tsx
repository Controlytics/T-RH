import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

export interface Crumb {
  label: string;
  /** Omit on the last crumb — you do not link to where you already are. */
  to?: string;
}

/**
 * The header every screen opens with: where you are, what this screen is for,
 * and the one action you most likely came to take.
 *
 * One component rather than each page assembling its own, because the previous
 * arrangement produced a different title size and a different action position on
 * almost every screen — which is most of what made the application feel like
 * several products.
 */
export function PageHeader({
  title, description, crumbs, actions, meta, className,
}: {
  title: string;
  /** One sentence on what the screen is for. Not a tagline. */
  description?: string;
  crumbs?: Crumb[];
  /** The screen's primary action, and at most one or two beside it. */
  actions?: ReactNode;
  /** Status or counts belonging to the screen as a whole. */
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('space-y-3', className)}>
      {crumbs && crumbs.length > 0 && <Breadcrumbs crumbs={crumbs} />}

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-slate-500">{description}</p>
          )}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/**
 * Where you are, and the way back.
 *
 * The separator is decorative and hidden from screen readers; an `<ol>` already
 * conveys the sequence, and hearing "slash" between every level is noise.
 */
export function Breadcrumbs({ crumbs, className }: { crumbs: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-[12px] text-slate-500">
        {crumbs.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className="text-slate-300">/</span>}
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to} className="rounded px-0.5 hover:text-slate-700 hover:underline">
                {c.label}
              </Link>
            ) : (
              <span aria-current={i === crumbs.length - 1 ? 'page' : undefined} className="font-medium text-slate-700">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
