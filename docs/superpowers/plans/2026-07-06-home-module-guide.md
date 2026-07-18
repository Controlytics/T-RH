# Home — Module Workflow Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only **Home** page (`/home`), reachable from a top-of-sidebar item visible to every authenticated user, that documents every sidebar module as a vertical-stepper flowchart with the role(s) allowed at each step.

**Architecture:** A typed content catalog (`MODULE_FLOWS`) drives a generic React/Tailwind stepper (`FlowChart`). Each step names its backend permission `gate`; the role list per step is **computed** from an embedded default-role→permission map (`deriveRolesForGate`) that is drift-guarded against `apps/api/prisma/default-roles.ts`. No new dependencies.

**Tech Stack:** React 19, Vite 6, Tailwind CSS, TypeScript, vitest (jsdom), `@digilog/shared` (`PERMISSIONS`, `Permission`, `PERMISSION_TREE`).

## Global Constraints

- Light theme only — `bg-white` cards, `bg-slate-50` sections, `border-slate-200`; gradient section headers OK. No dark theme.
- No new npm dependencies.
- No `RequireRole` gate on `/home` — authenticated users only.
- The `home` sidebar item is NOT added to `packages/shared/src/types/sidebar-items.ts` and NOT exposed in the role-config sidebar picker.
- Content must be derived from real code, never invented. Each step carries a `gate: Permission[]` traceable to `PERMISSION_TREE`; roles come from `deriveRolesForGate`, never hand-typed.
- After any edit to `packages/shared`, run `npm run build -w @digilog/shared` before testing web.
- Web unit tests: `cd apps/web && npx vitest run <file>`.
- Commit after each task. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

```
apps/web/src/routes/home/
  index.tsx            — HomePage: intro, TOC, role legend, one <section> per module
  module-flows.ts      — MODULE_FLOWS: ModuleFlow[] (the derived content catalog)
  role-gates.ts        — DEFAULT_ROLE_PERMISSIONS map + deriveRolesForGate() + ROLE_META
  types.ts             — FlowStep, ModuleFlow, StepKind interfaces
  FlowChart.tsx        — generic vertical stepper renderer
  __tests__/role-gates.test.ts       — deriveRolesForGate + drift guard vs default-roles.ts
  __tests__/module-flows.test.ts     — catalog integrity (gates real, no dup ids, ≥1 step)
  __tests__/FlowChart.test.tsx       — render smoke test
apps/web/src/components/layout/sidebar.tsx   — add `home` nav item + always-visible early return
apps/web/src/main.tsx                        — add <Route path="/home">
```

---

## Task 1: Sidebar item + route + placeholder page

**Files:**
- Create: `apps/web/src/routes/home/index.tsx`
- Modify: `apps/web/src/components/layout/sidebar.tsx` (add nav item + filter early-return)
- Modify: `apps/web/src/main.tsx` (add route + import)

**Interfaces:**
- Produces: `HomePage` default export at `apps/web/src/routes/home/index.tsx`; route `/home`; sidebar item id `home`.

- [ ] **Step 1: Create the placeholder page**

Create `apps/web/src/routes/home/index.tsx`:

```tsx
export default function HomePage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-slate-800">Module Guide</h1>
      <p className="mt-2 text-slate-600">
        Workflow flowcharts for every module, with the roles allowed at each step.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Add the `home` nav item to the sidebar**

In `apps/web/src/components/layout/sidebar.tsx`, add as the FIRST element of the `allNavItems` array (before the `dashboard` item at line ~24):

```tsx
  {
    id: 'home',
    label: 'Home',
    href: '/home',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 12l8.954-8.955a1.5 1.5 0 012.122 0L22.28 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" />
      </svg>
    ),
  },
```

- [ ] **Step 3: Make `home` always visible in the sidebar filter**

In `apps/web/src/components/layout/sidebar.tsx`, inside the `allNavItems.filter((item) => { ... })` callback (starts ~line 260), add this as the FIRST line of the callback body, before the `SUPER_ADMIN` check:

```tsx
    // Home is ungated documentation — always visible, and cannot be hidden by a
    // role's custom sidebarItems config.
    if (item.id === 'home') return true;
```

- [ ] **Step 4: Register the route**

In `apps/web/src/main.tsx`, add the import near the other route imports (top of file, with the eager imports — HomePage is light, no lazy needed):

```tsx
import HomePage from './routes/home';
```

Then add the route inside the `AppLayout` group, immediately after the dashboard route `<Route path="/" element={<DashboardPage />} />` (~line 179):

```tsx
            <Route path="/home" element={<HomePage />} />
