# Audit Trail — Complete Before/After Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every entity edit records a before + after snapshot, and the Audit detail view shows a clear "Changes" (old → new) summary plus the full record, visible to all roles, with sensitive fields masked.

**Architecture:** Backend — a shared `sanitizeAuditValue()` strips secrets from any snapshot; edit paths that lack a "before" (starting with the typed filter edit) fetch the pre-change values and pass them to `auditLog`. Frontend — a `diffAuditValues()` helper computes the changed-only diff; the audit detail modal renders a Changes section + collapsible full panels, moved out of the SUPER_ADMIN-only block, with masking.

**Tech Stack:** Fastify + Prisma (TypeScript) backend; React + Vite + Vitest frontend. Existing `auditLog` already persists `beforeValue`/`afterValue` inside the SHA-256 hash chain — no schema change.

## Global Constraints

- No DB migration; no change to the audit storage format or hash chain. Only what *new* rows capture changes; historical rows are never modified.
- Secrets are never persisted in `before_value`/`after_value` — strip at capture, mask at render (defense in depth).
- Sensitive-key match (identical on both sides), case-insensitive: `/password|secret|token|apikey|api[_-]?key|private[_-]?key|credential/`.
- Light theme only (`bg-white`, `bg-slate-50`, `border-slate-200`); no dark styles.
- Rebuild `@digilog/shared` only if shared types change (they don't here).
- After web edits, remember source is invisible to a prod build until `npx vite build`; dev server (Vite :5175) reflects immediately.

---

### Task 1: Backend sanitizer helper

**Files:**
- Create: `apps/api/src/lib/audit-diff.ts`
- Test: `apps/api/src/lib/audit-diff.test.ts`

**Interfaces:**
- Produces: `sanitizeAuditValue<T>(value: T): T` — deep-clones an object/array, dropping any key whose name matches the sensitive-key regex. Primitives returned as-is.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/audit-diff.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeAuditValue } from './audit-diff.js';

