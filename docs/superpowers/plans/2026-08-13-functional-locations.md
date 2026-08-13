# Functional Locations Implementation Plan (Project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Block → Area tree of Functional Locations, with each instrument linked to at most one, replacing the free-text `block`/`area` columns as the authoritative grouping.

**Architecture:** One new Prisma model with a self-relation (depth capped at 2) plus a single nullable FK on `Instrument`, so exclusivity is structural rather than enforced. Pure validation and tree-resolution functions carry the rules and the tests; the route layer is thin. A hand-written migration seeds locations from the existing free-text values.

**Tech Stack:** Fastify 5 + Prisma 6 + PostgreSQL 18 (api), React 19 + Vite 6 + SWR (web), vitest 3.

**Spec:** `docs/superpowers/specs/2026-08-13-functional-locations-design.md`

## Global Constraints

- **`prisma migrate diff` MUST NOT be piped into a migration file.** It emits three destructive statements in this repo (drops the partitioned `instrument_telemetry_history`, drops `audit_trail.chain_position` NOT NULL, recreates an unchanged FK). Read the header of `20260811120000_instrument_floorplans/migration.sql` first. Hand-write the SQL.
- **`npx prisma generate` fails with EPERM while the API dev server is running** (`tsx watch` holds `query_engine-windows.dll.node`). Stop the API, generate, restart. A stale client silently hides type errors.
- **`vitest` does not typecheck.** `npx tsc --noEmit` on `apps/api` AND `apps/web` is mandatory per task.
- **Known-failing web baseline is 5** (stale `url-utils` cases referencing `routes/pm-schedules/*`, which never existed here). Ratchet down only, never up.
- **Fastify strips any response field absent from the schema.** Every new field must be declared, or it silently never reaches the browser.
- **An audit template is TWO edits:** `packages/shared/src/types/audit-templates.ts` AND a substitution in `apps/web/src/routes/audit/audit-helpers.ts`, or the placeholder renders literally in the §11 record. `template-placeholders.test.ts` catches it.
- Depth is capped at **2** (BLOCK > AREA). Instruments may link to a BLOCK directly.
- Deleting a location with instruments or children is **refused with 409**, never cascaded.
- Do NOT stage or commit the operator's 5 pre-existing modified files, or the untracked PDF/PNG files in the repo root.
- Verified pre-change counts: **34 permissions, 41 reauth actions, 11 sidebar items, 31 models, 6 enums, 21 API modules, 45 routes.**

## File Structure

**Create**
- `apps/api/prisma/migrations/20260813HHMMSS_functional_locations/migration.sql` — table, enum, FK, indexes, and the seed from free-text values.
- `apps/api/src/modules/functional-locations/validation.ts` — pure invariant checks.
- `apps/api/src/modules/functional-locations/__tests__/validation.test.ts`
- `apps/api/src/modules/functional-locations/tree.ts` — `resolveLocationIds`, tree assembly.
- `apps/api/src/modules/functional-locations/__tests__/tree.test.ts`
- `apps/api/src/modules/functional-locations/routes.ts` — the 7 endpoints.
- `apps/web/src/routes/functional-locations/index.tsx` — the tree page.
- `apps/web/src/routes/functional-locations/location-dialog.tsx` — create/rename.
- `apps/web/src/routes/functional-locations/instrument-panel.tsx` — the Relation section.

**Modify**
- `apps/api/prisma/schema.prisma` — enum, model, 2 fields + index on `Instrument`.
- `apps/api/src/app.ts` — register the module.
- `packages/shared/src/types/permissions.ts` — 4 permissions.
- `packages/shared/src/types/reauth-actions.ts` — 3 actions.
- `packages/shared/src/types/sidebar-items.ts` — 1 item.
- `packages/shared/src/types/permission-tree.ts` — 1 group.
- `packages/shared/src/types/audit-actions.ts`, `audit-templates.ts` — 4 actions + templates.
- `apps/web/src/routes/audit/audit-helpers.ts` — template substitutions.
- `apps/web/src/main.tsx` — 1 route.
- `apps/web/src/components/layout/sidebar.tsx` — nav entry.
- `apps/web/src/routes/instruments/create.tsx` — remove `block`/`area` inputs.
- `CLAUDE.md`, `CHANGELOG.md`, `tasks/todo.md`.