```

- [ ] **Step 5: Verify build + manual render**

Run: `cd apps/web && npx vite build`
Expected: build succeeds, no TS errors.

Manual: `cd apps/web && npx vite --host`, open http://localhost:5175/home while logged in → placeholder renders; the **Home** item appears at the top of the sidebar. Log in as a non-admin (e.g. OPERATOR) → Home still shows.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/home/index.tsx apps/web/src/components/layout/sidebar.tsx apps/web/src/main.tsx
git commit -m "feat(home): add Home sidebar item + /home route with placeholder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Role-gate derivation + drift guard

**Files:**
- Create: `apps/web/src/routes/home/role-gates.ts`
- Test: `apps/web/src/routes/home/__tests__/role-gates.test.ts`

**Interfaces:**
- Produces:
  - `deriveRolesForGate(gate: Permission[]): string[]` — union of default role names holding ANY permission in `gate`, in hierarchy order (SUPER_ADMIN → VIEWER). Empty `gate` → `[]`.
  - `DEFAULT_ROLE_PERMISSIONS: Record<string, readonly Permission[]>` — embedded copy of `apps/api/prisma/default-roles.ts` role permissions.
  - `ROLE_META: { name: string; displayName: string; badgeClass: string }[]` in hierarchy order — for the legend + badges.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/routes/home/__tests__/role-gates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveRolesForGate, DEFAULT_ROLE_PERMISSIONS, ROLE_META } from '../role-gates';
// Cross-workspace drift guard: the embedded map MUST match the real seed source.
import { defaultRoles } from '../../../../../api/prisma/default-roles';

describe('deriveRolesForGate', () => {
  it('returns roles that hold the gate, in hierarchy order', () => {
    // FILTER_OPERATE is held by all 5 operational roles (not VIEWER).
    expect(deriveRolesForGate(['FILTER_OPERATE'])).toEqual([
      'SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'MAINTENANCE', 'OPERATOR',
    ]);
  });

  it('FILTER_BYPASS is admin-only', () => {
    expect(deriveRolesForGate(['FILTER_BYPASS'])).toEqual(['SUPER_ADMIN', 'ADMIN']);
  });

  it('STAGE_APPROVAL_DECIDE includes supervisor', () => {
    expect(deriveRolesForGate(['STAGE_APPROVAL_DECIDE'])).toEqual([
      'SUPER_ADMIN', 'ADMIN', 'SUPERVISOR',
    ]);
  });

  it('unions across multiple gate permissions without duplicates', () => {
    const r = deriveRolesForGate(['FILTER_BYPASS', 'FILTER_OPERATE']);
    expect(r).toEqual(['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'MAINTENANCE', 'OPERATOR']);
  });

  it('empty gate → empty list', () => {
    expect(deriveRolesForGate([])).toEqual([]);
  });
});

describe('DEFAULT_ROLE_PERMISSIONS drift guard', () => {
  it('matches apps/api/prisma/default-roles.ts exactly', () => {
    for (const role of defaultRoles) {
      expect(new Set(DEFAULT_ROLE_PERMISSIONS[role.name])).toEqual(new Set(role.permissions));
    }
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual(
      defaultRoles.map((r) => r.name).sort(),
    );
  });
});

describe('ROLE_META', () => {
  it('lists all six roles in hierarchy order', () => {
    expect(ROLE_META.map((m) => m.name)).toEqual([
      'SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'MAINTENANCE', 'OPERATOR', 'VIEWER',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/home/__tests__/role-gates.test.ts`
Expected: FAIL — cannot resolve `../role-gates`.

- [ ] **Step 3: Implement `role-gates.ts`**

Create `apps/web/src/routes/home/role-gates.ts`. **Copy each role's `permissions` array verbatim from `apps/api/prisma/default-roles.ts`** (the drift-guard test enforces exact equality — if you paraphrase, it fails):

