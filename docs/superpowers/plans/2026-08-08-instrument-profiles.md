# Instrument Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group instruments under named profiles — create a profile, then register instruments inside it.

**Architecture:** One new table `instrument_profiles`; `instruments.profile_id` becomes a `NOT NULL` FK with `ON DELETE RESTRICT`, so the "a profile with instruments cannot be deleted" rule is enforced by Postgres rather than only by a service check. A new `/api/instrument-profiles` CRUD module reuses the existing `INSTRUMENT_*` permissions. `/instruments` becomes the profile list; today's instrument list moves to `/instruments/profiles/:id` unchanged in content.

**Tech Stack:** Fastify + Prisma (PostgreSQL 18) on the API; React 19 + Vite + SWR + Tailwind on the web; vitest both sides; Zod schemas in `@digilog/shared`.

**Spec:** `docs/superpowers/specs/2026-08-08-instrument-profiles-design.md`

## Global Constraints

- **Migrations are hand-authored.** `prisma db push` and `prisma migrate dev` auto-generation are FORBIDDEN — the baseline is a `pg_dump`. Use `prisma migrate diff` → review → hand-author → `npm run db:verify-migrations` (must PASS before commit). See `apps/api/CLAUDE.md`.
- **No new permission constants and no new reauth actions.** Reuse `INSTRUMENT_READ` / `INSTRUMENT_CREATE` / `INSTRUMENT_UPDATE` / `INSTRUMENT_DELETE`. Adding one drags in the `PERMISSION_TREE` frozen-snapshot test plus count updates in three CLAUDE.md files.
- **Fastify strips response properties not declared in the route schema.** Every response schema that should carry profile data must declare it, or the UI silently receives nothing.
- **The bulk CSV format does not change.** The profile is chosen once for the whole upload, as a sibling field to `csv`.
- **Instrument identity, tokens, MQTT topics and ingest are untouched.** Devices are addressed by UUID; nothing in this change may alter the wire.
- **Rebuild shared after editing it:** `npm run build -w @digilog/shared` before running API or web tests.
- **Run API tests single-fork:** `cd apps/api && npm test` (wired to `--pool=forks --poolOptions.forks.singleFork=true`). Other invocations flake.
- **Known-good API baseline:** 14 failures across 5 files — `auth-profile-reauth`, `entities`, `replacement-audit-enrichment`, `super-admin-unretire`, `block-change-approval-current`. All pre-existing. Any *other* failure is yours.
- **Known-good web baseline:** 5 failures across `url-utils` and `use-can`. Pre-existing.

---

### Task 1: Schema, migration and backfill

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add model; add 2 lines to `Instrument` near line 787)
- Create: `apps/api/prisma/migrations/20260808120000_add_instrument_profiles/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma model `InstrumentProfile` with fields `id, name, description, isActive, createdAt, updatedAt, createdBy, updatedBy` and relation `instruments`. `Instrument.profileId: string` (non-null) and `Instrument.profile`.

- [ ] **Step 1: Add the model to `schema.prisma`**

Insert immediately BEFORE `model Instrument {` (line ~750):

```prisma
/// A named container for instruments. Grouping only — a profile carries no
/// settings and nothing is inherited from it (see the 2026-08-08 design spec).
/// Deletion of a populated profile is refused by the FK below, not merely by
/// the service, so no future code path can orphan an instrument.
model InstrumentProfile {
  id          String   @id @default(uuid())
  name        String   @unique
  description String?
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy   String?  @map("created_by")
  updatedBy   String?  @map("updated_by")

  instruments Instrument[]

  @@map("instrument_profiles")
}
```

- [ ] **Step 2: Add the relation to `Instrument`**

In `model Instrument`, directly after the `attributes  InstrumentAttribute[]` line:

```prisma
  profileId String            @map("profile_id")
  profile   InstrumentProfile @relation(fields: [profileId], references: [id], onDelete: Restrict)
```

And add to the index block, next to `@@index([gatewayId])`:

```prisma
  @@index([profileId])
```

- [ ] **Step 3: Hand-author the migration**

Create `apps/api/prisma/migrations/20260808120000_add_instrument_profiles/migration.sql`:

```sql
-- Instrument Profiles: a named container for instruments.
--
-- profile_id is added in three moves rather than one because the table is
-- populated: a NOT NULL column cannot be added without a default, and we want
-- the backfill to be an explicit, reviewable statement rather than a column
-- default that silently disappears afterwards.

CREATE TABLE "instrument_profiles" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL,
    "created_by"  TEXT,
    "updated_by"  TEXT,
    CONSTRAINT "instrument_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instrument_profiles_name_key" ON "instrument_profiles"("name");

-- Every instrument that predates profiles lands here.
INSERT INTO "instrument_profiles" ("id", "name", "description", "updated_at")
VALUES (gen_random_uuid()::text, 'Default',
        'Instruments registered before profiles existed', CURRENT_TIMESTAMP);

ALTER TABLE "instruments" ADD COLUMN "profile_id" TEXT;

UPDATE "instruments"
   SET "profile_id" = (SELECT "id" FROM "instrument_profiles" WHERE "name" = 'Default');

ALTER TABLE "instruments" ALTER COLUMN "profile_id" SET NOT NULL;

-- RESTRICT, not CASCADE: deleting a profile must never destroy registered
-- devices, and must never leave one without a profile.
ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "instrument_profiles"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "instruments_profile_id_idx" ON "instruments"("profile_id");
```

- [ ] **Step 4: Apply to the dev database**

Run: `cd apps/api && npx prisma migrate deploy`
Expected: `1 migration found` … `Applied`.

- [ ] **Step 5: Regenerate the Prisma client**

Run: `cd apps/api && npx prisma generate`
Expected: `Generated Prisma Client`.

- [ ] **Step 6: Verify the backfill left nothing behind**

Run:
```bash
psql "postgresql://digilog:digilog123@localhost:5432/compliance_core_db" -c \
  "SELECT p.name, count(i.id) FROM instrument_profiles p LEFT JOIN instruments i ON i.profile_id = p.id GROUP BY p.name;"
```
Expected: one row, `Default`, with a count equal to the instrument count. Then:
```bash
psql "postgresql://digilog:digilog123@localhost:5432/compliance_core_db" -c \
  "SELECT count(*) FROM instruments WHERE profile_id IS NULL;"
```
Expected: `0`.

- [ ] **Step 7: Verify the FK actually refuses a populated delete**

This proves the constraint rather than trusting it:
```bash
psql "postgresql://digilog:digilog123@localhost:5432/compliance_core_db" -c \
  "DELETE FROM instrument_profiles WHERE name = 'Default';"
```
Expected: `ERROR: update or delete on table "instrument_profiles" violates foreign key constraint "instruments_profile_id_fkey" on table "instruments"`.

- [ ] **Step 8: Apply to the test database**

The suite runs against `compliance_core_db_test`:
```bash
cd apps/api && DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test?schema=public" npx prisma migrate deploy
```
Expected: `Applied`.

- [ ] **Step 9: Run the drift guard**

Run: `cd apps/api && npm run db:verify-migrations`
Expected: PASS. This is mandatory before commit — it builds a scratch DB from the migrations and asserts it diffs empty against the dev DB.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260808120000_add_instrument_profiles/
git commit -m "feat(instruments): add InstrumentProfile model and backfill existing instruments"
```

---

### Task 2: Shared Zod schemas and audit actions

**Files:**
- Create: `packages/shared/src/schemas/instrument-profiles.ts`
- Modify: `packages/shared/src/schemas/instruments.ts` (add `profileId` to create; add to bulk)
- Modify: `packages/shared/src/index.ts` (export the new schema module)
- Modify: `packages/shared/src/types/audit-actions.ts` (3 new actions)
- Test: `packages/shared/src/schemas/instrument-profiles.test.ts`

**Interfaces:**
- Consumes: Task 1's model shape.
- Produces: `createInstrumentProfileSchema`, `updateInstrumentProfileSchema`, types `CreateInstrumentProfileInput` / `UpdateInstrumentProfileInput`; `createInstrumentSchema` gains required `profileId: string (uuid)`; `bulkCreateInstrumentsSchema` gains required `profileId`; audit action constants `INSTRUMENT_PROFILE_CREATED` / `_UPDATED` / `_DELETED`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/schemas/instrument-profiles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createInstrumentProfileSchema, updateInstrumentProfileSchema } from './instrument-profiles.js';

