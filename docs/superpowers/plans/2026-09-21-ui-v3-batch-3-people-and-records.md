# UI v3 — Batch 3: people and records — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Users (list, create, edit, reset requests), Admin Requests, Notifications, Audit Trail, Reports and Profile on the Batch 1 primitives.

**Architecture:** As in Batch 2 — each screen's hand-built header, stat row and table header is replaced by `PageHero`, `StatCard`, `Toolbar` and the shared `Table`; data flow, mutations, gates and every existing test are untouched. Pages that had no render test get one that pins the new shape.

**Tech Stack:** React 19, Tailwind v4, vitest 3 + Testing Library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md` (§4, Batch 3)

## Global Constraints

Identical to Batch 2: no new dependencies; light theme only; status colours untouched; no helper prose (every replaced header's `description` is dropped); **no behaviour change**; every `data-testid` / accessible name a test relies on preserved; touched test files run individually by exit code; commits gated on exit codes with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer; main checkout, `data-layer`.

---

## File structure

| File | Change |
|---|---|
| `routes/users/list.tsx` | header row → `PageHero` (the two buttons as `actions`); `UserStatsBar` → four `StatCard`s |
| `routes/users/components/user-stats-bar.tsx` | rewritten on `StatCard` (same props) |
| `routes/users/create.tsx`, `reset-requests.tsx` | header row → `PageHero` (Back as `actions`); reset history table → shared `Table` |
| `routes/users/edit.tsx` | crumbs + identity block → `PageHero` (title = full name, `meta` = the badges and username) |
| `routes/users/__tests__/pages-render.test.tsx` (new) | mounts list, create, reset-requests |
| `routes/admin-requests/index.tsx` | header strip → `PageHero` with `Toolbar` search inside; stat buttons on status tokens; table → shared `Table` |
| `routes/notifications/index.tsx` | header row → `PageHero` (Mark all as `actions`) |
| `routes/audit/index.tsx` | header row → `PageHero` (`tiles` = Total records, `actions` = export) |
| `routes/reports/index.tsx` | `PageHeader` → `PageHero`; table header → shared band |
| `routes/profile/index.tsx` | identity card's cover → `--band-gradient` |
| `apps/web/CLAUDE.md`, `CHANGELOG.md` | record the batch |

---

### Task 1: Users list + stats

- [ ] **Step 1: Failing test** — create `routes/users/__tests__/pages-render.test.tsx`. Read `users/list.tsx` lines 1–60 for its hooks (`useSWR` keys for `/api/users`, `/api/users/stats`, `/api/roles`, pending reset count; `useCan`; `useAuth`; pagination) and mock each the way `settings-page.test.tsx` does. First case:

```tsx
  it('Users list opens with the hero band carrying Create User, and four StatCards', () => {
    mountList();
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('link', { name: /create user/i }))).toBe(true);
    expect(screen.getAllByTestId('stat-card')).toHaveLength(4);
    expect(screen.getByText('Total users')).toBeInTheDocument();
  });
```
Run → fails (no `page-hero`).

- [ ] **Step 2: `user-stats-bar.tsx`** — replace the body with four `StatCard`s in a `grid grid-cols-2 gap-4 xl:grid-cols-4`: `{ eyebrow: 'Total users', value: stats.total, tone: 'neutral' }`, `{ 'Active', stats.enabled, 'ok' }`, `{ 'Locked', stats.locked, 'warn' }`, `{ 'Disabled', stats.disabled, 'danger' }`, each with its existing svg as `icon` (the paths are in the current file). Props unchanged.

- [ ] **Step 3: `list.tsx`** — replace the `<div className="flex items-center justify-between">` … `</div>` that wraps `PageHeader` and the button group with `<PageHero title="User Management" crumbs={…same…} icon={…same…} actions={<>…the two Links exactly as they are…</>} />`; drop `description`. Import `PageHero`, drop `PageHeader`.

- [ ] **Step 4: Run** the new test + `tsc` → 0. **Commit:** `feat(users): list on PageHero; stats as StatCards`.

### Task 2: Users create, edit, reset requests

- [ ] **Step 1: Failing cases** in `pages-render.test.tsx`: create (`/users/create`) renders `page-hero` containing the "Back to Users" link; reset-requests (`/users/reset-requests`, mock `/api/users/reset-requests*` with one processed row) renders `page-hero` and a `thead[data-band="gradient"]`; edit (`/users/u-1`, mock `/api/users/u-1` with `fullName: 'Ada Lovelace'`, `username: 'ada'`, `status: 'ACTIVE'`, `role: 'OPERATOR'`) renders `page-hero` whose h1 is `Ada Lovelace`. Run → all three fail.

- [ ] **Step 2: `create.tsx`, `reset-requests.tsx`** — the header `<div className="flex items-center justify-between">` … `</div>` → `PageHero` with the same `title`/`crumbs`/`icon`, `actions={<Link to="/users"><Button className="border border-white/30 bg-white/10 text-white hover:bg-white/20">Back to Users</Button></Link>}`; drop `description`. In `reset-requests.tsx` the history `<table className="tbl w-full">` → `Table`/`TableHeader`/`TableHead`/`TableBody`/`TableRow`/`TableCell` (same mechanical mapping as the instrument list in Batch 2: header `<th className="…">X</th>` → `<TableHead>X</TableHead>`, rows `<tr …>` → `<TableRow>`, `<td className="py-4 px-4">` → `<TableCell>`).

- [ ] **Step 3: `edit.tsx`** — `<Breadcrumbs …/>` + the `<div className="flex items-center justify-between">` identity block → `PageHero title={userData.fullName} crumbs={…same three…} icon={<span className="font-bold">{initials}</span>} meta={<><Badge …status…/>{isDirectoryUser && <Badge …>Active Directory</Badge>}<span className="font-mono text-[0.8125rem] text-white/80">@{userData.username}</span>{isDirectoryUser && userData.ldapDn && <span className="font-mono text-xs text-white/60 break-all">{userData.ldapDn}</span>}</>} actions={<Link to="/users"><Button className="border border-white/30 bg-white/10 text-white hover:bg-white/20">Back to Users</Button></Link>} />` where `initials` is the existing expression. Drop `Breadcrumbs` import.

- [ ] **Step 4: Run** the test file + `tsc` → 0. **Commit:** `feat(users): create, edit and reset requests on PageHero; reset history on the shared table`.

### Task 3: Admin Requests

- [ ] **Step 1: Failing assertion** — in `admin-requests/__tests__/keyboard-access.test.tsx`'s first case add `expect(screen.getByTestId('page-hero').contains(screen.getByRole('textbox', { name: 'Search requests' }))).toBe(true);`. Run → fails.

- [ ] **Step 2:** In `index.tsx` replace the header strip `<div className="px-6 pt-5 pb-4 border-b …">` up to and including its search `<div className="relative w-full sm:w-72">…</div>` and the wrapping `flex … justify-between` div with:

```tsx
      <PageHero
        className="mx-6 mt-5"
        title="Admin Requests"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Admin Requests' }]}
        icon={/* existing svg */}
      >
        <Toolbar
          className="border-0 bg-transparent p-0 shadow-none"
          search={{ name: 'admin-request-search', label: 'Search requests', placeholder: 'Search requester or ID…', value: search, onChange: setSearch }}
        />
      </PageHero>