```ts
import type { Permission } from '@digilog/shared';

/**
 * Embedded copy of the default-role → permissions map from
 * apps/api/prisma/default-roles.ts. The web app can't import across the
 * workspace at runtime, so this is duplicated and kept honest by the drift
 * guard in __tests__/role-gates.test.ts (asserts exact set-equality).
 *
 * WHEN default-roles.ts CHANGES: update this map, or the drift test fails.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  SUPER_ADMIN: [
    'USER_CREATE','USER_READ','USER_UPDATE','USER_DELETE','USER_ENABLE_DISABLE','USER_UNLOCK','USER_RESET_PASSWORD',
    'ADMIN_REQUEST_APPROVE','ADMIN_REQUEST_REJECT',
    'CONFIG_READ','CONFIG_UPDATE','FIELD_ID_UPDATE',
    'AUDIT_READ','AUDIT_EXPORT','ROLE_MANAGE',
    'ASSET_CREATE','ASSET_UPDATE','ASSET_DELETE',
    'ASSET_IDENTIFIER_CREATE','ASSET_IDENTIFIER_DELETE','ASSET_VIEW','ASSET_READ',
    'DASHBOARD_CREATE','DASHBOARD_MANAGE','DASHBOARD_VIEW','DASHBOARD_ASSIGN',
    'NOTIFICATION_VIEW','NOTIFICATION_CREATE','NOTIFICATION_UPDATE','NOTIFICATION_DELETE','NOTIFICATION_MANAGE',
    'BACKUP_MANAGE','BACKUP_RESTORE',
    'FILTER_OPERATE','FILTER_BYPASS','CHECKLIST_SUBMIT','EVENT_READ',
    'FILTER_CREATE','FILTER_EDIT','FILTER_DELETE','FILTER_BULK_UPLOAD','FILTER_RETIRE','FILTER_REPLACE','FILTER_STATUS_UPDATE',
    'FILTER_HIERARCHY_CREATE','FILTER_HIERARCHY_EDIT','FILTER_HIERARCHY_DELETE','FILTER_RFID_MANAGE',
    'FCP_READ','FCP_CREATE','FCP_UPDATE','FCP_DELETE',
    'FP_READ','FP_CREATE','FP_UPDATE','FP_DELETE','FP_ASSIGN',
    'PM_READ','PM_CREATE','PM_UPDATE','PM_DELETE','PM_EXECUTE','PM_APPROVE',
    'CYCLE_READ','READ_DEBUG_TRACE','MANAGE_DEBUG_TRACE',
    'BLOCK_CHANGE_REQUEST','BLOCK_CHANGE_APPROVE',
    'REPORT_GENERATE','REPORT_EXPORT',
    'REPORT_REVIEW_SUBMIT','REPORT_REVIEW','REPORT_APPROVE',
    'STAGE_APPROVAL_VIEW','STAGE_APPROVAL_DECIDE',
    'VERSION_HISTORY_VIEW',
  ] as Permission[],
  ADMIN: [
    'USER_CREATE','USER_READ','USER_UPDATE','USER_ENABLE_DISABLE','USER_UNLOCK','USER_RESET_PASSWORD',
    'ADMIN_REQUEST_APPROVE','ADMIN_REQUEST_REJECT',
    'CONFIG_READ','CONFIG_UPDATE','FIELD_ID_UPDATE','ROLE_MANAGE',
    'AUDIT_READ','AUDIT_EXPORT',
    'ASSET_CREATE','ASSET_UPDATE','ASSET_DELETE',
    'ASSET_IDENTIFIER_CREATE','ASSET_IDENTIFIER_DELETE','ASSET_VIEW','ASSET_READ',
    'DASHBOARD_CREATE','DASHBOARD_MANAGE','DASHBOARD_VIEW','DASHBOARD_ASSIGN',
    'NOTIFICATION_VIEW','NOTIFICATION_CREATE','NOTIFICATION_UPDATE','NOTIFICATION_MANAGE',
    'BACKUP_MANAGE','BACKUP_RESTORE',
    'FILTER_OPERATE','FILTER_BYPASS','CHECKLIST_SUBMIT','EVENT_READ',
    'FILTER_CREATE','FILTER_EDIT','FILTER_DELETE','FILTER_BULK_UPLOAD','FILTER_RETIRE','FILTER_REPLACE','FILTER_STATUS_UPDATE',
    'FILTER_HIERARCHY_CREATE','FILTER_HIERARCHY_EDIT','FILTER_HIERARCHY_DELETE','FILTER_RFID_MANAGE',
    'FCP_READ','FCP_CREATE','FCP_UPDATE','FCP_DELETE',
    'FP_READ','FP_CREATE','FP_UPDATE','FP_DELETE','FP_ASSIGN',
    'PM_READ','PM_CREATE','PM_UPDATE','PM_EXECUTE','PM_APPROVE',
    'CYCLE_READ','READ_DEBUG_TRACE','MANAGE_DEBUG_TRACE',
    'BLOCK_CHANGE_REQUEST','BLOCK_CHANGE_APPROVE',
    'REPORT_GENERATE','REPORT_EXPORT',
    'REPORT_REVIEW_SUBMIT','REPORT_REVIEW','REPORT_APPROVE',
    'STAGE_APPROVAL_VIEW','STAGE_APPROVAL_DECIDE',
  ] as Permission[],
  SUPERVISOR: [
    'AUDIT_READ',
    'ASSET_VIEW','ASSET_READ','ASSET_CREATE',
    'DASHBOARD_VIEW',
    'FILTER_OPERATE','CHECKLIST_SUBMIT','EVENT_READ',
    'FILTER_CREATE','FILTER_EDIT',
    'FCP_READ','FP_READ','PM_READ','CYCLE_READ',
    'BLOCK_CHANGE_REQUEST',
    'STAGE_APPROVAL_VIEW','STAGE_APPROVAL_DECIDE',
    'REPORT_GENERATE','REPORT_EXPORT',
  ] as Permission[],
  MAINTENANCE: [
    'AUDIT_READ',
    'ASSET_VIEW','ASSET_READ','ASSET_CREATE','ASSET_UPDATE',
    'DASHBOARD_VIEW',
    'FILTER_OPERATE','CHECKLIST_SUBMIT','EVENT_READ',
    'FCP_READ','FP_READ','PM_READ','CYCLE_READ',
    'BLOCK_CHANGE_REQUEST',
    'REPORT_GENERATE','REPORT_EXPORT',
  ] as Permission[],
  OPERATOR: [
    'AUDIT_READ',
    'ASSET_VIEW','ASSET_READ',
    'DASHBOARD_VIEW',
    'FILTER_OPERATE','CHECKLIST_SUBMIT','EVENT_READ',
    'FCP_READ','FP_READ','PM_READ','CYCLE_READ',
    'BLOCK_CHANGE_REQUEST',
  ] as Permission[],
  VIEWER: [
    'AUDIT_READ',
    'ASSET_VIEW','ASSET_READ',
    'DASHBOARD_VIEW',
  ] as Permission[],
};

/** Roles in hierarchy order (highest → lowest). Drives legend + derivation order. */
export const ROLE_META: { name: string; displayName: string; badgeClass: string }[] = [
  { name: 'SUPER_ADMIN', displayName: 'Super Admin', badgeClass: 'bg-red-100 text-red-700 border-red-200' },
  { name: 'ADMIN',       displayName: 'Admin',       badgeClass: 'bg-purple-100 text-purple-700 border-purple-200' },
  { name: 'SUPERVISOR',  displayName: 'Supervisor',  badgeClass: 'bg-blue-100 text-blue-700 border-blue-200' },
  { name: 'MAINTENANCE', displayName: 'Maintenance', badgeClass: 'bg-amber-100 text-amber-700 border-amber-200' },
  { name: 'OPERATOR',    displayName: 'Operator',    badgeClass: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { name: 'VIEWER',      displayName: 'Viewer',      badgeClass: 'bg-slate-100 text-slate-600 border-slate-200' },
];

/**
 * Default role names that hold ANY of the given gate permissions, returned in
 * hierarchy order. Mirrors requireAnyPermission semantics. Empty gate → [].
 */
export function deriveRolesForGate(gate: Permission[]): string[] {
  if (gate.length === 0) return [];
  return ROLE_META
    .map((m) => m.name)
    .filter((name) => {
      const held = DEFAULT_ROLE_PERMISSIONS[name] ?? [];
      return gate.some((g) => held.includes(g));
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/routes/home/__tests__/role-gates.test.ts`
Expected: PASS (all cases green, drift guard green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/home/role-gates.ts apps/web/src/routes/home/__tests__/role-gates.test.ts
git commit -m "feat(home): role-gate derivation with drift guard vs default-roles.ts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Content types + FlowChart renderer

**Files:**
- Create: `apps/web/src/routes/home/types.ts`
- Create: `apps/web/src/routes/home/FlowChart.tsx`
- Test: `apps/web/src/routes/home/__tests__/FlowChart.test.tsx`

**Interfaces:**
- Consumes: `deriveRolesForGate`, `ROLE_META` from `role-gates.ts`; `Permission` from `@digilog/shared`.
- Produces:
  - `types.ts`: `StepKind = 'action' | 'decision' | 'system'`; `FlowStep`, `ModuleFlow`, `ModuleCategory` interfaces.
  - `FlowChart.tsx`: `export function FlowChart({ steps }: { steps: FlowStep[] })`.

- [ ] **Step 1: Create the type definitions**

Create `apps/web/src/routes/home/types.ts`:

```ts
import type { Permission } from '@digilog/shared';

export type StepKind = 'action' | 'decision' | 'system';

export type ModuleCategory =
  | 'Operations'
  | 'Governance & Compliance'
  | 'Admin'
  | 'Reports'
  | 'System';

export interface FlowStep {
  label: string;
  description?: string;
  /** Backend permission gate (requireAnyPermission semantics). [] = no gate / read-only. */
  gate: Permission[];
  kind: StepKind;
  /** Optional side-branch (e.g. Bypass, Terminate). */
  branch?: { label: string; gate: Permission[] };
}

export interface ModuleFlow {
  /** Matches a sidebar item id where one exists. Unique across the catalog. */
  id: string;
  title: string;
  category: ModuleCategory;
  /** One-line "what it does". */
  summary: string;
  steps: FlowStep[];
}
```

- [ ] **Step 2: Write the failing render test**

Create `apps/web/src/routes/home/__tests__/FlowChart.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlowChart } from '../FlowChart';
import type { FlowStep } from '../types';

const steps: FlowStep[] = [
  { label: 'Start Cycle', gate: ['FILTER_OPERATE'], kind: 'action' },
  { label: 'Submit Checklist', gate: ['FILTER_OPERATE'], kind: 'action',
    branch: { label: 'Bypass (deviation)', gate: ['FILTER_BYPASS'] } },
];

describe('FlowChart', () => {
  it('renders each step label', () => {
    render(<FlowChart steps={steps} />);
    expect(screen.getByText('Start Cycle')).toBeInTheDocument();
    expect(screen.getByText('Submit Checklist')).toBeInTheDocument();
  });

  it('renders derived role badges for a step (OPERATOR holds FILTER_OPERATE)', () => {
    render(<FlowChart steps={steps} />);
    expect(screen.getAllByText('Operator').length).toBeGreaterThan(0);
  });

  it('renders the branch label', () => {
    render(<FlowChart steps={steps} />);
    expect(screen.getByText('Bypass (deviation)')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/home/__tests__/FlowChart.test.tsx`
Expected: FAIL — cannot resolve `../FlowChart`.

- [ ] **Step 4: Implement `FlowChart.tsx`**

Create `apps/web/src/routes/home/FlowChart.tsx`:

```tsx
import type { Permission } from '@digilog/shared';
import type { FlowStep } from './types';
import { deriveRolesForGate, ROLE_META } from './role-gates';

function RoleBadges({ gate }: { gate: Permission[] }) {
  const roles = deriveRolesForGate(gate);
  if (roles.length === 0) {
    return <span className="text-xs text-slate-400 italic">any user</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((name) => {
        const meta = ROLE_META.find((m) => m.name === name)!;
        return (
          <span
            key={name}
            className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badgeClass}`}
          >
            {meta.displayName}
          </span>
        );
      })}
    </div>
  );
}

