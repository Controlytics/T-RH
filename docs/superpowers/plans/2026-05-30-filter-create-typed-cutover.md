# Filter Single-Create Typed Cutover (A-01 Slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Filter single-creation off the asset-template / `templateId` / generic-`attributes` API surface onto a concrete typed endpoint (`POST /api/hierarchy/filters`) whose dropdown fields are validated against the live `filter-field-options` config — without touching the dual-write persistence the rest of the app depends on.

**Architecture:** Persistence is unchanged. A DB trigger (`fn_mirror_asset_instance`) already mirrors every `asset_instances` write into the typed `filters` table by `template_kind`, and `instanceService.create` already creates the `FilterDetails` sidecar (filterSet + filterProfileId). So the cutover is an **API-surface + field-source** change only: a new endpoint takes concrete filter fields (no `templateId`, no generic `attributes`), resolves the FILTER template internally for the unavoidable `asset_instances.template_id` FK, validates `ahuType`/`filterType`/`micronSize` against the live config (NOT the template `attributeSchema`), maps them into the `attributes` JSON internally, and delegates to the proven `instanceService.create`. The web create dialog is repointed at it and its dynamic-attributeSchema field block is removed.

**Tech Stack:** Fastify + Prisma (apps/api), React + SWR (apps/web), vitest (both). exceljs already added (for Slice 2; inert here).

**Scope boundary:** This plan covers **single-create only**. Bulk upload (Slice 2) is a separate follow-up plan that reuses the field-options validator built here. Filter **edit** (`EditFilterDialog`) is out of scope and stays on the legacy path for now (the FILTER template `attributeSchema` is empty, so there is no functional divergence).

**Pre-existing inert files** (created earlier this session for Slice 2, harmless, do not delete): `apps/api/src/modules/assets/services/filter-upload-shared.service.ts`, `apps/api/src/modules/assets/services/filter-upload-template.service.ts`. Task 1 supersedes the first.

---

## File Structure

- **Create** `apps/api/src/modules/assets/services/filter-fields.service.ts` — single source for filter field-option master data: `loadFilterFieldOptions()`, `resolveFilterTemplateRef()`, `validateAndBuildFilterAttributes()`. Reused by Slice 2.
- **Create** `apps/api/src/modules/assets/services/__tests__/filter-fields.service.test.ts` — unit tests for the validator.
- **Modify** `apps/api/src/modules/hierarchy/hierarchy.service.ts` — add `createFilter(input, ctx)`.
- **Modify** `apps/api/src/modules/hierarchy/routes.ts` — add `POST /filters`.
- **Create** `apps/api/src/modules/hierarchy/__tests__/create-filter.routes.test.ts` — integration test.
- **Modify** `apps/web/src/routes/filter-management/filter-list.tsx` — repoint `submitCreateFilter`; drop create-path attributeSchema usage.
- **Modify** `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx` — remove the dynamic-attributeSchema field block + its props.
- **Delete** the now-inert `filter-upload-shared.service.ts` (its content is folded into `filter-fields.service.ts`).

---

## Task 1: Field-options validator service

