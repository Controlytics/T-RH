# UI v3 — Batch 2: the monitoring screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Alarms, Instruments (list, detail, trend), Data Report, Settings and Functional Locations on the Batch 1 primitives, so the six screens the operator uses most open with one band, one toolbar and one table.

**Architecture:** Each screen's hand-built hero, toolbar and table header is replaced by `PageHero`, `Toolbar` and the shared `Table`; the page's data flow, fetch keys, mutations, gates and every existing test are untouched. `PageHero` gains a `meta` slot (status chips) because the instrument detail and trend pages carry one. The dashboard is deliberately NOT touched: its hero and title were removed at the operator's instruction on 2026-08-29 and its readings table already carries the coloured column groups of `screen-2.png`.

**Tech Stack:** React 19, Tailwind v4, vitest 3 + Testing Library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md` (§4, Batch 2)

## Global Constraints

- No new dependencies. Light theme only. All ten presets render (everything reads `--band-gradient`, `--surface-tint-*`, `--status-*`).
- Status colours never change. One number per element. No helper prose (every `description` prop is dropped from the replaced headers — the operator strips prose). Units in headers only.
- **No behaviour change.** Fetch keys, mutations, re-auth, audit, `useCan`/`RequireRole` and every `data-testid` / accessible name a test relies on are preserved.
- Run touched test files INDIVIDUALLY by exit code. Commit gated on exit codes; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work in the main checkout on `data-layer`; push to `data-layer` only.

---

## File structure

| File | Change |
|---|---|
| `components/ui/page-hero.tsx` (+ test) | `meta?: ReactNode` passed to `PageHeader` |
| `routes/alarms/index.tsx` | `PageHeader` → `PageHero` with the export icon as its action |
| `routes/alarms/alarm-stat-cards.tsx` | palette → the `--status-*` tokens + top rail (still buttons) |
| `routes/alarms/alarm-table.tsx` | banner → `--band-gradient`; sticky solid → the band's end colour |
| `routes/instruments/list.tsx` | hero → `PageHero` (actions), filter card → `Toolbar`, table → shared `Table` |
| `routes/instruments/detail.tsx` | crumbs + hero → `PageHero` (title = code, `meta` = the chips, actions) |
| `routes/instruments/trend.tsx`, `trend-header.tsx` | crumbs + `TrendHeader` → `PageHero` (`meta` = status/updated); `TrendHeader` deleted |
| `routes/data-report/index.tsx` | `PageHeader` → `PageHero` |
| `routes/settings/index.tsx` | `PageHeader` + Common settings bar → `PageHero` with the picker INSIDE; widget band → `--band-gradient` |
| `routes/functional-locations/index.tsx`, `detail.tsx` | private hero markup → `PageHero` (tiles / meta / actions / search inside) |
| `apps/web/CLAUDE.md`, `CHANGELOG.md` | record the batch |

---

### Task 0: `PageHero` gains `meta`

**Files:** Modify `components/ui/page-hero.tsx`; Test `components/ui/__tests__/page-hero.test.tsx`.

**Interfaces:** Produces `PageHero({ …, meta?: ReactNode, testId?: string })` — `meta` is rendered by `PageHeader`'s existing `meta` row under the title; `testId` (default `'page-hero'`) is the root's `data-testid`, and the root ALWAYS carries `data-hero="v3"`.

- [ ] **Step 1: Add the failing cases** to `page-hero.test.tsx`:

```tsx
  it('renders meta chips under the title, inside the band', () => {
    render(<MemoryRouter><PageHero title="CWH/RDU/001-00" meta={<span data-testid="chip">Active</span>} /></MemoryRouter>);
    expect(screen.getByTestId('page-hero').contains(screen.getByTestId('chip'))).toBe(true);
  });

  it('can carry a caller\'s test id and always says it is the v3 hero', () => {
    render(<MemoryRouter><PageHero title="Blocks" testId="fl-hero" /></MemoryRouter>);
    expect(screen.getByTestId('fl-hero')).toHaveAttribute('data-hero', 'v3');
    expect(screen.queryByTestId('page-hero')).toBeNull();
  });
