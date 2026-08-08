# Per-Profile Instrument Attributes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each instrument profile its own list of attribute keys that the New Instrument form asks for, replacing the single global list.

**Architecture:** One nullable `attribute_keys TEXT` column on `instrument_profiles` holding the same newline-separated string the global config already uses, so `parseInstrumentAttributeKeys` stays the only definition of what a line means. Read and written through the profile's existing `GET`/`PUT /api/instrument-profiles/:id` — no new endpoints, no new permissions. The Configuration page gains a target picker; the New Instrument form and the detail-page Attributes panel read the selected/owning profile instead of the global config.

**Tech Stack:** Fastify + Prisma (PostgreSQL 18), React 19 + Vite + SWR + Tailwind, Zod in `@digilog/shared`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`

## Global Constraints

- **`prisma db push` and `prisma migrate dev` auto-generation are FORBIDDEN.** Migrations are hand-authored SQL under `apps/api/prisma/migrations/<UTC-timestamp>_<name>/migration.sql`. Both forbidden commands can silently drop hash-chained audit data (21 CFR §11).
- **`npm run db:verify-migrations` must PASS before any commit that touches the schema.**
- **Always pass `DATABASE_URL` explicitly.** There are three `.env` files in this tree and the repo-root one has pointed at a sibling checkout before. This repo's DB is `compliance_core_db`; the test DB is `compliance_core_db_test`.
- **Rebuild shared before testing api or web:** `npm run build -w @digilog/shared`.
- **`cd apps/api && npm test`** is the only stable invocation (it carries `--pool=forks --poolOptions.forks.singleFork=true`). Baseline: **1173 passing, 0 failed, 12 skipped, 113 files**. Web baseline: **573/573, 44 files**.
- **vitest never typechecks.** `npx tsc -p apps/api/tsconfig.json --noEmit` and `cd apps/web && npx vite build` are separate, required checks.
- **No count changes anywhere.** This adds a column, not a model: 29 models, 6 enums, 22 config defs, 102 permissions, 83 feature privileges, 92 reauth actions, 27 sidebar items all stay. Do not "correct" them.
- **Values are never inherited, only prompts.** No code may back-fill, rewrite or delete an attribute on an existing instrument because a profile's list changed.
- **Light theme only** — `bg-white`, `bg-slate-50`, `border-slate-200`. No dark variants.
- **The API dev server** runs on port **3001** with `API_HTTPS=true`; the web dev server on **5176**.

---

### Task 1: Shared schema accepts `attributeKeys`

**Files:**
- Modify: `packages/shared/src/schemas/instrument-profiles.ts` (whole file — 35 lines)
- Test: `packages/shared/src/schemas/instrument-profiles.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `createInstrumentProfileSchema` and `updateInstrumentProfileSchema` gain an `attributeKeys` field. Create: `string | undefined` (`.optional()` — omitted means "let the server seed it"). Update: `string | null | undefined` (`.nullish()`). `CreateInstrumentProfileInput.attributeKeys?: string`, `UpdateInstrumentProfileInput.attributeKeys?: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/schemas/instrument-profiles.test.ts`:

```ts
describe('createInstrumentProfileSchema attributeKeys', () => {
  it('accepts a newline-separated key list', () => {
    const out = createInstrumentProfileSchema.parse({
      name: 'Cleanroom-A',
      attributeKeys: 'Block\nArea\nSlave ID',
    });
    expect(out.attributeKeys).toBe('Block\nArea\nSlave ID');
  });

  it('leaves attributeKeys ABSENT when not sent, so the server can seed the default template', () => {
    // Not `''` and not a default: the route distinguishes "omitted" (seed me)
    // from "empty" (this profile asks for nothing), and a Zod default here
    // would destroy that distinction before the route ever sees it.
    const out = createInstrumentProfileSchema.parse({ name: 'Cleanroom-A' });
    expect('attributeKeys' in out).toBe(false);
  });

  it('accepts an empty string — a profile that deliberately asks for nothing', () => {
    expect(createInstrumentProfileSchema.parse({ name: 'A', attributeKeys: '' }).attributeKeys).toBe('');
  });

  it('does NOT trim, so the stored string matches what the config path stores', () => {
    // The dynamic-config PUT stores its value verbatim. If this trimmed, the
    // same list would round-trip differently depending on which page saved it.
    expect(createInstrumentProfileSchema.parse({ name: 'A', attributeKeys: 'Block\n' }).attributeKeys)
      .toBe('Block\n');
  });

  it('rejects more than 2000 characters, matching instrumentAttributesConfigSchema', () => {
    const tooLong = 'k'.repeat(2001);
    expect(createInstrumentProfileSchema.safeParse({ name: 'A', attributeKeys: tooLong }).success).toBe(false);
  });
});

describe('updateInstrumentProfileSchema attributeKeys', () => {
  it('accepts a replacement list', () => {
    expect(updateInstrumentProfileSchema.parse({ attributeKeys: 'Room' }).attributeKeys).toBe('Room');
  });

  it('accepts null, which re-arms the default-template fallback', () => {
    expect(updateInstrumentProfileSchema.parse({ attributeKeys: null }).attributeKeys).toBeNull();
  });

  it('accepts an empty string, which is NOT the same as null', () => {
    expect(updateInstrumentProfileSchema.parse({ attributeKeys: '' }).attributeKeys).toBe('');
  });

  it('rejects more than 2000 characters', () => {
    expect(updateInstrumentProfileSchema.safeParse({ attributeKeys: 'k'.repeat(2001) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/shared && npx vitest run src/schemas/instrument-profiles.test.ts
```

Expected: FAIL. The `attributeKeys` assertions fail because the field is stripped by Zod (`expect(out.attributeKeys).toBe(...)` receives `undefined`), and the two `2001`-character cases report `success: true` instead of `false`.

- [ ] **Step 3: Add the field to both schemas**

In `packages/shared/src/schemas/instrument-profiles.ts`, replace the doc comment on lines 3-13 and add the field to both schemas. The comment currently asserts profiles carry no settings, which this change makes false:

```ts
import { z } from 'zod';

/**
 * An instrument profile is a named container for instruments.
 *
 * It carries ONE inherited setting: `attributeKeys`, the attribute keys the New
 * Instrument form asks for in this profile. Profiles inherit PROMPTS, never
 * VALUES — nothing is back-filled onto an instrument that already exists, and
 * moving an instrument between profiles changes only which keys are suggested.
 * See `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`.
 *
 * `name` is trimmed before validation because the database's unique index is an
 * exact match. Without trimming, "Cleanroom-A" and "Cleanroom-A " are two
 * distinct profiles that look identical everywhere they are rendered — an
 * operator would have no way to tell which one their instruments went into.
 */

/**
 * Newline-separated, one key per line, capped to match
 * `instrumentAttributesConfigSchema` so a per-profile list cannot hold more than
 * the default template could.
 *
 * NOT trimmed, deliberately: the dynamic-config PUT stores its value verbatim,
 * and a list that round-trips differently depending on which page saved it is a
 * bug waiting to be found months later. Per-line trimming, blank-dropping and
 * case-insensitive de-duplication all happen in `parseInstrumentAttributeKeys`,
 * which is the single definition of what a line means.
 */
const attributeKeysField = z.string()
  .max(2000, 'Attribute keys must be 2000 characters or fewer');

export const createInstrumentProfileSchema = z.object({
  name: z.string().trim()
    .min(1, 'Profile name is required')
    .max(120, 'Profile name must be 120 characters or fewer'),
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer').optional(),
  isActive: z.boolean().default(true),
  // `.optional()` with NO default: an absent field means "seed from the default
  // template", which only the route can do. A `.default('')` here would make
  // every new profile ask for nothing.
  attributeKeys: attributeKeysField.optional(),
});

export const updateInstrumentProfileSchema = z.object({
  name: z.string().trim()
    .min(1, 'Profile name is required')
    .max(120, 'Profile name must be 120 characters or fewer')
    .optional(),
  // `.nullish()` rather than `.optional()`: null is meaningful here — it is how
  // an operator clears a description they no longer want.
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer').nullish(),
  isActive: z.boolean().optional(),
  // `.nullish()` for the same reason as description, with a narrower meaning:
  // null re-arms the default-template fallback, '' means "ask for nothing".
  attributeKeys: attributeKeysField.nullish(),
});

export type CreateInstrumentProfileInput = z.infer<typeof createInstrumentProfileSchema>;
export type UpdateInstrumentProfileInput = z.infer<typeof updateInstrumentProfileSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/shared && npx vitest run src/schemas/instrument-profiles.test.ts
```