**Files:**
- Create: `apps/api/src/modules/assets/services/filter-fields.service.ts`
- Test: `apps/api/src/modules/assets/services/__tests__/filter-fields.service.test.ts`
- Delete: `apps/api/src/modules/assets/services/filter-upload-shared.service.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/assets/services/__tests__/filter-fields.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAndBuildFilterAttributes } from '../filter-fields.service.js';
import { prisma } from '../../../../lib/prisma.js';

vi.mock('../../../../lib/prisma.js', () => ({
  prisma: { systemConfig: { findUnique: vi.fn() } },
}));

const OPTS = { ahuType: ['Process', 'Non Process'], filterType: ['HEPA', 'PRE'], micronSize: ['5', '10'] };

beforeEach(() => {
  (prisma.systemConfig.findUnique as any).mockResolvedValue({ configValue: { value: OPTS } });
});

describe('validateAndBuildFilterAttributes', () => {
  it('accepts in-list values (case-insensitive) and builds attributes', async () => {
    const r = await validateAndBuildFilterAttributes({ ahuType: 'process', filterType: 'HEPA', micronSize: '5' });
    expect(r.errors).toEqual([]);
    expect(r.attributes).toEqual({ ahuType: 'Process', filterType: 'HEPA', micronSize: '5' });
  });

  it('rejects an out-of-list value with field/value/message', async () => {
    const r = await validateAndBuildFilterAttributes({ filterType: 'CARBON' });
    expect(r.attributes).toEqual({});
    expect(r.errors).toEqual([
      { field: 'filterType', value: 'CARBON', message: 'must be one of: HEPA, PRE' },
    ]);
  });

  it('stores lastCleaningDate NA and ISO date, rejects garbage', async () => {
    expect((await validateAndBuildFilterAttributes({ lastCleaningDate: 'NA' })).attributes).toEqual({ lastCleaningDate: 'NA' });
    expect((await validateAndBuildFilterAttributes({ lastCleaningDate: '2026-04-15' })).attributes).toEqual({ lastCleaningDate: '2026-04-15' });
    const bad = await validateAndBuildFilterAttributes({ lastCleaningDate: '15/04/2026' });
    expect(bad.errors[0]).toEqual({ field: 'lastCleaningDate', value: '15/04/2026', message: 'must be a date (YYYY-MM-DD) or NA' });
  });

  it('omits empty/blank optional fields without error', async () => {
    const r = await validateAndBuildFilterAttributes({ ahuType: '', filterType: undefined, micronSize: null, lastCleaningDate: '' });
    expect(r.errors).toEqual([]);
    expect(r.attributes).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/assets/services/__tests__/filter-fields.service.test.ts`
Expected: FAIL — cannot find module `../filter-fields.service.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/assets/services/filter-fields.service.ts
//
// Single source for the concrete Filter field-option master data. Per the
// A-01 direction (D2=A), filter fields come from the runtime
// `filter-field-options` config — NOT the asset-template attributeSchema.
// Used by single-create (Slice 1) and bulk upload (Slice 2).
import { prisma } from '../../../lib/prisma.js';

export interface FilterFieldOptions {
  ahuType: string[];
  filterType: string[];
  micronSize: string[];
}

export interface FilterFieldInput {
  ahuType?: string | null;
  filterType?: string | null;
  micronSize?: string | null;
  lastCleaningDate?: string | null; // 'NA' | 'YYYY-MM-DD' | '' | null
}

export interface FilterFieldError { field: string; value: string; message: string; }
export interface FilterFieldResult { attributes: Record<string, unknown>; errors: FilterFieldError[]; }

// Reads the same config row the web app reads via GET /api/filters/field-options.
export async function loadFilterFieldOptions(): Promise<FilterFieldOptions> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'filter-field-options' } });
  const stored = row?.configValue as { value?: Record<string, unknown> } | undefined;
  const inner = (stored && typeof stored === 'object' && 'value' in stored ? stored.value : {}) ?? {};
  return {
    ahuType: Array.isArray((inner as any).ahuType) ? ((inner as any).ahuType as string[]) : ['Process', 'Non Process'],
    filterType: Array.isArray((inner as any).filterType) ? ((inner as any).filterType as string[]) : [],
    micronSize: Array.isArray((inner as any).micronSize) ? ((inner as any).micronSize as string[]) : [],
  };
}

// Resolves the FILTER-kind template id/version for the unavoidable
// asset_instances.template_id FK. NOT a field source — attributeSchema is
// ignored. Same value the web single-create posts as `filterTemplateId`.
export async function resolveFilterTemplateRef(): Promise<{ id: string; version: number } | null> {
  const t = await prisma.assetTemplate.findFirst({
    where: { templateKind: 'FILTER', isActive: true },
    select: { id: true, version: true },
    orderBy: { createdAt: 'asc' },
  });
  return t ? { id: t.id, version: t.version } : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Optional-but-validated, mirroring single-create (no asterisk there): a blank
// field is omitted; a present field must be in the live master-data list.
export async function validateAndBuildFilterAttributes(input: FilterFieldInput): Promise<FilterFieldResult> {
  const opts = await loadFilterFieldOptions();
  const attributes: Record<string, unknown> = {};
  const errors: FilterFieldError[] = [];

  const checkList = (field: 'ahuType' | 'filterType' | 'micronSize', list: string[]) => {
    const raw = (input[field] ?? '').toString().trim();
    if (!raw) return;
    const match = list.find((o) => o.toLowerCase() === raw.toLowerCase());
    if (!match) errors.push({ field, value: raw, message: `must be one of: ${list.join(', ')}` });
    else attributes[field] = match;
  };
  checkList('ahuType', opts.ahuType);
  checkList('filterType', opts.filterType);
  checkList('micronSize', opts.micronSize);

  const lcd = (input.lastCleaningDate ?? '').toString().trim();
  if (lcd) {
    if (lcd.toUpperCase() === 'NA') attributes.lastCleaningDate = 'NA';
    else if (ISO_DATE.test(lcd) && !Number.isNaN(Date.parse(lcd))) attributes.lastCleaningDate = lcd;
    else errors.push({ field: 'lastCleaningDate', value: lcd, message: 'must be a date (YYYY-MM-DD) or NA' });
  }

  return { attributes, errors };
}
```