```

- [ ] **Step 2: Run** `npx vitest run src/components/ui/__tests__/page-hero.test.tsx` → EXIT=1 (both new cases fail).

- [ ] **Step 3: Implement** — add `meta?: ReactNode` and `testId?: string` to the props type; on the root `<section>` use `data-testid={testId ?? 'page-hero'}` and add `data-hero="v3"`; pass `meta={meta}` to `<PageHeader inverted …/>`.

- [ ] **Step 4: Run** → EXIT=0, 6 passed. **Commit:** `feat(ui): PageHero meta slot and caller test id`.

---

### Task 1: Alarms

**Files:** `routes/alarms/index.tsx` (lines ~315–345), `routes/alarms/alarm-stat-cards.tsx` (`PALETTE`), `routes/alarms/alarm-table.tsx` (`ALARM_BANNER_GRADIENT`, `ALARM_BANNER_SOLID`). Test: `routes/alarms/__tests__/alarms-page.test.tsx` (existing, must stay green) + one new case.

- [ ] **Step 1: Add the failing case** to `alarms-page.test.tsx`, inside the top-level `describe`, using that file's existing `mount()`/render helper:

```tsx
  it('opens with the page hero band carrying the export action', () => {
    mount();
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('heading', { level: 1, name: 'Alarms' }))).toBe(true);
    expect(hero.contains(screen.getByRole('button', { name: /export/i }))).toBe(true);
  });
```
(Read the file first for the helper's name and whether the export trigger's accessible name is "Export" — `ExportMenu iconOnly` carries `aria-label`; use its exact text.)

- [ ] **Step 2: Run** the file → the new case fails (no `page-hero`).

- [ ] **Step 3: Replace the header block** in `index.tsx`. Import `PageHero` from `@/components/ui/page-hero` (drop the `PageHeader` import). Replace from `<PageHeader className="mb-6"` through the closing `</div>` of the `mb-2 flex justify-end` export wrapper with:

```tsx
      <PageHero
        className="mb-6"
        title="Alarms"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Alarms' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        }
        // The download exports exactly what the filters below select, so it
        // rides in the band as the screen's one action. Icon only, as before.
        actions={<ExportMenu surface="alarms" iconOnly onExportPdf={() => setDownloadOpen(true)} />}
      />

      <div className="mb-5">
        <AlarmStatCards
          counts={counts}
          selected={filters.status}
          onSelect={(q) => setFilters((f) => ({ ...f, status: q }))}
        />
      </div>
