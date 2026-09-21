# UI v3 — Batch 1: foundation, shell, auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the design tokens, the six primitives, the sidebar's active-pill treatment and the four auth pages on the new visual language, with a render test per primitive, so Batches 2–4 can rebuild every screen on them.

**Architecture:** Tokens go into the existing `@theme` block of `apps/web/src/app.css` and derive from the `--theme-*` variables `lib/themes.ts` already sets, so all ten presets work unchanged. Each primitive is one file in `apps/web/src/components/ui/` with one render test in `components/ui/__tests__/`. Existing primitives keep their names and props; new capability is added as optional props. No API, fetch key, mutation or permission gate changes anywhere.

**Tech Stack:** React 19, Vite 6, Tailwind v4 (`@theme` tokens, `@layer components`), vitest 3 + Testing Library (jsdom), react-router-dom v6. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md`

## Global Constraints

- No new dependencies. Light theme only. All ten presets in `lib/themes.ts` must render.
- Status colours (`--status-*`) are never changed: they carry data.
- One number per element. No helper prose; labels only. Units in headers, never in cells.
- Every shared CSS class lives inside `@layer components` (an unlayered rule beats every Tailwind utility).
- No behaviour change: fetch keys, mutations, re-auth, audit and `useCan`/`RequireRole` gates are moved, never altered.
- Every `data-testid`, `aria-label` and accessible name a test relies on is preserved.
- Run touched test files INDIVIDUALLY by exit code (`npx vitest run <file> > out.txt 2>&1; echo EXIT=$?`). The whole `apps/web` suite manufactures failures on this tree.
- Commit gated on exit codes; message trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work in the main checkout on branch `data-layer`; push to `data-layer` only.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/web/src/app.css` (`@theme` block, lines 9–~80) | add five tokens; nothing else in the file moves |
| `apps/web/src/components/ui/page-hero.tsx` (new) | the gradient band every screen starts with; wraps `PageHeader inverted` |
| `apps/web/src/components/ui/stat-card.tsx` (new) | medallion + eyebrow + ONE figure + optional link, tinted by tone |
| `apps/web/src/components/ui/table.tsx` (modify) | band on `TableHeader`, `TableGroupRow`, sortable `TableHead`, `accent` on `TableRow`, `TableEmpty`, `TableFooter` |
| `apps/web/src/components/ui/form-section.tsx` (new) | gradient-plate card with a field grid |
| `apps/web/src/components/ui/dialog-banner.tsx` (new, moved) | the banner; `routes/functional-locations/dialog-banner.tsx` re-exports it and keeps `LocationGlyph` |
| `apps/web/src/components/ui/toolbar.tsx` (new) | search + filters + trailing row |
| `apps/web/src/components/layout/sidebar.tsx` (modify, ~lines 300–330) | active item becomes a white pill with theme ink and a right dot |
| `apps/web/src/routes/auth/auth-shell.tsx` (new) | full-bleed band gradient + soft circles + centred card, shared by the four auth pages |
| `apps/web/src/routes/auth/{login,forgot-password,change-password,contact-admin}.tsx` (modify roots only) | wrap in `AuthShell` |
| `apps/web/scripts/contrast-check.mjs` (new) | WCAG AA check of white on each preset's gradient and slate-900 on the tints |
| `apps/web/CLAUDE.md`, `CHANGELOG.md` | record the batch |

---

### Task 1: Tokens + `PageHero`

**Files:**
- Modify: `apps/web/src/app.css` (inside `@theme {`, after the `--status-idle-*` line ~66)
- Create: `apps/web/src/components/ui/page-hero.tsx`
- Test: `apps/web/src/components/ui/__tests__/page-hero.test.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `Crumb` from `components/ui/page-header.tsx` (existing); `cn` from `@/lib/cn`.
- Produces: `PageHero({ title, icon?, crumbs?, actions?, tiles?, children?, className? })`; `HeroTile = { label: string; value: ReactNode; hint?: string }`. CSS tokens `--text-figure`, `--text-figure-lg`, `--surface-tint-1`, `--surface-tint-2`, `--band-gradient`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ui/__tests__/page-hero.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageHero } from '../page-hero';

/**
 * The band every screen starts with. What matters is structure a test can
 * read: ONE h1, the crumbs, the tiles printing label and value once each, and
 * the caller's toolbar landing INSIDE the band — a toolbar rendered under it
 * is the two-row layout the operator asked to have joined on every widget.
 */
const mount = (extra: Partial<Parameters<typeof PageHero>[0]> = {}) => render(
  <MemoryRouter>
    <PageHero
      title="Alarms"
      crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Alarms' }]}
      tiles={[{ label: 'Active', value: 16 }, { label: 'Cleared', value: 8, hint: 'today' }]}
      {...extra}
    >
      <input aria-label="Search alarms" />
    </PageHero>
  </MemoryRouter>,
);

describe('PageHero', () => {
  it('renders one h1 and the breadcrumb trail', () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Dashboard');
  });

  it('prints each tile label and value exactly once', () => {
    mount();
    const band = screen.getByTestId('page-hero');
    expect(within(band).getAllByText('Active')).toHaveLength(1);
    expect(within(band).getAllByText('16')).toHaveLength(1);
    expect(within(band).getByText('today')).toBeInTheDocument();
  });

  it('puts the caller\'s toolbar INSIDE the band', () => {
    mount();
    const band = screen.getByTestId('page-hero');
    expect(band.contains(screen.getByRole('textbox', { name: 'Search alarms' }))).toBe(true);
  });

  it('renders no tile row and no toolbar row when neither is given', () => {
    render(<MemoryRouter><PageHero title="Users" /></MemoryRouter>);
    expect(screen.queryByTestId('page-hero-tiles')).toBeNull();
    expect(screen.queryByTestId('page-hero-toolbar')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/page-hero.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?; grep -E "Tests |Error" /tmp/t.txt`