- [ ] **Step 4: Delete the superseded scaffold**

Run: `cd apps/api && rm src/modules/assets/services/filter-upload-shared.service.ts`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/assets/services/__tests__/filter-fields.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/assets/services/filter-fields.service.ts \
        apps/api/src/modules/assets/services/__tests__/filter-fields.service.test.ts
git rm apps/api/src/modules/assets/services/filter-upload-shared.service.ts
git commit -m "feat(a-01 slice1): filter field-options validator service"
```

---

## Task 2: `createFilter` service method

**Files:**
- Modify: `apps/api/src/modules/hierarchy/hierarchy.service.ts` (add method to the `hierarchyService` object at line 200, and imports at top)
- Test: covered by Task 3 integration test (service is thin; validator already unit-tested)

- [ ] **Step 1: Add imports at the top of `hierarchy.service.ts`**

```ts
import { instanceService } from '../assets/services/instance.service.js';
import { resolveFilterTemplateRef, validateAndBuildFilterAttributes, type FilterFieldInput } from '../assets/services/filter-fields.service.js';
import { ValidationError } from '../../lib/errors.js';
import type { RequestContext } from '../../types/context.js';
```

> Verify the `ValidationError` import path matches `instance.service.ts`'s import (grep `ValidationError` in that file). Adjust if it differs.

- [ ] **Step 2: Add the `createFilter` method inside the `hierarchyService` object**

```ts
  // Typed filter create (A-01 Slice 1). Concrete fields only — no templateId,
  // no generic attributes from the caller. Resolves the FILTER template
  // internally for the asset_instances FK; the fn_mirror_asset_instance
  // trigger mirrors the write into the typed `filters` table, and
  // instanceService.create writes the FilterDetails sidecar (filterSet +
  // filterProfileId). Field-option values are validated against the live
  // filter-field-options config and folded into the attributes JSON.
  async createFilter(
    input: FilterFieldInput & {
      name: string;
      ahuId: string;
      filterSet?: 'A' | 'B';
      filterProfileId?: string;
    },
    ctx: RequestContext,
  ) {
    const tmpl = await resolveFilterTemplateRef();
    if (!tmpl) throw new ValidationError('No active FILTER template is configured');

    const { attributes, errors } = await validateAndBuildFilterAttributes(input);
    if (errors.length > 0) throw new ValidationError('FILTER_FIELD_VALIDATION_ERROR', errors as any);

    return instanceService.create(
      {
        name: input.name,
        templateId: tmpl.id,
        parentId: input.ahuId,
        ...(input.filterSet ? { filterSet: input.filterSet } : {}),
        ...(input.filterProfileId ? { filterProfileId: input.filterProfileId } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      },
      ctx,
    );
  },
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit`
Expected: no errors. (If `ValidationError` arity differs — some codebases use `new ValidationError(message)` only — match the existing call style used in `instance.service.ts`.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/hierarchy/hierarchy.service.ts
git commit -m "feat(a-01 slice1): hierarchyService.createFilter delegates to instanceService"
```

---

## Task 3: `POST /api/hierarchy/filters` route + integration test

**Files:**
- Modify: `apps/api/src/modules/hierarchy/routes.ts` (imports at top; new route inside `hierarchyRoutes`)
- Test: `apps/api/src/modules/hierarchy/__tests__/create-filter.routes.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/modules/hierarchy/__tests__/create-filter.routes.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, loginAs } from '../../../../test/helpers.js'; // match the helper used by hierarchy.routes.test.ts
import { prisma } from '../../../lib/prisma.js';

let app: any; let token: string; let ahuId: string;

beforeAll(async () => {
  app = await buildTestApp();
  token = await loginAs(app, 'admin');
  const ahu = await prisma.assetInstance.findFirst({
    where: { template: { templateKind: 'AHU' }, isActive: true }, select: { id: true },
  });
  ahuId = ahu!.id;
});

describe('POST /api/hierarchy/filters', () => {
  it('creates a filter from concrete fields and persists ahuType into attributes', async () => {
    const name = `PlanTest-${Date.now()}`;
    const res = await app.inject({
      method: 'POST', url: '/api/hierarchy/filters',
      headers: { authorization: `Bearer ${token}` },
      payload: { name, ahuId, filterSet: 'A', ahuType: 'Process', filterType: 'HEPA', micronSize: '5' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().data.id;
    const typed = await prisma.filter.findUnique({ where: { id } });
    expect(typed).not.toBeNull();
    expect((typed!.attributes as any).ahuType).toBe('Process');
    const fd = await prisma.filterDetails.findUnique({ where: { assetInstanceId: id } });
    expect(fd!.filterSet).toBe('SET_A');
  });

  it('rejects an out-of-list dropdown value with 400 + field/value/message', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/hierarchy/filters',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Bad-${Date.now()}`, ahuId, filterType: 'CARBON' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('must be one of');
  });
});
```

> Before writing the route, open `apps/api/src/modules/hierarchy/__tests__/hierarchy.routes.test.ts` and copy its exact app-build + login helper imports/calls into this file (the placeholders `buildTestApp`/`loginAs` above must match the real helpers).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/hierarchy/__tests__/create-filter.routes.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add imports to `routes.ts`**

```ts
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { ValidationError } from '../../lib/errors.js';
```

- [ ] **Step 4: Add the route inside `hierarchyRoutes` (after the `/filters/:id` GET, ~line 296)**

```ts
  app.post('/filters', {
    preHandler: [app.requireAnyPermission('ASSET_CREATE', 'FILTER_CREATE', 'FILTER_HIERARCHY_CREATE')],
    schema: {
      tags: ['Hierarchy'],
      summary: 'Create a filter (typed)',
      description: 'Create a filter from concrete fields. No templateId/attributes — dropdown values are validated against the live filter-field-options config.',
      body: {
        type: 'object',
        required: ['name', 'ahuId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          ahuId: { type: 'string', format: 'uuid' },
          filterSet: { type: 'string', enum: ['A', 'B'] },
          ahuType: { type: 'string' },
          filterType: { type: 'string' },
          micronSize: { type: 'string' },
          lastCleaningDate: { type: 'string' },
          filterProfileId: { type: 'string', format: 'uuid' },
        },
        additionalProperties: false,
      },
      response: {
        201: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth(['CREATE_ASSET', 'CREATE_FILTER'], req, reply);
    if (!ok) return;
    try {
      const data = await hierarchyService.createFilter(req.body as any, buildContext(req));
      return reply.code(201).send({ success: true, data });
    } catch (err: any) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message, details: (err as any).details ?? undefined });
      }
      throw err;
    }
  });
