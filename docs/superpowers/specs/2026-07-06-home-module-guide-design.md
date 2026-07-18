# Home — Module Workflow Guide (Design)

**Date:** 2026-07-06
**Branch:** RFID
**Status:** Approved (design), pending implementation plan

## Goal

Add a **Home** item to the sidebar that opens a read-only guide. The page
documents every sidebar module's functionality as a **flowchart of workflow
steps**, with the **role(s)** allowed to perform each step. It serves three
audiences at once: new-user onboarding, a role/permission overview, and a
21 CFR Part 11 compliance/architecture reference.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Purpose | All three: onboarding + role overview + compliance doc |
| Flow content | Workflow steps, with the acting role(s) on each step |
| Scope | Every sidebar module (~24) |
| Rendering | Data-driven vertical stepper — no new dependencies |
| Roles source | Static, **derived** from real permission data and baked in |
| Placement | Top sidebar item, route `/home`, visible to every authenticated user |
| Grouping | Modules grouped into categories |

## Non-goals (YAGNI)

- No live/dynamic role resolution at runtime (roles are baked at author time).
- No editing, no per-user customization, no persistence — pure read-only.
- No new charting/graph dependency (mermaid, reactflow, etc.).
- No swimlane layout.

## Content integrity — the compliance-critical requirement

Because auditor/compliance documentation is an explicit purpose, flow content
MUST be **derived from real code, not authored from memory**. A flowchart that
misstates who can do what, or invents a step order, is fabricated compliance
evidence and is worse than no page. "Static rendering" is NOT a license to
invent content.

Each step traces to real sources:

1. **Step → gate.** Each step carries a `gate` permission (e.g. `FILTER_OPERATE`)
   taken from `packages/shared/src/types/permission-tree.ts` (`PERMISSION_TREE`,
   the single source of truth for Sidebar→Page→Action→gate).
2. **Gate → roles.** The role list on each step is derived from which default
   roles actually hold that gate in `apps/api/prisma/default-roles.ts`, then
   baked into the catalog. So "Submit Checklist ▸ OPERATOR" is true by
   construction, not asserted.
3. **Sequence → real flow.** Step order comes from the actual module code
   (routes/services), e.g. the filter-operations sequence derives from
   `packages/shared/src/types/action-tape.ts` (7 action variants:
   ADVANCE_TO_STAGE / SUBMIT_CHECKLIST / SUBMIT_DRYER_READINGS /
   SET_DRYER_DURATION / BYPASS_STAGE / TERMINATE_CYCLE / COMPLETE_CYCLE) plus
   the pipeline flow — not intuition.

**Sourcing method:** dispatch parallel Explore agents (one per module or
category) to extract, per module: (a) the real action sequence from its
routes/service, and (b) the gate permission per action. Assemble the verified
output into the catalog. The per-step `gate` field is retained as provenance so
the derived role list is checkable and regenerable.

**Note baked into the page:** default roles are shown; **custom roles inherit
by their permissions** — if a custom role holds a step's gate permission, that
role can perform the step even though only default roles are drawn.

## Architecture

### Sidebar + routing

- New nav item `home` at the **top** of `allNavItems` in
  `apps/web/src/components/layout/sidebar.tsx` (above Dashboard), with a home
  icon and `href: '/home'`.
- In the `filteredItems` filter, add `if (item.id === 'home') return true;`
  **before** the `config.sidebarItems` override check, so the item is visible to
  every authenticated user and cannot be hidden by a role's custom sidebar
  configuration. (`isSidebarItemVisible('home', perms)` already returns `true`
  for any non-empty perms because `home` has no `PERMISSION_TREE` group, but the
  explicit early-return also defeats the per-role `config.sidebarItems` list.)
- `home` is deliberately **NOT** added to `packages/shared/src/types/sidebar-items.ts`
  (the configurable-items list) and **NOT** exposed in the role-config sidebar
  picker. It is ungated, non-configurable, always-on documentation.
- New route in `apps/web/src/main.tsx`: `<Route path="/home" element={<HomePage />} />`
  inside the `AppLayout` group, with **no `RequireRole`** wrapper (authenticated
  users only, no permission gate).

### Files