```
The stat/filter card grid stays where it is but its wrapper becomes `<div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 py-4">`; in `STAT_ACCENTS` (read it) switch the four accents' `iconBg` / `ring` to the status tokens (`bg-[var(--status-info-dot)] text-white` / `ring-[var(--status-info-dot)]` etc., `all` = neutral `bg-[var(--theme-primary,#2a78d6)]`). The table `<table className="tbl w-full"><thead className="sticky top-0 z-10"><tr className="bg-slate-50 …">{[…].map(h => <th …>)}` → `<Table><TableHeader><tr>{[…].map((h, i) => <TableHead key={i} scope={h ? 'col' : undefined}>{h}</TableHead>)}</tr></TableHeader><TableBody>` … `</TableBody></Table>`; rows `<tr …>` → `<TableRow …>` keeping their classNames, `<td className="px-5 py-4 …">` → `<TableCell className="…">`.

- [ ] **Step 3: Run** `keyboard-access.test.tsx` + `tsc` → 0. **Commit:** `feat(admin-requests): PageHero with the search inside, status-token cards, shared table`.

### Task 4: Notifications, Audit, Reports, Profile

- [ ] **Step 1: Failing assertions** — `reports-page.test.tsx` line ~80: add `expect(screen.getByTestId('page-hero')).toBeInTheDocument();` and `expect(document.querySelector('thead')).toHaveAttribute('data-band', 'gradient');`. Notifications and Audit have no page render test: add `routes/notifications/__tests__/page-render.test.tsx` and `routes/audit/__tests__/page-render.test.tsx`, each mounting the page with `swr`, `use-can`, `use-auth`, `use-toast`, `use-datetime-format` mocked and asserting `page-hero` contains the h1 (Audit: mock `/api/config/report-labels*` if the title hook reads it; read `audit/index.tsx` imports first). Run → fail.

- [ ] **Step 2: `notifications/index.tsx`** — header row → `PageHero title="Notifications" crumbs icon actions={data?.unreadCount > 0 && can('notifications.mark') && <Button onClick={markAllAsRead} className="border border-white/30 bg-white/10 text-white hover:bg-white/20">Mark All as Read</Button>}`.

- [ ] **Step 3: `audit/index.tsx`** — header row (PageHeader + the total + export group) → `PageHero title={auditL.title} crumbs icon tiles={data ? [{ label: 'Total records', value: data.total.toLocaleString() }] : undefined} actions={canExport && (data?.data?.length ?? 0) > 0 && <ExportMenu surface="audit" onExportPdf={exportPdf} onExportExcel={exportExcel} busy={downloading} />}`; drop `description` ("21 CFR Part 11 Compliant Activity Log" — the sidebar's compliance line already states it).

- [ ] **Step 4: `reports/index.tsx`** — `PageHeader` → `PageHero` (drop description); the `<table className="w-full border-collapse"><thead><tr style={{ backgroundColor: 'color-mix(…)' }}>` → `<Table><TableHeader><tr>` with `<TableHead scope="col">` cells (drop the `th` class const if unused), body rows → `TableRow`/`TableCell`; keep the row's `data-testid`s.

- [ ] **Step 5: `profile/index.tsx`** — the identity card's cover element (read lines ~170–200; it is the `div` above the avatar with a gradient `style` or `bg-gradient-*` class) → `style={{ background: 'var(--band-gradient)' }}`.

- [ ] **Step 6: Run** `reports-page.test.tsx`, the two new render tests, `audit-table.test.tsx`, `template-placeholders.test.ts` + `tsc` → 0. **Commit:** `feat(notifications,audit,reports,profile): PageHero; shared table band`.

### Task 5: Verification, docs, push

- [ ] `tsc --noEmit` + `vite build` → 0; every test file named above individually → 0.
- [ ] `apps/web/CLAUDE.md`: a "Batch 3" paragraph under UI v3; `CHANGELOG.md`: `[Unreleased] - UI v3, Batch 3`. Commit `docs(ui): record UI v3 Batch 3`; push `data-layer`.
- [ ] Report: Users and Admin Requests first.