```

> Confirm `ValidationError` exposes its detail payload as `.details` (grep its definition in `apps/api/src/lib/errors.ts`). If the field is named differently, adjust the `details:` line so the validator's `{field,value,message}[]` reaches the client.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/hierarchy/__tests__/create-filter.routes.test.ts`
Expected: PASS (2 tests). If login/helper wiring needs a unique SUPER_ADMIN per the API testing note, provision one in `beforeAll` instead of shared `admin`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/hierarchy/routes.ts apps/api/src/modules/hierarchy/__tests__/create-filter.routes.test.ts
git commit -m "feat(a-01 slice1): POST /api/hierarchy/filters typed filter create"
```

---

## Task 4: Repoint web `submitCreateFilter` + drop create-path attributeSchema

**Files:**
- Modify: `apps/web/src/routes/filter-management/filter-list.tsx` (`submitCreateFilter`, ~lines 960-1030; the `<CreateFilterDialog>` call site ~line 1818)
- Modify: `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx`

- [ ] **Step 1: Replace the body of `submitCreateFilter`**

Replace lines 960-1030 (the whole function) with:

```ts
  const submitCreateFilter = async () => {
    if (!createFilterAhu || !createFilterName.trim()) {
      setCreateFilterError('Please choose an AHU and enter a filter name.');
      return;
    }
    setCreateFilterSubmitting(true);
    setCreateFilterError('');
    try {
      await reauth.execute('CREATE_FILTER', async (password?: string) => {
        // Typed create (A-01 Slice 1) — concrete fields only, no templateId,
        // no generic attributes. Field-option values validated server-side
        // against the live filter-field-options config.
        const body: any = {
          name: createFilterName.trim(),
          ahuId: createFilterAhu,
          filterSet: createFilterSet,
          ...(createFilterAhuType && { ahuType: createFilterAhuType }),
          ...(createFilterFilterType && { filterType: createFilterFilterType }),
          ...(createFilterMicronSize && { micronSize: createFilterMicronSize }),
          ...(createFilterProfile && { filterProfileId: createFilterProfile }),
        };
        const lastEnc = encodeLastCleaningDate(createFilterLastCleaning);
        if (lastEnc !== undefined) body.lastCleaningDate = lastEnc;
        if (password) await api.postWithReauth('/api/hierarchy/filters', body, password);
        else await api.post('/api/hierarchy/filters', body);
      }, {
        onSuccess: () => {
          toast.success('Filter Created', `"${createFilterName}" added`);
          setCreateFilterOpen(false);
          mutate('/api/assets/instances?limit=500');
          mutate((k: string) => typeof k === 'string' && k.startsWith('/api/hierarchy/filters'));
          setCreateFilterSubmitting(false);
        },
        onError: (err: any) => {
          setCreateFilterError(err?.message ?? 'Failed to create filter');
          setCreateFilterSubmitting(false);
        },
      });
    } catch (err: any) {
      setCreateFilterError(err?.message ?? 'Failed to create filter');
      setCreateFilterSubmitting(false);
    }
  };