export function FlowChart({ steps }: { steps: FlowStep[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((step, i) => (
        <li key={i} className="relative">
          <div className="flex items-start gap-3">
            {/* index bubble + connector */}
            <div className="flex flex-col items-center">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                  step.kind === 'decision'
                    ? 'border-amber-300 bg-amber-50 text-amber-700'
                    : step.kind === 'system'
                      ? 'border-slate-300 bg-slate-50 text-slate-500'
                      : 'border-slate-300 bg-white text-slate-700'
                }`}
              >
                {i + 1}
              </span>
              {i < steps.length - 1 && <span className="w-px flex-1 bg-slate-200 min-h-6" />}
            </div>
            {/* step card */}
            <div className="flex-1 pb-5">
              <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">{step.label}</span>
                  <RoleBadges gate={step.gate} />
                </div>
                {step.description && (
                  <p className="mt-1 text-sm text-slate-500">{step.description}</p>
                )}
                {step.branch && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-2 py-1.5">
                    <span className="text-xs font-medium text-slate-600">⤷ {step.branch.label}</span>
                    <RoleBadges gate={step.branch.gate} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/routes/home/__tests__/FlowChart.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/home/types.ts apps/web/src/routes/home/FlowChart.tsx apps/web/src/routes/home/__tests__/FlowChart.test.tsx
git commit -m "feat(home): content types + FlowChart vertical-stepper renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Catalog scaffold + HomePage assembly

**Files:**
- Create: `apps/web/src/routes/home/module-flows.ts`
- Modify: `apps/web/src/routes/home/index.tsx` (replace placeholder with full page)
- Test: `apps/web/src/routes/home/__tests__/module-flows.test.ts`

**Interfaces:**
- Consumes: `ModuleFlow`, `ModuleCategory` from `types.ts`; `FlowChart`, `ROLE_META` from siblings.
- Produces: `MODULE_FLOWS: ModuleFlow[]` (seeded with Filter Operations only; grows in Tasks 5–9); `CATEGORY_ORDER: ModuleCategory[]`.

- [ ] **Step 1: Create the catalog seeded with one verified module**

Create `apps/web/src/routes/home/module-flows.ts`. The Filter Operations sequence below is derived from `packages/shared/src/types/action-tape.ts` (7 action variants) + the pipeline flow in `CLAUDE.md` (WASH → DRY → STORAGE, checklist gates advance, bypass = deviation, terminate with reason). Gates trace to `PERMISSION_TREE` / `default-roles.ts`:

```ts
import type { ModuleFlow, ModuleCategory } from './types';

export const CATEGORY_ORDER: ModuleCategory[] = [
  'Operations', 'Governance & Compliance', 'Admin', 'Reports', 'System',
];

export const MODULE_FLOWS: ModuleFlow[] = [
  {
    id: 'filter-operations',
    title: 'Filter Operations',
    category: 'Operations',
    summary: 'Run a filter through its cleaning cycle: start, wash, dry, store, with checklists gating each advance.',
    steps: [
      { label: 'Start Cleaning Cycle', kind: 'action', gate: ['FILTER_OPERATE'],
        description: 'Select a cleaning reason and profile; profile is locked for the whole cycle.' },
      { label: 'Wash In / Wash Out', kind: 'action', gate: ['FILTER_OPERATE'] },
      { label: 'Submit Checklist', kind: 'decision', gate: ['FILTER_OPERATE'],
        description: 'Server blocks advance until the pending checklist is complete.',
        branch: { label: 'Bypass stage (records a deviation)', gate: ['FILTER_BYPASS'] } },
      { label: 'Dry In → set duration → Dry Out', kind: 'action', gate: ['FILTER_OPERATE'],
        description: 'Dryer duration is set and a countdown runs before Dry Out.' },
      { label: 'Storage In / Storage Out', kind: 'action', gate: ['FILTER_OPERATE'] },
      { label: 'Cycle auto-completes at the last stage', kind: 'system', gate: [],
        description: 'When the final STAGE leads to the END node the cycle closes automatically.',
        // Terminate is available throughout as an operator-initiated branch.
      },
      { label: 'Terminate cycle early (with reason)', kind: 'decision', gate: ['FILTER_OPERATE'],
        description: 'Optional off-ramp at any point; requires a reason.' },
    ],
  },
];
```

- [ ] **Step 2: Write the failing integrity + page test**

Create `apps/web/src/routes/home/__tests__/module-flows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MODULE_FLOWS, CATEGORY_ORDER } from '../module-flows';
import { PERMISSIONS } from '@digilog/shared';

const ALL_PERMS = new Set(Object.values(PERMISSIONS));

describe('MODULE_FLOWS integrity', () => {
  it('has no duplicate module ids', () => {
    const ids = MODULE_FLOWS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every module has at least one step', () => {
    for (const m of MODULE_FLOWS) expect(m.steps.length).toBeGreaterThan(0);
  });

  it('every gate permission is a real PERMISSIONS constant', () => {
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        for (const g of s.gate) expect(ALL_PERMS.has(g)).toBe(true);
        for (const g of s.branch?.gate ?? []) expect(ALL_PERMS.has(g)).toBe(true);
      }
    }
  });

  it('every module category is one of the known categories', () => {
    for (const m of MODULE_FLOWS) expect(CATEGORY_ORDER).toContain(m.category);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails, then passes after the catalog exists**

Run: `cd apps/web && npx vitest run src/routes/home/__tests__/module-flows.test.ts`
Expected: PASS (catalog already created in Step 1 — this test locks it). If `PERMISSIONS` values assertion fails, a gate is misspelled; fix the catalog.

- [ ] **Step 4: Replace the placeholder page with the full HomePage**

Replace the entire contents of `apps/web/src/routes/home/index.tsx`:

```tsx
import { MODULE_FLOWS, CATEGORY_ORDER } from './module-flows';
import { FlowChart } from './FlowChart';
import { ROLE_META } from './role-gates';
import type { ModuleCategory } from './types';

function slug(id: string) { return `mod-${id}`; }

export default function HomePage() {
  const byCategory = CATEGORY_ORDER
    .map((cat) => ({ cat, mods: MODULE_FLOWS.filter((m) => m.category === cat) }))
    .filter((g) => g.mods.length > 0);

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      {/* Intro */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Module Guide</h1>
        <p className="mt-2 text-slate-600">
          How each module works, step by step, with the role(s) allowed to perform
          each action. Default system roles are shown; custom roles inherit an
          action whenever they hold that step's permission.
        </p>
      </header>

      {/* Role legend */}
      <section className="mb-8 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Roles</h2>
        <div className="flex flex-wrap gap-2">
          {ROLE_META.map((m) => (
            <span key={m.name} className={`inline-block rounded-full border px-2.5 py-1 text-xs font-medium ${m.badgeClass}`}>
              {m.displayName}
            </span>
          ))}
        </div>
      </section>

      {/* Table of contents */}
      <nav className="mb-8 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Modules</h2>
        {byCategory.map(({ cat, mods }) => (
          <div key={cat} className="mb-3 last:mb-0">
            <p className="text-xs font-semibold text-slate-400">{cat}</p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {mods.map((m) => (
                <li key={m.id}>
                  <a href={`#${slug(m.id)}`} className="text-sm text-cyan-700 hover:underline">{m.title}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Sections */}
      {byCategory.map(({ cat, mods }) => (
        <section key={cat} className="mb-10">
          <h2 className="mb-4 border-b border-slate-200 pb-1 text-lg font-bold text-slate-700">{cat}</h2>
          <div className="space-y-8">
            {mods.map((m) => (
              <article key={m.id} id={slug(m.id)} className="scroll-mt-6">
                <h3 className="text-base font-semibold text-slate-800">{m.title}</h3>
                <p className="mb-3 text-sm text-slate-500">{m.summary}</p>
                <FlowChart steps={m.steps} />
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Verify build + manual render**

Run: `cd apps/web && npx vite build`
Expected: build succeeds.

Manual: open `/home` → intro, role legend, a "Modules" TOC with an "Operations" group linking to Filter Operations, and the Filter Operations flowchart with role badges. Click the TOC link → jumps to the section. No console errors, no unstyled elements.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/home/module-flows.ts apps/web/src/routes/home/index.tsx apps/web/src/routes/home/__tests__/module-flows.test.ts
git commit -m "feat(home): catalog scaffold + full HomePage (TOC, legend, sections)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Tasks 5–9: Author module content by category

Each of these tasks **appends `ModuleFlow` entries to `MODULE_FLOWS`** in `apps/web/src/routes/home/module-flows.ts`, then reruns the integrity test. The pattern is identical; only the modules and their source files differ.

**Sourcing rule (applies to every module):** before authoring a flow, confirm the real action sequence and the gate per action. Do this by either (a) dispatching an `Explore` agent scoped to the module's backend route/service + its `PERMISSION_TREE` group, or (b) reading them directly. For each step, the `gate` array MUST equal the backend `requirePermission`/`requireAnyPermission` args for that action (cross-check `PERMISSION_TREE`'s `gate` field for the matching node id). Never invent a step or a gate. If a module has no real multi-step workflow, give it a 1–2 step "what it does" summary flow (`kind: 'system'`, `gate: []` for read-only viewing) rather than fabricating a sequence.

**Per-task cycle (same for Tasks 5–9):**
- [ ] Source each module's sequence + gates (Explore agent or direct read of the listed files).
- [ ] Append the module's `ModuleFlow` object(s) to `MODULE_FLOWS`.
- [ ] Run `cd apps/web && npx vitest run src/routes/home/__tests__/module-flows.test.ts` → expect PASS (fix any invalid gate).
- [ ] `cd apps/web && npx vite build` → expect success.
- [ ] Manual: open `/home`, confirm the new modules appear under their category with sensible role badges.
- [ ] Commit: `git add apps/web/src/routes/home/module-flows.ts && git commit -m "feat(home): author <category> module flows` + co-author trailer.

### Task 5: Operations modules

Add flows for the remaining Operations modules (Filter Operations already done in Task 4):

| Module (id) | Title | Source files for sequence + gates |
|---|---|---|
| `cleaning-profiles` | Cleaning Profiles | `apps/api/src/modules/cleaning-profiles/`; gates `FCP_READ/CREATE/UPDATE/DELETE` |
| `checklists` | Checklists | `apps/api/src/modules/checklist-profiles/`; PERMISSION_TREE `checklists.*` |
| `equipment-groups` | Equipment Groups | `apps/api/src/modules/equipment-groups/`; PERMISSION_TREE `equipment_groups.*` |
| `pm-schedules` | PM Schedules | `apps/api/src/modules/pm-schedules/`; gates `PM_READ/CREATE/UPDATE/EXECUTE/APPROVE` |
| `my-tasks` | My Tasks | `apps/api/src/modules/pm-schedules/` (task assignment); read-heavy — summary flow OK |
| `filter-list` | Filters | `apps/api/src/modules/assets/` + `hierarchy/`; gates `FILTER_CREATE/EDIT/DELETE`, `FILTER_HIERARCHY_*`, `FILTER_BULK_UPLOAD`, `FILTER_STATUS_UPDATE`, `FILTER_RFID_MANAGE` |
| `filter-retirements` | Retirement List | `apps/api/src/modules/filter-operations/` retire path; gate `FILTER_RETIRE` |
| `filter-replacements` | Replacement List | `apps/api/src/modules/replacement-schedule/`; gate `FILTER_REPLACE` |

### Task 6: Governance & Compliance modules

| Module (id) | Title | Source files for sequence + gates |
|---|---|---|
| `approvals` | Approvals (Block Change) | `apps/api/src/modules/block-change-requests/`; gates `BLOCK_CHANGE_REQUEST`, `BLOCK_CHANGE_APPROVE` |
| `stage-approvals` | Stage Approvals | `apps/api/src/modules/stage-approvals/`; gates `STAGE_APPROVAL_VIEW`, `STAGE_APPROVAL_DECIDE` |
| `report-reviews` | Report Reviews | `apps/api/src/modules/report-reviews/`; gates `REPORT_REVIEW_SUBMIT`, `REPORT_REVIEW`, `REPORT_APPROVE` |
| `deviations` | Deviations | `apps/api/src/modules/filter-operations/` deviation sweep + `pm-schedules`; mostly read/track — summary flow |
| `audit` | Audit Trail | `apps/api/src/modules/audit/`; gates `AUDIT_READ`, `AUDIT_EXPORT`, `AUDIT_DELETE` (redact/delete branches) |
| `version-history` | Version History | `apps/api/src/modules/*/versions` endpoints; gate `VERSION_HISTORY_VIEW` |

### Task 7: Admin modules

| Module (id) | Title | Source files for sequence + gates |
|---|---|---|
| `users` | Users | `apps/api/src/modules/users/`; gates `USER_CREATE/READ/UPDATE/DELETE/ENABLE_DISABLE/UNLOCK/RESET_PASSWORD` |
| `admin-requests` | Admin Requests | `apps/api/src/modules/admin-requests/`; gates `ADMIN_REQUEST_APPROVE`, `ADMIN_REQUEST_REJECT` |
| `configuration` | Configuration | `apps/api/src/modules/config/`; gates `CONFIG_READ`, `CONFIG_UPDATE`, `ROLE_MANAGE` — summary + role-management sub-flow |
| `notifications` | Notifications | `apps/api/src/modules/notifications/`; gates `NOTIFICATION_VIEW`, `NOTIFICATION_DELETE` — mostly read; summary flow |

### Task 8: Reports modules

| Module (id) | Title | Source files for sequence + gates |
|---|---|---|
| `cleaning-cycles` | Filter Cleaning Record | `apps/api/src/modules/filter-operations/` cycles/events; gates `CYCLE_READ`, `REPORT_EXPORT`, `REPORT_GENERATE` |
| `filter-lifecycle-report` | Filter Lifecycle Report | same; gates `CYCLE_READ`, `REPORT_EXPORT` |
| `rfid-track-record` | RFID Track Record | `apps/api/src/modules/assets/` identifiers; gate `FILTER_RFID_MANAGE` / read |
| `quality-notifications` | Quality Notifications | `apps/api/src/modules/pm-schedules/` qnn; config-gated visibility — summary flow |

### Task 9: System modules (thin — summary flows)

| Module (id) | Title | Notes |
|---|---|---|
| `dashboard` | Dashboard | Read-only landing; gates `DASHBOARD_VIEW` (+ create/manage/assign as branches). 1–3 step summary. |
| `system-health` | System Health | Read-only status page; `gate: []`, `kind: 'system'`. Single summary step. |
| `debug-traces` | Debug Traces | Read-only audit-derived traces; gates `READ_DEBUG_TRACE`, `MANAGE_DEBUG_TRACE`. Summary flow. |

After Task 9, `MODULE_FLOWS` covers all ~24 sidebar modules across the five categories.

---

## Task 10: Documentation sync + final verification

**Files:**
- Modify: `CLAUDE.md`, `apps/web/CLAUDE.md`, `CHANGELOG.md`, and any other active-doc-set file the sweep flags.

- [ ] **Step 1: Run the full home test suite**

Run: `cd apps/web && npx vitest run src/routes/home/`
Expected: all three suites PASS.

- [ ] **Step 2: Stale-count sweep for the route count**

The new `/home` route takes `main.tsx` from **76 → 77** `<Route>` definitions. Verify the live count:

Run: `grep -cE "<Route" apps/web/src/main.tsx`
Expected: `77`.

Then grep the active doc set for the old count and update each match to 77:

Run: `grep -rn "76 \`<Route>\`\|76 <Route>\|76 Routes\|**76**" CLAUDE.md apps/web/CLAUDE.md README.md PROJECT_SUMMARY.md 2>/dev/null`
Update every match (`CLAUDE.md` System Stats "Frontend: 76 Routes"; `apps/web/CLAUDE.md` "76 `<Route>` definitions").

- [ ] **Step 3: Note the sidebar item in apps/web/CLAUDE.md**

Add a one-line note that a non-configurable `home` sidebar item + `/home` Module Guide page were added (top of sidebar, visible to all authenticated users, not in `sidebar-items.ts`).

- [ ] **Step 4: Add a CHANGELOG entry**

Append to `CHANGELOG.md` under the current date: the Home Module Guide page — per-module workflow flowcharts with roles derived from `default-roles.ts`, drift-guarded.

- [ ] **Step 5: Full manual verification pass**

- `cd apps/web && npx vite build` → succeeds.
- Log in as SUPER_ADMIN → `/home` shows all five categories, every module, all flowcharts render, role badges correct (e.g. Bypass = Super Admin + Admin only).
- Log in as OPERATOR → Home item visible; `/home` renders identically (it's ungated documentation).
- Check browser console → no errors, no unstyled elements.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md apps/web/CLAUDE.md CHANGELOG.md
git commit -m "docs(home): sync route count 76->77 + changelog for Module Guide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (author checks — done)

- **Spec coverage:** sidebar item + route (T1), always-visible rule (T1 Step 3), derived roles + drift guard (T2), stepper renderer with branches (T3), TOC + legend + categories + thin-module handling (T4–T9), integrity tests (T2–T4), doc-sync 76→77 (T10). All spec sections map to a task.
- **Placeholder scan:** infrastructure tasks (T1–T4) carry full code. Content tasks (T5–T9) intentionally list source files + the sourcing rule instead of pre-writing 20 flows from memory — this enforces the spec's "derive, don't invent" requirement; the integrity test + between-task review are the gates.
- **Type consistency:** `FlowStep.gate: Permission[]`, `branch.gate: Permission[]`, `deriveRolesForGate(gate: Permission[]): string[]`, `ROLE_META` shape, and `ModuleFlow` fields are consistent across T2/T3/T4 and used unchanged in T5–T9.