```
apps/web/src/routes/home/
  index.tsx          — HomePage: intro, table-of-contents, role legend, sections
  module-flows.ts    — typed catalog of ModuleFlow[] (the derived content)
  FlowChart.tsx      — generic vertical stepper renderer
  __tests__/module-flows.test.ts — catalog integrity tests
```

### Data model (`module-flows.ts`)

```ts
import type { Permission } from '@digilog/shared';

type StepKind = 'action' | 'decision' | 'system';

interface FlowStep {
  label: string;
  description?: string;
  gate?: Permission;                 // provenance — derives `roles`
  roles: string[];                   // baked, derived from default-roles.ts
  kind: StepKind;
  branch?: { label: string; roles: string[] };  // e.g. Bypass, Terminate
}

interface ModuleFlow {
  id: string;                        // matches a sidebar item id where possible
  title: string;
  icon?: string;
  category: 'Operations' | 'Governance & Compliance' | 'Admin' | 'Reports' | 'System';
  summary: string;                   // one-line "what it does"
  steps: FlowStep[];                 // thin modules may carry a single summary step
}

export const MODULE_FLOWS: ModuleFlow[];
```

Categories and their members (indicative — finalized during sourcing):

- **Operations** — Filter Operations, Cleaning Profiles, Checklists, Equipment
  Groups, PM Schedules, My Tasks, Filters, Retirement List, Replacement List.
- **Governance & Compliance** — Approvals, Stage Approvals, Report Reviews,
  Deviations, Audit Trail, Version History.
- **Admin** — Users, Admin Requests, Configuration, Notifications.
- **Reports** — Filter Cleaning Record, Filter Lifecycle Report,
  RFID Track Record, Quality Notifications.
- **System** — Dashboard, System Health, Debug Traces.

Thin modules (Dashboard, Notifications, Debug Traces, System Health) get a short
"what it does" card or a 1–2 step flow rather than a forced fake sequence.

### Rendering

- `HomePage` (`index.tsx`):
  - Intro paragraph + the "custom roles inherit by permissions" note.
  - **Table of contents** with jump links (needed for ~24 modules), grouped by
    category.
  - **Role legend** — one color chip + label per default role.
  - One `<section>` per module: title, icon, summary, then the `<FlowChart>`.
- `FlowChart` (`FlowChart.tsx`): generic vertical stepper.
  - Numbered step boxes connected by downward arrows.
  - Color-coded role badge(s) per step (colors from the role legend).
  - `decision` steps rendered distinctly (e.g. diamond/pill accent).
  - `branch` rendered as a side call-out off its step.
  - Light theme only: `bg-white` cards, `bg-slate-50` sections,
    `border-slate-200`; gradient section headers acceptable.
  - Responsive: single column, wraps cleanly on mobile.

## Testing

- `module-flows.test.ts` (vitest):
  - Every module has ≥1 step.
  - Every `gate` value is a real member of `PERMISSIONS`.
  - Every role string is a known default role.
  - No duplicate module ids.
- A render smoke test for `HomePage` / `FlowChart` (jsdom) — renders without
  throwing, shows each module title.
- Manual UI verification at the end: `/home` renders, sidebar item shows for a
  non-admin role, no console errors, no unstyled elements.

## Documentation sync (required by this change)

- `main.tsx` route count **76 → 77** — update every doc quoting the count
  (`CLAUDE.md`, `apps/web/CLAUDE.md`, and any other active-doc-set match found by
  the stale-count sweep).
- `allNavItems` grows by one — note in `apps/web/CLAUDE.md` if it quotes the
  sidebar item count.
- `CHANGELOG.md` entry for the new Home guide page.
- Run the stale-stat sweep: derive a regex from the previous counts and grep the
  active doc set; update every match.

## Risks / open points

- **Accuracy drift over time.** The baked roles reflect `default-roles.ts` at
  author time. If default role grants change later, the page can go stale. The
  `gate` provenance field makes regeneration mechanical; a future follow-up
  could derive roles live. Documented as a known limitation, not solved now.
- **Sourcing 24 modules accurately** is the main effort and the main risk;
  mitigated by the parallel-agent extraction + the integrity tests.