```

> `mutate` here is SWR's global `mutate` (already imported in this file — confirm; if the local import is the bound `mutate`, the key-filter form still works). The `filterTemplateId` / `filterAttributeSchema` / `findMissingRequiredAttributes` / `createFilterAttrs` references are intentionally gone from this path.

- [ ] **Step 2: Drop the attributeSchema props from the `<CreateFilterDialog>` call site (~line 1818)**

Remove these two props from the `<CreateFilterDialog ... />` element: `attrs={createFilterAttrs}` and `onAttrChange={setCreateFilterAttrs}` and `schema={filterAttributeSchema}`. Leave all other props (ahu, area, name, filterSet, fieldOptions, ahuType, filterType, micronSize, lastCleaning, and their handlers) intact.

- [ ] **Step 3: Remove the dynamic-attributeSchema block + props from `CreateFilterDialog.tsx`**

In `CreateFilterDialog.tsx`: delete `schema`, `attrs`, `onAttrChange` from both the `Props` type (lines 11, 13, 26) and the destructured params (lines 37-39), delete the `import ... TemplateField` reference if now unused, and delete the entire `{schema.length > 0 && ( ... )}` JSX block (lines 116-167). Keep the `FilterFieldOptionsSection` block — that is the concrete-field source and stays.

- [ ] **Step 4: Typecheck + build the web app**

Run: `cd apps/web && npx tsc --noEmit && npx vite build`
Expected: no type errors (unused `createFilterAttrs` state may now warn — remove the now-dead `createFilterAttrs` / `setCreateFilterAttrs` `useState` and the `filterAttributeSchema` memo + `findMissingRequiredAttributes` import only if they are no longer referenced anywhere else in the file; grep first). Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-list.tsx \
        apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx
git commit -m "feat(a-01 slice1): single-create posts /api/hierarchy/filters, drop attributeSchema fields"
```