describe('createInstrumentProfileSchema', () => {
  it('accepts a name alone', () => {
    expect(createInstrumentProfileSchema.parse({ name: 'Cleanroom-A' }))
      .toMatchObject({ name: 'Cleanroom-A', isActive: true });
  });

  it('rejects an empty name', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only name — it would render as a blank card', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('trims surrounding whitespace so "A " and "A" cannot both exist', () => {
    // The DB unique index is exact-match; without trimming, two profiles could
    // differ only by a trailing space and be indistinguishable on screen.
    expect(createInstrumentProfileSchema.parse({ name: '  Cleanroom-A  ' }).name).toBe('Cleanroom-A');
  });

  it('caps the name so it cannot overflow the card layout', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('updateInstrumentProfileSchema', () => {
  it('allows a partial update', () => {
    expect(updateInstrumentProfileSchema.parse({ description: 'new' }))
      .toEqual({ description: 'new' });
  });

  it('still rejects a blank name when one is supplied', () => {
    expect(updateInstrumentProfileSchema.safeParse({ name: '  ' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/schemas/instrument-profiles.test.ts`
Expected: FAIL — `Cannot find module './instrument-profiles.js'`.

- [ ] **Step 3: Write the schema**

Create `packages/shared/src/schemas/instrument-profiles.ts`:

```ts
import { z } from 'zod';

/**
 * A profile is a named container for instruments — grouping only. It carries no
 * settings, and instruments inherit nothing from it (2026-08-08 design spec).
 *
 * `name` is trimmed before validation because the database's unique index is an
 * exact match: without trimming, "Cleanroom-A" and "Cleanroom-A " are two
 * different profiles that look identical in every list.
 */
export const createInstrumentProfileSchema = z.object({
  name: z.string().trim().min(1, 'Profile name is required').max(120, 'Profile name must be 120 characters or fewer'),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().default(true),
});

export const updateInstrumentProfileSchema = z.object({
  name: z.string().trim().min(1, 'Profile name is required').max(120).optional(),
  description: z.string().trim().max(500).nullish(),
  isActive: z.boolean().optional(),
});

export type CreateInstrumentProfileInput = z.infer<typeof createInstrumentProfileSchema>;
export type UpdateInstrumentProfileInput = z.infer<typeof updateInstrumentProfileSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run src/schemas/instrument-profiles.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Export it from the barrel**

In `packages/shared/src/index.ts`, next to the other `schemas/` exports, add:

```ts
export * from './schemas/instrument-profiles.js';
```

- [ ] **Step 6: Add `profileId` to the instrument schemas**

In `packages/shared/src/schemas/instruments.ts`, inside `createInstrumentSchema` (after `code: codeSchema,`):

```ts
  // Required: every instrument belongs to exactly one profile. Existing rows
  // were backfilled to "Default" by migration 20260808120000.
  profileId: z.string().uuid('A profile must be selected'),
```

Inside `updateInstrumentSchema`, after the `isActive` line:

```ts
  // Moving an instrument between profiles. Optional — omitted means "leave it".
  profileId: z.string().uuid().optional(),
```

Replace `bulkCreateInstrumentsSchema` with:

```ts
export const bulkCreateInstrumentsSchema = z.object({
  csv: z.string().min(1, 'CSV content is required').max(1_048_576, 'CSV must be under 1 MB'),
  // Chosen ONCE for the whole upload, deliberately not a CSV column: adding a
  // column would change a file format operators already have on disk.
  profileId: z.string().uuid('A profile must be selected'),
});
```

- [ ] **Step 7: Add the audit actions**

In `packages/shared/src/types/audit-actions.ts`, after `INSTRUMENT_TOKEN_SET`:

```ts
  // Profiles are grouping only, but a RENAME changes what an inspector sees
  // against every instrument in the profile — so the change itself is auditable.
  // Moving an instrument between profiles is covered by INSTRUMENT_UPDATED.
  INSTRUMENT_PROFILE_CREATED: 'INSTRUMENT_PROFILE_CREATED',
  INSTRUMENT_PROFILE_UPDATED: 'INSTRUMENT_PROFILE_UPDATED',
  INSTRUMENT_PROFILE_DELETED: 'INSTRUMENT_PROFILE_DELETED',
```

- [ ] **Step 8: Build shared and run its whole suite**

Run: `npm run build -w @digilog/shared && cd packages/shared && npx vitest run`
Expected: all pass. If the frozen permission-snapshot test fails, you added a permission — revert that; this task adds none.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): instrument-profile schemas and audit actions"
```

---

### Task 3: Backend — the instrument-profiles module

**Files:**
- Create: `apps/api/src/modules/instrument-profiles/routes.ts`
- Modify: `apps/api/src/app.ts` (import near line 53, register near line 372)
- Test: `apps/api/src/e2e/instrument-profiles.e2e.test.ts`

**Interfaces:**
- Consumes: Task 2's `createInstrumentProfileSchema` / `updateInstrumentProfileSchema`; Task 1's `prisma.instrumentProfile`.
- Produces: `/api/instrument-profiles` — `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`. List items carry `{ id, name, description, isActive, instrumentCount, activeCount, createdAt, updatedAt, createdBy }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/e2e/instrument-profiles.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

let app: FastifyInstance;
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.instrument.deleteMany({ where: { code: { startsWith: 'IPT-' } } });
  await prisma.instrumentProfile.deleteMany({ where: { name: { startsWith: 'IPT ' } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: ADMIN_PASSWORD, force: true },
  });
  token = JSON.parse(res.body).token;
  await cleanup();
});

afterAll(async () => { await cleanup(); await app.close(); });
beforeEach(cleanup);

describe('POST /api/instrument-profiles', () => {
  it('creates a profile', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instrument-profiles', headers: auth(),
      payload: { name: 'IPT Cleanroom-A', description: 'Grade B' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({
      name: 'IPT Cleanroom-A', description: 'Grade B', isActive: true, instrumentCount: 0,
    });
  });

  it('refuses a duplicate name with 409, not a 500 from the unique index', async () => {
    await app.inject({ method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload: { name: 'IPT Dup' } });
    const res = await app.inject({ method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload: { name: 'IPT Dup' } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('DUPLICATE_NAME');
  });
});

describe('GET /api/instrument-profiles', () => {
  it('lists profiles with their instrument counts', async () => {
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload: { name: 'IPT Counted' },
    })).body);

    await prisma.instrument.create({
      data: { name: 'IPT-A', code: 'IPT-A', profileId: created.id, isActive: true },
    });
    await prisma.instrument.create({
      data: { name: 'IPT-B', code: 'IPT-B', profileId: created.id, isActive: false },
    });

    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles', headers: auth() });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body).data.find((p: any) => p.id === created.id);
    expect(row).toMatchObject({ instrumentCount: 2, activeCount: 1 });
  });
});

describe('DELETE /api/instrument-profiles/:id', () => {
  it('deletes an empty profile', async () => {
    const p = JSON.parse((await app.inject({
      method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload: { name: 'IPT Empty' },
    })).body);

    const res = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${p.id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(await prisma.instrumentProfile.findUnique({ where: { id: p.id } })).toBeNull();
  });

  it('REFUSES a profile that still has instruments, and says how many', async () => {
    const p = JSON.parse((await app.inject({
      method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload: { name: 'IPT Populated' },
    })).body);
    await prisma.instrument.create({ data: { name: 'IPT-C', code: 'IPT-C', profileId: p.id } });

    const res = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${p.id}`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('PROFILE_NOT_EMPTY');
    expect(JSON.parse(res.body).message).toContain('1');
    // Still there — the refusal is real, not cosmetic.
    expect(await prisma.instrumentProfile.findUnique({ where: { id: p.id } })).not.toBeNull();
  });

  it('the DATABASE refuses it too, not just the service', async () => {
    // Proves ON DELETE RESTRICT. If someone later removes the service check,
    // this still fails closed.
    const p = await prisma.instrumentProfile.create({ data: { name: 'IPT FkGuard' } });
    await prisma.instrument.create({ data: { name: 'IPT-D', code: 'IPT-D', profileId: p.id } });

    await expect(prisma.instrumentProfile.delete({ where: { id: p.id } })).rejects.toThrow();
  });
});

describe('PUT /api/instrument-profiles/:id', () => {
  it('renames a profile', async () => {
    const p = JSON.parse((await app.inject({
      method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload: { name: 'IPT Before' },
    })).body);

    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { name: 'IPT After' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('IPT After');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/e2e/instrument-profiles.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — every request 404s (route not registered).

- [ ] **Step 3: Write the module**

Create `apps/api/src/modules/instrument-profiles/routes.ts`:

```ts
import { type FastifyInstance } from 'fastify';
import { createInstrumentProfileSchema, updateInstrumentProfileSchema } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { errorResponses } from '../../lib/error-schemas.js';

/**
 * Instrument profiles — a named container for instruments. Grouping only: a
 * profile carries no settings and instruments inherit nothing from it.
 *
 * Permissions deliberately reuse INSTRUMENT_*: a profile is not a capability
 * boundary of its own, so anyone who may register an instrument may create the
 * folder it sits in. Adding dedicated constants would pull in the PERMISSION_TREE
 * frozen-snapshot test and three documented counts for no access-control gain.
 */

const profileProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  isActive: { type: 'boolean' },
  instrumentCount: { type: 'integer' },
  activeCount: { type: 'integer' },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  createdBy: { type: 'string', nullable: true },
};

type ProfileRow = {
  id: string; name: string; description: string | null; isActive: boolean;
  createdAt: Date; updatedAt: Date; createdBy: string | null;
  instruments?: { isActive: boolean }[];
};

/** Shape a row for the wire, deriving both counts from the same fetch. */
function present(row: ProfileRow) {
  const instruments = row.instruments ?? [];
  const { instruments: _drop, ...rest } = row;
  return {
    ...rest,
    instrumentCount: instruments.length,
    activeCount: instruments.filter((i) => i.isActive).length,
  };
}

const withInstruments = { instruments: { select: { isActive: true } } };

/** Prisma's unique-constraint error, narrowed to this table's name index. */
function isDuplicateName(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export default async function instrumentProfileRoutes(app: FastifyInstance) {
  // GET /api/instrument-profiles
  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'List instrument profiles',
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: profileProps } },
            total: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async () => {
    const rows = await prisma.instrumentProfile.findMany({
      include: withInstruments,
      orderBy: { name: 'asc' },
    });
    return { data: rows.map((r) => present(r as ProfileRow)), total: rows.length };
  });

  // GET /api/instrument-profiles/:id
  app.get('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Get an instrument profile',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.instrumentProfile.findUnique({ where: { id }, include: withInstruments });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    return present(row as ProfileRow);
  });

  // POST /api/instrument-profiles
  app.post('/', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Create an instrument profile',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
      response: { 201: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const parsed = createInstrumentProfileSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const ctx = buildContext(req);

    try {
      const row = await prisma.instrumentProfile.create({
        data: { ...parsed.data, createdBy: ctx.userId },
        include: withInstruments,
      });

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_CREATED',
        targetType: 'instrument_profile', targetId: row.id,
        afterValue: { name: row.name, description: row.description, isActive: row.isActive },
        signatureMeaning: `Instrument profile "${row.name}" created`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });

      return reply.code(201).send(present(row as ProfileRow));
    } catch (err) {
      if (isDuplicateName(err)) {
        return reply.code(409).send({
          error: 'DUPLICATE_NAME',
          message: `A profile named "${parsed.data.name}" already exists.`,
        });
      }
      throw err;
    }
  });

  // PUT /api/instrument-profiles/:id
  app.put('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Update an instrument profile',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          isActive: { type: 'boolean' },
        },
      },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateInstrumentProfileSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const before = await prisma.instrumentProfile.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    const ctx = buildContext(req);

    try {
      const row = await prisma.instrumentProfile.update({
        where: { id },
        data: { ...parsed.data, updatedBy: ctx.userId },
        include: withInstruments,
      });

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_UPDATED',
        targetType: 'instrument_profile', targetId: id,
        beforeValue: { name: before.name, description: before.description, isActive: before.isActive },
        afterValue: { name: row.name, description: row.description, isActive: row.isActive },
        signatureMeaning: before.name === row.name
          ? `Instrument profile "${row.name}" updated`
          : `Instrument profile renamed "${before.name}" → "${row.name}"`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });

      return present(row as ProfileRow);
    } catch (err) {
      if (isDuplicateName(err)) {
        return reply.code(409).send({
          error: 'DUPLICATE_NAME',
          message: `A profile named "${parsed.data.name}" already exists.`,
        });
      }
      throw err;
    }
  });

  // DELETE /api/instrument-profiles/:id
  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Delete an instrument profile',
      description: 'Refused while the profile still contains instruments.',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.instrumentProfile.findUnique({
      where: { id }, include: { _count: { select: { instruments: true } } },
    });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });

    // Checked here so the operator gets a COUNT and a next step. The FK
    // (ON DELETE RESTRICT) refuses it regardless — this check exists for the
    // message, not for the safety.
    if (row._count.instruments > 0) {
      const n = row._count.instruments;
      return reply.code(409).send({
        error: 'PROFILE_NOT_EMPTY',
        message: `"${row.name}" still contains ${n} instrument${n === 1 ? '' : 's'}. `
          + 'Move or delete them before deleting the profile.',
      });
    }

    const ctx = buildContext(req);
    await prisma.instrumentProfile.delete({ where: { id } });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'INSTRUMENT_PROFILE_DELETED',
      targetType: 'instrument_profile', targetId: id,
      beforeValue: { name: row.name, description: row.description, isActive: row.isActive },
      signatureMeaning: `Instrument profile "${row.name}" deleted`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { success: true };
  });
}
```

- [ ] **Step 4: Register it in `app.ts`**

Add the import next to the other instrument imports (~line 53):

```ts
import instrumentProfileRoutes from './modules/instrument-profiles/routes.js';
```

Add the registration immediately BEFORE the `instrumentRoutes` registration (~line 372):

```ts
await app.register(instrumentProfileRoutes, { prefix: '/api/instrument-profiles' });
```

- [ ] **Step 5: Register it in the test harness**

`apps/api/src/e2e/test-helper.ts` builds its own Fastify instance. Add the import next to `instrumentRoutes`:

```ts
import instrumentProfileRoutes from '../modules/instrument-profiles/routes.js';
```

and the registration next to the instruments one:

```ts
await app.register(instrumentProfileRoutes, { prefix: '/api/instrument-profiles' });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/e2e/instrument-profiles.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/instrument-profiles apps/api/src/app.ts apps/api/src/e2e/test-helper.ts apps/api/src/e2e/instrument-profiles.e2e.test.ts
git commit -m "feat(instruments): instrument-profiles CRUD with non-empty delete guard"
```

---

### Task 4: Backend — wire `profileId` through instruments

**Files:**
- Modify: `apps/api/src/modules/instruments/routes.ts` (`instrumentProps` ~line 51; `POST /` body ~line 545; `POST /bulk` ~line 602; `PUT /:id` ~line 665)
- Test: `apps/api/src/e2e/instrument-profiles.e2e.test.ts` (append a describe block)

**Interfaces:**
- Consumes: Task 2's `createInstrumentSchema.profileId`, `bulkCreateInstrumentsSchema.profileId`, `updateInstrumentSchema.profileId`.
- Produces: instrument reads carry `profileId` and `profileName`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/e2e/instrument-profiles.e2e.test.ts`:

```ts
describe('instruments carry their profile', () => {
  async function makeProfile(name: string) {
    return JSON.parse((await app.inject({
      method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload: { name },
    })).body);
  }

  it('POST /api/instruments requires a profile', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-E', code: 'IPT-E' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates an instrument inside a profile and reads it back', async () => {
    const p = await makeProfile('IPT Wire');
    const created = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-F', code: 'IPT-F', profileId: p.id },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).profileId).toBe(p.id);

    const read = await app.inject({
      method: 'GET', url: `/api/instruments/${JSON.parse(created.body).id}`, headers: auth(),
    });
    expect(JSON.parse(read.body)).toMatchObject({ profileId: p.id, profileName: 'IPT Wire' });
  });

  it('rejects a profileId that does not exist, with 400 not 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-G', code: 'IPT-G', profileId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('PROFILE_NOT_FOUND');
  });

  it('moves an instrument between profiles', async () => {
    const from = await makeProfile('IPT From');
    const to = await makeProfile('IPT To');
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-H', code: 'IPT-H', profileId: from.id },
    })).body);

    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${created.id}`, headers: auth(),
      payload: { profileId: to.id },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).profileId).toBe(to.id);
  });

  it('applies ONE profile to every row of a bulk upload, with no CSV column', async () => {
    const p = await makeProfile('IPT Bulk');
    const csv = 'code,name\nIPT-I,IPT-I\nIPT-J,IPT-J\n';
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: auth(),
      payload: { csv, profileId: p.id },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.instrument.findMany({ where: { code: { in: ['IPT-I', 'IPT-J'] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.profileId === p.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/e2e/instrument-profiles.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — the create returns 500 (`profileId` missing at the DB level) or 201 without the field.

- [ ] **Step 3: Declare the fields on the response shape**

In `apps/api/src/modules/instruments/routes.ts`, add to `instrumentProps` (~line 51), after `isActive`:

```ts
  // Fastify strips undeclared response properties — omit these and the UI sees
  // no profile at all, however correct the query is.
  profileId: { type: 'string' },
  profileName: { type: 'string', nullable: true },
```

- [ ] **Step 4: Include the profile name in reads**

Find `const activeCredential = {` (~line 128) and add below it:

```ts
/** Reads join the profile purely for its name — the UI shows a label, not an id. */
const withProfileName = { profile: { select: { name: true } } };
```

Then in `present()` (~line 115), change the body to:

```ts
function present(row: InstrumentRow) {
  const { credentials, profile, ...rest } = row as InstrumentRow & { profile?: { name: string } | null };
  const active = credentials?.[0];
  return {
    ...rest,
    profileName: profile?.name ?? null,
    tokenPrefix: active?.tokenPrefix ?? null,
    // The CIPHERTEXT ITSELF is destructured away with `credentials` and never
    // reaches the client — only the boolean derived from it. Selecting it here
    // is what lets the UI decide whether Reveal is even offered.
    tokenRevealable: Boolean(active?.tokenEncrypted) && tokenKeyConfigured(),
  };
}
```

Then add `...withProfileName` to every `include:` that already has `credentials: activeCredential` in this file. Find them with:

```bash
grep -n "credentials: activeCredential" apps/api/src/modules/instruments/routes.ts
```

Each becomes `include: { credentials: activeCredential, ...withProfileName }`.

- [ ] **Step 5: Add `profileId` to the create and update body schemas**

In `POST /` body properties (~line 548), after `isActive`:

```ts
          profileId: { type: 'string', format: 'uuid' },
```

and change `required: ['name', 'code']` to `required: ['name', 'code', 'profileId']`.

In `POST /bulk` body (~line 607), change to:

```ts
      body: {
        type: 'object',
        required: ['csv', 'profileId'],
        properties: { csv: { type: 'string' }, profileId: { type: 'string', format: 'uuid' } },
      },
```

In `PUT /:id` body properties, add:

```ts
          profileId: { type: 'string', format: 'uuid' },
```

- [ ] **Step 6: Turn an unknown profile into a 400**

Add this helper next to `isDuplicateCode` in `apps/api/src/modules/instruments/routes.ts`:

```ts
/**
 * A profileId that names no profile would otherwise surface as a raw FK error
 * (500). Checked explicitly so the operator is told which field is wrong.
 * There is a benign race — a profile deleted between this check and the insert
 * — but a populated profile cannot be deleted, so the window closes itself.
 */
async function profileMissing(profileId: string | undefined): Promise<boolean> {
  if (!profileId) return false;
  return !(await prisma.instrumentProfile.findUnique({ where: { id: profileId }, select: { id: true } }));
}
```

In the `POST /` handler, immediately after the `gatewayInvariantError` check:

```ts
    if (await profileMissing(parsed.data.profileId)) {
      return reply.code(400).send({ error: 'PROFILE_NOT_FOUND', message: 'The selected profile no longer exists.' });
    }
```

In the `POST /bulk` handler, immediately after the `bulkCreateInstrumentsSchema` parse succeeds:

```ts
    if (await profileMissing(parsed.data.profileId)) {
      return reply.code(400).send({ error: 'PROFILE_NOT_FOUND', message: 'The selected profile no longer exists.' });
    }
```

and add the profile to each draft where `createWithCredential` is called in that loop:

```ts
          created.push(await createWithCredential(
            { ...sanitizeStrings(draft as unknown as Record<string, unknown>, IDENTITY_FIELDS),
              profileId: parsed.data.profileId }, ctx,
          ));
```

In the `PUT /:id` handler, after its own body parse:

```ts
    if (await profileMissing((parsed.data as { profileId?: string }).profileId)) {
      return reply.code(400).send({ error: 'PROFILE_NOT_FOUND', message: 'The selected profile no longer exists.' });
    }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/e2e/instrument-profiles.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (13 tests).

- [ ] **Step 8: Typecheck**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/instruments/routes.ts apps/api/src/e2e/instrument-profiles.e2e.test.ts
git commit -m "feat(instruments): every instrument belongs to a profile"
```

---

### Task 5: Repair the existing instrument fixtures

**Files:**
- Modify: `apps/api/src/e2e/instrument-ingest.test.ts`
- Modify: `apps/api/src/e2e/mqtt-auth.test.ts`
- Modify: `apps/api/src/e2e/mqtt-ingest.test.ts`
- Modify: `apps/api/src/e2e/tcp-ingest.test.ts`
- Modify: `apps/api/src/e2e/ws-ingest.test.ts`

**Interfaces:**
- Consumes: Task 1's non-null `profileId`.
- Produces: nothing new — restores the suite to its baseline.

- [ ] **Step 1: See exactly which calls break**

Run: `cd apps/api && npx vitest run src/e2e/instrument-ingest.test.ts src/e2e/mqtt-auth.test.ts src/e2e/mqtt-ingest.test.ts src/e2e/tcp-ingest.test.ts src/e2e/ws-ingest.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — Prisma rejects `instrument.create` for a missing required `profileId`.

- [ ] **Step 2: Add a fixture profile to each file**

In each of the five files, inside the existing `beforeAll`, BEFORE the first `prisma.instrument.create`, add (changing the name per file so parallel files never collide):

```ts
  // Instruments require a profile since migration 20260808120000. One throwaway
  // profile per file keeps these fixtures independent of each other.
  const profile = await prisma.instrumentProfile.upsert({
    where: { name: 'fixture:<THIS-FILE-NAME>' },
    update: {},
    create: { name: 'fixture:<THIS-FILE-NAME>' },
  });
```

Use these exact names: `fixture:instrument-ingest`, `fixture:mqtt-auth`, `fixture:mqtt-ingest`, `fixture:tcp-ingest`, `fixture:ws-ingest`.

Then add `profileId: profile.id,` to the `data:` of every `prisma.instrument.create` in that file.

- [ ] **Step 3: Run the five files to verify they pass**

Run: `cd apps/api && npx vitest run src/e2e/instrument-ingest.test.ts src/e2e/mqtt-auth.test.ts src/e2e/mqtt-ingest.test.ts src/e2e/tcp-ingest.test.ts src/e2e/ws-ingest.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS.

- [ ] **Step 4: Run the FULL API suite and compare against the baseline**

Run: `cd apps/api && npm test`
Expected: exactly 14 failures across the 5 known files listed in Global Constraints. Any other failing file is a regression from this change — fix it before continuing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/e2e
git commit -m "test(instruments): give instrument fixtures a profile"
```

---

### Task 6: Frontend — the profile list page

**Files:**
- Create: `apps/web/src/routes/instruments/profile-list.tsx`
- Modify: `apps/web/src/main.tsx` (lazy import ~line 58; routes ~line 147)
- Test: manual, per Step 6.

**Interfaces:**
- Consumes: `GET/POST/PUT/DELETE /api/instrument-profiles` from Task 3.
- Produces: route `/instruments` renders `InstrumentProfileListPage`; route `/instruments/profiles/:id` renders the existing `InstrumentListPage`.

- [ ] **Step 1: Write the page**

Create `apps/web/src/routes/instruments/profile-list.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { api } from '../../lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';

interface Profile {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  instrumentCount: number;
  activeCount: number;
}

/**
 * The Instruments landing page: profiles first, instruments inside them.
 *
 * A profile is grouping only — no settings, nothing inherited. The counts are
 * the reason this page earns its place: an operator wants to know how many
 * instruments a group holds and how many are reporting, before drilling in.
 */
export function InstrumentProfileListPage() {
  const { data, mutate } = useSWR<{ data: Profile[] }>('/api/instrument-profiles');
  const { toast } = useToast();
  const canCreate = useCan('instruments.create');
  const canDelete = useCan('instruments.delete');

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const profiles = data?.data ?? [];

  const create = async () => {
    setSaving(true);
    try {
      await api.post('/api/instrument-profiles', { name, description: description || undefined });
      setName(''); setDescription(''); setCreating(false);
      mutate();
      toast.success('Profile created', `"${name}" is ready for instruments.`);
    } catch (e: any) {
      toast.error('Could not create profile', e?.message ?? 'Unknown error');
    }
    setSaving(false);
  };

  const remove = async (p: Profile) => {
    try {
      await api.delete(`/api/instrument-profiles/${p.id}`);
      mutate();
      toast.success('Profile deleted', `"${p.name}" was removed.`);
    } catch (e: any) {
      // The backend refuses a populated profile with a count and a next step —
      // surface its message rather than inventing a vaguer one here.
      toast.error('Could not delete profile', e?.message ?? 'Unknown error');
    }
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Instrument Profiles</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Group instruments by area, system or purpose. Open a profile to see and add its instruments.
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setCreating((c) => !c)}
            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-medium shadow-sm hover:from-blue-600 hover:to-blue-700"
          >
            {creating ? 'Cancel' : '+ New Profile'}
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Profile Name</span>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Cleanroom-A"
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Description <span className="text-slate-400">(optional)</span></span>
              <input
                value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Grade B cleanroom, Block 2"
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <button
              onClick={create} disabled={!name.trim() || saving}
              className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create Profile'}
            </button>
          </div>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200/60 p-12 text-center">
          <p className="text-slate-500">No profiles yet.</p>
          <p className="text-sm text-slate-400 mt-1">Create one to start registering instruments.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {profiles.map((p) => (
            <div key={p.id} className="group relative bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 hover:shadow-md transition-shadow">
              <Link to={`/instruments/profiles/${p.id}`} className="block">
                <h3 className="font-semibold text-slate-800">{p.name}</h3>
                {p.description && <p className="text-sm text-slate-500 mt-1 line-clamp-2">{p.description}</p>}
                <div className="flex items-baseline gap-4 mt-4">
                  <div>
                    <p className="text-2xl font-bold text-slate-800">{p.instrumentCount}</p>
                    <p className="text-xs text-slate-400">instrument{p.instrumentCount === 1 ? '' : 's'}</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-emerald-600">{p.activeCount}</p>
                    <p className="text-xs text-slate-400">active</p>
                  </div>
                </div>
              </Link>
              {canDelete && (
                <button
                  onClick={() => remove(p)}
                  title={p.instrumentCount > 0
                    ? `Contains ${p.instrumentCount} instrument${p.instrumentCount === 1 ? '' : 's'} — move or delete them first`
                    : 'Delete this profile'}
                  className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the routes**

In `apps/web/src/main.tsx`, next to the other instrument lazy imports (~line 58):

```tsx
const InstrumentProfileListPage = lazy(() => import('./routes/instruments/profile-list').then(m => ({ default: m.InstrumentProfileListPage })));
```

Replace the existing `/instruments` route with these two (the instrument list moves to the drill-in path):

```tsx
            <Route path="/instruments" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_READ]}><Suspense fallback={<LazyFallback />}><InstrumentProfileListPage /></Suspense></RequireRole>} />
            <Route path="/instruments/profiles/:profileId" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_READ]}><Suspense fallback={<LazyFallback />}><InstrumentListPage /></Suspense></RequireRole>} />
```

Leave `/instruments/new`, `/instruments/bulk` and `/instruments/:id` exactly as they are.

> Route order matters: `/instruments/profiles/:profileId` must be declared BEFORE `/instruments/:id`, or `profiles` is captured as an instrument id.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 4: Run the web suite**

Run: `cd apps/web && npm test`
Expected: the baseline 5 failures, no more.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instruments/profile-list.tsx apps/web/src/main.tsx
git commit -m "feat(web): instrument profiles landing page"
```

- [ ] **Step 6: See it in the browser**

Start the app (`cd apps/api && npx tsx watch src/app.ts` and `cd apps/web && npx vite --host`), sign in, open `/instruments`. Expected: a "Default" card showing the count of your existing instruments. Click it — the instrument list appears at `/instruments/profiles/<id>`.

---

### Task 7: Frontend — scope the list and wire the create paths

**Files:**
- Modify: `apps/web/src/routes/instruments/list.tsx`
- Modify: `apps/web/src/routes/instruments/create.tsx`
- Modify: `apps/web/src/routes/instruments/bulk-create.tsx`
- Modify: `apps/web/src/routes/instruments/detail.tsx`

**Interfaces:**
- Consumes: Task 4's `profileId` / `profileName` on instrument reads; Task 3's profile list.
- Produces: no new interfaces.

- [ ] **Step 1: Scope the list to its profile**

In `apps/web/src/routes/instruments/list.tsx`, add near the top of the component:

```tsx
  const { profileId } = useParams<{ profileId: string }>();
  const { data: profile } = useSWR<{ id: string; name: string }>(
    profileId ? `/api/instrument-profiles/${profileId}` : null,
  );
```

(add `useParams` to the existing `react-router-dom` import).

Filter the rows the page already fetched — the instrument list endpoint returns
`profileId`, so no API change is needed:

```tsx
  // Scoped to one profile. The endpoint returns every instrument; filtering
  // here keeps the tiles, search and table code identical to the unscoped page.
  const inProfile = profileId ? rows.filter((r) => r.profileId === profileId) : rows;
```

Use `inProfile` wherever the component previously used the full row list, and add the profile name to the heading:

```tsx
        <h1 className="text-2xl font-bold text-slate-800">
          {profile?.name ?? 'Instruments'}
        </h1>
```

Add a back link above the heading:

```tsx
        <Link to="/instruments" className="text-sm text-slate-500 hover:text-slate-700">← All profiles</Link>
```

Point the page's "New Instrument" and "Bulk" buttons at the profile-aware URLs:

```tsx
        <Link to={profileId ? `/instruments/new?profileId=${profileId}` : '/instruments/new'}>
```
```tsx
        <Link to={profileId ? `/instruments/bulk?profileId=${profileId}` : '/instruments/bulk'}>
```

Also add `profileId: string;` to the row interface at the top of the file (near `block: string | null;`).

- [ ] **Step 2: Pre-fill the profile on the create form**

In `apps/web/src/routes/instruments/create.tsx`, add:

```tsx
import { useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
```

Inside the component:

```tsx
  const [searchParams] = useSearchParams();
  const presetProfileId = searchParams.get('profileId');
  const { data: profiles } = useSWR<{ data: { id: string; name: string }[] }>('/api/instrument-profiles');
  const [profileId, setProfileId] = useState(presetProfileId ?? '');
```

Render, above the Instrument ID field — a read-only chip when the profile came
from the URL, a required selector otherwise:

```tsx
          {presetProfileId ? (
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
              <span className="text-xs text-slate-500">Profile</span>
              <p className="text-sm font-medium text-slate-800">
                {profiles?.data.find((p) => p.id === presetProfileId)?.name ?? '…'}
              </p>
            </div>
          ) : (
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Profile <span className="text-red-500">*</span></span>
              <select
                value={profileId} onChange={(e) => setProfileId(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="">Select a profile…</option>
                {profiles?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
```

Add `payload.profileId = profileId;` where the submit handler builds its payload
(next to the existing `if (isGateway) payload.isGateway = true;`), and disable
the submit button when `!profileId`.

On success, return to the profile rather than the flat list:

```tsx
      navigate(profileId ? `/instruments/profiles/${profileId}` : '/instruments');
```

- [ ] **Step 3: Add the profile selector to bulk upload**

In `apps/web/src/routes/instruments/bulk-create.tsx`, mirror Step 2: read
`profileId` from the query string, fetch `/api/instrument-profiles`, render the
same chip-or-selector above the CSV box, and include `profileId` in the POST body
alongside `csv`. **Do not touch the CSV parsing or its column list.**

- [ ] **Step 4: Show the profile on the detail page**

In `apps/web/src/routes/instruments/detail.tsx`, render the profile name near the
instrument's code, and add a Move control:

```tsx
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Profile</span>
          <select
            value={data.profileId}
            onChange={async (e) => {
              await api.put(`/api/instruments/${data.id}`, { profileId: e.target.value });
              mutate();
              toast.success('Instrument moved', 'The instrument now belongs to the selected profile.');
            }}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm"
          >
            {profiles?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
```

fetching `profiles` with the same `useSWR<{ data: { id: string; name: string }[] }>('/api/instrument-profiles')`.

- [ ] **Step 5: Typecheck and run the web suite**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npm test`
Expected: no type errors; the baseline 5 failures, no more.

- [ ] **Step 6: Exercise it in the browser**

With both servers running:
1. `/instruments` → create a profile "Cleanroom-A".
2. Open it → "+ New Instrument" → the profile shows as a chip → register one.
3. Back to `/instruments` → Cleanroom-A shows 1 instrument.
4. Try to delete Cleanroom-A → refused, message names the count.
5. Open the instrument → move it to Default → both counts change.
6. Delete Cleanroom-A → succeeds now it is empty.
7. Check the browser console is free of errors throughout.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/instruments
git commit -m "feat(web): create and view instruments within a profile"
```

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`, `apps/api/CLAUDE.md`, `packages/shared/CLAUDE.md` (model count)
- Modify: `API_REFERENCE.md`
- Modify: `tasks/todo.md`

- [ ] **Step 1: Correct the model count with a verified number**

Run: `grep -cE "^model " apps/api/prisma/schema.prisma`
Expected: `29`.

The three CLAUDE.md files currently claim **61 models**. That figure is stale
DigiLog inheritance and was never true in this fork — before this change the real
count was 28. Replace it with the verified `29` in all three, and add one line
recording why the number drops rather than rises:

> **29 Prisma models** (verified `grep -cE "^model "` 2026-08-08). The previous
> "61" was inherited from upstream DigiLog and never described this fork; the
> real count before Instrument Profiles was 28.

- [ ] **Step 2: Document the endpoints**

In `API_REFERENCE.md`, next to the instruments section:

```
GET    /api/instrument-profiles       Permission: INSTRUMENT_READ
GET    /api/instrument-profiles/:id   Permission: INSTRUMENT_READ
POST   /api/instrument-profiles       Permission: INSTRUMENT_CREATE
PUT    /api/instrument-profiles/:id   Permission: INSTRUMENT_UPDATE
DELETE /api/instrument-profiles/:id   Permission: INSTRUMENT_DELETE — 409 while the profile still holds instruments
```

Note that `POST /api/instruments` and `POST /api/instruments/bulk` now require
`profileId`, and that the **bulk CSV format is unchanged** — the profile is a
sibling field to `csv`, not a column.

- [ ] **Step 3: Write the CHANGELOG entry**

Add at the top of `CHANGELOG.md`, under a new `## [Unreleased]` heading, covering:
what profiles are and are not (grouping only, nothing inherited); that membership
is required and existing instruments were backfilled to `Default`; that deletion
of a populated profile is refused by the FK and not only by the service; that the
CSV format did not change; and that no permissions or reauth actions were added.

- [ ] **Step 4: Add the audit entry to `tasks/todo.md`**

Record the decisions, the touchpoints tested, and anything left undone.

- [ ] **Step 5: Run everything**

```bash
npm run build -w @digilog/shared
cd apps/api && npx tsc -p tsconfig.json --noEmit && npm test
cd ../web && npx tsc --noEmit -p tsconfig.json && npm test
```
Expected: API at the 14-failure baseline across the 5 known files; web at its
5-failure baseline; no type errors.

- [ ] **Step 6: Verify backup picks the new table up**

`backup.repository.ts` enumerates `pg_tables` and topologically sorts by FK, so
`instrument_profiles` should appear automatically and be ordered BEFORE
`instruments`. Confirm rather than assume:

```bash
cd apps/api && npx vitest run src/modules/backup --pool=forks --poolOptions.forks.singleFork=true
```
Expected: PASS. Then take a backup through the UI and confirm the archive
contains `instrument_profiles` ahead of `instruments`.

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md CLAUDE.md apps/api/CLAUDE.md packages/shared/CLAUDE.md API_REFERENCE.md tasks/todo.md
git commit -m "docs(instruments): instrument profiles; correct the stale model count"
```

---

## Self-review notes

**Spec coverage:** §3 data model → Task 1. §4 backend module → Task 3; instrument
wiring → Task 4. §5 frontend → Tasks 6–7. §6 out-of-scope items are absent from
every task, as intended. §7 tension (pre-filled chip, unchanged CSV) → Task 7
Steps 2–3. §8 touchpoints → Task 5 Step 4, Task 7 Step 6, Task 8 Steps 5–6. §9
stale counts → Task 8 Step 1. §10 testing → Tasks 2–5.

**Type consistency:** `profileId` (never `profile_id`) in all TypeScript;
`profileName` on reads only; `instrumentCount`/`activeCount` used identically in
Task 3's `present()`, Task 3's tests and Task 6's `Profile` interface.
`InstrumentProfileListPage` is the export name in both Task 6 Step 1 and Step 2.

**Known risk not eliminated:** Task 7 Step 1 filters instruments client-side. That
is correct while instrument counts are small (tens), and matches how the page
already loads everything at once. If the registry grows to thousands, the list
endpoint needs a `profileId` query parameter — noted here rather than built now.
