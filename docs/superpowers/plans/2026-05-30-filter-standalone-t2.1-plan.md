# Filter Standalone — Tier 2 Phase 1 (Typed-Direct Create + Reverse Mirror)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Make Filter **creation** write the typed `filters` + `filter_details` tables **directly** (no `validateParent`, no `asset_relationships`, no asset-template attributeSchema), with a **reverse-mirror trigger** that keeps the legacy `asset_instances` row in sync so the 7 pages still reading `/api/assets/instances` keep working. This eliminates "Parent connections reached" and makes `filters` the write source-of-truth.

**Architecture:** A new `AFTER INSERT/UPDATE/DELETE` trigger on `filters` (`fn_mirror_typed_to_asset_instance`) upserts/deletes the matching `asset_instances` row (same id, `template_id` = the active FILTER template, `parent_id` = `ahu_id`). Both the new reverse trigger and the existing forward trigger (`fn_mirror_asset_instance`) get a `pg_trigger_depth() > 1` guard so the two mirrors can't recurse. A new `filterService.create()` writes `filters` (+ `filter_details`, + RFID) directly; bulk-upload and single-create route through it instead of `instanceService.create()`.

**Tech Stack:** PostgreSQL plpgsql triggers (applied via psql — repo has no `_prisma_migrations`), Prisma (`prisma.filter`, `prisma.filterDetails`), Fastify, vitest.

**Scope:** CREATE only. Retire/replace/cycle/delete and the 7 reader files are later phases (T2.2–T2.4). The reverse mirror stays until T2.4.

**Verified facts (live, 2026-05-30):**
- `asset_instances` NOT-NULL cols: `id, name, template_id, template_version(def 1), status(def 'Active'), attributes(def '{}'), telemetry_config(def '{}'), custom_attributes(def '{}'), is_active(def true), created_at, updated_at`. `parent_id, description, uns_path, created_by, updated_by` nullable.
- `filters` cols: `id, ahu_id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by`.
- Forward trigger on `asset_instances` = `trg_mirror_asset_instance_iud` → `fn_mirror_asset_instance()`. No trigger on `filters` yet.
- `filter_details.asset_instance_id` FK → `asset_instances.id`; `asset_identifiers.asset_id` FK → `asset_instances.id`. Both need the asset_instances mirror row to exist → the reverse trigger (AFTER INSERT on `filters`, same txn) creates it before the app's next statement.

---

## Task 1: Reverse-mirror trigger + forward-trigger depth guard

**Files:**
- Create: `apps/api/prisma/migrations/20260530_filter_reverse_mirror/migration.sql`
- Apply via psql (no `migrate deploy` — repo applies SQL directly).

- [ ] **Step 1: Write the migration SQL**

```sql
-- T2.1: reverse mirror filters -> asset_instances + recursion guards.

-- (1) Guard the EXISTING forward trigger so it no-ops when fired re-entrantly
--     by the reverse trigger. CREATE OR REPLACE keeping the body; only add the
--     guard as the first statement. (Full body re-stated by the engineer from
--     `SELECT pg_get_functiondef('fn_mirror_asset_instance'::regproc)` — insert
--     the guard immediately after BEGIN.)
-- The guard to insert after BEGIN:
--     IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;

-- (2) Reverse trigger function.
CREATE OR REPLACE FUNCTION fn_mirror_typed_to_asset_instance() RETURNS TRIGGER AS $$
DECLARE
  v_tmpl UUID;
BEGIN
  -- Break the reverse<->forward recursion: only act on the originating write.
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM asset_instances WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  -- Resolve the active FILTER asset-template id (asset_instances.template_id is
  -- NOT NULL; the forward mirror + legacy readers still key off template_kind).
  SELECT id INTO v_tmpl FROM asset_templates
    WHERE template_kind = 'FILTER' AND is_active = true
    ORDER BY created_at ASC LIMIT 1;
  IF v_tmpl IS NULL THEN
    RAISE EXCEPTION 'No active FILTER asset_template to mirror filter % into asset_instances', NEW.id;
  END IF;

  INSERT INTO asset_instances
    (id, name, description, template_id, template_version, status, attributes,
     telemetry_config, custom_attributes, parent_id, uns_path, is_active,
     created_at, updated_at, created_by, updated_by)
  VALUES
    (NEW.id, NEW.name, NEW.description, v_tmpl, 1, NEW.status, NEW.attributes,
     '{}'::jsonb, NEW.custom_attributes, NEW.ahu_id, NEW.uns_path, NEW.is_active,
     NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    attributes = EXCLUDED.attributes,
    custom_attributes = EXCLUDED.custom_attributes,
    parent_id = EXCLUDED.parent_id,
    uns_path = EXCLUDED.uns_path,
    is_active = EXCLUDED.is_active,
    updated_at = EXCLUDED.updated_at,
    updated_by = EXCLUDED.updated_by;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (3) Attach the reverse trigger to `filters`.
DROP TRIGGER IF EXISTS trg_mirror_typed_to_asset_instance ON filters;
CREATE TRIGGER trg_mirror_typed_to_asset_instance
  AFTER INSERT OR UPDATE OR DELETE ON filters
  FOR EACH ROW EXECUTE FUNCTION fn_mirror_typed_to_asset_instance();
```