describe('sanitizeAuditValue', () => {
  it('drops sensitive keys at any depth, keeps the rest', () => {
    const input = { name: 'F1', password: 'x', passwordHash: 'y', nested: { token: 't', ok: 1 } };
    expect(sanitizeAuditValue(input)).toEqual({ name: 'F1', nested: { ok: 1 } });
  });

  it('returns primitives and null unchanged', () => {
    expect(sanitizeAuditValue('hello')).toBe('hello');
    expect(sanitizeAuditValue(42)).toBe(42);
    expect(sanitizeAuditValue(null)).toBe(null);
  });

  it('sanitizes objects inside arrays', () => {
    expect(sanitizeAuditValue([{ token: 'a', keep: 1 }])).toEqual([{ keep: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/lib/audit-diff.test.ts`
Expected: FAIL — cannot find module `./audit-diff.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/lib/audit-diff.ts
/**
 * Sensitive audit keys — never persist these in before/after snapshots.
 * Kept in sync with the frontend copy in apps/web/src/routes/audit/audit-helpers.ts.
 */
export const SENSITIVE_KEY_RE = /password|secret|token|apikey|api[_-]?key|private[_-]?key|credential/i;

/** Deep-clone, dropping any key matching SENSITIVE_KEY_RE. Primitives pass through. */
export function sanitizeAuditValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeAuditValue(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    out[k] = v && typeof v === 'object' ? sanitizeAuditValue(v) : v;
  }
  return out as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/lib/audit-diff.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/audit-diff.ts apps/api/src/lib/audit-diff.test.ts
git commit -m "feat(audit): add sanitizeAuditValue helper (strip secrets from snapshots)"
```

---

### Task 2: Capture before-value in the typed filter edit

**Files:**
- Modify: `apps/api/src/modules/assets/services/filter.service.ts:82-121` (the `update()` method)
- Test: `apps/api/src/modules/assets/services/filter.service.test.ts` (new)

**Interfaces:**
- Consumes: `sanitizeAuditValue` from `../../../lib/audit-diff.js` (Task 1).

Context — the current `update()` logs `ASSET_UPDATED` with only `afterValue` (no `beforeValue`). It reaches through `PUT /api/hierarchy/filters/:id` → `hierarchyService.updateFilter` → `filterService.update`. Filter set lives in the `FilterDetails` sidecar; name + attributes live on the `filter` row.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/assets/services/filter.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const auditLog = vi.fn();
const prisma = {
  filter: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  filterDetails: { findUnique: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(async (cb: any) => cb({
    filter: { update: vi.fn().mockResolvedValue({ id: 'f1', name: 'NEW' }) },
    filterDetails: { upsert: vi.fn() },
  })),
};

vi.mock('../../../lib/prisma.js', () => ({ prisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: (...a: any[]) => auditLog(...a) }));
vi.mock('./filter-fields.service.js', () => ({
  validateAndBuildFilterAttributes: vi.fn(async () => ({ attributes: { micronSize: '5' }, errors: [] })),
}));
vi.mock('./identifier.service.js', () => ({ identifierService: {} }));

import { filterService } from './filter.service.js';

const ctx = { userId: 'u1', userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 't', sessionId: 's' } as any;

describe('filterService.update — audit before/after', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the pre-edit values in beforeValue', async () => {
    prisma.filter.findUnique.mockResolvedValue({ id: 'f1', name: 'OLD', attributes: { micronSize: '3' } });
    prisma.filter.findFirst.mockResolvedValue(null); // no name dupe
    prisma.filterDetails.findUnique.mockResolvedValue({ filterSet: 'SET_A' });

    await filterService.update('f1', { name: 'NEW' } as any, ctx);

    expect(auditLog).toHaveBeenCalledTimes(1);
    const entry = auditLog.mock.calls[0][0];
    expect(entry.action).toBe('ASSET_UPDATED');
    expect(entry.beforeValue).toMatchObject({ name: 'OLD', filterSet: 'SET_A', attributes: { micronSize: '3' }, templateKind: 'FILTER' });
    expect(entry.afterValue).toMatchObject({ name: 'NEW', templateKind: 'FILTER' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/assets/services/filter.service.test.ts`
Expected: FAIL — `entry.beforeValue` is `undefined`.

- [ ] **Step 3: Implement the capture**

In `apps/api/src/modules/assets/services/filter.service.ts`, add the import near the other lib imports (line 8 area):

```ts
import { sanitizeAuditValue } from '../../../lib/audit-diff.js';
```

Replace the existing-fetch line (currently `const existing = await prisma.filter.findUnique({ where: { id }, select: { id: true } });`) with a snapshot fetch:

```ts
    const existing = await prisma.filter.findUnique({ where: { id }, select: { id: true, name: true, attributes: true } });
    if (!existing) throw new ValidationError('Filter not found');
    const existingDetails = await prisma.filterDetails.findUnique({ where: { assetInstanceId: id }, select: { filterSet: true } });
```

Then replace the `auditLog({ ... })` call (lines ~114-119) with a before+after version:

```ts
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ASSET_UPDATED', targetType: 'asset_instance', targetId: id,
      beforeValue: sanitizeAuditValue({ name: existing.name, filterSet: existingDetails?.filterSet, attributes: existing.attributes, templateKind: 'FILTER' }),
      afterValue: sanitizeAuditValue({ name: data.name, filterSet: filterSetEnum, attributes, templateKind: 'FILTER' }),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/assets/services/filter.service.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/assets/services/filter.service.ts apps/api/src/modules/assets/services/filter.service.test.ts
git commit -m "fix(audit): capture before-value on typed filter edit"
```

---

### Task 3: Frontend diff + masking helpers

**Files:**
- Modify: `apps/web/src/routes/audit/audit-helpers.ts` (add exports at end of file)
- Test: `apps/web/src/routes/audit/audit-helpers.test.ts` (append a describe block)

**Interfaces:**
- Produces:
  - `prettyFieldName(key: string): string` — `"filterSet"` → `"Filter Set"`, `"current_lifecycle_state"` → `"Current Lifecycle State"`.
  - `maskAuditValue(key: string, value: unknown): string` — `"••••••"` for sensitive keys; `"-"` for null/undefined; JSON for objects; `String(value)` otherwise.
  - `AuditFieldChange` = `{ field: string; from: string; to: string }`.
  - `diffAuditValues(before: any, after: any): AuditFieldChange[]` — changed keys only, UUID/`*Id` keys skipped, sensitive values masked.

- [ ] **Step 1: Write the failing test** (append to `audit-helpers.test.ts`)

```ts
import { diffAuditValues, maskAuditValue, prettyFieldName } from './audit-helpers';

describe('audit-helpers — before/after diff', () => {
  it('returns only the fields that changed, old → new', () => {
    expect(diffAuditValues({ name: 'A', filterSize: '10' }, { name: 'A', filterSize: '12' }))
      .toEqual([{ field: 'Filter Size', from: '10', to: '12' }]);
  });

  it('returns empty when nothing changed', () => {
    expect(diffAuditValues({ name: 'A' }, { name: 'A' })).toEqual([]);
  });

  it('masks sensitive values', () => {
    expect(diffAuditValues({ password: 'old' }, { password: 'new' }))
      .toEqual([{ field: 'Password', from: '••••••', to: '••••••' }]);
  });

  it('skips id / uuid-valued keys', () => {
    const before = { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'A' };
    const after = { userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'B' };
    expect(diffAuditValues(before, after)).toEqual([{ field: 'Name', from: 'A', to: 'B' }]);
  });

  it('maskAuditValue handles null and objects', () => {
    expect(maskAuditValue('name', null)).toBe('-');
    expect(maskAuditValue('meta', { a: 1 })).toBe('{"a":1}');
    expect(prettyFieldName('current_lifecycle_state')).toBe('Current Lifecycle State');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/audit/audit-helpers.test.ts`
Expected: FAIL — `diffAuditValues is not a function`.

- [ ] **Step 3: Implement — append to `audit-helpers.ts`**

```ts
// Sensitive audit keys — kept in sync with apps/api/src/lib/audit-diff.ts.
const SENSITIVE_KEY_RE = /password|secret|token|apikey|api[_-]?key|private[_-]?key|credential/i;
const DIFF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function prettyFieldName(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function maskAuditValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY_RE.test(key)) return '••••••';
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface AuditFieldChange { field: string; from: string; to: string; }

/** Changed fields only, old → new. Skips id/uuid keys; masks sensitive values. */
export function diffAuditValues(before: any, after: any): AuditFieldChange[] {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  const changes: AuditFieldChange[] = [];
  for (const key of keys) {
    if (/(^|[^a-z])id$/i.test(key)) continue;
    const bv = b[key];
    const av = a[key];
    if (typeof bv === 'string' && DIFF_UUID_RE.test(bv)) continue;
    if (typeof av === 'string' && DIFF_UUID_RE.test(av)) continue;
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    changes.push({ field: prettyFieldName(key), from: maskAuditValue(key, bv), to: maskAuditValue(key, av) });
  }
  return changes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/routes/audit/audit-helpers.test.ts`
Expected: PASS (existing suite + 5 new).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/audit/audit-helpers.ts apps/web/src/routes/audit/audit-helpers.test.ts
git commit -m "feat(audit): diffAuditValues + maskAuditValue helpers"
```

---

### Task 4: Render — Changes section, collapsible full panels, visible to all roles

**Files:**
- Modify: `apps/web/src/routes/audit/components/audit-detail-modal.tsx`

**Interfaces:**
- Consumes: `diffAuditValues`, `maskAuditValue`, `prettyFieldName` from `../audit-helpers` (Task 3).

There is no automated render test here (JSX layout). Verification is a manual browser check in Step 4. The behavioural logic is covered by Task 3's helper tests.

- [ ] **Step 1: Add the import** (top of file, next to the existing `formatActionLabel` import)

```tsx
import { formatActionLabel, diffAuditValues, maskAuditValue, prettyFieldName } from '../audit-helpers';
```

- [ ] **Step 2: Move before/after OUT of the SUPER_ADMIN block and add the Changes section**

In `audit-detail-modal.tsx`, the before/after IIFE currently sits **inside** the `{isSuperAdmin && ( ... )}` block (lines ~140-186). Cut that whole `{(() => { const beforeEntries = ... })()}` block out of the `isSuperAdmin` fragment and paste it **after** the closing `)}` of the `isSuperAdmin` block (after line ~199), so it renders for all roles. Then replace the pasted block with this version, which (a) adds a Changes summary on top, (b) collapses the full panels into `<details>`, and (c) masks values via `maskAuditValue`:

```tsx
          {/* Before/After — visible to ALL roles. Changed-fields summary on top,
              full previous/new record collapsible below. Secrets masked. */}
          {(() => {
            const changes = diffAuditValues(selectedRecord.beforeValue, selectedRecord.afterValue);
            const beforeEntries = pruneUuids(selectedRecord.beforeValue);
            const afterEntries = pruneUuids(selectedRecord.afterValue);
            if (changes.length === 0 && beforeEntries.length === 0 && afterEntries.length === 0) return null;
            return (
              <div className="space-y-3">
                {changes.length > 0 && (
                  <div className="rounded-xl border border-indigo-100 overflow-hidden">
                    <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-100">
                      <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wider">Changes</p>
                    </div>
                    <div className="p-4 bg-white space-y-2">
                      {changes.map((c) => (
                        <div key={c.field} className="flex items-start gap-3 py-1.5 border-b border-slate-50 last:border-0">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider min-w-[120px] pt-0.5">{c.field}</span>
                          <span className="text-sm flex items-center gap-2 flex-wrap">
                            <span className="text-red-600 line-through break-all">{c.from}</span>
                            <span className="text-slate-400">→</span>
                            <span className="text-green-700 font-medium break-all">{c.to}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(beforeEntries.length > 0 || afterEntries.length > 0) && (
                  <details className="rounded-xl border border-slate-200 overflow-hidden">
                    <summary className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wider cursor-pointer select-none">
                      Full record (previous / new)
                    </summary>
                    <div className="p-4 bg-white grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-2">Previous Value</p>
                        {beforeEntries.length === 0 ? <p className="text-sm text-slate-400">—</p> : beforeEntries.map(([key, value]) => (
                          <div key={key} className="py-1 text-sm">
                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider mr-2">{prettyFieldName(key)}</span>
                            <span className="text-slate-800 break-all">{maskAuditValue(key, value)}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-green-700 uppercase tracking-wider mb-2">New Value</p>
                        {afterEntries.length === 0 ? <p className="text-sm text-slate-400">—</p> : afterEntries.map(([key, value]) => (
                          <div key={key} className="py-1 text-sm">
                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider mr-2">{prettyFieldName(key)}</span>
                            <span className="text-slate-800 break-all">{maskAuditValue(key, value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                )}
              </div>
            );
          })()}
```

Note: `pruneUuids` already exists in this file and stays. The old `formatIfDate`-based before/after markup that lived in the `isSuperAdmin` block is fully replaced by the above (do not leave the old copy behind).

- [ ] **Step 3: Typecheck the web app**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0 (no unused-import or type errors; if `formatIfDate` becomes unused after the replacement, remove it from the destructured props and from `AuditDetailModalProps`, and drop the prop at the single call site in `apps/web/src/routes/audit/index.tsx`).

- [ ] **Step 4: Manual browser verification**

1. Ensure API + Vite dev are running (`start-digilog.bat` or the two dev commands).
2. Log in, open the Audit page as a NON-SUPER_ADMIN role, open an `ASSET_UPDATED` (filter edit) record.
3. Confirm: a "Changes" panel shows `Field: old → new`; a "Full record" section expands to previous/new; no console errors; any password-like field shows `••••••`.
4. Edit a filter's field in the Filter list, then open the fresh audit record → the changed field shows old → new.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/audit/components/audit-detail-modal.tsx apps/web/src/routes/audit/index.tsx
git commit -m "feat(audit): show before/after Changes to all roles, mask secrets"
```

---

### Task 5: Sweep remaining edit paths + docs

**Files:**
- Verify/modify: `apps/api/src/modules/checklist-profiles/checklist-profile.service.ts` (update path)
- Modify: `CHANGELOG.md`
- Modify: memory (`project_audit_before_after_details_2026_07_08.md` + `MEMORY.md` pointer)

**Interfaces:**
- Consumes: `sanitizeAuditValue` (Task 1) for any newly added before/after.

- [ ] **Step 1: Audit the checklist-profile update path**

Run: `grep -n "auditLog\|action:\|beforeValue\|async update\|snapshot" apps/api/src/modules/checklist-profiles/checklist-profile.service.ts`

Decision rule:
- If updates are audited (an `UPDATED`/`EDITED` action) **without** a `beforeValue`, add one: fetch the current profile before mutating and pass `beforeValue: sanitizeAuditValue({...})` mirroring the `afterValue` field set. Add a unit test mirroring Task 2's mock pattern.
- If checklist-profile updates are captured only via the version snapshot (ChecklistProfileVersion) and there is **no** per-edit audit action, record that as expected (versioned entity — the prior version IS the before) and make no change.

- [ ] **Step 2: Confirm the other in-scope entities already capture before** (no code change expected — these were verified during design; this step is a guard)

Run: `for f in users/user.service roles/routes cleaning-profiles/cleaning-profile.service equipment-groups/equipment-groups.service pm-schedules/pm-schedule-crud; do echo "== $f =="; grep -c beforeValue apps/api/src/modules/$f.ts; done`
Expected: each returns ≥ 1. If any in-scope UPDATE action is found without a before, add one following the Task 2 pattern (fetch-before + `sanitizeAuditValue`) and a matching unit test.

- [ ] **Step 3: Run the full API + web suites** (no regressions)

Run: `cd apps/api && npm test` — expected: previous baseline (829 passing) + the new `audit-diff` / `filter.service` tests, 0 new failures.
Run: `cd apps/web && npm test` — expected: audit-helpers suite passes including the 5 new diff tests.

- [ ] **Step 4: Update CHANGELOG**

Add under the current date in `CHANGELOG.md`:

```markdown
### Audit trail — complete before/after details (2026-07-08)
- Typed filter edit now records a `beforeValue` (was after-only) so filter field
  changes show previous → updated.
- Audit detail modal shows a "Changes" summary (changed fields, old → new) plus a
  collapsible full previous/new record, now visible to ALL roles (was SUPER_ADMIN
  only). Sensitive fields (passwords, secrets, tokens) are stripped at capture and
  masked (`••••••`) at render. No schema/hash-chain change; the diff also applies
  to existing rows that already carry before + after.
```

- [ ] **Step 5: Write memory + commit**

Create `~/.claude/projects/.../memory/project_audit_before_after_details_2026_07_08.md` (type: project) summarizing: capture gap was the typed filter path (`filter.service.update`, via `PUT /api/hierarchy/filters/:id`); most other services already captured before; render was SUPER_ADMIN-gated; new `sanitizeAuditValue` (api) + `diffAuditValues`/`maskAuditValue` (web); masking denylist. Add the one-line pointer to `MEMORY.md`.

```bash
git add CHANGELOG.md apps/api/src/modules/checklist-profiles/checklist-profile.service.ts 2>/dev/null; \
git add -A apps/api/src/modules/checklist-profiles 2>/dev/null; \
git commit -m "chore(audit): sweep edit paths + docs for before/after completeness"
```

---

## Self-Review

- **Spec coverage:** capture gap (Task 2 + Task 5 sweep), secrets never stored (Task 1 + used in Tasks 2/5), Changes summary + collapsible full (Task 4), visible to all roles (Task 4), masking at render (Tasks 3/4), tests (Tasks 1/2/3 + Task 4 manual + Task 5 suites), no migration/hash-chain change (Global Constraints). All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows full code; the one conditional (Task 5 Step 1) states an explicit decision rule with both branches, not a vague "handle it".
- **Type consistency:** `sanitizeAuditValue` (Task 1) reused verbatim in Tasks 2/5; `diffAuditValues`/`maskAuditValue`/`prettyFieldName`/`AuditFieldChange` defined in Task 3, consumed in Task 4 with matching names; sensitive regex identical string in api and web copies.