Expected: PASS, all cases including the pre-existing name/description tests.

- [ ] **Step 5: Rebuild shared, then commit**

```bash
npm run build -w @digilog/shared
git add packages/shared/src/schemas/instrument-profiles.ts packages/shared/src/schemas/instrument-profiles.test.ts
git commit -m "feat(shared): accept attributeKeys on instrument profile schemas"
```

---

### Task 2: Prisma column and hand-authored migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma:751-774` (the doc comment and the `InstrumentProfile` model)
- Create: `apps/api/prisma/migrations/20260808163000_instrument_profile_attribute_keys/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.instrumentProfile` rows carry `attributeKeys: string | null` (column `attribute_keys`). Every pre-existing profile row holds a copy of the live global list.

- [ ] **Step 1: Record the current global list, to check the backfill against**

```bash
psql "postgresql://digilog:digilog123@localhost:5432/compliance_core_db" \
  -t -c "select config_value->>'keys' from system_config where config_key = 'instrument-attributes';"
```

Expected: the 12-key list beginning `Block`, `Area`, `Location` and ending `Slave ID`. **Write down the number of lines** — the backfill assertion in Step 6 compares against it. Do not substitute `INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT`; that constant is a different, 6-key list and seeding from it would silently reset every profile.

- [ ] **Step 2: Add the column and rewrite the false comment**

In `apps/api/prisma/schema.prisma`, replace the comment at lines 751-760 and the model body. The existing comment says profiles carry no settings and instruments inherit nothing — after this change that is false, and a stale comment here is exactly the `certs/rootCA.pem` trap `CLAUDE.md` records:

```prisma
/// A named container for instruments.
///
/// A profile carries ONE inherited setting: `attributeKeys`, the list of
/// attribute keys the New Instrument form asks for in this profile. Profiles
/// inherit PROMPTS, never VALUES — nothing is ever back-filled onto an
/// instrument that already exists, and moving an instrument between profiles
/// changes only which keys are suggested, never its recorded attributes. See
/// `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`.
///
/// Deleting a profile that still holds instruments is refused by the FOREIGN KEY
/// on `Instrument.profileId` (onDelete: Restrict), not merely by the service
/// check that produces the friendly message. A future code path that forgets the
/// check therefore still cannot orphan an instrument or destroy a populated
/// group.
model InstrumentProfile {
  id          String   @id @default(uuid())
  name        String   @unique
  description String?
  isActive    Boolean  @default(true) @map("is_active")
  /// Newline-separated attribute keys, the same wire format as the global
  /// default template, so `parseInstrumentAttributeKeys` stays the one
  /// definition of what a line means.
  ///
  /// Three states: a non-empty string is this profile's own list; `''` means it
  /// asks for no attributes; NULL means never customised and falls back to the
  /// default template. NULL is a read-side safety net for a code path that
  /// forgets to seed — the migration backfills every existing row and POST
  /// seeds every new one, so it should not occur.
  attributeKeys String? @map("attribute_keys")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy   String?  @map("created_by")
  updatedBy   String?  @map("updated_by")

  instruments Instrument[]

  @@map("instrument_profiles")
}
```

- [ ] **Step 3: Hand-author the migration**

Create `apps/api/prisma/migrations/20260808163000_instrument_profile_attribute_keys/migration.sql`:

```sql
-- Per-profile instrument attribute keys.
-- Spec: docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md

ALTER TABLE "instrument_profiles" ADD COLUMN "attribute_keys" TEXT;

-- Every existing profile starts as an exact copy of the list that was global
-- until now, so day-one behaviour is identical and a profile diverges only when
-- an admin edits it.
--
-- Reads the LIVE config row, NOT the code default: this install's list is 12
-- keys and INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT is 6, so seeding from the constant
-- would quietly reset every profile to a list nobody configured. The literal
-- below is only the fresh-install fallback, for a database where the config row
-- has not been seeded yet.
UPDATE "instrument_profiles"
SET "attribute_keys" = COALESCE(
  (SELECT c."config_value"->>'keys'
     FROM "system_config" c
    WHERE c."config_key" = 'instrument-attributes'),
  E'Block\nArea\nLocation\nRoom\nCalibration Due\nAsset Tag'
)
WHERE "attribute_keys" IS NULL;
```

- [ ] **Step 4: Apply the migration to the dev and test databases**

```bash
cd apps/api
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db" npx prisma migrate deploy
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test" npx prisma migrate deploy
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db" npx prisma generate
```

Expected: `1 migration found` … `Applied migration 20260808163000_instrument_profile_attribute_keys` for each database, then a successful client generation.

Do **not** run `prisma migrate resolve --applied` here. That marks a migration as applied *without running it*, which is right for the pg_dump baseline and wrong for a new migration whose `UPDATE` must actually execute.

- [ ] **Step 5: Run the drift guard**

```bash
cd apps/api && npm run db:verify-migrations
```

Expected: PASS. It builds a scratch database from the migration history and asserts it diffs empty against the dev database. A failure here means `schema.prisma` and the SQL disagree — fix the SQL, not the guard.

- [ ] **Step 6: Verify the backfill copied the LIVE list**

```bash
psql "postgresql://digilog:digilog123@localhost:5432/compliance_core_db" -c "
  select p.name,
         array_length(string_to_array(p.attribute_keys, E'\n'), 1) as key_lines,
         p.attribute_keys = (select c.config_value->>'keys' from system_config c
                              where c.config_key = 'instrument-attributes') as matches_global
    from instrument_profiles p order by p.name;"
```

Expected: one row per existing profile, `matches_global` **true** for every row, and `key_lines` equal to the count recorded in Step 1. If `matches_global` is false anywhere, the backfill read the wrong source — do not proceed.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260808163000_instrument_profile_attribute_keys/
git commit -m "feat(db): per-profile instrument attribute keys column, backfilled from the global list"
```

---

### Task 3: API reads, seeds and audits `attributeKeys`

**Files:**
- Modify: `apps/api/src/modules/instrument-profiles/routes.ts` (header comment 9-20, `profileProps` 22-32, `ProfileRow` 34-43, POST 128-165, PUT 184-229)
- Test: `apps/api/src/e2e/instrument-profiles.e2e.test.ts` (append)

**Interfaces:**
- Consumes: `createInstrumentProfileSchema` / `updateInstrumentProfileSchema` from Task 1; the `attribute_keys` column from Task 2.
- Produces: `GET /api/instrument-profiles` and `GET /api/instrument-profiles/:id` return `attributeKeys: string | null` on every profile object. `POST` accepts optional `attributeKeys` and seeds from the live default template when omitted. `PUT` accepts `attributeKeys: string | null`. The web tasks depend on the field name being exactly `attributeKeys`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/e2e/instrument-profiles.e2e.test.ts`:

```ts
const updateProfile = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/instrument-profiles/${id}`, headers: auth(), payload });

/** The list that is global today — what a new profile must be seeded from. */
async function globalKeys(): Promise<string> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-attributes' } });
  return (row?.configValue as { keys?: string } | null)?.keys ?? '';
}

describe('instrument profile attributeKeys', () => {
  it('seeds a new profile from the LIVE default template when attributeKeys is omitted', async () => {
    // Not from INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT: the constant and this
    // install's configured list are different, and seeding from the constant
    // would hand every new profile a list nobody configured.
    const res = await createProfile({ name: 'IPT Seeded' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).attributeKeys).toBe(await globalKeys());
  });

  it('stores an explicit list verbatim instead of seeding', async () => {
    const res = await createProfile({ name: 'IPT Explicit', attributeKeys: 'Room\nSlave ID' });
    expect(JSON.parse(res.body).attributeKeys).toBe('Room\nSlave ID');
  });

  it('stores a key containing "<" VERBATIM', async () => {
    // REGRESSION GUARD for the sanitizeStrings skip. stripHtml DISCARDS
    // tag-shaped content, so without ['attributeKeys'] in skipKeys this key
    // becomes "Temp" — while the dynamic-config PUT, which does not strip,
    // would have stored it intact. The two write paths must agree.
    const res = await createProfile({ name: 'IPT Angle', attributeKeys: 'Temp <5C\nRoom' });
    expect(JSON.parse(res.body).attributeKeys).toBe('Temp <5C\nRoom');
  });

  it('accepts an empty list, and it reads back as empty rather than null', async () => {
    const id = JSON.parse((await createProfile({ name: 'IPT Empty' })).body).id;
    const res = await updateProfile(id, { attributeKeys: '' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).attributeKeys).toBe('');
  });

  it('accepts null, which re-arms the default-template fallback', async () => {
    const id = JSON.parse((await createProfile({ name: 'IPT Null' })).body).id;
    const res = await updateProfile(id, { attributeKeys: null });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).attributeKeys).toBeNull();
  });

  it('returns attributeKeys for every profile in the list, so one fetch serves the config page', async () => {
    await createProfile({ name: 'IPT List A', attributeKeys: 'Room' });
    await createProfile({ name: 'IPT List B', attributeKeys: '' });
    const rows = JSON.parse((await app.inject({
      method: 'GET', url: '/api/instrument-profiles', headers: auth(),
    })).body).data as { name: string; attributeKeys: string | null }[];
    const mine = rows.filter((r) => r.name.startsWith('IPT List '));
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => 'attributeKeys' in r)).toBe(true);
  });

  it('audits a key change with the PARSED arrays and a count in the signature', async () => {
    const id = JSON.parse((await createProfile({
      name: 'IPT Audited', attributeKeys: 'Block\nArea\nRoom',
    })).body).id;
    await updateProfile(id, { attributeKeys: 'Room' });

    const row = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(row).not.toBeNull();
    // Arrays, not the raw newline string: an inspector reads keys, and the
    // audit UI already diffs keyed arrays.
    expect((row!.beforeValue as { attributeKeys: string[] }).attributeKeys)
      .toEqual(['Block', 'Area', 'Room']);
    expect((row!.afterValue as { attributeKeys: string[] }).attributeKeys).toEqual(['Room']);
    expect(row!.signatureMeaning).toBe('Instrument profile "IPT Audited" attribute keys changed (3 → 1)');
  });

  it('still reports a rename rather than the key change when both happen', async () => {
    const id = JSON.parse((await createProfile({ name: 'IPT Before', attributeKeys: 'Room' })).body).id;
    await updateProfile(id, { name: 'IPT After', attributeKeys: 'Block' });
    const row = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(row!.signatureMeaning).toBe('Instrument profile renamed "IPT Before" → "IPT After"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run src/e2e/instrument-profiles.e2e.test.ts
```

Expected: FAIL. `attributeKeys` is `undefined` on every response (the field is not in `profileProps`, so Fastify's response serialiser strips it), and the audit assertions fail because `beforeValue.attributeKeys` does not exist.

- [ ] **Step 3: Add the imports, the response field and the row type**

In `apps/api/src/modules/instrument-profiles/routes.ts`, extend the imports at lines 1-7:

```ts
import { type FastifyInstance } from 'fastify';
import {
  createInstrumentProfileSchema,
  updateInstrumentProfileSchema,
  instrumentAttributesConfigSchema,
  parseInstrumentAttributeKeys,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { configService } from '../config/config.service.js';
```

Replace the header comment's second paragraph (lines 12-14), which currently claims profiles carry no settings:

```ts
/**
 * Instrument profiles — a named container for instruments.
 *
 * A profile carries ONE inherited setting: `attributeKeys`, the attribute keys
 * the New Instrument form asks for in this profile. Profiles inherit PROMPTS,
 * never VALUES — see
 * `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`.
 *
 * PERMISSIONS reuse `INSTRUMENT_*` deliberately. A profile is not a capability
 * boundary of its own — anyone who may register an instrument may create the
 * folder it sits in — and dedicated constants would pull in the PERMISSION_TREE
 * frozen-snapshot test plus three documented counts for no access-control gain.
 */
```

Add to `profileProps` (after `isActive`):

```ts
  attributeKeys: { type: 'string', nullable: true },
```

Add to `ProfileRow` (after `isActive: boolean;`):

```ts
  attributeKeys: string | null;
```

`present()` needs no change — `attributeKeys` flows through its `...rest` spread.

- [ ] **Step 4: Seed on POST and skip the sanitiser**

In the POST handler, replace the `safeParse` call and the `create` call (lines 129-141):

```ts
    const parsed = createInstrumentProfileSchema.safeParse(
      // `attributeKeys` is EXEMPT from HTML stripping so that the two write
      // paths for this same data agree. The dynamic-config PUT does not strip
      // (config.service.ts:87-93), and stripHtml DISCARDS tag-shaped content
      // rather than escaping it — so without this exemption a key like
      // "Temp <5C" would survive on the Configuration page and be silently
      // truncated to "Temp" here. Not a new exposure: the SPA escapes on
      // output, and this is the same value the config endpoint already stores
      // unstripped.
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['attributeKeys']),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const ctx = buildContext(req);

    // An ABSENT attributeKeys means "seed me from the default template"; an
    // empty string means "this profile asks for nothing". Only the first is
    // filled in here, which is why the schema carries no Zod default.
    const attributeKeys = parsed.data.attributeKeys === undefined
      ? (await configService.getConfig('instrument-attributes', instrumentAttributesConfigSchema)).keys
      : parsed.data.attributeKeys;

    try {
      const row = await prisma.instrumentProfile.create({
        data: { ...parsed.data, attributeKeys, createdBy: ctx.userId },
        include: withInstruments,
      });
```

Add `attributeKeys` to the POST audit's `afterValue`:

```ts
        afterValue: {
          name: row.name, description: row.description, isActive: row.isActive,
          attributeKeys: parseInstrumentAttributeKeys(row.attributeKeys),
        },
```

- [ ] **Step 5: Handle the key change on PUT, including the audit**

In the PUT handler, apply the same `skipKeys` change to `sanitizeStrings` (line 187):

```ts
    const parsed = updateInstrumentProfileSchema.safeParse(
      // Exempt for the same reason as POST — see the comment there.
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['attributeKeys']),
    );
```

Then replace the `auditLog` call (lines 204-217) with:

```ts
      const keysBefore = parseInstrumentAttributeKeys(before.attributeKeys);
      const keysAfter = parseInstrumentAttributeKeys(row.attributeKeys);
      // Compared as PARSED lists, so a whitespace-only edit that changes no key
      // does not claim the keys changed.
      const keysChanged = keysBefore.join('\n') !== keysAfter.join('\n');

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_UPDATED',
        targetType: 'instrument_profile', targetId: id,
        beforeValue: {
          name: before.name, description: before.description, isActive: before.isActive,
          attributeKeys: keysBefore,
        },
        afterValue: {
          name: row.name, description: row.description, isActive: row.isActive,
          attributeKeys: keysAfter,
        },
        // A rename is called out first: it changes what an inspector reads
        // against every instrument in the profile, so "updated" alone would
        // understate it. A key change is named next, with the counts, because
        // it changes what every future registration is asked. Both fit
        // audit_trail.signature_meaning's varchar(255): ~50 fixed characters
        // plus a name capped at 120.
        signatureMeaning: before.name !== row.name
          ? `Instrument profile renamed "${before.name}" → "${row.name}"`
          : keysChanged
            ? `Instrument profile "${row.name}" attribute keys changed (${keysBefore.length} → ${keysAfter.length})`
            : `Instrument profile "${row.name}" updated`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/e2e/instrument-profiles.e2e.test.ts
```

Expected: PASS, including the pre-existing delete/duplicate-name tests.

- [ ] **Step 7: Typecheck, then commit**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
git add apps/api/src/modules/instrument-profiles/routes.ts apps/api/src/e2e/instrument-profiles.e2e.test.ts
git commit -m "feat(api): read, seed and audit per-profile instrument attribute keys"
```

Expected: `tsc` prints nothing. It is a separate check because vitest never typechecks.

---

### Task 4: Configuration page edits per-profile lists

**Files:**
- Modify: `apps/web/src/routes/config/instrument-attributes.tsx` (whole file)
- Modify: `apps/api/src/modules/config/defs/instrument-attributes.def.ts` (doc comment 4-22, `moduleName`/`description`, the `keys` setting's `label`/`description`)
- Create: `apps/web/src/routes/config/__tests__/instrument-attributes.test.tsx` (new directory)

**Interfaces:**
- Consumes: `attributeKeys` on the profile list from Task 3.
- Produces: no exports change — `InstrumentAttributesConfigPage` keeps its name and signature, so `main.tsx:26,111` need no edit.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/routes/config/__tests__/instrument-attributes.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { InstrumentAttributesConfigPage } from '../instrument-attributes';

const put = vi.fn().mockResolvedValue({});
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...a) } }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const PROFILES = {
  data: [
    { id: 'p1', name: 'Cleanroom AHU', instrumentCount: 12, attributeKeys: 'Block\nArea\nRoom' },
    { id: 'p2', name: 'Warehouse Sensors', instrumentCount: 3, attributeKeys: 'Asset Tag' },
  ],
  total: 2,
};

const fetcher = (url: string) => {
  if (url === '/api/instrument-profiles') return Promise.resolve(PROFILES);
  if (url === '/api/config/dynamic/instrument-attributes') {
    return Promise.resolve({ keys: 'Block\nArea\nLocation' });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const renderPage = () => render(
  <SWRConfig value={{ fetcher, provider: () => new Map(), dedupingInterval: 0 }}>
    <MemoryRouter><InstrumentAttributesConfigPage /></MemoryRouter>
  </SWRConfig>,
);

beforeEach(() => put.mockClear());

describe('InstrumentAttributesConfigPage target picker', () => {
  it('starts on the default template and shows its keys', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('Block')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Location')).toBeInTheDocument();
  });

  it('shows the selected profile keys, not the default, after switching', async () => {
    renderPage();
    await screen.findByDisplayValue('Block');
    await userEvent.selectOptions(screen.getByLabelText('Editing'), 'p2');
    expect(await screen.findByDisplayValue('Asset Tag')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Location')).not.toBeInTheDocument();
  });

  it('saves a profile through the profile PUT, not the config PUT', async () => {
    renderPage();
    await screen.findByDisplayValue('Block');
    await userEvent.selectOptions(screen.getByLabelText('Editing'), 'p2');
    await userEvent.clear(await screen.findByDisplayValue('Asset Tag'));
    await userEvent.type(screen.getByLabelText('Attribute key 1'), 'Firmware Rev');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/instrument-profiles/p2', { attributeKeys: 'Firmware Rev' },
    ));
  });

  it('saves the default through the config PUT', async () => {
    renderPage();
    await userEvent.type(await screen.findByDisplayValue('Block'), ' X');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/config/dynamic/instrument-attributes', { keys: 'Block X\nArea\nLocation' },
    ));
  });

  it('refuses to switch target while dirty unless the discard is confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await userEvent.type(await screen.findByDisplayValue('Block'), ' X');
    await userEvent.selectOptions(screen.getByLabelText('Editing'), 'p2');
    expect(confirmSpy).toHaveBeenCalled();
    // Still editing the default: the edit survived and the switch did not happen.
    expect(screen.getByDisplayValue('Block X')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('warns when a profile omits the placement keys', async () => {
    renderPage();
    await screen.findByDisplayValue('Block');
    // Warehouse Sensors has only "Asset Tag" — no Block/Area/Location.
    await userEvent.selectOptions(screen.getByLabelText('Editing'), 'p2');
    expect(await screen.findByText(/placement/i)).toBeInTheDocument();
  });

  it('does not warn when all three placement keys are present', async () => {
    renderPage();
    await screen.findByDisplayValue('Location');
    expect(screen.queryByText(/placement/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run src/routes/config/__tests__/instrument-attributes.test.tsx
```

Expected: FAIL. `getByLabelText('Editing')` throws because no selector exists, and the page currently fetches only the config key.

- [ ] **Step 3: Add the target state and the two fetches**

In `apps/web/src/routes/config/instrument-attributes.tsx`, replace the doc comment (lines 11-27) and the state block (lines 29-56):

```tsx
/**
 * The attribute keys the New Instrument form asks for — PER PROFILE.
 *
 * Each instrument profile owns its own list; the global config key is now only
 * the template a newly created profile is seeded from. One page rather than an
 * editor on each profile (2026-08-08 operator request), so the lists can be
 * compared side by side.
 *
 * The STORAGE is unchanged on both targets — still one newline-separated string,
 * for the default under `/api/config/dynamic/instrument-attributes` and for a
 * profile under `attributeKeys` on the profile itself — because the create form
 * and `parseInstrumentAttributeKeys` already agree on that shape, and changing
 * the wire format to make an editor nicer would be the tail wagging the dog.
 * This page is a view over one of those strings: split on load, joined on save.
 *
 * Rows are keyed by a STABLE id, not by array index and not by the key text.
 * Index keys make React reuse the wrong input when a row is deleted from the
 * middle (the classic symptom: you delete row 2 and row 3's text appears to
 * jump up while focus stays put); text keys remount the field on every
 * keystroke, which loses the caret.
 */

interface Row { id: number; key: string }
interface Profile { id: string; name: string; instrumentCount: number; attributeKeys: string | null }

/** The default template, distinguishable from any profile id. */
const DEFAULT_TARGET = '__default__';

let nextId = 1;
const toRows = (keys: string[]): Row[] => keys.map((key) => ({ id: nextId++, key }));

export function InstrumentAttributesConfigPage() {
  const { toast } = useToast();
  const { data: profileList } = useSWR<{ data: Profile[] }>('/api/instrument-profiles');
  const { data: defaultConfig, mutate } = useSWR<{ keys?: string }>('/api/config/dynamic/instrument-attributes');

  const [target, setTarget] = useState<string>(DEFAULT_TARGET);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The list as it stands on the server for the CURRENT target, in the same
   * normalised form the save sends. Comparing against it is what makes "Save
   * changes" go quiet once there is nothing to save — after a successful save it
   * is updated in place, so the button disables immediately instead of staying
   * lit until the next keystroke. Reset whenever the target changes, or the
   * dirty check would compare one target's edits against another's baseline.
   */
  const [saved, setSaved] = useState<string | null>(null);
  /** Which target `rows`/`saved` were seeded from, so a target change re-seeds. */
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const profiles = profileList?.data ?? [];
  const selectedProfile = profiles.find((p) => p.id === target) ?? null;
  const serverKeys = target === DEFAULT_TARGET ? defaultConfig?.keys : selectedProfile?.attributeKeys;
  const ready = target === DEFAULT_TARGET ? defaultConfig !== undefined : selectedProfile !== null;

  // Seed once per target, then leave the operator's edits alone — a revalidation
  // mid-edit must not overwrite what they are typing.
  useEffect(() => {
    if (ready && seededFor !== target) {
      const keys = parseInstrumentAttributeKeys(serverKeys);
      setRows(toRows(keys));
      setSaved(keys.join('\n'));
      setSeededFor(target);
    }
  }, [ready, seededFor, target, serverKeys]);

  if (rows === null) return <div className="py-10 text-center text-slate-400">Loading…</div>;
```

- [ ] **Step 4: Add the guarded target change, the placement advisory and the save routing**

Immediately after the existing `move` helper (line 96), add:

```tsx
  /**
   * Switching target is a second way to lose work: the editor deliberately
   * ignores server revalidations mid-edit, so an unsaved list would simply
   * vanish. Confirm, and leave the selector where it was when declined.
   */
  const changeTarget = (next: string) => {
    if (next === target) return;
    if (dirty && !window.confirm(
      'You have unsaved changes to this list. Discard them and switch?',
    )) return;
    setTarget(next);
  };

  /**
   * Block / Area / Location are not attributes — they are real columns the
   * Instruments list filters and displays on. A profile MAY omit them (2026-08-08
   * operator decision), and this says what that costs. Advice, not a block:
   * the same posture as the 20-key note below.
   */
  const missingPlacement = ['Block', 'Area', 'Location']
    .filter((p) => !trimmed.some((k) => k.toLowerCase() === p.toLowerCase()));
```

Replace `save()` (lines 98-119):

```tsx
  const save = async () => {
    if (blocked || !dirty) return;
    setSaving(true);
    try {
      // Blank rows are dropped rather than refused: an operator who added a row
      // and changed their mind should not have to hunt for it to save.
      // `normalised` is the SAME value the dirty check compares against — built
      // once, so the button cannot disagree with what was sent.
      const keys = normalised;
      if (target === DEFAULT_TARGET) {
        await apiClient.put('/api/config/dynamic/instrument-attributes', { keys });
        await mutate();
      } else {
        await apiClient.put(`/api/instrument-profiles/${target}`, { attributeKeys: keys });
        await mutateProfiles();
      }
      // Before the revalidation, not after: this is what makes the button go
      // quiet the moment the save lands, instead of staying lit until the next
      // keystroke.
      setSaved(keys);
      const where = target === DEFAULT_TARGET ? 'New profiles' : `The ${selectedProfile?.name} form`;
      toast.success(
        'Attribute keys saved',
        `${where} now ${target === DEFAULT_TARGET ? 'start with' : 'asks for'} ${kept} attribute${kept === 1 ? '' : 's'}.`,
      );
    } catch (err: unknown) {
      toast.error('Could not save', (err as { message?: string })?.message ?? 'The attribute keys were not changed.');
    } finally {
      setSaving(false);
    }
  };
```

`mutateProfiles` comes from the profile fetch — change its declaration in Step 3 to destructure it:

```tsx
  const { data: profileList, mutate: mutateProfiles } = useSWR<{ data: Profile[] }>('/api/instrument-profiles');
```

- [ ] **Step 5: Render the selector, the advisory and the corrected copy**

Replace the header block (lines 122-133) and add the selector card above the existing "Attribute keys" card:

```tsx
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Instrument Attributes</h1>
          <p className="text-sm text-slate-500">
            The attributes the New Instrument form asks for, per profile. You set
            the keys here; whoever registers a device fills in the values.
          </p>
        </div>
        <Link to="/config"><Button variant="secondary">Back to Settings</Button></Link>
      </div>

      <Card>
        <CardContent className="py-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Editing</span>
            <select
              aria-label="Editing"
              value={target}
              onChange={(e) => changeTarget(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              <option value={DEFAULT_TARGET}>Default for new profiles</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.instrumentCount} instrument{p.instrumentCount === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-slate-500">
            {target === DEFAULT_TARGET
              ? 'This list is copied into each new profile. It is not asked for on its own.'
              : 'This list is what the New Instrument form asks for in this profile only.'}
          </p>
        </CardContent>
      </Card>
```

Replace the empty-state paragraph (lines 143-147) so a profile's empty list reads as a real configuration:

```tsx
          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
              {target === DEFAULT_TARGET
                ? 'No attribute keys. New profiles will start with none — add one below.'
                : 'This profile will ask for no attributes. Add one below.'}
            </p>
          )}
```

Add the advisory just above the `Add attribute key` row (before line 202's `<div className="flex items-center justify-between gap-2 pt-1">`):

```tsx
          {target !== DEFAULT_TARGET && missingPlacement.length > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              This profile does not ask for {missingPlacement.join(', ')}. Those are
              real placement columns — instruments registered here will have them
              empty, and the Instruments list Placement column and its filters will
              be blank for them.
            </p>
          )}
```

Replace the footer note (lines 219-226):

```tsx
        <p className="mr-auto text-xs text-slate-500">
          {target === DEFAULT_TARGET
            ? 'Applies to profiles created from now on. Existing profiles keep their own lists.'
            : `Applies to the next instrument registered in ${selectedProfile?.name}. Attributes already recorded are untouched.`}
        </p>
```

- [ ] **Step 6: Update the config definition's copy**

In `apps/api/src/modules/config/defs/instrument-attributes.def.ts`, replace the doc comment and the two description strings. The current text says these keys are what the New Instrument form asks for, which is now only true via a profile:

```ts
/**
 * The DEFAULT attribute keys a newly created instrument profile starts with.
 *
 * Instrument attributes are free-form key/value pairs, which is right for the
 * data model and wrong for data entry: left to itself every operator invents
 * their own spelling of the same idea ("Room", "room", "Room No"), and the
 * result is a registry that cannot be filtered on. This turns the KEYS into an
 * administered list while leaving the VALUES to whoever registers the device.
 *
 * Since 2026-08-08 the list that a registration form actually asks for lives on
 * the PROFILE (`InstrumentProfile.attributeKeys`). This key is the template a
 * new profile is seeded from and is asked for on no form by itself. Both are
 * edited on the same page, Configuration → Instrument Attributes, chosen with a
 * picker.
 *
 * A newline-separated textarea rather than a JSON setting: an admin editing
 * this is writing a list of words, and JSON punctuation is a way to make that
 * fail. Parsing (trim, drop blanks, de-duplicate) lives in `@digilog/shared` so
 * every consumer agrees on what a line means.
 *
 * The list is a PROMPT, not a constraint. The attributes panel on the detail
 * page still accepts any key, and an instrument created before a key was added
 * simply does not have it — nothing is back-filled and nothing is rejected.
 */
```

Change `description` on the module to:

```ts
  description: 'The attribute keys a new instrument profile starts with. Each profile\'s own list is edited on the same page.',
```

and the `keys` setting's `description` to:

```ts
      description: 'One key per line, in the order they should appear on the form. Blank lines and duplicates are ignored. Copied into each new profile; leave empty for new profiles to start with none.',
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run build -w @digilog/shared
cd apps/web && npx vitest run src/routes/config/__tests__/instrument-attributes.test.tsx
```

Expected: PASS, all seven cases.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/config/instrument-attributes.tsx \
        apps/web/src/routes/config/__tests__/instrument-attributes.test.tsx \
        apps/api/src/modules/config/defs/instrument-attributes.def.ts
git commit -m "feat(web): edit instrument attribute keys per profile"
```

---

### Task 5: New Instrument form asks the selected profile's keys

**Files:**
- Modify: `apps/web/src/routes/instruments/create.tsx` (doc comment 27-32, state 56-57, Attributes card 161-183, profile select 129-140)
- Modify: `apps/api/src/modules/config/routes.ts:180-193` (comment only)
- Test: `apps/web/src/routes/instruments/__tests__/create.test.tsx` (append)

**Interfaces:**
- Consumes: `attributeKeys` on `GET /api/instrument-profiles/:id` from Task 3.
- Produces: nothing new. The submit payload shape is unchanged — placement keys still route to `block`/`area`/`location` columns, everything else posts to `/api/instruments/:id/attributes`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/routes/instruments/__tests__/create.test.tsx`. Match the existing file's mock and render helpers rather than introducing new ones; the fetcher must serve `/api/instrument-profiles/p1`:

```tsx
describe('InstrumentCreatePage attributes come from the profile', () => {
  it('asks for nothing and says why before a profile is chosen', async () => {
    renderPage();  // no ?profileId= — the bare /instruments/new route
    expect(await screen.findByText(/choose a profile to see the attributes/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Room')).not.toBeInTheDocument();
  });

  it('asks for the chosen profile keys', async () => {
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText(/profile/i), 'p1');
    expect(await screen.findByLabelText('Room')).toBeInTheDocument();
    expect(screen.getByLabelText('Block')).toBeInTheDocument();
  });

  it('shows a LOADING line, never "no attributes", while the profile is in flight', async () => {
    // The distinction that matters: rendering nothing here is
    // indistinguishable from "this profile asks for nothing", and an operator
    // would submit an instrument with every attribute missing.
    renderPage({ profileDelayMs: 50 });
    await userEvent.selectOptions(await screen.findByLabelText(/profile/i), 'p1');
    expect(screen.getByText(/loading the attributes/i)).toBeInTheDocument();
    expect(screen.queryByText(/asks for no attributes/i)).not.toBeInTheDocument();
  });

  it('says a profile asks for nothing when its list really is empty', async () => {
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText(/profile/i), 'p-empty');
    expect(await screen.findByText(/asks for no attributes/i)).toBeInTheDocument();
  });

  it('warns explicitly when the profile list cannot be loaded, and does not block', async () => {
    renderPage({ profileError: true });
    await userEvent.selectOptions(await screen.findByLabelText(/profile/i), 'p1');
    expect(await screen.findByText(/could not load the attributes/i)).toBeInTheDocument();
    // Still submittable: a config read failure never blocked registration and
    // must not start doing so.
    expect(screen.getByRole('button', { name: /create instrument/i })).toBeEnabled();
  });

  it('confirms before discarding typed values when the profile changes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText(/profile/i), 'p1');
    await userEvent.type(await screen.findByLabelText('Room'), '214');
    await userEvent.selectOptions(screen.getByLabelText(/profile/i), 'p-empty');
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByLabelText('Room')).toHaveValue('214');  // switch declined
    confirmSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run src/routes/instruments/__tests__/create.test.tsx
```

Expected: FAIL. The page still reads the global config, so the "choose a profile" text and the loading/error lines do not exist.

- [ ] **Step 3: Read the profile instead of the global config**

In `apps/web/src/routes/instruments/create.tsx`, replace lines 56-57:

```tsx
  /**
   * The keys this PROFILE asks for. Read from the profile rather than the global
   * config since 2026-08-08 — each profile owns its own list.
   *
   * `INSTRUMENT_CREATE`'s grant set includes `INSTRUMENT_READ`
   * (permission-tree.ts:323), so anyone who can reach this form can read the
   * profile. That matters: the config endpoint this replaced was deliberately
   * ungated so the form would not silently ask for nothing for exactly the role
   * that fills it in.
   */
  const { data: profile, error: profileError, isLoading: profileLoading } =
    useSWR<{ attributeKeys: string | null }>(
      profileId ? `/api/instrument-profiles/${profileId}` : null,
    );
  const attributeKeys = parseInstrumentAttributeKeys(profile?.attributeKeys);
```

Update the doc comment's Attributes paragraph (lines 27-32):

```tsx
/**
 * ...
 * ── Attributes ──
 * Which keys are asked for is administered per PROFILE, in Configuration →
 * Instrument Attributes, so the same idea does not get stored as "Room", "room"
 * and "Room No" by three different operators, and so a Modbus sensor is not
 * asked for cleanroom humidity limits. This form only collects VALUES. The list
 * is a prompt, not a constraint: the detail page still accepts any key.
 */
```

- [ ] **Step 4: Guard the profile change**

Add after the `profileId` state declaration (line 50):

```tsx
  /**
   * Values are not carried across profiles — a different profile asks different
   * questions — so a switch clears them. Confirmed rather than silent: the
   * operator typed those values. Unreachable on the normal route, which arrives
   * with `?profileId=` and shows a chip instead of this selector.
   */
  const changeProfile = (next: string) => {
    if (next === profileId) return;
    const typed = Object.values(attrs).some((v) => v.trim() !== '');
    if (typed && !window.confirm(
      'The attributes you have filled in do not apply to a different profile and will be cleared. Continue?',
    )) return;
    setAttrs({});
    setProfileId(next);
  };
```

Change the select's handler (line 133) from `onChange={(e) => setProfileId(e.target.value)}` to:

```tsx
                  required value={profileId} onChange={(e) => changeProfile(e.target.value)}
```

- [ ] **Step 5: Render the four distinct states**

Replace the Attributes card body (lines 163-182):

```tsx
          <CardContent className="space-y-4">
            {/*
              Four states, deliberately distinguishable. Collapsing "loading" or
              "failed" into "no attributes" lets an operator register an
              instrument with every attribute missing and no signal that
              anything went wrong.
            */}
            {!profileId ? (
              <p className="text-xs text-slate-500">
                Choose a profile to see the attributes it asks for.
              </p>
            ) : profileLoading ? (
              <p className="text-xs text-slate-500">Loading the attributes this profile asks for…</p>
            ) : profileError ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Could not load the attributes this profile asks for. You can still
                register the instrument and add them from its Attributes panel.
              </p>
            ) : attributeKeys.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {attributeKeys.map((key) => (
                  <label key={key} className="space-y-1">
                    <span className="text-sm font-medium text-slate-700">{key}</span>
                    <Input
                      value={attrs[key] ?? ''}
                      onChange={(e) => setAttrs((a) => ({ ...a, [key]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                This profile asks for no attributes. Add keys for it in
                Configuration → Instrument Attributes.
              </p>
            )}
          </CardContent>
```

- [ ] **Step 6: Record that the config endpoint is now uncalled**

In `apps/api/src/modules/config/routes.ts`, replace the comment above `/instrument-attributes/current` (lines 180-184). Keeping the endpoint is a deliberate decision (2026-08-08) and an undocumented orphan is how this project accumulated the dead code it has spent months deleting:

```ts
  // Public read — all authenticated users, so the form never silently asks for
  // nothing for exactly the role that fills it in. Only the KEY LIST is
  // exposed, which is a form label, not a secret.
  //
  // CURRENTLY UNCALLED (2026-08-08). Its two callers were the New Instrument
  // form and the detail-page Attributes panel; both now read the owning
  // PROFILE's `attributeKeys` instead, and the Configuration page reads the
  // default through /api/config/dynamic/instrument-attributes. KEPT
  // deliberately — it is the documented public read of the default template,
  // and deleting a live endpoint is a separate decision with its own
  // API_REFERENCE churn. Do not add callers without deciding which list they
  // actually want: this one is the template for NEW profiles, not what any
  // form asks for.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/routes/instruments/__tests__/create.test.tsx
```

Expected: PASS, including the pre-existing create-flow tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/instruments/create.tsx \
        apps/web/src/routes/instruments/__tests__/create.test.tsx \
        apps/api/src/modules/config/routes.ts
git commit -m "feat(web): New Instrument form asks the selected profile's attribute keys"
```

---

### Task 6: Attributes panel suggests the owning profile's keys

**Files:**
- Modify: `apps/web/src/routes/instruments/attributes-panel.tsx` (props at line 43, config fetch at 49, `missingKeys` at 77-79)
- Modify: `apps/web/src/routes/instruments/detail.tsx:459`
- Test: `apps/web/src/routes/instruments/__tests__/attributes-panel.test.tsx` (append)

**Interfaces:**
- Consumes: `attributeKeys` on `GET /api/instrument-profiles/:id` from Task 3.
- Produces: `AttributesPanel` signature becomes `{ instrumentId: string; profileId: string; canEdit: boolean }`. `detail.tsx` is the only caller.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/routes/instruments/__tests__/attributes-panel.test.tsx`:

```tsx
describe('AttributesPanel suggestions come from the profile', () => {
  it('suggests the profile keys the instrument has no value for', async () => {
    // Profile p1 asks Block/Area/Room; the instrument has only Room.
    renderPanel({ profileId: 'p1', attributes: [{ key: 'Room', value: '214' }] });
    // Block and Area are PLACEMENT keys and stay excluded — they are columns,
    // edited in Details, and offering them here would write a second copy that
    // nothing reads.
    expect(await screen.findByText('Room')).toBeInTheDocument();
    expect(screen.queryByLabelText('Block')).not.toBeInTheDocument();
  });

  it('suggests a non-placement key the instrument is missing', async () => {
    renderPanel({ profileId: 'p-slave', attributes: [] });  // asks "Slave ID"
    expect(await screen.findByLabelText('Slave ID')).toBeInTheDocument();
  });

  it('keeps rendering an attribute the profile no longer asks for', async () => {
    // Recorded data is never hidden by a profile change — only suggestions move.
    renderPanel({ profileId: 'p-slave', attributes: [{ key: 'Legacy Tag', value: 'X-9' }] });
    expect(await screen.findByText('Legacy Tag')).toBeInTheDocument();
    expect(screen.getByText('X-9')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run src/routes/instruments/__tests__/attributes-panel.test.tsx
```

Expected: FAIL — `renderPanel` does not accept `profileId`, and the panel still reads the global config.

- [ ] **Step 3: Take `profileId` and read the profile**

In `apps/web/src/routes/instruments/attributes-panel.tsx`, change the signature at line 43:

```tsx
export function AttributesPanel(
  { instrumentId, profileId, canEdit }:
  { instrumentId: string; profileId: string; canEdit: boolean },
) {
```

Replace the config fetch at lines 47-49:

```tsx
  // The administered key list for THIS instrument's profile. A failure here must
  // not break the panel — an unreachable profile simply offers no suggestions,
  // which is safe because every recorded attribute still renders below.
  const { data: profile } = useSWR<{ attributeKeys: string | null }>(
    profileId ? `/api/instrument-profiles/${profileId}` : null,
  );
```

Replace the `missingKeys` computation at lines 77-79:

```tsx
  const missingKeys = parseInstrumentAttributeKeys(profile?.attributeKeys)
    .filter((k) => !placementColumnFor(k))
    .filter((k) => !have.has(k.trim().toLowerCase()));
```

- [ ] **Step 4: Pass `profileId` from the detail page**

In `apps/web/src/routes/instruments/detail.tsx`, change line 459:

```tsx
        <AttributesPanel instrumentId={inst.id} profileId={inst.profileId} canEdit={can('instruments.edit')} />
```

If `inst.profileId` is not on the detail page's instrument type, add it — the API returns it (`instruments/routes.ts:864`).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/routes/instruments/__tests__/attributes-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Build to typecheck the changed prop, then commit**

```bash
cd apps/web && npx vite build
git add apps/web/src/routes/instruments/attributes-panel.tsx \
        apps/web/src/routes/instruments/detail.tsx \
        apps/web/src/routes/instruments/__tests__/attributes-panel.test.tsx
git commit -m "feat(web): attributes panel suggests the owning profile's keys"
```

Expected: the build succeeds. A missed call site for the new required prop surfaces here, not in vitest.

---

### Task 7: Documentation sync

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `apps/api/CLAUDE.md` (the `schema.prisma` bullet under Key Paths)
- Modify: `API_REFERENCE.md:177-181`
- Modify: `docs/superpowers/specs/2026-08-08-instrument-profiles-design.md:147-149` and its decision table row for "Profile contents"
- Modify: `tasks/todo.md`

**Interfaces:** none.

- [ ] **Step 1: Amend the superseded spec**

In `docs/superpowers/specs/2026-08-08-instrument-profiles-design.md`, replace the §6 bullet at lines 147-149:

```markdown
- **Profiles inherit PROMPTS but never VALUES.** ~~Profiles do not inherit
  anything.~~ **Superseded 2026-08-08** by
  `2026-08-08-per-profile-instrument-attributes-design.md`: a profile now owns the
  attribute-key list its New Instrument form asks for. The question this section
  deferred — "what happens to existing members when the default changes?" — is
  answered there: nothing. No value is ever back-filled, rewritten or deleted on
  an instrument that already exists.
```

Change the decision table's "Profile contents" row (line 28) to:

```markdown
| Profile contents | Name + description, **and since 2026-08-08 an attribute-key list** | See the per-profile attributes spec |
```

- [ ] **Step 2: Update `apps/api/CLAUDE.md`**

Append to the `schema.prisma` bullet under **Key Paths**:

```markdown
**2026-08-08** added `InstrumentProfile.attributeKeys` (nullable `attribute_keys TEXT`)
— the attribute keys the New Instrument form asks for in that profile, replacing
the single global list; migration `20260808163000_instrument_profile_attribute_keys`
backfills every existing profile from the live `system_config['instrument-attributes']`
value. **No model or enum count change** (29 models / 6 enums stand).
```

- [ ] **Step 3: Update `API_REFERENCE.md`**

Under the instrument-profiles block at lines 177-181, add:

```markdown
`POST` and `PUT` additionally accept `attributeKeys` (newline-separated, max 2000
chars) — the attribute keys the New Instrument form asks for in that profile.
Every read returns it. Omitted on `POST`, it is seeded from
`system_config['instrument-attributes']`; `''` means the profile asks for no
attributes; `null` on `PUT` re-arms that fallback.
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Add under an `## Unreleased` heading (create it if absent), at the top of the entries:

```markdown
### Per-profile instrument attributes (2026-08-08)

Each instrument profile now owns the list of attribute keys its New Instrument
form asks for; the global list at Configuration → Instrument Attributes became
the template a new profile is seeded from. Reverses the "profiles are grouping
only, they inherit nothing" decision of the same day, and answers the question
that decision deferred: profiles inherit **prompts, never values** — no
attribute on an existing instrument is ever back-filled, rewritten or deleted
because a profile's list changed, and moving an instrument between profiles
changes only which keys are suggested.

- `InstrumentProfile.attributeKeys` (nullable), migration
  `20260808163000_instrument_profile_attribute_keys`, backfilled from the live
  config value so day-one behaviour was unchanged
- Configuration → Instrument Attributes gained a target picker, a discard guard
  on switching targets, and an advisory when a profile omits Block/Area/Location
  (those are real placement columns; instruments registered there have them empty
  and the Instruments list Placement filter is blank for them — accepted
  trade-off, operator decision)
- The New Instrument form asks nothing until a profile is chosen, and now tells
  "loading", "asks for none" and "could not load" apart rather than rendering an
  empty section for all three
- `attributeKeys` is exempt from `sanitizeStrings` on the profile routes so the
  two write paths for this data agree — the dynamic-config PUT never stripped
  HTML, and `stripHtml` discards tag-shaped content, so a key like `Temp <5C`
  would otherwise have been truncated on one page and kept on the other
- `GET /api/config/instrument-attributes/current` is now uncalled; kept and
  documented as such rather than left an undocumented orphan
- No permission, privilege, reauth, sidebar, model, enum or config-def count
  changed
```

- [ ] **Step 5: Add the `tasks/todo.md` audit entry**

Append to the audit log section:

```markdown
- 2026-08-08 — Per-profile instrument attribute keys. Spec
  `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`,
  plan `docs/superpowers/plans/2026-08-08-per-profile-instrument-attributes.md`.
  Amended the same-day instrument-profiles spec §6, which claimed profiles
  inherit nothing. Verified during the work: no role holds any `INSTRUMENT_*`
  permission in `default-roles.ts` or the live DB — instruments are reachable
  only via SUPER_ADMIN bypass. Pre-existing, out of scope here, worth its own
  task.
```

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md apps/api/CLAUDE.md API_REFERENCE.md tasks/todo.md \
        docs/superpowers/specs/2026-08-08-instrument-profiles-design.md
git commit -m "docs: sync per-profile instrument attributes"
```

---

### Task 8: Full verification

**Files:** none modified unless a check fails.

**Interfaces:** none.

- [ ] **Step 1: Typecheck both apps**

```bash
npm run build -w @digilog/shared
npx tsc -p apps/api/tsconfig.json --noEmit
cd apps/web && npx vite build
```

Expected: no output from `tsc`; a successful web build. vitest never typechecks, so a green suite is not evidence this passes.

- [ ] **Step 2: Run the shared and api suites**

```bash
cd packages/shared && npx vitest run
cd ../../apps/api && npm test
```

Expected: shared green. API **at or above the 1173 passing / 0 failed / 12 skipped, 113 files** baseline, plus the new profile cases. Any *new* failure is yours; investigate it rather than re-running. Do not use plain `npx vitest run` — the default pool produces flaky failures that are not real bugs.

- [ ] **Step 3: Run the web suite**

```bash
cd apps/web && npm test
```

Expected: **at or above 573/573, 44 files**, plus the new cases.

- [ ] **Step 4: Re-run the drift guard**

```bash
cd apps/api && npm run db:verify-migrations
```

Expected: PASS.

- [ ] **Step 5: Walk the feature in the browser**

Start both servers (API on 3001, web on 5176):

```bash
cd apps/api && npx tsx watch src/app.ts     # https://localhost:3001
cd apps/web && npx vite --host              # http://localhost:5176
```

Then, logged in as `superadmin`:

1. Configuration → Instrument Attributes. Confirm it opens on "Default for new profiles" showing the 12 keys, and that each existing profile shows the same 12 (the backfill).
2. Select a profile, delete all but two keys, save. Reopen the default target — it must still show 12.
3. Edit a list, then switch target without saving — the discard prompt appears; decline and the edits survive.
4. Remove Block/Area/Location from a profile — the amber placement advisory appears.
5. Create a profile. It must arrive pre-seeded with the default list, not empty.
6. `/instruments/new` with no profile — the Attributes card says to choose a profile. Pick one; its keys appear. Pick a different one after typing a value; the confirm appears.
7. Register an instrument in a profile whose list omits Block. Confirm the Instruments list shows it with an empty Placement, and that filtering by Block does not return it — the accepted consequence, verified rather than assumed.
8. Open that instrument's detail page. The Attributes panel suggests only its profile's non-placement keys, and any attribute the profile does not ask for still renders.
9. Move an instrument to another profile. Its recorded attributes must be unchanged; only the suggestions change.
10. Audit Trail — the profile key change appears as `Instrument profile "X" attribute keys changed (12 → 5)` with before/after key arrays.

Throughout: watch for unstyled or misaligned elements, and check the console for responses that disagree with what the UI shows.

- [ ] **Step 6: Report the results**

State the actual numbers from Steps 2 and 3 against the baselines, and anything found in Step 5. If a check failed, say so with its output rather than describing the feature as complete.

---

## Self-Review

**Spec coverage.** Every section maps to a task: spec §4 data model → Task 2; §5 migration → Task 2; §6 API, sanitiser divergence and the kept-but-orphaned endpoint → Tasks 3 and 5; §7 config page → Task 4; §8 create form → Task 5; §9 attributes panel → Task 6; §10 testing → Tasks 1-6 plus Task 8; §11 touchpoints → all nine files appear; §12 docs → Task 7. Spec §13's out-of-scope items are deliberately absent.

**Type consistency.** `attributeKeys` is the field name in the Zod schemas (Task 1), Prisma model (Task 2), API response and audit payload (Task 3), and all three web consumers (Tasks 4-6). `AttributesPanel`'s new `profileId` prop is added in Task 6 and its sole call site updated in the same task. `DEFAULT_TARGET` is defined and used only within Task 4.

**Known risk carried forward.** Task 6's `inst.profileId` assumes the detail page's instrument type exposes it; the API returns it, but if the local type omits the field, Step 4 must add it. Called out in the step rather than left to be discovered.