---

## Task 5: Verify end-to-end + docs

**Files:**
- Modify: `CHANGELOG.md`, `tasks/A-01-COUPLED-CLUSTER-PLAN.md` (note), memory.

- [ ] **Step 1: Run the API suite (single-fork) for regressions**

Run: `cd apps/api && npm test`
Expected: no NEW failures vs the documented baseline (subtract the known pre-existing failures). The two new suites pass.

- [ ] **Step 2: Manual browser verify (Playwright or dev app)**

Start the dev stack. Open a block → Filters → Create Filter. Pick an AHU, name it, choose Set A + an AHU Type / Filter Type / Micron Size, Save. Confirm:
  - Success toast, filter appears in the list with the chosen AHU Type / Filter Type / Micron Size.
  - DevTools Network: the request goes to `POST /api/hierarchy/filters` (NOT `/api/assets/instances`), payload has no `templateId`/`attributes`.
  - No console errors; no unstyled UI.
  - Re-open the filter (traceability/edit) → ahuType/filterType/micronSize/lastCleaningDate persisted.
  - Negative: temporarily craft a request with a bogus `filterType` (or via the API) → 400 with a "must be one of" message.

- [ ] **Step 3: Grep for other callers that assumed single-create hit `/api/assets/instances`**

Run: `grep -rn "assets/instances" apps/web/src/routes/filter-management | grep -i create`
Expected: the create path no longer posts there. (Edit path may still — that's in scope-boundary.)

- [ ] **Step 4: Update docs**

- `CHANGELOG.md`: add an entry under A-01 — "Filter single-create cut over to `POST /api/hierarchy/filters` (concrete fields, no templateId/attributeSchema; field-options validated server-side). Bulk upload (Slice 2) to follow."
- `tasks/A-01-COUPLED-CLUSTER-PLAN.md`: note Slice 1 (single-create write cutover) shipped; bulk-upload + edit-path are follow-ups.
- Memory: write/refresh a `project` note pointing at this plan + the `filter-fields.service.ts` reuse point for Slice 2.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md tasks/A-01-COUPLED-CLUSTER-PLAN.md
git commit -m "docs(a-01 slice1): record filter single-create typed cutover"
```

---

## Self-review notes

- **Spec coverage:** "no templateId/attributes in the create surface" → Task 3 body schema (`additionalProperties:false`, no templateId) + Task 4 payload. "field values from live master data, not hardcoded" → Task 1 `loadFilterFieldOptions` reads config each call. "match single-create fields" → FilterFieldOptionsSection retained; same four fields + filterSet + name + AHU. "clear validation messages" → `{field,value,message}` surfaced as 400 details.
- **Persistence safety:** unchanged — trigger mirrors typed `filters`; `instanceService.create` writes `FilterDetails`. No new write path, so the dual-write invariant the rest of the app relies on is untouched.
- **Type consistency:** `validateAndBuildFilterAttributes` / `resolveFilterTemplateRef` / `loadFilterFieldOptions` names are identical across Tasks 1-2. `createFilter(input, ctx)` input shape matches the route body.
- **Known adjustment points flagged inline:** `ValidationError` import path + arity + detail-field name; test-app/login helper names (copy from the sibling hierarchy test); SWR `mutate` binding.