> The engineer MUST regenerate the full `fn_mirror_asset_instance` body via `pg_get_functiondef`, insert the one guard line after `BEGIN`, and include that `CREATE OR REPLACE` in this migration. Do not hand-truncate the existing body.

- [ ] **Step 2: Apply + manual recursion/parity test (psql, transactional, rolled back)**

Run (PowerShell/bash; rollback so no test rows persist):
```sql
BEGIN;
-- pick a real AHU id:
--   SELECT id FROM ahus LIMIT 1;  -> :ahu
INSERT INTO filters (id, ahu_id, name, status, attributes, is_active, created_at, updated_at, created_by)
VALUES (gen_random_uuid(), :'ahu', 'ZZ-rev-mirror', 'Active', '{"ahuType":"Process"}'::jsonb, true, now(), now(), 'superadmin')
RETURNING id \gset
-- asset_instances mirror must exist with template_id set + parent_id = ahu:
SELECT (SELECT count(*) FROM asset_instances WHERE id = :'id') AS ai_rows,
       (SELECT template_kind FROM asset_templates t JOIN asset_instances i ON i.template_id=t.id WHERE i.id=:'id') AS kind,
       (SELECT parent_id = :'ahu' FROM asset_instances WHERE id=:'id') AS parent_ok;
-- delete must cascade out of asset_instances:
DELETE FROM filters WHERE id = :'id';
SELECT count(*) AS ai_after FROM asset_instances WHERE id = :'id';  -- expect 0
ROLLBACK;
```
Expected: `ai_rows=1, kind='FILTER', parent_ok=t`, `ai_after=0`. No infinite-recursion error (proves the depth guards work).

- [ ] **Step 3: Commit**
```bash
git add apps/api/prisma/migrations/20260530_filter_reverse_mirror/migration.sql
git commit -m "feat(a-01 t2.1): reverse-mirror trigger filters->asset_instances + depth guards"
```

---

## Task 2: `filterService.create()` — typed-direct write

**Files:**
- Create: `apps/api/src/modules/assets/services/filter.service.ts`
- Test: `apps/api/src/modules/assets/services/__tests__/filter.service.test.ts`

- [ ] **Step 1: Write the failing test (mocked prisma + identifierService)**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterService } from '../filter.service.js';
import { prisma } from '../../../../lib/prisma.js';

vi.mock('../../../../lib/prisma.js', () => ({
  prisma: {
    ahu: { findUnique: vi.fn() },
    filter: { findFirst: vi.fn(), create: vi.fn() },
    filterDetails: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn({
      filter: { create: vi.fn(async ({ data }: any) => ({ id: 'f1', ...data })) },
      filterDetails: { create: vi.fn() },
    })),
  },
}));
vi.mock('../filter-fields.service.js', () => ({
  validateAndBuildFilterAttributes: vi.fn(async (i: any) => ({ attributes: i.ahuType ? { ahuType: 'Process' } : {}, errors: [] })),
}));
vi.mock('../identifier.service.js', () => ({ identifierService: { create: vi.fn() } }));
vi.mock('../../../../lib/audit.js', () => ({ auditLog: vi.fn() }));

const ctx = { userId: 'superadmin', userRole: 'SUPER_ADMIN' } as any;
beforeEach(() => {
  vi.clearAllMocks();
  (prisma.ahu.findUnique as any).mockResolvedValue({ id: 'ahu1' });
  (prisma.filter.findFirst as any).mockResolvedValue(null); // name not taken
});