```
(The `AlarmStatCards` block is kept exactly; only the header above it and the export wrapper below it change.)

- [ ] **Step 4: Re-skin the stat cards** — replace `PALETTE` in `alarm-stat-cards.tsx` so the four tones read the status tokens (same shape, same keys; the buttons, `aria-pressed`, titles and icons are untouched):

```tsx
const PALETTE: Record<QuadrantTone, Palette> = {
  danger: { card: 'border-slate-200/70 bg-[var(--status-danger-bg)]', icon: 'bg-[var(--status-danger-dot)]', label: 'text-[var(--status-danger-ink)]', value: 'text-[var(--status-danger-ink)]', ring: 'ring-[var(--status-danger-dot)]' },
  info:   { card: 'border-slate-200/70 bg-[var(--status-info-bg)]',   icon: 'bg-[var(--status-info-dot)]',   label: 'text-[var(--status-info-ink)]',   value: 'text-[var(--status-info-ink)]',   ring: 'ring-[var(--status-info-dot)]' },
  warn:   { card: 'border-slate-200/70 bg-[var(--status-warn-bg)]',   icon: 'bg-[var(--status-warn-dot)]',   label: 'text-[var(--status-warn-ink)]',   value: 'text-[var(--status-warn-ink)]',   ring: 'ring-[var(--status-warn-dot)]' },
  ok:     { card: 'border-slate-200/70 bg-[var(--status-ok-bg)]',     icon: 'bg-[var(--status-ok-dot)]',     label: 'text-[var(--status-ok-ink)]',     value: 'text-[var(--status-ok-ink)]',     ring: 'ring-[var(--status-ok-dot)]' },
};
```
and change the button's class string from `rounded-2xl border px-5 py-4` to `relative overflow-hidden rounded-[var(--radius-card)] border px-5 py-4`, adding as the button's FIRST child `<span aria-hidden className={\`absolute inset-x-0 top-0 h-[3px] ${p.icon}\`} />` (the StatCard's top rail, in the tone's dot colour). Update the comment above `PALETTE`: "The four tones read the `--status-*` tokens (UI v3, 2026-09-21), so a card here and a StatCard elsewhere are the same colour for the same meaning."

- [ ] **Step 5: The banner** — in `alarm-table.tsx` replace the two style constants:

```tsx
export const ALARM_BANNER_GRADIENT: CSSProperties = { background: 'var(--band-gradient)' };
/** The band's END colour, solid — the sticky action column sits at the right edge of the band. */
export const ALARM_BANNER_SOLID: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--theme-gradient-to, #1e3a5f) 78%, black)',
};
```
Update the comment above them: the banner is the v3 band, the same `--band-gradient` every shared table header uses; the solid is its end colour because the sticky column is at the right end.

- [ ] **Step 6: Run** `alarms-page.test.tsx`, `alarm-display.test.ts`, `alarms-report.test.ts`, `instruments/__tests__/alarms-widget.test.tsx`, `dashboard/__tests__/selection-alarms.test.tsx` individually → all EXIT=0. **Commit:** `feat(alarms): PageHero, status-token stat cards, v3 table band`.

---

### Task 2: Instruments list

**Files:** `routes/instruments/list.tsx` (hero block ~161–199; filter card ~208–229; table ~234–…). Test: `routes/instruments/__tests__/list-page.test.tsx` (NEW — the list has no render test).

- [ ] **Step 1: Write the failing test.** Read `list.tsx`'s imports and hooks (`useSWR` keys, `useCan`, `use-pagination-config`, `instrument-activity`) and mock them the way `settings-page.test.tsx` does. Assert:

```tsx
  it('opens with the hero band carrying New instrument, a search toolbar and the shared table band', () => {
    mount();  // as SUPER_ADMIN with two instrument rows
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('link', { name: /new instrument/i }))).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Search instruments' })).toHaveAttribute('name', 'instrument-search');
    expect(document.querySelector('thead')).toHaveAttribute('data-band', 'gradient');
    expect(screen.getByRole('link', { name: 'CWH/RDU/001-00' })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run** → fails (no `page-hero`).

- [ ] **Step 3: Replace the hero** (the `<div className="relative overflow-hidden … style={themeGradient}>` block through its closing `</div>` after the mast motif) with:

```tsx
      <PageHero
        title={profile?.name ?? 'Instruments'}
        crumbs={profileId
          ? [{ label: 'Dashboard', to: '/' }, { label: 'Instruments', to: '/instruments' }, { label: profile?.name ?? '…' }]
          : [{ label: 'Dashboard', to: '/' }, { label: 'Instruments' }]}
        actions={can('instruments.create') && (
          <>
            <Link to={profileId ? `/instruments/bulk?profileId=${profileId}` : '/instruments/bulk'}>
              <Button className="border border-white/30 bg-white/10 text-white hover:bg-white/20">Bulk upload</Button>
            </Link>
            <Link to={profileId ? `/instruments/new?profileId=${profileId}` : '/instruments/new'}>
              <Button className="bg-white text-slate-800 hover:bg-white/90">New instrument</Button>
            </Link>
          </>
        )}
      />
```
The "Register" eyebrow and the description sentence are dropped (prose). Remove the now-unused `themeGradient` import if `SummaryTile` no longer uses it (it uses it for the `brand` tone rail — keep the import in that case).

- [ ] **Step 4: Replace the filter card** (`<div className="rounded-[var(--radius-card)] border … p-4">` … `</div>`) with:

```tsx
      <Toolbar
        search={{ name: 'instrument-search', label: 'Search instruments', placeholder: 'Search name, code or serial…', value: search, onChange: setSearch }}
        filters={
          <Select className="w-40" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
        }
        trailing={tileFilter && (
          <Button variant="ghost" size="sm" type="button" onClick={() => setTileFilter(null)}>
            Clear {tileFilter} filter
          </Button>
        )}
      />
```
Import `Toolbar` from `@/components/ui/toolbar`; drop the `Input` import if unused.

- [ ] **Step 5: Replace the table frame** — `<div className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white"><table className="tbl w-full text-sm"><thead><tr className="border-b …">` becomes `<Table><TableHeader><tr>`; each header `<th className="px-4 py-3 text-[0.6875rem] …">X</th>` becomes `<TableHead>X</TableHead>`; `<tbody>` → `<TableBody>`; each row `<tr …>` → `<TableRow …>` (keep any className the row carries) and `<td>` → `<TableCell>` (keep classNames). Close with `</TableBody></Table>`. Import the six from `@/components/ui/table`. The pagination that follows the table stays where it is.

- [ ] **Step 6: Run** the new test and `tsc --noEmit` → EXIT=0. **Commit:** `feat(instruments): list on PageHero, Toolbar and the shared table`.

---

### Task 3: Instrument detail

**Files:** `routes/instruments/detail.tsx` (lines ~318–~400: `Breadcrumbs` + hero). Tests: `detail-edit.test.tsx`, `detail-delete.test.tsx`, `detail-token-reveal.test.tsx` (existing; add one assertion to `detail-edit`).

- [ ] **Step 1: Add the failing assertion** to the first render case of `detail-edit.test.tsx`: `expect(screen.getByTestId('page-hero')).toHaveTextContent('CWH/RDU/001-00');` (use the fixture's code).

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3: Replace** the `<Breadcrumbs …/>` and the hero `<div … style={themeGradient}>` … `</div>` with `PageHero`:
  - `title={inst.code}`, `crumbs` = the same three crumbs, `icon` = the instrument glyph already used on the list page,
  - `meta` = the existing chip row (`Gateway` chip, `Child of …` link, the Active/Inactive observed chip, the declared chip, the `in {profileName}` link) moved verbatim into one `<>…</>`,
  - `actions` = the existing right-hand button group moved verbatim.
  Read the block to its closing tag before cutting; nothing inside the chips or buttons changes. Drop the `Breadcrumbs` and `themeGradient` imports if unused.

- [ ] **Step 4: Run** the three detail tests individually + `tsc` → EXIT=0. **Commit:** `feat(instruments): detail on PageHero`.

---

### Task 4: Instrument trend

**Files:** `routes/instruments/trend.tsx` (lines ~779–800), delete `routes/instruments/trend-header.tsx`. Tests: `trend-downloads.test.tsx`, `trend-chart-card.test.tsx`, `trend-widget-labels.test.tsx`, `trend-default-interval.test.tsx` (existing) + one assertion in `trend-downloads`.

- [ ] **Step 1: Add the failing assertion** in `trend-downloads.test.tsx`'s first case: `expect(screen.getByTestId('page-hero')).toBeInTheDocument();`.

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3: Replace** the `<Breadcrumbs …/>` + `<TrendHeader …/>` pair with:

```tsx
      <PageHero
        title={inst?.code ?? '…'}
        crumbs={trendCrumbs(originFrom(location.state), id ?? null, inst?.code ?? null)}
        actions={<ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport({ kind: 'timeseries' })} />}
        meta={
          <>
            <span className="text-[0.8125rem] text-white/80">{inst?.name ?? ''}{placementText && <span className="text-white/55"> · {placementText}</span>}</span>
            {(() => { const sc = trend.overview?.status ? statusClasses(trend.overview.status) : null; return (
              <span className="flex items-center gap-1.5 text-xs text-white/85">
                {sc && (<><span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} aria-hidden="true" /><span className="font-semibold text-white">{sc.label}</span><span className="text-white/60">·</span></>)}
                <span className="tabular-nums">{latestReadingTs ? `updated ${readingAge(latestReadingTs)}` : 'no readings yet'}</span>
              </span>
            ); })()}
          </>
        }
      />
```
Import `statusClasses, readingAge` from `@/routes/dashboard/status` and `PageHero`; delete `trend-header.tsx` and its import. The "Back to instrument" link is gone: the crumb trail's instrument link is the same hop.

- [ ] **Step 4: Run** the four trend tests individually + `tsc` → EXIT=0. **Commit:** `feat(instruments): trend on PageHero; TrendHeader removed`.

---

### Task 5: Data Report and Settings

**Files:** `routes/data-report/index.tsx`; `routes/settings/index.tsx` (header + Common settings section, ~lines 298–325; the widget band `style={themeGradient}` ~line 338). Tests: `data-report-page.test.tsx`, `settings-page.test.tsx` (existing; one assertion each).

- [ ] **Step 1: Failing assertions.** In `data-report-page.test.tsx`'s heading case add `expect(screen.getByTestId('page-hero')).toBeInTheDocument();`. In `settings-page.test.tsx`'s first case add `expect(screen.getByTestId('page-hero').contains(screen.getByRole('button', { expanded: false }))).toBe(true);` (the picker inside the band).

- [ ] **Step 2: Run** both → fail.

- [ ] **Step 3: Data Report** — `PageHeader` → `PageHero` with the same `title`, `crumbs`, `icon`, `className="mb-6"`; drop `description`.

- [ ] **Step 4: Settings** — replace `<PageHeader …/>` AND the `<section aria-label="Common settings" …>…</section>` with:

```tsx
      <PageHero
        title="Settings"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Settings' }]}
        icon={/* the existing gear svg */}
      >
        <section aria-label="Common settings" className="flex flex-wrap items-center gap-4">
          <span className="text-xs font-bold uppercase tracking-[0.08em] text-white/85">Instrument</span>
          <SearchableSelect … exactly as before … className="w-72" />
          {!isLoading && !error && options.length === 0 && <span className="text-sm text-white/85">No instruments are assigned to you.</span>}
          {error && <span className="text-sm text-white">The instruments could not be loaded. Try again.</span>}
        </section>
      </PageHero>
```
and change the widget band `style={themeGradient}` to `style={{ background: 'var(--band-gradient)' }}`. Drop the `themeGradient` import if unused.

- [ ] **Step 5: Run** both tests individually + `tsc` → EXIT=0. **Commit:** `feat(data-report,settings): PageHero; the Settings picker rides in the band`.

---

### Task 6: Functional Locations

**Files:** `routes/functional-locations/index.tsx` (hero `<section data-testid="fl-hero">` … `</section>`), `detail.tsx` (`<section data-testid="fl-detail-hero">` … `</section>`). Tests: `index-page.test.tsx`, `detail-page.test.tsx` (existing — they assert `fl-hero`, `fl-figure-*`, `fl-detail-hero` and `queryByRole('img')` absent; keep those ids).

- [ ] **Step 1: Failing assertions.** In `index-page.test.tsx`: `expect(screen.getByTestId('fl-hero')).toHaveAttribute('data-hero', 'v3');` — the hero IS the primitive. In `detail-page.test.tsx`: the same for `fl-detail-hero`.

- [ ] **Step 2: Run** → fail.

- [ ] **Step 3: `index.tsx`** — replace the section with

```tsx
      <PageHero
        data-testid="fl-hero"
        title="Functional Locations"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Functional Locations' }]}
        icon={LocationGlyph}
        actions={actions}
        tiles={[
          { label: tree.length === 1 ? 'Block' : 'Blocks', value: tree.length },
          { label: areaCount === 1 ? 'Area' : 'Areas', value: areaCount },
          { label: totalInstruments === 1 ? 'Instrument assigned' : 'Instruments assigned', value: totalInstruments },
        ]}
      >
        {tree.length > 0 && (
          <label className="block w-full md:max-w-md">
            <span className="mb-1.5 block text-[0.8125rem] font-medium text-white/85">Find a block or area</span>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search blocks and areas…" className="h-9 border-white/30 bg-white/90 text-slate-900 placeholder:text-slate-500" />
          </label>
        )}
      </PageHero>
```
`PageHero` takes `testId` (Task 0): `<PageHero testId="fl-hero" …>` keeps the existing `fl-hero` assertions working, and the primitive always carries `data-hero="v3"`, which is the lock that the page uses it. The three existing `fl-figure-*` assertions in `index-page.test.tsx` are re-pointed to the tiles: `within(screen.getByTestId('page-hero-tiles')).getByText('Blocks')` etc. Delete the page's private `Figure` component if it has no other caller.

- [ ] **Step 4: `detail.tsx`** — replace the section with `<PageHero testId="fl-detail-hero" title={data.name} crumbs={…the same crumbs…} icon={LocationGlyph} meta={<span className="inline-flex items-center rounded-[var(--radius-pill)] bg-white/20 px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-white ring-1 ring-inset ring-white/30">{isBlock ? 'Block' : 'Area'}</span>} actions={…the existing button group…} />` and add `data-hero="v3"` via the same prop. The "Inside {parentName}" line becomes a second `meta` span `text-[0.8125rem] text-white/75`.

- [ ] **Step 5: Run** both FL tests individually + `tsc` → EXIT=0. **Commit:** `feat(functional-locations): both heroes on PageHero`.

---

### Task 7: Verification, docs, push

- [ ] `npx tsc --noEmit -p tsconfig.json` and `npx vite build` in `apps/web` → both 0.
- [ ] Every test file named in Tasks 0–6, individually by exit code → all 0.
- [ ] `apps/web/CLAUDE.md`: under "UI v3", add a "Batch 2 (2026-09-21)" paragraph listing the six screens and the two deliberate exceptions (dashboard untouched; the trend page's "Back to instrument" link replaced by the crumb). `CHANGELOG.md`: a new `[Unreleased] - UI v3, Batch 2` entry at the top with the same content and "not seen on screen".
- [ ] Commit `docs(ui): record UI v3 Batch 2`, `git push origin data-layer`.
- [ ] Report: the six screens to look at; Alarms and Instruments first.
