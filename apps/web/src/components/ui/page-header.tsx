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
  title, description, crumbs, actions, meta, icon, inverted = false, className,
}: {
  title: string;
  /** One sentence on what the screen is for. Not a tagline. */
  description?: string;
  crumbs?: Crumb[];
  /** The screen's primary action, and at most one or two beside it. */
  actions?: ReactNode;
  /** Status or counts belonging to the screen as a whole. */
  meta?: ReactNode;
  /**
   * The screen's glyph. Optional, and drawn in ONE treatment for every page.
   *
   * Nineteen pages carried an icon tile of their own and each picked its own
   * two-stop gradient — blue-to-indigo on Password Policy, a themed gradient on
   * Users, emerald on LDAP. The icon is worth keeping: it is a fast
   * "which screen am I on" cue, especially for the config pages, which are
   * otherwise a wall of forms. The nineteen gradients are not — they made the
   * page title compete with the status colours that carry meaning.
   *
   * Pass the bare <svg>; the tile around it belongs to this component.
   */
  icon?: ReactNode;
  /**
   * For a header that sits on a DARK ground.
   *
   * Two screens (Help Articles, Roles & Access) keep a saturated gradient
   * banner and put this header inside it. The default ink is slate-900 on
   * slate-500, which on a teal or violet gradient is unreadable — the banners
   * used to carry their own white type. This inverts the ink rather than
   * asking those pages to give up their banner.
   */
  inverted?: boolean;
  className?: string;
}) {
  return (
    <header className={cn('space-y-3', className)}>
      {crumbs && crumbs.length > 0 && <Breadcrumbs crumbs={crumbs} inverted={inverted} />}

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3.5">
          {icon && (
            // The theme's own colour, at a tint. It follows all ten presets, so
            // the header belongs to the site rather than to whichever palette
            // the page's author reached for — and at 12% it sits behind the
            // title instead of competing with it.
            <span
              className={cn(
                'mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-card)]',
                inverted ? 'bg-white/20 text-white backdrop-blur-sm' : 'text-[var(--theme-primary,#2a78d6)]',
              )}
              style={inverted ? undefined : { backgroundColor: 'color-mix(in srgb, var(--theme-primary, #2a78d6) 12%, white)' }}
              aria-hidden
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h1
              className={cn(
                'text-[1.625rem] font-semibold leading-tight tracking-[-0.01em]',
                inverted ? 'text-white' : 'text-slate-900',
              )}
            >
              {title}
            </h1>
            {description && (
              <p className={cn(
                'mt-1 max-w-2xl text-[0.875rem] leading-relaxed',
                inverted ? 'text-white/80' : 'text-slate-500',
              )}>
                {description}
              </p>
            )}
            {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
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
export function Breadcrumbs({ crumbs, inverted = false, className }: { crumbs: Crumb[]; inverted?: boolean; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className={cn('flex flex-wrap items-center gap-1 text-[0.75rem]', inverted ? 'text-white/70' : 'text-slate-500')}>
        {crumbs.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className={inverted ? 'text-white/40' : 'text-slate-300'}>/</span>}
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to} className={cn('rounded px-0.5 hover:underline', inverted ? 'hover:text-white' : 'hover:text-slate-700')}>
                {c.label}
              </Link>
            ) : (
              <span
                aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                className={cn('font-medium', inverted ? 'text-white' : 'text-slate-700')}
              >
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