Expected: EXIT=1, "Failed to resolve import ../page-hero".

- [ ] **Step 3: Add the tokens**

In `apps/web/src/app.css`, inside the `@theme {` block, directly after the line
`--status-idle-ink: #334155;    --status-idle-bg: #f1f5f9;    --status-idle-dot: #64748b;`, insert:

```css
  /* ── Design tokens: v3 (2026-09-21) ──────────────────────────────────────
     Everything below derives from the --theme-* variables lib/themes.ts sets,
     so all ten presets work with no per-preset edit. */
  --text-figure: 2rem;              /* 32px semibold tabular — the ONE number on a StatCard */
  --text-figure--line-height: 2.25rem;
  --text-figure-lg: 2.5rem;         /* 40px — a hero figure tile */
  --text-figure-lg--line-height: 2.75rem;
  --surface-tint-1: color-mix(in srgb, var(--theme-primary, #2a78d6) 6%, white);
  --surface-tint-2: color-mix(in srgb, var(--theme-primary, #2a78d6) 12%, white);
  --band-gradient: linear-gradient(90deg, var(--theme-gradient-from, #2a78d6), var(--theme-gradient-to, #1e3a5f));
```

- [ ] **Step 4: Write `PageHero`**

```tsx
// apps/web/src/components/ui/page-hero.tsx
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
  title, icon, crumbs, actions, tiles, children, className,
}: {
  title: string;
  icon?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  tiles?: HeroTile[];
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-testid="page-hero"
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-card)] px-6 py-5 text-white shadow-[var(--elev-2)]',
        className,
      )}
      style={{ background: 'var(--band-gradient)' }}
    >
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-white/10" />
      <span aria-hidden className="pointer-events-none absolute -bottom-28 right-24 h-56 w-56 rounded-full bg-white/[0.06]" />
      <div className="relative space-y-5">
        <PageHeader inverted title={title} icon={icon} crumbs={crumbs} actions={actions} />
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/page-hero.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?; grep -E "Tests " /tmp/t.txt`
Expected: EXIT=0, 4 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app.css apps/web/src/components/ui/page-hero.tsx apps/web/src/components/ui/__tests__/page-hero.test.tsx
git commit -m "feat(ui): v3 tokens and PageHero band" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `StatCard`

**Files:**
- Create: `apps/web/src/components/ui/stat-card.tsx`
- Test: `apps/web/src/components/ui/__tests__/stat-card.test.tsx`

**Interfaces:**
- Consumes: `StatusTone` from `./status-badge`; `Link` from react-router-dom; `cn`.
- Produces: `StatCard({ eyebrow, value, icon, tone?: StatusTone | 'neutral', to?, linkLabel?, className? })`, root `data-testid="stat-card"`, `data-tone`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ui/__tests__/stat-card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StatCard } from '../stat-card';

/**
 * ONE number per card (operator rule, 2026-09-17: a secondary figure beside
 * a primary one reads as "showing two times"). The mockups' sparkline and
 * "from yesterday" are deliberately absent — nothing stores that history.
 */
const glyph = <svg data-testid="glyph" viewBox="0 0 24 24" />;