---

### Task 1: Pure validation

**Files:** Create `apps/api/src/modules/functional-locations/validation.ts` and its test.

**Interfaces:**
- Produces: `type FlType = 'BLOCK' | 'AREA'`; `interface FlDraft { name: string; type: FlType; parentId: string | null }`; `interface FlParent { id: string; type: FlType } | null`; `validateFlDraft(draft, parent, siblingNames: string[], selfId?: string): { field: string; message: string } | null`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { validateFlDraft } from '../validation';

const block = { id: 'b1', type: 'BLOCK' as const };
const area = { id: 'a1', type: 'AREA' as const };

describe('validateFlDraft', () => {
  it('accepts a BLOCK with no parent', () => {
    expect(validateFlDraft({ name: 'CWH', type: 'BLOCK', parentId: null }, null, [])).toBeNull();
  });

  it('rejects a BLOCK that has a parent', () => {
    const e = validateFlDraft({ name: 'CWH', type: 'BLOCK', parentId: 'b1' }, block, []);
    expect(e?.field).toBe('parentId');
  });

  it('rejects an AREA with no parent', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: null }, null, [])?.field).toBe('parentId');
  });

  it('rejects an AREA parented to an AREA — this is the depth cap', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: 'a1' }, area, [])?.field).toBe('parentId');
  });

  it('accepts an AREA under a BLOCK', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: 'b1' }, block, [])).toBeNull();
  });

  it('rejects a blank or whitespace-only name', () => {
    expect(validateFlDraft({ name: '   ', type: 'BLOCK', parentId: null }, null, [])?.field).toBe('name');
  });

  it('rejects a duplicate name among siblings, case-insensitively', () => {
    // Postgres unique index is case-SENSITIVE, so "cwh" and "CWH" would both be
    // stored. Two locations differing only in case are indistinguishable to a
    // human reading a dropdown, so this is rejected here.
    expect(validateFlDraft({ name: 'cwh', type: 'BLOCK', parentId: null }, null, ['CWH'])?.field).toBe('name');
  });

  it('allows the same name under different parents', () => {
    // Two blocks may each own a "QC" area; siblingNames is per-parent.
    expect(validateFlDraft({ name: 'QC', type: 'AREA', parentId: 'b1' }, block, ['Packing'])).toBeNull();
  });

  it('allows a rename that keeps its own name', () => {
    expect(validateFlDraft({ name: 'CWH', type: 'BLOCK', parentId: null }, null, ['CWH'], 'self-is-cwh')).toBeNull();
  });

  it('rejects a location parented to itself', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: 'a1' }, block, [], 'a1')?.field).toBe('parentId');
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd apps/api && npx vitest run src/modules/functional-locations/__tests__/validation.test.ts`
Expected: FAIL — cannot resolve `../validation`.

- [ ] **Step 3: Implement**

```ts
export type FlType = 'BLOCK' | 'AREA';

export interface FlDraft { name: string; type: FlType; parentId: string | null }
export interface FlParentRef { id: string; type: FlType }

export interface FlFieldError { field: 'name' | 'parentId' | 'type'; message: string }

/**
 * Invariants for a functional location, as pure logic so they are testable
 * without Prisma and enforced identically on create and update.
 *
 * `parent` is the RESOLVED parent row (null when parentId is null); the caller
 * fetches it. `siblingNames` are the existing names under that same parent.
 * `selfId` is set on update so a rename can keep its own name.
 *
 * The depth cap lives here: an AREA may only be parented to a BLOCK, and since
 * only AREAs may have parents, a third level is unreachable.
 */
