# UI v3 — Batch 4: configuration and system — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Configuration index, every page under `routes/config/` (including the dynamic config page, Roles & Access and Help), System Health and Debug traces on the Batch 1 primitives — the last batch.

**Architecture:** Three mechanical passes plus a handful of hand edits. (1) Every plain `PageHeader` becomes `PageHero` with its `description` dropped; the six pages whose header sits beside sibling controls move those controls into `actions`; the three pages that wrap their header in a private gradient (dynamic-config, Help, Roles & Access) lose the wrapper. (2) Every raw `<table>` in the batch is rewritten onto the shared `Table` by a tokenising transformer that preserves row and cell attributes. (3) The two `FormSection`s in the codebase are unified: `components/ui/form-field.tsx`'s becomes a re-export of the v3 one, so the dynamic config page's groups gain the gradient plate with no page edit. The Configuration index's 19 per-card gradients become the one band gradient.

**Tech Stack:** React 19, Tailwind v4, vitest 3 + Testing Library, a Python transformer run once (not committed). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md` (§4, Batch 4)

## Global Constraints

Identical to Batches 2–3: no new dependencies; light theme only; status colours untouched; no helper prose; **no behaviour change**; every `data-testid` / accessible name a test relies on preserved; touched test files individually by exit code; commits gated on exit codes with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer; main checkout, `data-layer`.

---

### Task 1: One `FormSection`

**Files:** `components/ui/form-section.tsx` (gain `columns: 3`, accept and IGNORE `description` for source compatibility with a comment saying why), `components/ui/form-field.tsx` (replace its local `FormSection` with `export { FormSection } from './form-section';`), test `components/ui/__tests__/form-section.test.tsx`.

- [ ] **Step 1: Failing cases** — `columns={3}` sets `data-columns="3"`; importing `FormSection` from `../form-field` renders `form-section-grid` (the re-export). Run → fail.
- [ ] **Step 2: Implement** as above. The old header (grey `h3`, optional description sentence) goes; the dynamic config page's groups now open with the gradient plate.
- [ ] **Step 3: Run** the test + `tsc` → 0. **Commit:** `refactor(ui): one FormSection — form-field re-exports the v3 primitive`.

### Task 2: Heroes everywhere

**Files:** the 18 plain-header pages listed by `grep -l "<PageHeader" routes/config/*.tsx routes/config/*/*.tsx routes/system-health/index.tsx routes/debug/index.tsx` minus the three inverted ones; plus `dynamic-config.tsx`, `help.tsx`, `role-access.tsx`.

- [ ] **Step 1: Failing test** — create `routes/config/__tests__/pages-hero.test.tsx` mounting the Configuration index, Password Policy, Date/Time, System Health and Debug pages under generic mocks (`swr` → `{ data: undefined, mutate }` for every key except what each page needs to render past its skeleton — read each page's early-return guards first), asserting each renders `page-hero` containing its h1. Add to `instrument-attributes.test.tsx`'s first case: `expect(screen.getByTestId('page-hero')).toBeInTheDocument();`. Run → fail.
- [ ] **Step 2: Mechanical pass** (script, run once): in each plain-header file, inside the `<PageHeader … />` block, delete the `description=` line, rename the tag to `<PageHero`, and swap the import (keep the `Breadcrumbs`/`PageHeader` import only if the file still uses it). For the six pages with a sibling beside the header (`access-matrix`, `action-reauth`, `datetime`, `ldap`, `notification-logs`, `debug`): remove the `flex … justify-between` wrapper and move the sibling into `actions=` (datetime and notification-logs have no sibling — just unwrap). Buttons inside the band take `className="border border-white/30 bg-white/10 text-white hover:bg-white/20"`; a primary Save takes `bg-white text-slate-900 hover:bg-white/90`; a status pill keeps its own colours (it is data).
- [ ] **Step 3: The three wrapped pages.** `dynamic-config.tsx`: `PageHeader` → `PageHero`, drop `description`, keep `actions`. `help.tsx`: the whole emerald gradient header `div` → `PageHero title="Help Articles" crumbs icon tiles={[{ label: 'Articles', value: articleList.length }]} actions={<Button className="bg-white text-slate-900 hover:bg-white/90" onClick={openCreate}>New Article</Button>}`; the back-arrow `Link` goes (the crumb is that hop). `role-access.tsx`: the violet gradient header `div` → `PageHero title="Role & Access Configuration" crumbs icon actions={renderHeaderActions()}`; the back-arrow `Link` goes.
- [ ] **Step 4: Run** the new test, `instrument-attributes.test.tsx`, `browser-tab-section.test.tsx`, `tsc` → 0. **Commit:** `feat(config,system): every configuration and system screen on PageHero`.

### Task 3: Tables onto the shared band

**Files:** `access-matrix.tsx`, `action-reauth.tsx`, `alarm-webhooks.tsx` (2 tables), `export-options.tsx`, `help.tsx`, `notification-rules/index.tsx`, `notification-settings/notification-logs.tsx`, `debug/index.tsx`.

- [ ] **Step 1:** Run the transformer (`scratchpad/table-transform.py`, tokenising — it walks each `<tr`/`<td`/`<th` tag to its real `>` tracking braces and quotes, so `onClick={() => …}` survives). It maps `<table …>`→`<Table>`, `<thead …>`→`<TableHeader>`, `<tbody …>`→`<TableBody>`, `<tr …attrs>`→`<TableRow …attrs>`, `<th …attrs>`→`<TableHead …attrs minus className>`, `<td …attrs>`→`<TableCell …attrs>`, and the closers; adds the import. Review each diff by eye for a `<table>` that was inside a `<Card>` with its own frame (drop the redundant wrapper only if it is a bare `overflow-x-auto` div).
- [ ] **Step 2:** `tsc` → 0; run the batch's tests → 0. **Commit:** `feat(config,system): eight tables onto the shared band`.

### Task 4: Configuration index and System Health

- [ ] `config/index.tsx` `ConfigCard`: the medallion `bg-gradient-to-br ${card.gradient}` → `style={{ background: 'var(--band-gradient)' }}` (the 19 per-card gradients were the thing the PageHeader comment called out); card ground `hover:bg-[var(--surface-tint-1)]`. `card.gradient` stays in the data (unused) so the card list does not need re-typing — note it in the component's comment. `system-health/index.tsx`: header already `meta`-capable → `PageHero` with the same `meta`.
- [ ] Run `pages-hero.test.tsx` + `tsc` → 0. **Commit:** `feat(config): index cards on the band gradient; System Health on PageHero`.

### Task 5: Verification, docs, push

- [ ] `tsc --noEmit` + `vite build` → 0; every test file named above individually → 0; `npm run check:contrast` still passes.
- [ ] `apps/web/CLAUDE.md`: a "Batch 4 — done" paragraph closing the UI v3 section (the design system is now on every screen; what stayed deliberately: the dashboard); `CHANGELOG.md`: `[Unreleased] - UI v3, Batch 4`. Commit `docs(ui): record UI v3 Batch 4`; push `data-layer`.
- [ ] Report: Configuration index, Roles & Access and Help first — the last two lose their own violet and emerald gradients for the theme band.