describe('StatCard', () => {
  it('prints the eyebrow and exactly one figure', () => {
    render(<MemoryRouter><StatCard eyebrow="Active unacknowledged" value={16} icon={glyph} tone="danger" /></MemoryRouter>);
    const card = screen.getByTestId('stat-card');
    expect(within(card).getByText('Active unacknowledged')).toBeInTheDocument();
    expect(within(card).getAllByText('16')).toHaveLength(1);
    expect(card).toHaveAttribute('data-tone', 'danger');
  });

  it('is neutral by default and links only when given a destination', () => {
    const { rerender } = render(<MemoryRouter><StatCard eyebrow="Total users" value={12} icon={glyph} /></MemoryRouter>);
    expect(screen.getByTestId('stat-card')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.queryByRole('link')).toBeNull();
    rerender(<MemoryRouter><StatCard eyebrow="Total users" value={12} icon={glyph} to="/users" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /view details/i })).toHaveAttribute('href', '/users');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/stat-card.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=1, import of `../stat-card` fails.

- [ ] **Step 3: Write `StatCard`**

```tsx
// apps/web/src/components/ui/stat-card.tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import type { StatusTone } from './status-badge';

/**
 * A screen-level figure (UI v3, 2026-09-21): icon medallion, eyebrow, ONE
 * number, optional link — the card of `cc-dashboard.png` and `Alarms.png`.
 *
 * `tone` tints the ground with the STATUS ground and paints a 3px top rail in
 * the status dot; `neutral` uses the theme tint. Status colour never travels
 * alone here either: the eyebrow is the word beside the colour.
 *
 * Deliberately absent: the mockups' sparkline and "↑ 2 from yesterday".
 * Nothing in this system stores alarm-state history, and a trend line drawn
 * from nothing would be a fabrication on a §11 screen. One number.
 */
const GROUND: Record<StatusTone | 'neutral', { bg: string; rail: string; medallion: string }> = {
  neutral: { bg: 'bg-[var(--surface-tint-1)]', rail: 'bg-[var(--theme-primary,#2a78d6)]', medallion: '' },
  ok: { bg: 'bg-[var(--status-ok-bg)]', rail: 'bg-[var(--status-ok-dot)]', medallion: 'bg-[var(--status-ok-dot)]' },
  warn: { bg: 'bg-[var(--status-warn-bg)]', rail: 'bg-[var(--status-warn-dot)]', medallion: 'bg-[var(--status-warn-dot)]' },
  danger: { bg: 'bg-[var(--status-danger-bg)]', rail: 'bg-[var(--status-danger-dot)]', medallion: 'bg-[var(--status-danger-dot)]' },
  info: { bg: 'bg-[var(--status-info-bg)]', rail: 'bg-[var(--status-info-dot)]', medallion: 'bg-[var(--status-info-dot)]' },
  idle: { bg: 'bg-[var(--status-idle-bg)]', rail: 'bg-[var(--status-idle-dot)]', medallion: 'bg-[var(--status-idle-dot)]' },
};

export function StatCard({
  eyebrow, value, icon, tone = 'neutral', to, linkLabel = 'View details', className,
}: {
  eyebrow: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: StatusTone | 'neutral';
  to?: string;
  linkLabel?: string;
  className?: string;
}) {
  const g = GROUND[tone];
  return (
    <div
      data-testid="stat-card"
      data-tone={tone}
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-card)] border border-slate-200/70 px-5 pb-4 pt-5 shadow-[var(--elev-1)]',
        g.bg, className,
      )}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px]', g.rail)} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-slate-500">{eyebrow}</p>
          <p className="mt-2 text-[length:var(--text-figure)] font-semibold leading-[var(--text-figure--line-height)] tabular-nums text-slate-900">
            {value}
          </p>
        </div>
        <span
          aria-hidden
          className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white shadow-[var(--elev-1)]', g.medallion)}
          style={tone === 'neutral' ? { background: 'var(--band-gradient)' } : undefined}
        >
          {icon}
        </span>
      </div>
      {to && (
        <Link to={to} className="mt-3 inline-flex items-center gap-1 text-[0.8125rem] font-medium text-[var(--theme-primary,#2a78d6)] hover:underline">
          {linkLabel}
          <span aria-hidden>›</span>
        </Link>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/stat-card.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=0, 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/stat-card.tsx apps/web/src/components/ui/__tests__/stat-card.test.tsx
git commit -m "feat(ui): StatCard — one figure, medallion, tinted ground" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `DataTable` — band, group row, sortable head, accent rail, empty, footer

**Files:**
- Modify: `apps/web/src/components/ui/table.tsx` (whole file replaced below; existing exports keep their names and default appearance callers can opt out of)
- Test: `apps/web/src/components/ui/__tests__/table.test.tsx`

**Interfaces:**
- Consumes: `EmptyState` from `./empty-state`; `Pagination`, `PaginationProps` from `./pagination`; `StatusTone` from `./status-badge`.
- Produces: `Table`, `TableHeader({ band?: 'gradient' | 'neutral' })` (default `gradient`), `TableGroupRow({ groups: { label: string; span: number; hue?: 'temp' | 'rh' | 'theme' }[] })`, `TableHead({ sortable?, sortDir?: 'asc' | 'desc' | null, onSort? })`, `TableRow({ accent?: StatusTone })`, `TableCell`, `TableBody`, `TableEmpty({ title, description?, action? })`, `TableFooter(PaginationProps)`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ui/__tests__/table.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
  Table, TableHeader, TableGroupRow, TableHead, TableBody, TableRow, TableCell, TableEmpty, TableFooter,
} from '../table';

/**
 * The shared table, rebuilt for UI v3. Nineteen route files hand-rolled
 * their own <table> before this; what they needed and the primitive lacked
 * is pinned here: a grouped header row (screen-2.png's TEMPERATURE / HUMIDITY
 * bands), a sortable head that SAYS its sort (aria-sort, not an icon alone),
 * a row accent rail keyed on a status tone, an empty state inside the table's
 * own frame, and the pagination footer.
 */
describe('DataTable', () => {
  it('a sortable head carries aria-sort and reports a click', () => {
    const onSort = vi.fn();
    render(
      <Table>
        <TableHeader>
          <tr><TableHead sortable sortDir="desc" onSort={onSort}>Raised</TableHead></tr>
        </TableHeader>
      </Table>,
    );
    const head = screen.getByRole('columnheader', { name: /raised/i });
    expect(head).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(within(head).getByRole('button'));
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  it('a group row spans its columns and names its hue', () => {
    render(
      <Table>
        <TableHeader>
          <TableGroupRow groups={[{ label: 'Instrument', span: 1 }, { label: 'Temperature (°C)', span: 2, hue: 'temp' }]} />
        </TableHeader>
      </Table>,
    );
    const temp = screen.getByRole('columnheader', { name: /temperature/i });
    expect(temp).toHaveAttribute('colspan', '2');
    expect(temp).toHaveAttribute('data-hue', 'temp');
  });

  it('a row accent is keyed on a status tone', () => {
    render(
      <Table><TableBody>
        <TableRow accent="danger"><TableCell>x</TableCell></TableRow>
      </TableBody></Table>,
    );
    expect(screen.getByRole('row')).toHaveAttribute('data-accent', 'danger');
  });

  it('the empty state sits inside the table frame and the footer pages', () => {
    const onPageChange = vi.fn();
    render(
      <Table>
        <TableBody><TableEmpty colSpan={3} title="No alarms" /></TableBody>
        <TableFooter colSpan={3} page={2} pageSize={25} totalItems={60} onPageChange={onPageChange} />
      </Table>,
    );
    expect(screen.getByText('No alarms')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/table.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=1 — `TableGroupRow` / `TableEmpty` / `TableFooter` are not exported.

(If the Pagination previous-page button has a different accessible name, read `components/ui/pagination.tsx` and use its exact `aria-label` in the last case; do not change Pagination.)

- [ ] **Step 3: Replace `table.tsx`**

```tsx
// apps/web/src/components/ui/table.tsx
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
export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative w-full overflow-hidden rounded-[var(--radius-card)] border border-slate-200/70 bg-white shadow-[var(--elev-1)]">
      <div className="overflow-auto">
        <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
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
```

- [ ] **Step 4: Run the new test and the eight existing callers' tests**

Run the new test: `cd apps/web && npx vitest run src/components/ui/__tests__/table.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=0, 4 passed.

Then find the callers and run each one's test file individually:
`grep -rl "from '@/components/ui/table'" src/routes | grep -v __tests__` — for each route file, run its `__tests__/*.test.tsx` siblings one at a time by exit code. Every one must stay green; if a test asserted on the old grey header class, update the assertion to `data-band="gradient"` — markup only.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/table.tsx apps/web/src/components/ui/__tests__/table.test.tsx
git commit -m "feat(ui): DataTable — header band, group row, sortable head, accent rail, empty, footer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `FormSection`

**Files:**
- Create: `apps/web/src/components/ui/form-section.tsx`
- Test: `apps/web/src/components/ui/__tests__/form-section.test.tsx`

**Interfaces:**
- Produces: `FormSection({ title, icon?, actions?, columns?: 1 | 2, children, className? })` — root `<section aria-labelledby>` with an `h2`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ui/__tests__/form-section.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormSection } from '../form-section';

describe('FormSection', () => {
  it('is a labelled region with an h2 title and a two-column grid by default', () => {
    render(<FormSection title="Password rules"><label>Minimum length<input /></label></FormSection>);
    const region = screen.getByRole('region', { name: 'Password rules' });
    expect(region.querySelector('h2')).toHaveTextContent('Password rules');
    expect(screen.getByTestId('form-section-grid')).toHaveAttribute('data-columns', '2');
  });

  it('can be one column and carries its actions in the plate', () => {
    render(<FormSection title="LDAP" columns={1} actions={<button type="button">Test connection</button>}><p>x</p></FormSection>);
    expect(screen.getByTestId('form-section-grid')).toHaveAttribute('data-columns', '1');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/form-section.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=1, import fails.

- [ ] **Step 3: Write `FormSection`**

```tsx
// apps/web/src/components/ui/form-section.tsx
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/form-section.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=0, 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/form-section.tsx apps/web/src/components/ui/__tests__/form-section.test.tsx
git commit -m "feat(ui): FormSection — gradient plate over a field grid" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `DialogBanner` promoted to the shared set

**Files:**
- Create: `apps/web/src/components/ui/dialog-banner.tsx`
- Modify: `apps/web/src/routes/functional-locations/dialog-banner.tsx` (becomes a re-export + `LocationGlyph`)
- Test: `apps/web/src/components/ui/__tests__/dialog-banner.test.tsx`
- Regression: `apps/web/src/routes/functional-locations/__tests__/index-page.test.tsx`, `.../detail-page.test.tsx`

**Interfaces:**
- Produces: `DialogBanner({ title, subtitle?, icon?, tone?: 'theme' | 'danger' })`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ui/__tests__/dialog-banner.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DialogBanner } from '../dialog-banner';

describe('DialogBanner', () => {
  it('names the dialog in an h2 and is themed by default', () => {
    render(<DialogBanner title="Acknowledge alarm" subtitle="CWH/RDU/001-00" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Acknowledge alarm' })).toBeInTheDocument();
    expect(screen.getByTestId('dialog-banner')).toHaveAttribute('data-tone', 'theme');
  });

  it('a destructive dialog says so in its tone', () => {
    render(<DialogBanner title="Delete floor plan" tone="danger" />);
    expect(screen.getByTestId('dialog-banner')).toHaveAttribute('data-tone', 'danger');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/dialog-banner.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=1, import fails.

- [ ] **Step 3: Write the shared banner and re-point the old file**

```tsx
// apps/web/src/components/ui/dialog-banner.tsx
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
```

Replace the whole of `apps/web/src/routes/functional-locations/dialog-banner.tsx` with:

```tsx
/**
 * The banner moved to components/ui on 2026-09-21 (UI v3). This file keeps
 * the page tree's imports working and holds the glyph that is this tree's own.
 */
export { DialogBanner } from '@/components/ui/dialog-banner';

export const LocationGlyph = (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
  </svg>
);
```

- [ ] **Step 4: Run the new test and the two Functional Locations page tests, each by exit code**

```
cd apps/web
npx vitest run src/components/ui/__tests__/dialog-banner.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?
npx vitest run src/routes/functional-locations/__tests__/index-page.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?
npx vitest run src/routes/functional-locations/__tests__/detail-page.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?
```
Expected: EXIT=0 for all three.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/dialog-banner.tsx apps/web/src/components/ui/__tests__/dialog-banner.test.tsx apps/web/src/routes/functional-locations/dialog-banner.tsx
git commit -m "refactor(ui): promote DialogBanner to the shared set, with a danger tone" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `Toolbar`

**Files:**
- Create: `apps/web/src/components/ui/toolbar.tsx`
- Test: `apps/web/src/components/ui/__tests__/toolbar.test.tsx`

**Interfaces:**
- Consumes: `Input` from `./input`.
- Produces: `Toolbar({ search?: { name: string; value: string; onChange: (v: string) => void; placeholder?: string; label: string }, filters?, trailing?, className? })`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ui/__tests__/toolbar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toolbar } from '../toolbar';

/**
 * The search box needs a distinct `name` and an accessible label: an
 * unnamed text input beside a password field is what Chrome autofills the
 * username into (Alarms search box, 2026-08-31).
 */
describe('Toolbar', () => {
  it('renders a named, labelled search that reports typing, with filters and trailing actions', () => {
    const onChange = vi.fn();
    render(
      <Toolbar
        search={{ name: 'alarm-search', value: '', onChange, label: 'Search alarms', placeholder: 'Instrument, type, location' }}
        filters={<select aria-label="Type"><option>All</option></select>}
        trailing={<button type="button">Export</button>}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Search alarms' });
    expect(box).toHaveAttribute('name', 'alarm-search');
    fireEvent.change(box, { target: { value: 'CWH' } });
    expect(onChange).toHaveBeenCalledWith('CWH');
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('renders without a search box when none is given', () => {
    render(<Toolbar trailing={<button type="button">New</button>} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/toolbar.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=1, import fails.

- [ ] **Step 3: Write `Toolbar`**

```tsx
// apps/web/src/components/ui/toolbar.tsx
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/ui/__tests__/toolbar.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=0, 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/toolbar.tsx apps/web/src/components/ui/__tests__/toolbar.test.tsx
git commit -m "feat(ui): Toolbar — search, filters, trailing actions in one row" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Sidebar active pill

**Files:**
- Modify: `apps/web/src/components/layout/sidebar.tsx` — the `Link` inside `orderedItems.map` (the `className={cn(` block whose `active ?` branch reads `'bg-white/15 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]'`, and the `{active && (<span … bg-white />)}` rail after it)
- Test: `apps/web/src/components/layout/__tests__/sidebar-active.test.tsx` (new)

**Interfaces:** none new. The nav item list, order logic and `aria-current` are untouched.

- [ ] **Step 1: Write the failing test**

Read `apps/web/src/components/layout/__tests__/header.test.tsx` first for how this folder mocks `useAuth`, `useBranding` and `swr`, and copy those mocks verbatim.

```tsx
// apps/web/src/components/layout/__tests__/sidebar-active.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('swr', () => ({ default: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: {
    appName: 'T&RH-Monitoring', logoUrl: '', logoText: 'CC', companyName: 'Controlytics', primaryColor: '#0891b2',
    secondaryColor: '#0d9488', accentColor: '#14b8a6', loginBgStart: '#164e63',
  } }),
}));

const { Sidebar } = await import('../sidebar');

/**
 * UI v3: the active item is a white pill with theme ink and a right-hand
 * dot (cc-dashboard.png). Asserted by data attribute and the class the pill
 * is built from, because a colour alone is invisible to a test.
 */
describe('Sidebar active item', () => {
  it('marks the current route as a white pill and leaves the others translucent', () => {
    render(<MemoryRouter initialEntries={['/alarms']}><Sidebar userRole="SUPER_ADMIN" open onClose={() => {}} /></MemoryRouter>);
    const active = screen.getByRole('link', { current: 'page' });
    expect(active).toHaveAttribute('data-active', 'true');
    expect(active.className).toMatch(/\bbg-white\b/);
    const other = screen.getByRole('link', { name: /users/i });
    expect(other).toHaveAttribute('data-active', 'false');
    expect(other.className).not.toMatch(/\bbg-white\b/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/layout/__tests__/sidebar-active.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=1 — no `data-active` attribute.

- [ ] **Step 3: Change the active treatment**

In `sidebar.tsx`, on the `<Link>` inside `orderedItems.map`, add `data-active={active ? 'true' : 'false'}` beside `aria-current`, and replace the two branches of the `active ? … : …` expression with:

```tsx
                active
                  ? 'bg-white text-[var(--theme-primary,#2a78d6)] shadow-[var(--elev-1)]'
                  : 'text-white/75 hover:bg-white/10 hover:text-white',
```

Replace the `{active && (<span aria-hidden className="absolute left-0 …" />)}` rail block with a right-hand dot:

```tsx
              {active && !collapsed && (
                <span aria-hidden className="absolute right-3 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[var(--theme-primary,#2a78d6)]" />
              )}
```

And on the icon span, replace `active ? 'text-white' : 'text-white/60 group-hover:text-white'` with
`active ? 'text-[var(--theme-primary,#2a78d6)]' : 'text-white/60 group-hover:text-white'`.

Update the comment above the removed rail: it now reads "The active DOT sits at the right edge (cc-dashboard.png); the pill itself is the marker, so no rail."

- [ ] **Step 4: Run the new test and the header test**

```
cd apps/web
npx vitest run src/components/layout/__tests__/sidebar-active.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?
npx vitest run src/components/layout/__tests__/header.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?
```
Expected: EXIT=0 both.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx apps/web/src/components/layout/__tests__/sidebar-active.test.tsx
git commit -m "feat(shell): sidebar active item is a white pill with theme ink" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `AuthShell` and the four auth pages

**Files:**
- Create: `apps/web/src/routes/auth/auth-shell.tsx`
- Modify: `apps/web/src/routes/auth/login.tsx` (root `<div className="flex min-h-screen …">` … outer card only), `forgot-password.tsx` (root, lines ~37–44), `change-password.tsx` (root, lines ~105–106), `contact-admin.tsx` (both roots, lines ~306–307 and ~324–325)
- Test: `apps/web/src/routes/auth/__tests__/auth-shell.test.tsx` (new); existing tests under `routes/auth/__tests__/` (run each by exit code)

**Interfaces:**
- Produces: `AuthShell({ children, width?: 'md' | 'lg' })` — root `data-testid="auth-shell"`, card `data-testid="auth-card"`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/routes/auth/__tests__/auth-shell.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: { loginBgStart: '#164e63', loginBgEnd: '#1e3a5f', gradientStart: '#0891b2', gradientEnd: '#0d9488' } }),
}));
const { AuthShell } = await import('../auth-shell');

describe('AuthShell', () => {
  it('centres its content in one card over the band', () => {
    render(<AuthShell><form aria-label="Sign in" /></AuthShell>);
    const card = screen.getByTestId('auth-card');
    expect(card.contains(screen.getByRole('form', { name: 'Sign in' }))).toBe(true);
    expect(card.className).toMatch(/max-w-md/);
  });

  it('can be the wider card', () => {
    render(<AuthShell width="lg"><p>x</p></AuthShell>);
    expect(screen.getByTestId('auth-card').className).toMatch(/max-w-lg/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/auth/__tests__/auth-shell.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?`
Expected: EXIT=1, import fails.

- [ ] **Step 3: Write `AuthShell`**

```tsx
// apps/web/src/routes/auth/auth-shell.tsx
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useBranding } from '@/hooks/use-branding';

/**
 * The frame of every pre-login screen (UI v3, 2026-09-21): full-bleed
 * theme gradient with two soft circles, one centred white card. The four
 * auth pages each drew their own background before — one on slate-100, one
 * on a three-stop gradient, two on a diagonal — so the product's first
 * screen and its second did not match.
 *
 * The gradient reads the Branding login colours, as before, so the Login
 * Background section of Configuration → Branding still does what it says.
 */
export function AuthShell({ children, width = 'md' }: { children: ReactNode; width?: 'md' | 'lg' }) {
  const { branding } = useBranding();
  return (
    <div
      data-testid="auth-shell"
      className="relative flex min-h-screen items-center justify-center overflow-hidden p-6"
      style={{ background: `linear-gradient(135deg, ${branding.loginBgStart}, ${branding.loginBgEnd})` }}
    >
      <span aria-hidden className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-white/[0.07]" />
      <span aria-hidden className="pointer-events-none absolute -bottom-32 -right-16 h-[28rem] w-[28rem] rounded-full bg-white/[0.05]" />
      <div
        data-testid="auth-card"
        className={cn(
          'relative w-full overflow-hidden rounded-[var(--radius-card)] bg-white shadow-[var(--elev-3)]',
          width === 'lg' ? 'max-w-lg' : 'max-w-md',
        )}
      >
        <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${branding.gradientStart}, ${branding.gradientEnd})` }} />
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wrap the four pages**

`login.tsx`: replace the root `<div className="flex min-h-screen items-center justify-center p-8" style={{ background: … }}>` + `<div className="w-full max-w-md">` + the card `<div className="relative bg-white/95 …">` + its decorative `<div className="h-2" …/>` with `<AuthShell>`; keep everything from `<div className="p-8 pt-6">` inward unchanged; close with `</AuthShell>` where the three wrappers closed. Import `{ AuthShell } from './auth-shell'`. The two `<Dialog>`s at the end of the file stay outside `AuthShell` exactly where they are.

`forgot-password.tsx`: same substitution for its root + `max-w-md` wrapper.

`change-password.tsx`: replace `<div className="flex min-h-screen items-center justify-center bg-slate-100 p-4"><Card className="w-full max-w-md">` … `</Card></div>` with `<AuthShell>` … `</AuthShell>`; the `Card`'s children move up one level unchanged (drop the `Card` import if now unused).

`contact-admin.tsx`: both roots (`~306` submitted view, `~324` form view) become `<AuthShell>` / `<AuthShell width="lg">` around the existing inner content, dropping the hand-drawn white card `div`.

- [ ] **Step 5: Run the shell test and the one test that touches these routes, each by exit code**

No test mounts an auth page today (`routes/auth/__tests__/` does not exist; measured 2026-09-21). The one file that references them is the route-guard allow-list test.

```
cd apps/web
npx vitest run src/routes/auth/__tests__/auth-shell.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?
npx vitest run src/__tests__/route-guard-coverage.test.ts > /tmp/t.txt 2>&1; echo EXIT=$?
```
Expected: EXIT=0 for both. Then, because no render test covers the four pages, mount each one once by hand in a scratch test to prove it still renders without throwing — a wrapper change that breaks a hook order or an import is exactly the fault a typecheck cannot see:

```tsx
// apps/web/src/routes/auth/__tests__/auth-pages-render.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('swr', () => ({ default: () => ({ data: undefined, mutate: vi.fn() }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null, login: vi.fn(), logout: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: {
    appName: 'T&RH-Monitoring', appTagline: '21 CFR Part 11', logoUrl: '', logoText: 'CC', companyName: 'Controlytics',
    primaryColor: '#0891b2', secondaryColor: '#0d9488', accentColor: '#14b8a6',
    gradientStart: '#0891b2', gradientMiddle: '#0d9488', gradientEnd: '#14b8a6', loginBgStart: '#164e63', loginBgEnd: '#1e3a5f',
  } }),
}));

/** Each pre-login page mounts inside the shared AuthShell without throwing. */
describe('auth pages render inside AuthShell', () => {
  it('login', async () => {
    const { LoginPage } = await import('../login');
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
  it('forgot password', async () => {
    const { ForgotPasswordPage } = await import('../forgot-password');
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
  it('change password', async () => {
    const { ChangePasswordPage } = await import('../change-password');
    render(<MemoryRouter><ChangePasswordPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
  it('contact admin', async () => {
    const { ContactAdminPage } = await import('../contact-admin');
    render(<MemoryRouter><ContactAdminPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
});
```

Before writing it, read the top of each of the four files for the EXACT exported component name (`grep -n "^export" src/routes/auth/*.tsx`) and the hooks each imports; add a `vi.mock` for any hook not already mocked above (the file must not reach the network). Run it: `npx vitest run src/routes/auth/__tests__/auth-pages-render.test.tsx > /tmp/t.txt 2>&1; echo EXIT=$?` — expected EXIT=0, 4 passed. Commit it with the pages in Step 6.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/auth
git commit -m "feat(auth): one AuthShell frame for login, forgot, change-password and contact-admin" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Contrast check script

**Files:**
- Create: `apps/web/scripts/contrast-check.mjs`
- Modify: `apps/web/package.json` — add `"check:contrast": "node scripts/contrast-check.mjs"` under `scripts`

**Interfaces:** reads `THEMES` by parsing `src/lib/themes.ts` text for `gradientFrom`, `gradientTo`, `primary` hex values per preset. Exits 1 if any pair is below WCAG AA (4.5:1 for body text, 3:1 for large text).

- [ ] **Step 1: Write the script**

```js
// apps/web/scripts/contrast-check.mjs
// WCAG AA contrast for UI v3: white on every preset's gradient ends (the hero
// band, table header band, form plates) and slate-900 on the two theme tints.
// Run: npm run check:contrast   (exit 1 on any failure)
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/lib/themes.ts', import.meta.url), 'utf8');
const presets = [];
for (const block of src.split(/\n\s*\{\s*\n\s*id:/).slice(1)) {
  const id = block.match(/^\s*'([^']+)'/)?.[1];
  const pick = (k) => block.match(new RegExp(`${k}:\\s*'(#[0-9a-fA-F]{6})'`))?.[1];
  presets.push({ id, primary: pick('primary'), from: pick('gradientFrom'), to: pick('gradientTo') });
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (h, pct) => { // color-mix(in srgb, h pct%, white)
  const c = hex(h).map((v) => v * pct + 1 * (1 - pct));
  return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
};

let failed = 0;
for (const p of presets) {
  const rows = [
    ['white on gradientFrom (large text ≥3)', ratio('#ffffff', p.from), 3],
    ['white on gradientTo (large text ≥3)', ratio('#ffffff', p.to), 3],
    ['white on gradientFrom (body ≥4.5)', ratio('#ffffff', p.from), 4.5],
    ['slate-900 on tint-1 (body ≥4.5)', ratio('#0f172a', mix(p.primary, 0.06)), 4.5],
    ['slate-900 on tint-2 (body ≥4.5)', ratio('#0f172a', mix(p.primary, 0.12)), 4.5],
  ];
  for (const [label, r, min] of rows) {
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.id.padEnd(9)} ${label.padEnd(40)} ${r.toFixed(2)}`);
  }
}
console.log(failed ? `\n${failed} check(s) below WCAG AA` : '\nall presets pass');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it**