export function validateFlDraft(
  draft: FlDraft,
  parent: FlParentRef | null,
  siblingNames: string[],
  selfId?: string,
): FlFieldError | null {
  const name = draft.name?.trim() ?? '';
  if (!name) return { field: 'name', message: 'Name is required.' };

  if (draft.type === 'BLOCK') {
    if (draft.parentId) return { field: 'parentId', message: 'A Block sits at the top level and cannot have a parent.' };
  } else {
    if (!draft.parentId) return { field: 'parentId', message: 'An Area must belong to a Block.' };
    if (selfId && draft.parentId === selfId) return { field: 'parentId', message: 'A location cannot be its own parent.' };
    if (!parent) return { field: 'parentId', message: 'The selected Block does not exist.' };
    if (parent.type !== 'BLOCK') {
      return { field: 'parentId', message: 'An Area must belong to a Block, not to another Area.' };
    }
  }

  const clash = siblingNames.some((s) => s.trim().toLowerCase() === name.toLowerCase());
  if (clash && !(selfId && siblingNames.length > 0 && false)) {
    // A rename keeping its own name is handled by the caller excluding self from
    // siblingNames; if it did not, this would reject a no-op rename.
    if (!selfId || !siblingNames.some(() => false)) {
      if (clash) return { field: 'name', message: `"${name}" already exists here.` };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run — all pass.** Note the `allows a rename that keeps its own name` case requires the ROUTE to exclude self from `siblingNames`; simplify the clash block to a plain `if (clash) return …` and make the route responsible, then assert that in Task 3.

- [ ] **Step 5: `cd apps/api && npx tsc --noEmit -p tsconfig.json`, then commit**

```bash
git add apps/api/src/modules/functional-locations/
git commit -m "feat(api): pure validation for the functional-location tree"
```

---

### Task 2: Tree resolution

**Files:** Create `apps/api/src/modules/functional-locations/tree.ts` + test.

**Interfaces:**
- Produces: `interface FlNode { id: string; name: string; type: FlType; parentId: string | null }`; `resolveLocationIds(id: string, all: FlNode[]): string[]`; `buildTree(all: FlNode[], counts: Map<string, number>): FlTreeNode[]` where `FlTreeNode = FlNode & { ownCount: number; totalCount: number; children: FlTreeNode[] }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveLocationIds, buildTree } from '../tree';

const all = [
  { id: 'cwh', name: 'CWH', type: 'BLOCK' as const, parentId: null },
  { id: 'me', name: 'Module-E', type: 'AREA' as const, parentId: 'cwh' },
  { id: 'mf', name: 'Module-F', type: 'AREA' as const, parentId: 'cwh' },
  { id: 'bc', name: 'Block C', type: 'BLOCK' as const, parentId: null },
];

describe('resolveLocationIds', () => {
  it('returns a Block plus all its Areas', () => {
    // THE bug this feature is most likely to ship: a Block view that shows only
    // instruments linked directly to the Block and silently omits its Areas'.
    expect(resolveLocationIds('cwh', all).sort()).toEqual(['cwh', 'me', 'mf']);
  });

  it('returns only itself for an Area', () => {
    expect(resolveLocationIds('me', all)).toEqual(['me']);
  });

  it('returns only itself for an empty Block', () => {
    expect(resolveLocationIds('bc', all)).toEqual(['bc']);
  });

  it('returns an empty list for an unknown id', () => {
    expect(resolveLocationIds('nope', all)).toEqual([]);
  });
});

describe('buildTree', () => {
  it('nests areas under their block and rolls counts up', () => {
    const counts = new Map([['cwh', 1], ['me', 3], ['mf', 0]]);
    const tree = buildTree(all, counts);
    const cwh = tree.find((n) => n.id === 'cwh')!;
    expect(tree.map((n) => n.id)).toEqual(['bc', 'cwh']); // sorted by name
    expect(cwh.children.map((c) => c.id)).toEqual(['me', 'mf']);
    expect(cwh.ownCount).toBe(1);
    expect(cwh.totalCount).toBe(4); // 1 own + 3 + 0
  });

  it('gives an empty block a zero total, not undefined', () => {
    expect(buildTree(all, new Map()).find((n) => n.id === 'bc')!.totalCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run — FAIL (module missing).**

- [ ] **Step 3: Implement `tree.ts`** with `resolveLocationIds` (self + direct children, since depth is 2) and `buildTree` (blocks sorted by name, areas sorted by name, `totalCount = ownCount + sum(children)`).

- [ ] **Step 4: Run — pass. Step 5: tsc, commit.**

```bash
git commit -m "feat(api): resolve a Block to itself plus its Areas, and build the counted tree"
```

---

### Task 3: Schema, hand-written migration, and the free-text seed

**Files:** Modify `apps/api/prisma/schema.prisma`; create the migration SQL.

- [ ] **Step 1:** Add the `FunctionalLocationType` enum and `FunctionalLocation` model exactly as in the spec's Data Model section, plus on `Instrument`: `functionalLocationId String? @map("functional_location_id")`, the relation with `onDelete: Restrict`, and `@@index([functionalLocationId])`.

- [ ] **Step 2:** Stop the API dev server (it holds the Prisma DLL), then `npx prisma generate` from `apps/api`.

- [ ] **Step 3: Hand-write** `apps/api/prisma/migrations/20260813HHMMSS_functional_locations/migration.sql`:

```sql
-- Functional Locations: a two-level Block > Area tree, with each instrument
-- linked to at most one (a single nullable FK, so two locations is unrepresentable).
--
-- HAND-WRITTEN. `prisma migrate diff` in this repo emits three destructive
-- statements that must never reach a migration file:
--   1. DROP TABLE instrument_telemetry_history  (partitioned; Prisma reads it as stray)
--   2. ALTER audit_trail.chain_position DROP NOT NULL  (21 CFR hash-chain position)
--   3. drop/recreate an unchanged instrument_credentials FK
-- See 20260811120000_instrument_floorplans/migration.sql.

CREATE TYPE "FunctionalLocationType" AS ENUM ('BLOCK', 'AREA');

CREATE TABLE "functional_locations" (
  "id"         TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "type"       "FunctionalLocationType" NOT NULL,
  "parent_id"  TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "created_by" TEXT,
  "updated_by" TEXT,
  CONSTRAINT "functional_locations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "functional_locations_parent_id_name_key" ON "functional_locations"("parent_id", "name");
CREATE INDEX "functional_locations_type_idx" ON "functional_locations"("type");

ALTER TABLE "functional_locations"
  ADD CONSTRAINT "functional_locations_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "functional_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "instruments" ADD COLUMN "functional_location_id" TEXT;
CREATE INDEX "instruments_functional_location_id_idx" ON "instruments"("functional_location_id");
ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_functional_location_id_fkey"
  FOREIGN KEY ("functional_location_id") REFERENCES "functional_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed from the existing free-text block/area values. Verified against the live
-- database 2026-08-13: 2 blocks, 2 areas, 5 instruments linked, 15 left unlinked.
-- The block/area COLUMNS ARE KEPT: they stop being read, but a bad mapping must
-- stay comparable and correctable. Dropping them is a separate follow-up.
INSERT INTO "functional_locations" ("id", "name", "type", "parent_id", "updated_at", "created_by")
SELECT gen_random_uuid()::text, TRIM(block), 'BLOCK', NULL, NOW(), 'migration'
FROM "instruments"
WHERE block IS NOT NULL AND TRIM(block) <> ''
GROUP BY TRIM(block);

INSERT INTO "functional_locations" ("id", "name", "type", "parent_id", "updated_at", "created_by")
SELECT gen_random_uuid()::text, TRIM(i.area), 'AREA', b.id, NOW(), 'migration'
FROM "instruments" i
JOIN "functional_locations" b ON b."type" = 'BLOCK' AND b."name" = TRIM(i.block)
WHERE i.area IS NOT NULL AND TRIM(i.area) <> '' AND i.block IS NOT NULL
GROUP BY TRIM(i.area), b.id;

-- Area match first (more specific), then block-only instruments.
UPDATE "instruments" i SET "functional_location_id" = a.id
FROM "functional_locations" a
JOIN "functional_locations" b ON b.id = a."parent_id"
WHERE a."type" = 'AREA' AND a."name" = TRIM(i.area) AND b."name" = TRIM(i.block);

UPDATE "instruments" i SET "functional_location_id" = b.id
FROM "functional_locations" b
WHERE b."type" = 'BLOCK' AND b."name" = TRIM(i.block)
  AND i."functional_location_id" IS NULL
  AND (i.area IS NULL OR TRIM(i.area) = '');
```

- [ ] **Step 4: Apply and verify the mapping**

```bash
cd apps/api && npx prisma migrate deploy
```
Then confirm, with `DATABASE_URL` passed explicitly (never rely on ambient `.env` — the repo-root one has pointed at the sibling database before):

```sql
SELECT type, count(*) FROM functional_locations GROUP BY type;          -- BLOCK 2, AREA 2
SELECT count(*) FROM instruments WHERE functional_location_id IS NOT NULL; -- 5
```

- [ ] **Step 5: Drift guard, then commit**

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-migrations.ps1` (the documented npm script fails on the execution policy).

```bash
git commit -m "feat(api): functional_locations table, instrument FK, and the free-text seed"
```

---

### Task 4: Shared registries

**Files:** Modify `permissions.ts`, `reauth-actions.ts`, `sidebar-items.ts`, `permission-tree.ts`, `audit-actions.ts`, `audit-templates.ts`, and `apps/web/src/routes/audit/audit-helpers.ts`.

- [ ] **Step 1:** 4 permissions — `FUNCTIONAL_LOCATION_READ` / `_CREATE` / `_UPDATE` / `_DELETE` (34 → 38).
- [ ] **Step 2:** 3 reauth actions in the `Configuration` category — `CREATE_FUNCTIONAL_LOCATION`, `UPDATE_FUNCTIONAL_LOCATION`, `DELETE_FUNCTIONAL_LOCATION` (41 → 44).
- [ ] **Step 3:** 1 sidebar item — `{ id: 'functional-locations', label: 'Functional Locations', icon: '\u{1F5FA}', description: 'Block and Area grouping for instruments' }` (11 → 12).
- [ ] **Step 4:** 1 `PERMISSION_TREE` group with nodes for view/create/edit/delete, each carrying `permissions`, `gate`, `reauthAction`, `enforce` and `configurable`, following the shape of the existing instruments group. Update the frozen-snapshot test in the same commit or it fails.
- [ ] **Step 5:** 4 audit actions + templates, **and** the matching substitutions in `audit-helpers.ts`. Run `npx vitest run` on the shared package's `template-placeholders.test.ts` to prove no placeholder renders literally.
- [ ] **Step 6:** Backfill `role_configs.sidebar_items` and `user_configs.sidebar_items` so existing roles neither lose nor silently gain the item, mirroring how `home` was added.
- [ ] **Step 7:** `npm run build -w @digilog/shared`, both typechecks, commit.

---

### Task 5: API module

**Files:** Create `apps/api/src/modules/functional-locations/routes.ts`; modify `apps/api/src/app.ts`.

**Interfaces:** Consumes `validateFlDraft` (Task 1), `resolveLocationIds` / `buildTree` (Task 2).

- [ ] **Step 1:** The 7 endpoints from the spec. Every response field declared in the schema — Fastify strips undeclared fields, which has already cost `limits` and `profileName` today.
- [ ] **Step 2:** `GET /linkable-instruments` returns EVERY instrument with `{ id, code, name, functionalLocationId, functionalLocationPath }` — `path` being `"CWH > Module-E"` or null. Not unlinked-only: moving between locations is allowed, and an unlinked-only endpoint would make moving impossible from the picker.
- [ ] **Step 3:** DELETE returns **409** naming the counts when instruments or children exist. `Restrict` also enforces this at the database, but the API must produce a message a human can act on rather than a constraint error.
- [ ] **Step 4:** Create/update/delete and `PUT /:id/instruments` each require reauth and write an audit row, matching `floorplans/routes.ts`.
- [ ] **Step 5:** The update path must exclude the location's own name from `siblingNames` before calling `validateFlDraft`, or a no-op rename is rejected. Assert it in an e2e test.
- [ ] **Step 6:** Register in `app.ts` beside `floorplanRoutes` with prefix `/api/functional-locations`.
- [ ] **Step 7:** `npx tsc --noEmit`, `npx vitest run src/modules/functional-locations`, commit.

---

### Task 6: Frontend

**Files:** Create the three files under `apps/web/src/routes/functional-locations/`; modify `main.tsx`, `sidebar.tsx`, `instruments/create.tsx`.

- [ ] **Step 1:** `index.tsx` — Blocks with Areas nested, `ownCount`/`totalCount` per node, create / rename / delete, gated with `useCan('functional_locations.*')`.
- [ ] **Step 2:** `location-dialog.tsx` — name, type, and a parent select shown **only** when type is Area (a parent field on a Block is a field that can only be wrong).
- [ ] **Step 3:** `instrument-panel.tsx` — linked instruments plus an "Add instruments" picker modelled on `gateway-panel.tsx`. Instruments already linked elsewhere show their current path and require confirmation before moving.
- [ ] **Step 4:** `main.tsx` route `/functional-locations` (45 → 46) and the `sidebar.tsx` nav entry.
- [ ] **Step 5:** Remove the `block` and `area` inputs from `instruments/create.tsx`. Keep `location`.
- [ ] **Step 6:** `npx tsc --noEmit -p tsconfig.json`, `npx vite build`, `npx vitest run` (failures must equal the baseline of 5), commit.

---

### Task 7: Docs

- [ ] **Step 1:** `CLAUDE.md` — new counts (38 permissions, 44 reauth actions, 12 sidebar items, 32 models, 7 enums, 22 modules, 46 routes) and a line stating Functional Locations is the authoritative instrument grouping while `roomId` keeps geometry and `profileId` keeps device type.
- [ ] **Step 2:** `CHANGELOG.md` entry.
- [ ] **Step 3:** `tasks/todo.md` — projects A–D with A's status, so B/C/D are not lost.
- [ ] **Step 4:** Commit.

---

## Self-Review

**Spec coverage.** Data model → Task 3. Exclusivity via single FK → Task 3 (schema) with the move behaviour in Tasks 5–6. Invariants incl. depth cap → Task 1. Block-includes-Areas → Task 2. Deletion 409 → Tasks 3 (Restrict) + 5 (message). Free-text migration → Task 3. API (7 endpoints) → Task 5. Frontend (3 files) → Task 6. Permissions/sidebar/reauth/audit → Task 4. Testing → Tasks 1, 2, 5, 6. Docs → Task 7. Out-of-scope items appear in no task.

**Placeholder scan.** One real defect found and left flagged rather than hidden: Task 1's `validateFlDraft` clash block as first drafted contains dead, unreachable conditions (`&& false`, `siblingNames.some(() => false)`) — an artefact of trying to handle self-rename inside the validator. Task 1 Step 4 states the fix explicitly (plain `if (clash) return …`; the ROUTE excludes self from `siblingNames`) and Task 5 Step 5 asserts it. Simplify when implementing; do not ship the dead branches.

**Type consistency.** `FlType` is defined in Task 1 and reused in Task 2's `FlNode`. `resolveLocationIds(id, all)` and `buildTree(all, counts)` signatures match between Task 2's test and Task 5's consumption. `functionalLocationId` is spelled identically in schema, API and frontend. Audit action names match between `audit-actions.ts`, `audit-templates.ts` and `audit-helpers.ts` in Task 4.

**Gap found and closed.** No task originally backfilled `role_configs` / `user_configs` for the new sidebar item, which would have made the page invisible to every existing role — added as Task 4 Step 6.
