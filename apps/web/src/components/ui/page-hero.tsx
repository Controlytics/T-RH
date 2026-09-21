import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PageHeader, type Crumb } from './page-header';

/**
 * The gradient band every screen starts with (UI v3, 2026-09-21).
 *
 * One component so the title, the crumbs, the figures and the screen's own
 * controls sit in ONE band on every page — the operator's mockups
 * (`cc-dashboard.png`, `Alarms.png`) all open this way, and the previous
 * arrangement gave ten screens a band and thirty a grey strip.
 *
 * `tiles` are the screen-level figures: one number each, white-tinted on the
 * gradient. `children` is the screen's toolbar (a picker, a search row) and
 * lands INSIDE the band; a toolbar under the band is the two-row layout the
 * operator asked to have joined. The ink is the inverted PageHeader's.
 *
 * The two soft circles are decoration on the band's own colour; they carry
 * nothing and are `aria-hidden`.
 */
export interface HeroTile {
  label: string;
  value: ReactNode;
  /** A small line under the figure — a unit or a qualifier, never a sentence. */
  hint?: string;
}

export function PageHero({
  title, icon, crumbs, actions, meta, tiles, children, className, testId,
}: {
  title: string;
  icon?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  /** Status chips and identity lines under the title — the detail and trend pages carry them. */
  meta?: ReactNode;
  tiles?: HeroTile[];
  children?: ReactNode;
  className?: string;
  /** A caller's own test id where a page test already names its hero; the root is always `data-hero="v3"`. */
  testId?: string;
}) {
  return (
    <section
      data-testid={testId ?? 'page-hero'}
      data-hero="v3"
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-card)] px-6 py-5 text-white shadow-[var(--elev-2)]',
        className,
      )}
      style={{ background: 'var(--band-gradient)' }}
    >
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-white/10" />
      <span aria-hidden className="pointer-events-none absolute -bottom-28 right-24 h-56 w-56 rounded-full bg-white/[0.06]" />
      <div className="relative space-y-5">
        <PageHeader inverted title={title} icon={icon} crumbs={crumbs} actions={actions} meta={meta} />
        {tiles && tiles.length > 0 && (
          <dl data-testid="page-hero-tiles" className="flex flex-wrap gap-3">
            {tiles.map((t) => (
              <div key={t.label} className="min-w-[8.5rem] rounded-[var(--radius-card)] bg-white/12 px-4 py-3 backdrop-blur-sm">
                <dt className="text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-white/75">{t.label}</dt>
                <dd className="mt-1 text-[length:var(--text-figure-lg)] font-semibold leading-[var(--text-figure-lg--line-height)] tabular-nums">
                  {t.value}
                </dd>
                {t.hint && <dd className="text-[0.75rem] text-white/70">{t.hint}</dd>}
              </div>
            ))}
          </dl>
        )}
        {children && (
          <div data-testid="page-hero-toolbar" className="rounded-[var(--radius-card)] bg-white/10 p-3 backdrop-blur-sm">
            {children}
          </div>
        )}
      </div>
    </section>
  );
}