Run: `cd apps/web && node scripts/contrast-check.mjs; echo EXIT=$?`
Expected: a PASS/FAIL line per preset per check. If any "white on gradientFrom (body ≥4.5)" line FAILS for a light preset, that is a finding to report to the operator (body-size white text on that preset's band) — do not change `themes.ts`; the band carries only large or bold text by design, and the large-text rows must all pass. If a large-text row fails, STOP and report before continuing.

- [ ] **Step 3: Add the npm script and commit**

Add `"check:contrast": "node scripts/contrast-check.mjs",` to `apps/web/package.json` `scripts`.

```bash
git add apps/web/scripts/contrast-check.mjs apps/web/package.json
git commit -m "chore(ui): WCAG AA contrast check for the v3 bands and tints across all presets" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Batch verification, docs, push

**Files:**
- Modify: `apps/web/CLAUDE.md` (a new section "UI v3 (2026-09-21)" after "Design system (Stage 1 …)"), `CHANGELOG.md` (new `[Unreleased]` entry at the top)

- [ ] **Step 1: Typecheck and build**

```
cd apps/web && npx tsc --noEmit -p tsconfig.json > /tmp/t.txt 2>&1; echo TSC=$?
npx vite build > /tmp/b.txt 2>&1; echo BUILD=$?
```
Expected: both 0. Fix any type error in the files this batch created before continuing.

- [ ] **Step 2: Run every test file this batch touched, individually**

```
cd apps/web
for f in src/components/ui/__tests__/page-hero.test.tsx src/components/ui/__tests__/stat-card.test.tsx src/components/ui/__tests__/table.test.tsx src/components/ui/__tests__/form-section.test.tsx src/components/ui/__tests__/dialog-banner.test.tsx src/components/ui/__tests__/toolbar.test.tsx src/components/layout/__tests__/sidebar-active.test.tsx src/components/layout/__tests__/header.test.tsx src/routes/auth/__tests__/auth-shell.test.tsx src/routes/auth/__tests__/auth-pages-render.test.tsx src/__tests__/route-guard-coverage.test.ts src/routes/functional-locations/__tests__/index-page.test.tsx src/routes/functional-locations/__tests__/detail-page.test.tsx; do npx vitest run "$f" > /tmp/t.txt 2>&1; echo "$f EXIT=$?"; done
```
Plus every test file found in Task 3 Step 4 and Task 8 Step 5. Expected: every line EXIT=0.

- [ ] **Step 3: Docs**

Append to `apps/web/CLAUDE.md`, after the "Design system (Stage 1 `7ed8329`, Stage 2 2026-08-28)" section:

```markdown
## UI v3 — one visual language on every screen (Batch 1 landed 2026-09-21)

Spec: `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md`.
Operator: "update all the screens ui more professionally"; chose a new design
system in the language of their mockups (`Alarms.png`, `screen-2.png`,
`cc-dashboard.png`).

- **Tokens** (in `@theme`): `--text-figure`, `--text-figure-lg`,
  `--surface-tint-1/2`, `--band-gradient` — every one derived from the
  `--theme-*` variables, so all ten presets work. `npm run check:contrast`
  proves white-on-band and ink-on-tint against WCAG AA for every preset.
- **Primitives** in `components/ui/`: `PageHero` (the band every screen
  starts with; the screen's toolbar goes INSIDE it as `children`), `StatCard`
  (ONE figure; no sparkline, nothing stores that history), the rebuilt
  `Table` (`TableHeader band`, `TableGroupRow`, `TableHead sortable` with
  `aria-sort`, `TableRow accent`, `TableEmpty`, `TableFooter`), `FormSection`
  (gradient plate, field grid, no description), `DialogBanner` (moved here;
  `tone="danger"` for a destructive act), `Toolbar` (search with a distinct
  `name`, filters, trailing).
- **Shell**: the sidebar's active item is a white pill with theme ink and a
  right-hand dot. **Auth**: `routes/auth/auth-shell.tsx` frames login,
  forgot-password, change-password and contact-admin.
- Batches 2–4 rebuild the screens on these; see the spec §4. Status colours,
  PDFs, fetch keys and gates are untouched throughout.
```

Prepend to `CHANGELOG.md` under `# Changelog`:

```markdown
## [Unreleased] - UI v3, Batch 1: foundation, shell, auth (2026-09-21)

Operator: *"update all the screens ui more professionally and best ui
screens"*; chose "New design system, then every screen" in the language of
their own mockups. Spec `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md`,
plan `docs/superpowers/plans/2026-09-21-ui-v3-batch-1-foundation-shell-auth.md`.

- Five tokens derived from the theme variables; six primitives (`PageHero`,
  `StatCard`, rebuilt `Table`, `FormSection`, `DialogBanner`, `Toolbar`), each
  with a render test; sidebar active pill; one `AuthShell` for the four
  pre-login screens; `npm run check:contrast` over all ten presets.
- No behaviour change anywhere. Existing `Table` callers render with the new
  header band and nothing else. Not seen on screen — the login page and the
  sidebar are what need the operator's eye before Batch 2.
```

- [ ] **Step 4: Commit and push**

```bash
git add apps/web/CLAUDE.md CHANGELOG.md
git commit -m "docs(ui): record UI v3 Batch 1" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin data-layer
```

- [ ] **Step 5: Report to the operator**

Say: what landed, that the login page and the sidebar are the two things to look at on :5176, that nothing else on screen changed yet except every shared table's header band, and that Batch 2 (dashboard, alarms, instruments, data report, settings, functional locations) is next after their look.