describe('filterService.create', () => {
  it('rejects when the AHU does not exist (no asset hierarchy validation)', async () => {
    (prisma.ahu.findUnique as any).mockResolvedValue(null);
    await expect(filterService.create({ name: 'F', ahuId: 'nope' }, ctx)).rejects.toThrow(/AHU/);
  });

  it('rejects a duplicate filter name', async () => {
    (prisma.filter.findFirst as any).mockResolvedValue({ id: 'x' });
    await expect(filterService.create({ name: 'Dup', ahuId: 'ahu1' }, ctx)).rejects.toThrow(/exists/);
  });

  it('creates the typed filter with ahuId + attributes and returns it', async () => {
    const out = await filterService.create({ name: 'F', ahuId: 'ahu1', filterSet: 'A', ahuType: 'process' }, ctx);
    expect(out.id).toBe('f1');
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run red** — `cd apps/api && npx vitest run src/modules/assets/services/__tests__/filter.service.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `filter.service.ts`**

```ts
// Standalone Filter create — A-01 Tier 2. Writes the typed `filters` table
// directly (source of truth). NO validateParent, NO asset_relationships, NO
// asset-template attributeSchema. The reverse-mirror trigger keeps a legacy
// asset_instances row in sync for un-migrated readers.
import type { RequestContext } from '../../../types/context.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';
import { ValidationError } from '../../../lib/errors.js';
import { validateAndBuildFilterAttributes, type FilterFieldInput } from './filter-fields.service.js';
import { identifierService } from './identifier.service.js';

export interface CreateFilterTypedInput extends FilterFieldInput {
  name: string;
  ahuId: string;
  filterSet?: 'A' | 'B';
  filterProfileId?: string;
  rfidTag?: string;
}

export const filterService = {
  async create(input: CreateFilterTypedInput, ctx: RequestContext) {
    const name = input.name?.trim();
    if (!name) throw new ValidationError('Filter Name is required');

    const ahu = await prisma.ahu.findUnique({ where: { id: input.ahuId }, select: { id: true } });
    if (!ahu) throw new ValidationError('AHU not found');

    const existing = await prisma.filter.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, isActive: true }, select: { id: true } });
    if (existing) throw new ValidationError(`A filter with the name "${name}" already exists`);

    const { attributes, errors } = await validateAndBuildFilterAttributes(input);
    if (errors.length > 0) throw new ValidationError('One or more filter fields are invalid', errors as any);

    const filterSetEnum: 'SET_A' | 'SET_B' | undefined =
      input.filterSet === 'A' ? 'SET_A' : input.filterSet === 'B' ? 'SET_B' : undefined;

    const filter = await prisma.$transaction(async (tx) => {
      const f = await tx.filter.create({
        data: {
          ahuId: input.ahuId,
          name,
          status: 'Active',
          attributes: attributes as any,
          createdBy: ctx.userId,
        } as any,
      });
      // The reverse-mirror trigger has now created the asset_instances row
      // (same id) within this txn, so the FilterDetails FK resolves.
      await tx.filterDetails.create({
        data: {
          assetInstanceId: f.id,
          ...(filterSetEnum ? { filterSet: filterSetEnum } : {}),
          ...(input.filterProfileId ? { filterProfileId: input.filterProfileId } : {}),
        },
      });
      return f;
    });

    if (input.rfidTag) {
      await identifierService.create({ assetId: filter.id, identifierType: 'RFID', identifierValue: input.rfidTag, isPrimary: true }, ctx);
    }

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ASSET_CREATED', targetType: 'asset_instance', targetId: filter.id,
      afterValue: { name, ahuId: input.ahuId, filterSet: filterSetEnum, kind: 'FILTER' },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return filter;
  },
};
```

> Note: `auditLog` action stays `ASSET_CREATED`/`asset_instance` to preserve the existing 21 CFR audit-action registry + inspector contract (don't invent a new action in this phase).

- [ ] **Step 4: Run green** — same vitest command → 3 pass.
- [ ] **Step 5: Typecheck** — `cd apps/api && npx tsc -p tsconfig.json --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add apps/api/src/modules/assets/services/filter.service.ts apps/api/src/modules/assets/services/__tests__/filter.service.test.ts
git commit -m "feat(a-01 t2.1): standalone filterService.create (typed-direct, no hierarchy validation)"
```

---

## Task 3: Route single-create + bulk through `filterService.create`

**Files:**
- Modify: `apps/api/src/modules/hierarchy/hierarchy.service.ts` (`createFilter` delegates to `filterService.create`)
- Modify: `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts` (create loop calls `filterService.create`, drop the `resolveFilterTemplateRef` + `instanceService.create` + RFID-after-create — `filterService` now owns RFID)

- [ ] **Step 1** — In `hierarchy.service.ts` `createFilter`, replace the body that calls `resolveFilterTemplateRef` + `instanceService.create` with:
```ts
  async createFilter(input: CreateFilterInput, ctx: RequestContext) {
    return filterService.create(input, ctx);
  },
```
(Import `filterService` from `../assets/services/filter.service.js`; keep the `CreateFilterInput` type. `validateAndBuildFilterAttributes`/`resolveFilterTemplateRef` imports become unused here — remove them.)

- [ ] **Step 2** — In `bulk-upload-filter.service.ts` create loop, replace the `instanceService.create({...})` call + the separate RFID `identifierService.create` block with a single:
```ts
      const f = await filterService.create({
        name: c.name, ahuId,
        ...(c.filterSet ? { filterSet: c.filterSet } : {}),
        ...(c.rfidTag ? { rfidTag: c.rfidTag } : {}),
        ...c.attributes && {}, // attributes are re-derived inside filterService; pass raw field values instead
      }, ctx);
```
> Correction: `filterService.create` re-runs `validateAndBuildFilterAttributes` from raw field values, so bulk must pass the RAW row fields (`ahuType/filterType/micronSize/lastCleaningDate`), not the pre-built `attributes`. Change the `toCreate` items to carry the raw `FilterFieldInput` fields (ahuType/filterType/micronSize/lastCleaningDate) instead of the built `attributes`, and pass them through. Keep the per-row try/catch + the existing RFID-failure result handling, but RFID is now assigned inside `filterService.create` (so on RFID failure it throws → caught by the row try/catch → row error). Drop the now-unused `resolveFilterTemplateRef`, `instanceService`, and the post-create `identifierService.create` block.

- [ ] **Step 3: Typecheck** — `cd apps/api && npx tsc -p tsconfig.json --noEmit` → clean.
- [ ] **Step 4: Run existing tests** — `cd apps/api && npx vitest run src/modules/hierarchy/__tests__/create-filter.routes.test.ts src/e2e/c2-retire-replace-bulk-upload-reauth.test.ts` → green (the create-filter route test mocks `instanceService`; update it to mock `filterService.create` instead).
- [ ] **Step 5: Commit**
```bash
git add apps/api/src/modules/hierarchy/hierarchy.service.ts apps/api/src/modules/assets/services/bulk-upload-filter.service.ts apps/api/src/modules/hierarchy/__tests__/create-filter.routes.test.ts
git commit -m "feat(a-01 t2.1): single + bulk create route through filterService (drops validateParent/relationships)"
```

---

## Task 4: Live integration verification (the proof)

- [ ] **Step 1** — Restart the API (`tsx watch`) so the new code + trigger load.
- [ ] **Step 2** — Find an AHU at/near its old 10-child cap (the one that threw before). Build an .xlsx (via the existing node-script pattern) with 3 filter rows into that AHU. Upload via `POST /api/assets/instances/bulk-upload-filters` (reauth header).
- [ ] **Step 3** — Assert:
  - **No "Parent connections reached"** — all valid rows `created`.
  - typed `filters` row exists with `ahu_id` set; `asset_instances` mirror row exists (reverse trigger); `filter_details.filter_set` set; RFID (if given) in `asset_identifiers`.
  - **No new `asset_relationships` CONTAINS row** for the created filter (`SELECT count(*) FROM asset_relationships WHERE target_asset_id = '<id>'` → 0).
  - The filter is visible via BOTH `GET /api/assets/instances` (legacy, via mirror) and `GET /api/hierarchy/filters` (typed).
- [ ] **Step 4** — Clean up test rows (`DELETE FROM filters WHERE name LIKE 'ZZ-%'` → reverse trigger cascades asset_instances; verify `asset_instances`, `filter_details`, `asset_identifiers` all gone).

---

## Task 5: Docs + checkpoint

- [ ] `CHANGELOG.md`: A-01 Tier 2 Phase 1 entry (typed-direct filter create + reverse mirror; removed validateParent/relationships/template from create).
- [ ] `tasks/A-01-PHASE-2-PLAN.md`: mark filter-create cutover done; note reverse mirror live; next = reader migration (T2.2).
- [ ] Memory: project note — reverse mirror live, `filterService.create` is the create path, T2.2–T2.4 pending.
- [ ] Commit docs.

---

## Self-review notes
- **Spec coverage:** "Parent connections reached" gone (no validateParent — Task 2/3); no asset_relationships (Task 3 drops them); typed `filters` is write source (Task 2); legacy readers still work (reverse mirror — Task 1). Full asset_instances removal is **out of scope** (T2.4, gated on reader migration T2.2) — stated explicitly.
- **Recursion safety:** depth guard on BOTH triggers (Task 1) — manual psql test proves no infinite loop.
- **FK ordering:** reverse trigger creates asset_instances synchronously within the `filters` insert (AFTER trigger, same txn) before filter_details/RFID — verified in Task 4.
- **Audit:** keeps `ASSET_CREATED`/`asset_instance` action (registry unchanged); the mirror asset_instances row itself isn't separately audited (it's derived).
- **Adjustment point:** Task 3 bulk change must pass RAW field values to `filterService.create` (it re-derives attributes), not the pre-built `attributes` — called out inline.
