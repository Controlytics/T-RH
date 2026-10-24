# Attribute Edit Access (per role and per user) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-USER instrument-attribute edit rules, combined with the existing per-ROLE rules, administered on a new Super-Admin Configuration page that replaces the Roles & Access → Attribute Access tab.

**Architecture:** A pure `effectiveAttributeAccess(role, user)` in `@digilog/shared` combines the two rules (union of editability; re-auth OR). The API reads `role_configs.attribute_access` and the new `user_configs.attribute_access` and enforces the combined rule through the existing gate; `/attribute-access/me` returns it, so the Settings page and the Attributes panel change nothing. New admin routes list and save user rules with re-auth, privilege check, reason and audit.

**Tech Stack:** TypeScript, Fastify 5, Prisma 6 (PostgreSQL 18), React 19 + SWR, vitest.

**Spec:** `docs/superpowers/specs/2026-10-24-attribute-edit-access-design.md`

## Global Constraints

- The combined rule NARROWS `INSTRUMENT_UPDATE` and never widens it: `canEditAttributeKey(effective, key, hasUpdatePermission)` is unchanged.
- No user rule ⇒ the role rule, exactly today's behaviour.
- Role not configured (`null`) + user rule ⇒ `ALL_EDIT` with the user's `requireReauth`.
- `requireReauth` = role's OR user's.
- "None" is written as `Prisma.DbNull`, never `JsonNull`.
- Reason REQUIRED on both the role and the user save (`requireReason`, max 500).
- Admin routes: `ROLE_MANAGE` + `enforceReauth('UPDATE_ROLE_CONFIG')`; user route also `assertCanConfigureUser` (404 unknown).
- Every response field DECLARED in the route schema (Fastify strips undeclared ones).
- Migration hand-authored; strip any `DROP TABLE "instrument_telemetry_history"`; `npm run check:migrations` must pass; apply to `compliance_core_db` AND `compliance_core_db_test`.
- Web tests run ONE FILE AT A TIME, judged by exit code; API e2e with `--pool=forks --poolOptions.forks.singleFork=true`.
- Mutation-check each new rule; restore from a backup copy, never `git checkout`.

## Review Focus

1. A user whose ROLE lacks Edit Instruments is given an ALL_EDIT user rule — they must still be refused (403), and the admin screen must say the rule cannot take effect. → Task 2 test, Task 4 test.
2. A user rule exists but the role has NO rule (all editable) — editing must stay all-editable (a user ALL_VIEW must not lock them out). → Task 1 table, Task 2 test.
3. Selected keys that differ only in case between the role and user lists (`Room` vs `room`) — one key, editable, no duplicate. → Task 1 test.
4. A user rule saved for a user who is then disabled/deleted, or a userId that does not exist — PUT answers 404 and writes nothing. → Task 3 test.
5. `/attribute-access/me` and the write gate disagreeing (the panel shows Edit, the server refuses) — both must come from `loadAttributeAccess(role, userId)`. → Task 2 test.

---

### Task 1: The combined rule in `@digilog/shared`

**Files:**
- Modify: `packages/shared/src/types/attribute-access.ts` (append after `attributeWriteNeedsReauth`)
- Modify: `packages/shared/src/index.ts` (the `attribute-access.js` export block, ~line 180-189)
- Test: `packages/shared/src/types/attribute-access.test.ts`

**Interfaces:**
- Produces: `effectiveAttributeAccess(role: AttributeAccess | null, user: AttributeAccess | null): AttributeAccess | null`

- [ ] **Step 1: Write the failing tests** (append to `attribute-access.test.ts`; add `effectiveAttributeAccess` to its import list)

```ts
describe('effectiveAttributeAccess — a user rule COMBINED with the role rule (2026-10-24)', () => {
  const rule = (mode: 'ALL_EDIT' | 'ALL_VIEW' | 'SELECTED', keys: string[] = [], requireReauth = false) => ({ mode, keys, requireReauth });

  it('no user rule: the role rule, unchanged (today\'s behaviour)', () => {
    expect(effectiveAttributeAccess(null, null)).toBeNull();
    const r = rule('SELECTED', ['Room']);
    expect(effectiveAttributeAccess(r, null)).toBe(r);
  });

  it('role not configured (all editable): stays all editable; only the user\'s re-auth switch can add a prompt', () => {
    expect(effectiveAttributeAccess(null, rule('ALL_VIEW'))).toEqual(rule('ALL_EDIT'));
    expect(effectiveAttributeAccess(null, rule('SELECTED', ['a'], true))).toEqual(rule('ALL_EDIT', [], true));
  });

  it('ALL_EDIT on either side wins', () => {
    expect(effectiveAttributeAccess(rule('ALL_EDIT'), rule('ALL_VIEW'))).toEqual(rule('ALL_EDIT'));
    expect(effectiveAttributeAccess(rule('ALL_VIEW'), rule('ALL_EDIT'))).toEqual(rule('ALL_EDIT'));
  });

  it('view-only only when BOTH are view-only', () => {
    expect(effectiveAttributeAccess(rule('ALL_VIEW'), rule('ALL_VIEW'))).toEqual(rule('ALL_VIEW'));
    expect(effectiveAttributeAccess(rule('ALL_VIEW'), rule('SELECTED', ['b']))).toEqual(rule('SELECTED', ['b']));
    expect(effectiveAttributeAccess(rule('SELECTED', ['a']), rule('ALL_VIEW'))).toEqual(rule('SELECTED', ['a']));
  });

  it('selected keys: the union, folded case-insensitively, first spelling kept', () => {
    expect(effectiveAttributeAccess(rule('SELECTED', ['Room', 'Area']), rule('SELECTED', ['room', 'Location'])))
      .toEqual(rule('SELECTED', ['Room', 'Area', 'Location']));
  });

  it('re-auth is never dropped by combining', () => {
    expect(effectiveAttributeAccess(rule('SELECTED', ['a'], true), rule('SELECTED', ['b']))?.requireReauth).toBe(true);
    expect(effectiveAttributeAccess(rule('SELECTED', ['a']), rule('SELECTED', ['b'], true))?.requireReauth).toBe(true);
  });

  it('still needs Edit Instruments: the combined rule never edits without it', () => {
    const eff = effectiveAttributeAccess(rule('ALL_VIEW'), rule('ALL_EDIT'));
    expect(canEditAttributeKey(eff, 'Room', false)).toBe(false);
    expect(canEditAttributeKey(eff, 'Room', true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/attribute-access.test.ts`
Expected: FAIL — `effectiveAttributeAccess` is not exported.

- [ ] **Step 3: Implement** (append to `attribute-access.ts`)

```ts
/**
 * The rule that applies to ONE USER: their role's rule COMBINED with their own
 * (2026-10-24, operator decision "combine"). The user may change a key if
 * EITHER rule allows it, so a user rule only ever ADDS editing — to restrict
 * one person below their role, they need a different role.
 *
 *   no user rule            → the role rule, exactly as before user rules existed
 *   role not configured     → ALL_EDIT (that role edits everything already);
 *                             the user's re-auth switch still applies
 *   ALL_EDIT on either side → ALL_EDIT
 *   ALL_VIEW and ALL_VIEW   → ALL_VIEW
 *   otherwise               → SELECTED, the union of both key lists
 *
 * `requireReauth` is either side's: combining never drops a safety prompt.
 * Edit Instruments is still required — `canEditAttributeKey` takes it apart
 * from this rule and refuses without it, whatever is combined here.
 */
export function effectiveAttributeAccess(
  role: AttributeAccess | null,
  user: AttributeAccess | null,
): AttributeAccess | null {
  if (!user) return role;
  const requireReauth = (role?.requireReauth ?? false) || user.requireReauth;
  if (!role || role.mode === 'ALL_EDIT' || user.mode === 'ALL_EDIT') {
    return { mode: 'ALL_EDIT', keys: [], requireReauth };
  }
  if (role.mode === 'ALL_VIEW' && user.mode === 'ALL_VIEW') {
    return { mode: 'ALL_VIEW', keys: [], requireReauth };
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of [...(role.mode === 'SELECTED' ? role.keys : []), ...(user.mode === 'SELECTED' ? user.keys : [])]) {
    const key = k.trim();
    const fold = key.toLowerCase();
    if (!key || seen.has(fold)) continue;
    seen.add(fold);
    keys.push(key);
  }
  return { mode: 'SELECTED', keys, requireReauth };
}
```

Add `effectiveAttributeAccess,` to the `export { … } from './types/attribute-access.js';` block in `packages/shared/src/index.ts`.

- [ ] **Step 4: Run to verify it passes, then build**

Run: `cd packages/shared && npx vitest run src/types/attribute-access.test.ts && npx tsc`
Expected: PASS, tsc silent.

- [ ] **Step 5: Mutation check** — temporarily change `(role?.requireReauth ?? false) || user.requireReauth` to `user.requireReauth`; the re-auth test must fail. Restore from a backup copy.

---

### Task 2: The user column and enforcement of the combined rule

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`model UserConfig`, after `dashboardLayout`)
- Create: `apps/api/prisma/migrations/20261024120000_user_attribute_access/migration.sql`
- Modify: `apps/api/src/modules/instruments/attribute-access.ts` (`loadAttributeAccess`, refusal wording)
- Modify: `apps/api/src/modules/instruments/routes.ts` (callers at ~1628 bulk, ~2474 write gate, ~2771 `/attribute-access/me`)
- Modify: `apps/api/src/modules/instrument-profiles/routes.ts` (~471)
- Test: `apps/api/src/e2e/user-attribute-access.e2e.test.ts` (create)

**Interfaces:**
- Consumes: `effectiveAttributeAccess` (Task 1)
- Produces: `loadAttributeAccess(role: string | null | undefined, userId: string | null | undefined): Promise<AttributeAccess | null>` — the second parameter is REQUIRED so no caller can forget the user.

- [ ] **Step 1: Schema + migration**

`schema.prisma`, in `model UserConfig` after `dashboardLayout`:

```prisma
  /// Instrument attribute access for THIS user, COMBINED with their role's
  /// (role_configs.attribute_access): the user may change a key if either rule
  /// allows it (2026-10-24). NULL = no user rule. Same shape as the role column.
  attributeAccess Json? @map("attribute_access") @db.JsonB
```

`migration.sql`:

```sql
-- Per-USER instrument attribute access (2026-10-24). Combined with the role's
-- rule by `effectiveAttributeAccess` (@digilog/shared): the user may change a
-- key if either rule allows it. NULL = no user rule. Nullable with NO default,
-- so adding it changes nobody's access.
-- HAND-AUTHORED; any DROP TABLE "instrument_telemetry_history" prisma emits is
-- stripped, as in every migration since 2026-08-08.
ALTER TABLE "user_configs" ADD COLUMN "attribute_access" JSONB;
```

Run (from `apps/api`, API not running):
```bash
npm run check:migrations
DATABASE_URL="$(grep -E '^DATABASE_URL' .env | cut -d= -f2-)" npx prisma migrate deploy
DATABASE_URL="$(grep -E '^DATABASE_URL' .env | cut -d= -f2- | sed 's/compliance_core_db/compliance_core_db_test/')" npx prisma migrate deploy
npx prisma generate
```
Expected: guard OK; "1 migration applied" on each database.

- [ ] **Step 2: Write the failing e2e** (`apps/api/src/e2e/user-attribute-access.e2e.test.ts`)

```ts
/**
 * 2026-10-24 — per-USER attribute access, combined with the role's rule.
 * Throwaway role (Edit Instruments) + two users of it + one instrument with
 * attributes `Room` and `Area`. The role is SELECTED [Room]; user A also gets
 * SELECTED [Area] of their own; user B gets nothing of their own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

const S = Date.now().toString(36).toUpperCase();
const ROLE = `UAA_${S}`;
const PW = 'UserAttr@Pass1';
const U = { A: `uaa${S}a`.toLowerCase(), B: `uaa${S}b`.toLowerCase() };
const ids: Record<string, string> = {};
let app: FastifyInstance;
let tok: Record<string, Record<string, string>> = {};
let instrumentId = '';
let originalReauth: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;

const setRoleRule = (rule: unknown) => prisma.roleConfig.upsert({
  where: { role: ROLE }, update: { attributeAccess: (rule ?? Prisma.DbNull) as never }, create: { role: ROLE, attributeAccess: (rule ?? Prisma.DbNull) as never },
});
const setUserRule = (userId: string, rule: unknown) => prisma.userConfig.upsert({
  where: { userId }, update: { attributeAccess: (rule ?? Prisma.DbNull) as never }, create: { userId, attributeAccess: (rule ?? Prisma.DbNull) as never },
});
const putAttr = (who: string, key: string, value: string) => app.inject({
  method: 'PUT', url: `/api/instruments/${instrumentId}/attributes/${encodeURIComponent(key)}`, headers: tok[who],
  payload: { value, reason: 'e2e attribute change' },
});
const me = async (who: string) => (await app.inject({ method: 'GET', url: '/api/instruments/attribute-access/me', headers: tok[who] })).json();

beforeAll(async () => {
  app = await buildApp();
  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  if (existing) originalReauth = { configValue: existing.configValue, configType: existing.configType, requiresReauth: existing.requiresReauth };
  await prisma.systemConfig.upsert({ where: { configKey: 'action-reauth' }, update: { configValue: {} as never }, create: { configKey: 'action-reauth', configValue: {} as never, configType: 'security', requiresReauth: false } });
  invalidateReauthCache();
  await prisma.role.create({ data: { name: ROLE, displayName: ROLE, hierarchyLevel: 1, isSystem: false, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE'] } });
  invalidateRolePermsCache(ROLE);
  for (const [k, username] of Object.entries(U)) {
    ids[k] = (await prisma.user.create({ data: { username, fullName: username, role: ROLE, status: 'ENABLED', passwordHash: await hashPassword(PW), passwordChangedAt: new Date() } })).id;
    tok[k] = { authorization: `Bearer ${await loginAs(app, username, PW)}` };
  }
  const admin = { authorization: `Bearer ${await loginAs(app)}` };
  const created = await app.inject({ method: 'POST', url: '/api/instruments', headers: admin, payload: { name: `UAA-${S}`, code: `UAA-${S}`, profileId: await fixtureProfileId('fixture:user-attribute-access') } });
  instrumentId = created.json().id;
  for (const key of ['Room', 'Area']) {
    await app.inject({ method: 'POST', url: `/api/instruments/${instrumentId}/attributes`, headers: admin, payload: { key, value: 'x' } });
  }
});

afterAll(async () => {
  try {
    if (originalReauth) await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauth as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
  } finally { invalidateReauthCache(); }
  try { await prisma.instrument.deleteMany({ where: { id: instrumentId } }); } catch { /* best effort */ }
  try {
    const userIds = Object.values(ids);
    await prisma.userConfig.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch { /* best effort */ }
  try { await prisma.roleConfig.deleteMany({ where: { role: ROLE } }); await prisma.role.deleteMany({ where: { name: ROLE } }); } finally { invalidateRolePermsCache(ROLE); }
  await app.close();
});

describe('a user rule is COMBINED with the role rule', () => {
  it('role SELECTED [Room] + user A SELECTED [Area]: A may change Area, B (no rule of their own) may not', async () => {
    await setRoleRule({ mode: 'SELECTED', keys: ['Room'], requireReauth: false });
    await setUserRule(ids.A, { mode: 'SELECTED', keys: ['Area'], requireReauth: false });
    expect((await putAttr('A', 'Area', 'a1')).statusCode).toBe(200);
    expect((await putAttr('A', 'Room', 'r1')).statusCode).toBe(200);
    const refused = await putAttr('B', 'Area', 'b1');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/You may view "Area"/);
  });

  it('/attribute-access/me returns the combined rule — the same one the gate enforced', async () => {
    expect(await me('A')).toMatchObject({ mode: 'SELECTED', keys: ['Room', 'Area'] });
    expect(await me('B')).toMatchObject({ mode: 'SELECTED', keys: ['Room'] });
  });

  it('role not configured: a user ALL_VIEW rule leaves everything editable', async () => {
    await setRoleRule(null);
    await setUserRule(ids.A, { mode: 'ALL_VIEW', keys: [], requireReauth: false });
    expect((await putAttr('A', 'Room', 'r2')).statusCode).toBe(200);
    expect((await me('A')).mode).toBe('ALL_EDIT');
  });

  it('a user ALL_EDIT rule never edits without Edit Instruments on the role', async () => {
    await setRoleRule({ mode: 'ALL_VIEW', keys: [], requireReauth: false });
    await setUserRule(ids.A, { mode: 'ALL_EDIT', keys: [], requireReauth: false });
    await prisma.role.update({ where: { name: ROLE }, data: { permissions: ['INSTRUMENT_READ'] } });
    invalidateRolePermsCache(ROLE);
    try {
      expect((await putAttr('A', 'Room', 'r3')).statusCode).toBe(403);
    } finally {
      await prisma.role.update({ where: { name: ROLE }, data: { permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE'] } });
      invalidateRolePermsCache(ROLE);
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/e2e/user-attribute-access.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — A is refused on Area (the user rule is not read yet).

- [ ] **Step 4: Implement the resolver and the callers**

`apps/api/src/modules/instruments/attribute-access.ts` — add `effectiveAttributeAccess` to the shared import, and replace `loadAttributeAccess`:

```ts
/**
 * The rule for THIS request: the role's, combined with the user's own
 * (2026-10-24, `effectiveAttributeAccess`). `userId` is required — a caller
 * that passed only the role would enforce a different rule from the one
 * `/attribute-access/me` shows. Read per request, never cached: a stale cache
 * here would keep enforcing a rule an admin has just removed.
 */
export async function loadAttributeAccess(
  role: string | null | undefined,
  userId: string | null | undefined,
): Promise<AttributeAccess | null> {
  if (!role) return null;
  const [roleRow, userRow] = await Promise.all([
    prisma.roleConfig.findUnique({ where: { role }, select: { attributeAccess: true } }),
    userId ? prisma.userConfig.findUnique({ where: { userId }, select: { attributeAccess: true } }) : Promise.resolve(null),
  ]);
  return effectiveAttributeAccess(
    parseAttributeAccess(roleRow?.attributeAccess ?? null),
    parseAttributeAccess(userRow?.attributeAccess ?? null),
  );
}
```

Refusal wording in `refuseAttributeWrite` (the rule is no longer only the role's):

```ts
        message: isNewKey
          ? 'You may view instrument attributes but not add them.'
          : `You may view "${key}" but not change it.`,
```

Callers:
- `instruments/routes.ts` ~1628: `const access = await loadAttributeAccess(role, req.user?.sub);`
- `instruments/routes.ts` ~2474: `const access = await loadAttributeAccess(req.user?.role, req.user?.sub);`
- `instruments/routes.ts` ~2771: `const access = await loadAttributeAccess(req.user?.role, req.user?.sub);`
- `instrument-profiles/routes.ts` ~471: `const access = await loadAttributeAccess(ctx.userRole, ctx.userSub);`

Search for any test asserting the old wording: `grep -rn "Your role may view" apps/api/src apps/web/src` and update it to the new text.

- [ ] **Step 5: Run to verify it passes, then the existing attribute suites**

```bash
cd apps/api
npx vitest run src/e2e/user-attribute-access.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true
for f in src/e2e/instrument-attributes.test.ts src/e2e/bulk-attributes.e2e.test.ts src/e2e/role-attribute-access.e2e.test.ts; do npx vitest run $f --pool=forks --poolOptions.forks.singleFork=true; done
npx vitest run src/e2e/instrument-profiles.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true
```
Expected: all PASS.

- [ ] **Step 6: Mutation check** — make `loadAttributeAccess` ignore `userRow` (pass `null` as the user rule); the first e2e case must fail. Restore from a backup copy.

---

### Task 3: Admin routes — list and save a user's rule; a reason on both saves

**Files:**
- Modify: `apps/api/src/modules/roles/routes.ts` (role PUT ~788; add two routes after it; import `roleHasPermission`, `effectiveAttributeAccess`)
- Modify: `apps/api/src/e2e/role-attribute-access.e2e.test.ts` (reason on PUT; new cases)

**Interfaces:**
- Consumes: `effectiveAttributeAccess` (Task 1), `user_configs.attribute_access` (Task 2)
- Produces:
  - `GET /api/roles/attribute-access/users` → `{ users: Array<{ userId, username, fullName, role, mode: string|null, keys: string[], requireReauth: boolean, effective: { mode: string|null, keys: string[], requireReauth: boolean }, roleHasUpdate: boolean }> }`
  - `PUT /api/roles/attribute-access/user/:userId` body `{ mode: string|null, keys?: string[], requireReauth?: boolean, reason: string }` → `{ userId, mode, keys, requireReauth }`
  - `PUT /api/roles/attribute-access/:name` now REQUIRES `reason`

- [ ] **Step 1: Write the failing tests** (in `role-attribute-access.e2e.test.ts`)

Change the helper so existing cases send a reason:

```ts
const put = (body: Record<string, unknown>, role = ROLE) =>
  app.inject({ method: 'PUT', url: `/api/roles/attribute-access/${role}`, headers: auth, payload: { reason: 'e2e attribute access', ...body } });
```

Append:

```ts
describe('a reason is required to change attribute access (2026-10-24)', () => {
  it('role save without a reason is 400 REASON_REQUIRED and writes nothing', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/${ROLE}`, headers: auth, payload: { mode: 'ALL_VIEW' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('REASON_REQUIRED');
    expect(await roleRow()).toMatchObject({ mode: null });
  });
});

describe('per-USER attribute access (2026-10-24)', () => {
  const putUser = (userId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/roles/attribute-access/user/${userId}`, headers: auth, payload: body });
  const operatorId = async () => (await prisma.user.findUniqueOrThrow({ where: { username: 'RB0001' }, select: { id: true } })).id;
  afterEach(async () => {
    await prisma.userConfig.updateMany({ where: { userId: await operatorId() }, data: { attributeAccess: Prisma.DbNull } });
  });

  it('lists every enabled user with their own rule, the combined result and whether their role can edit instruments', async () => {
    await put({ mode: 'SELECTED', keys: ['Room'] });
    const id = await operatorId();
    expect((await putUser(id, { mode: 'SELECTED', keys: ['Area'], reason: 'e2e' })).statusCode).toBe(200);
    const row = (await app.inject({ method: 'GET', url: '/api/roles/attribute-access/users', headers: auth })).json().users
      .find((u: { userId: string }) => u.userId === id);
    expect(row).toMatchObject({ role: ROLE, mode: 'SELECTED', keys: ['Area'], effective: { mode: 'SELECTED', keys: ['Room', 'Area'] } });
    expect(typeof row.roleHasUpdate).toBe('boolean');
  });

  it('needs a reason, and writes a CONFIG_CHANGED row with it', async () => {
    const id = await operatorId();
    expect((await putUser(id, { mode: 'ALL_EDIT' })).statusCode).toBe(400);
    const reason = `e2e user rule ${Date.now()}`;
    expect((await putUser(id, { mode: 'ALL_EDIT', reason })).statusCode).toBe(200);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'CONFIG_CHANGED', targetType: 'user_config', targetId: id }, orderBy: { timestamp: 'desc' } });
    expect(row?.reason).toBe(reason);
    expect(row?.afterValue).toMatchObject({ attributeAccess: { mode: 'ALL_EDIT' } });
  });

  it('a null mode clears the user rule to SQL NULL', async () => {
    const id = await operatorId();
    await putUser(id, { mode: 'ALL_VIEW', reason: 'e2e' });
    expect((await putUser(id, { mode: null, reason: 'e2e clear' })).statusCode).toBe(200);
    const cfg = await prisma.userConfig.findUnique({ where: { userId: id }, select: { attributeAccess: true } });
    expect(cfg?.attributeAccess).toBeNull();
  });

  it('an unknown user is 404 and nothing is written', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await putUser(ghost, { mode: 'ALL_EDIT', reason: 'e2e' })).statusCode).toBe(404);
    expect(await prisma.userConfig.count({ where: { userId: ghost } })).toBe(0);
  });
});
```

(`afterEach` and `Prisma` are already imported in this file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/e2e/role-attribute-access.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — the reason case gets 200; the user routes 404.

- [ ] **Step 3: Implement** in `apps/api/src/modules/roles/routes.ts`

Imports: add `effectiveAttributeAccess` to the `@digilog/shared` import block; add `import { roleHasPermission } from '../../plugins/rbac.js';`.

Above the role PUT, a shared describer:

```ts
  /** Bounded wording for an attribute rule (signature_meaning is VARCHAR(255)). */
  const describeAttributeAccess = (next: AttributeAccess | null) => (next === null
    ? 'not configured (inherits Edit Instruments)'
    : next.mode === 'SELECTED'
      ? `${next.keys.length} attribute(s) editable`
      : next.mode === 'ALL_EDIT' ? 'all attributes editable' : 'all attributes view-only')
    + (next?.requireReauth ? ', password required' : '');
```

(`AttributeAccess` type imported from `@digilog/shared`.) In the role PUT: add `reason: { type: 'string', maxLength: 500 }` to the body schema; read `reason` from the body; after the `assertCanConfigureRole` line add `const why = requireReason(body.reason, "Changing a role's attribute access");`; replace the inline `describe` with `describeAttributeAccess(next)` in the signature meaning; pass `reason: why` to `auditLog`.

After the role PUT, add:

```ts
  // GET /attribute-access/users — every enabled user's own rule, and the rule
  // that actually applies to them (2026-10-24). `effective` is computed HERE,
  // with the same function the gate uses, so the screen shows the server's
  // answer rather than re-deriving it.
  app.get('/attribute-access/users', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: "Every user's own instrument attribute access, and the combined rule that applies",
      response: {
        200: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  username: { type: 'string' },
                  fullName: { type: 'string', nullable: true },
                  role: { type: 'string' },
                  mode: { type: 'string', nullable: true },
                  keys: { type: 'array', items: { type: 'string' } },
                  requireReauth: { type: 'boolean' },
                  // Declared with its inner keys, or Fastify strips them.
                  effective: {
                    type: 'object',
                    properties: {
                      mode: { type: 'string', nullable: true },
                      keys: { type: 'array', items: { type: 'string' } },
                      requireReauth: { type: 'boolean' },
                    },
                  },
                  // A user rule cannot take effect without Edit Instruments.
                  roleHasUpdate: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const [users, roleCfgs, userCfgs] = await Promise.all([
      prisma.user.findMany({ where: { status: 'ENABLED' }, select: { id: true, username: true, fullName: true, role: true }, orderBy: { username: 'asc' } }),
      prisma.roleConfig.findMany({ select: { role: true, attributeAccess: true } }),
      prisma.userConfig.findMany({ select: { userId: true, attributeAccess: true } }),
    ]);
    const roleRule = new Map(roleCfgs.map((c) => [c.role, parseAttributeAccess(c.attributeAccess)]));
    const userRule = new Map(userCfgs.map((c) => [c.userId, parseAttributeAccess(c.attributeAccess)]));
    const hasUpdate = new Map<string, boolean>();
    for (const role of new Set(users.map((u) => u.role))) hasUpdate.set(role, await roleHasPermission(role, 'INSTRUMENT_UPDATE'));
    return {
      users: users.map((u) => {
        const own = userRule.get(u.id) ?? null;
        const eff = effectiveAttributeAccess(roleRule.get(u.role) ?? null, own);
        return {
          userId: u.id, username: u.username, fullName: u.fullName, role: u.role,
          mode: own?.mode ?? null, keys: own?.keys ?? [], requireReauth: own?.requireReauth ?? false,
          effective: { mode: eff?.mode ?? null, keys: eff?.keys ?? [], requireReauth: eff?.requireReauth ?? false },
          roleHasUpdate: hasUpdate.get(u.role) ?? false,
        };
      }),
    };
  });

  // PUT /attribute-access/user/:userId — one user's own rule (2026-10-24).
  app.put('/attribute-access/user/:userId', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: "Set a user's own instrument attribute access (combined with their role's)",
      params: { type: 'object', properties: { userId: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          mode: { type: 'string', nullable: true, enum: [...ATTRIBUTE_ACCESS_MODES, null] as never },
          keys: { type: 'array', items: { type: 'string' } },
          requireReauth: { type: 'boolean' },
          reason: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { userId } = req.params as { userId: string };
    const body = req.body as { mode?: string | null; keys?: string[]; requireReauth?: boolean; reason?: string };
    const ctx = buildContext(req);
    const user = await assertCanConfigureUser(ctx, userId);
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND', message: 'User not found.' });
    const why = requireReason(body.reason, "Changing a user's attribute access");

    const next = body.mode === null || body.mode === undefined
      ? null
      : parseAttributeAccess({
          mode: body.mode,
          keys: body.mode === 'SELECTED' ? (body.keys ?? []) : [],
          requireReauth: body.requireReauth === true,
        });
    if (body.mode && !next) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: `mode must be one of: ${ATTRIBUTE_ACCESS_MODES.join(', ')}` });
    }

    await prisma.$transaction(async (tx) => {
      const before = await tx.userConfig.findUnique({ where: { userId }, select: { attributeAccess: true } });
      await tx.userConfig.upsert({
        where: { userId },
        create: { userId, attributeAccess: (next as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
        update: { attributeAccess: (next as Prisma.InputJsonObject | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'CONFIG_CHANGED',
        targetType: 'user_config', targetId: userId,
        beforeValue: { attributeAccess: before?.attributeAccess ?? null },
        afterValue: { attributeAccess: next },
        reason: why,
        signatureMeaning: `User "${user.username.slice(0, 60)}" attribute access set to ${describeAttributeAccess(next)}`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { userId, mode: next?.mode ?? null, keys: next?.keys ?? [], requireReauth: next?.requireReauth ?? false };
  });
```

- [ ] **Step 4: Run to verify it passes, plus neighbours**

```bash
cd apps/api
for f in src/e2e/role-attribute-access.e2e.test.ts src/e2e/user-attribute-access.e2e.test.ts src/e2e/role-config-privilege.e2e.test.ts src/e2e/role-guards.e2e.test.ts; do npx vitest run $f --pool=forks --poolOptions.forks.singleFork=true; done
npm run lint
```
Expected: all PASS; lint exit 0.

- [ ] **Step 5: Mutation checks** — (a) remove the `effective` declaration from the 200 schema → the list case fails; (b) remove `requireReason` from the user PUT → the reason case fails. Restore each from a backup copy.

---

### Task 4: The Configuration page — Roles and Users tabs; the old tab removed

**Files:**
- Modify: `apps/web/src/routes/config/roles-components/attribute-access-tab.tsx` (reason input + sent)
- Create: `apps/web/src/routes/config/roles-components/user-attribute-access.tsx`
- Create: `apps/web/src/routes/config/attribute-access.tsx`
- Modify: `apps/web/src/routes/config/role-access.tsx` (remove the tab, its render line and import; drop `'attribute-access'` from `TabId`)
- Modify: `apps/web/src/routes/config/index.tsx` (a `superAdminCards` entry after "Instrument Attributes")
- Modify: `apps/web/src/main.tsx` (lazy import + `<Route path="/config/attribute-access">`)
- Test: `apps/web/src/routes/config/roles-components/__tests__/tabs-reauth.test.tsx` (type a reason before saving the attribute tab)
- Test: `apps/web/src/routes/config/__tests__/attribute-access-page.test.tsx` (create)

**Interfaces:**
- Consumes: `GET /api/roles/attribute-access` (existing: `{roles, availableKeys}`), `GET /api/roles/attribute-access/users`, `PUT /api/roles/attribute-access/:name`, `PUT /api/roles/attribute-access/user/:userId` (Task 3)
- Produces: `AttributeAccessConfigPage` (route `/config/attribute-access`), `UserAttributeAccess` component

- [ ] **Step 1: Write the failing page test** (`apps/web/src/routes/config/__tests__/attribute-access-page.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const ROLES = { roles: [{ role: 'QA', mode: 'ALL_VIEW', keys: [], requireReauth: false, canUpdateInstruments: false }], availableKeys: ['Room', 'Area'] };
const USERS = { users: [
  { userId: 'u1', username: '333333', fullName: 'Q A', role: 'QA', mode: null, keys: [], requireReauth: false,
    effective: { mode: 'ALL_VIEW', keys: [], requireReauth: false }, roleHasUpdate: false },
] };
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: key === '/api/roles/attribute-access' ? ROLES : key === '/api/roles/attribute-access/users' ? USERS : undefined,
    mutate: vi.fn(async () => undefined),
  }),
}));
const put = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...(a as [])), putWithReauth: vi.fn() } }));
const executed: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void }) => { executed.push(action); await cb(undefined); opts?.onSuccess?.(); },
    isOpen: false, password: '', error: '', isVerifying: false, setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));
const toastError = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn() } }) }));
vi.mock('@/hooks/use-attribute-labels', () => ({ useAttributeLabels: () => ({ labelFor: (k: string) => k }) }));

const { AttributeAccessConfigPage } = await import('../attribute-access');
const mount = () => render(<MemoryRouter><AttributeAccessConfigPage /></MemoryRouter>);

beforeEach(() => { put.mockClear(); toastError.mockClear(); executed.length = 0; });

describe('Configuration → Attribute Edit Access', () => {
  it('opens on the Roles tab with the role editor', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Attribute Edit Access');
    expect(screen.getByText('QA')).toBeInTheDocument();
  });

  it('Users tab: a chosen user shows their role\'s rule, the combined result, and the Edit Instruments warning', async () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }));
    fireEvent.click(screen.getByRole('button', { name: /select a user/i }));
    fireEvent.click(await screen.findByText(/333333/));
    expect(screen.getByTestId('user-role-rule')).toHaveTextContent('All view-only');
    expect(screen.getByTestId('user-effective-rule')).toHaveTextContent('All view-only');
    expect(screen.getByTestId('user-rule-no-update')).toBeInTheDocument();
  });

  it('a user save needs a reason, then PUTs the user route under UPDATE_ROLE_CONFIG with it', async () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }));
    fireEvent.click(screen.getByRole('button', { name: /select a user/i }));
    fireEvent.click(await screen.findByText(/333333/));
    fireEvent.click(screen.getByLabelText('All editable'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(put).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Reason required', expect.any(String));
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'QA lead edits limits' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/api/roles/attribute-access/user/u1', { mode: 'ALL_EDIT', keys: [], requireReauth: false, reason: 'QA lead edits limits' });
    expect(executed).toEqual(['UPDATE_ROLE_CONFIG']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/config/__tests__/attribute-access-page.test.tsx`
Expected: FAIL — `../attribute-access` does not exist.

- [ ] **Step 3: The role editor sends a reason** (`attribute-access-tab.tsx`)

Add `const [reasons, setReasons] = useState<Record<string, string>>({});`. In `save(r)` before `setSaving`:

```ts
    const why = (reasons[r.role] ?? '').trim();
    if (!why) {
      toast.error('Reason required', 'State why this role\'s attribute access is changing — it is recorded in the audit trail.');
      return;
    }
```

and send `reason: why` in `body`; on success also clear `reasons[r.role]`. Under each card, when `dirty(r)`:

```tsx
            {dirty(r) && (
              <div className="mt-3">
                <label htmlFor={`attr-reason-${r.role}`} className="mb-1 block text-xs font-medium text-slate-600">Reason for change</label>
                <input id={`attr-reason-${r.role}`} className="ctl w-full" maxLength={500}
                  value={reasons[r.role] ?? ''} onChange={(e) => setReasons((x) => ({ ...x, [r.role]: e.target.value }))}
                  placeholder="Why is this changing? Recorded in the audit trail." />
              </div>
            )}
```

Export `MODE_LABEL` (the user editor shows the same words).

- [ ] **Step 4: The user editor** (`user-attribute-access.tsx`)

```tsx
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { ATTRIBUTE_ACCESS_MODES, type AttributeAccessMode } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useToast } from '@/hooks/use-toast';
import { useAttributeLabels } from '@/hooks/use-attribute-labels';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { MODE_LABEL } from './attribute-access-tab';

interface Rule { mode: AttributeAccessMode | null; keys: string[]; requireReauth: boolean }
interface UserRow extends Rule { userId: string; username: string; fullName: string | null; role: string; effective: Rule; roleHasUpdate: boolean }
interface RoleRow extends Rule { role: string }

const describe = (r: Rule) => (r.mode === null ? 'Not configured (Edit Instruments decides)'
  : r.mode === 'SELECTED' ? `${MODE_LABEL.SELECTED}: ${r.keys.join(', ') || 'none'}` : MODE_LABEL[r.mode]);

/**
 * One USER's own attribute rule (2026-10-24). Combined with their role's: the
 * user may change a key if EITHER allows it — so a user rule only ever adds
 * editing. Shown beside it: the role's rule and the COMBINED result, both the
 * server's answer (`GET /api/roles/attribute-access/users`), and a warning when
 * the role lacks Edit Instruments (the rule then cannot take effect).
 */
export function UserAttributeAccess() {
  const { toast } = useToast();
  const { labelFor } = useAttributeLabels();
  const reauth = useReauth();
  const { data, mutate } = useSWR<{ users: UserRow[] }>('/api/roles/attribute-access/users');
  const { data: rolesData } = useSWR<{ roles: RoleRow[]; availableKeys: string[] }>('/api/roles/attribute-access');
  const [userId, setUserId] = useState('');
  const [draft, setDraft] = useState<Rule | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const users = data?.users ?? [];
  const user = users.find((u) => u.userId === userId) ?? null;
  const roleRule = rolesData?.roles.find((r) => r.role === user?.role) ?? null;
  const availableKeys = rolesData?.availableKeys ?? [];
  const now: Rule | null = user ? (draft ?? { mode: user.mode, keys: user.keys, requireReauth: user.requireReauth }) : null;
  const options = useMemo(() => users.map((u) => ({ value: u.userId, label: `${u.username}${u.fullName ? ` — ${u.fullName}` : ''} (${u.role})` })), [users]);

  const pick = (id: string) => { setUserId(id); setDraft(null); setReason(''); };
  const edit = (patch: Partial<Rule>) => now && setDraft({ ...now, ...patch });
  const toggleKey = (key: string) => {
    if (!now) return;
    const has = now.keys.some((k) => k.trim().toLowerCase() === key.trim().toLowerCase());
    edit({ keys: has ? now.keys.filter((k) => k.trim().toLowerCase() !== key.trim().toLowerCase()) : [...now.keys, key] });
  };

  const save = () => {
    if (!user || !now) return;
    const why = reason.trim();
    if (!why) { toast.error('Reason required', 'State why this user\'s attribute access is changing — it is recorded in the audit trail.'); return; }
    const url = `/api/roles/attribute-access/user/${encodeURIComponent(user.userId)}`;
    const body = { mode: now.mode, keys: now.mode === 'SELECTED' ? now.keys : [], requireReauth: now.requireReauth, reason: why };
    setSaving(true);
    void reauth.execute('UPDATE_ROLE_CONFIG', async (password?: string) => {
      if (password) await apiClient.putWithReauth(url, body, password);
      else await apiClient.put(url, body);
    }, {
      onSuccess: async () => { setDraft(null); setReason(''); setSaving(false); await mutate(); toast.success('Attribute access saved', `"${user.username}" updated.`); },
      onError: (e) => { toast.error('Could not save', (e as Error)?.message ?? 'The change was not saved.'); setSaving(false); },
      onCancel: () => setSaving(false),
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        A user&apos;s own rule is combined with their role&apos;s: they may change an attribute if either allows it.
      </p>
      <SearchableSelect value={userId} onChange={pick} options={options} placeholder="Select a user" className="max-w-md" />
      {user && now && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <dl className="grid gap-1 text-sm sm:grid-cols-2">
            <div><dt className="text-xs font-semibold uppercase text-slate-500">Their role ({user.role})</dt>
              <dd data-testid="user-role-rule">{roleRule ? describe(roleRule) : describe({ mode: null, keys: [], requireReauth: false })}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-slate-500">What applies</dt>
              <dd data-testid="user-effective-rule">{describe(user.effective)}</dd></div>
          </dl>
          {!user.roleHasUpdate && (
            <p data-testid="user-rule-no-update" className="text-xs text-amber-700">
              Their role has no Edit Instruments permission, so this user can change no attribute whatever is set here.
            </p>
          )}
          <div className="flex flex-wrap gap-4">
            {([null, ...ATTRIBUTE_ACCESS_MODES] as (AttributeAccessMode | null)[]).map((m) => (
              <label key={String(m)} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="user-attr-mode" className="ctl-radio" checked={now.mode === m} onChange={() => edit({ mode: m })} />
                {m === null ? 'No rule of their own' : MODE_LABEL[m]}
              </label>
            ))}
          </div>
          {now.mode === 'SELECTED' && (
            <div className="grid gap-1 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
              {availableKeys.map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="ctl-check" checked={now.keys.some((s) => s.trim().toLowerCase() === k.trim().toLowerCase())} onChange={() => toggleKey(k)} />
                  <span className="truncate" title={k}>{labelFor(k)}</span>
                </label>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="ctl-check" checked={now.requireReauth} disabled={now.mode === null || now.mode === 'ALL_VIEW'} onChange={(e) => edit({ requireReauth: e.target.checked })} />
            Ask for this user&apos;s password on every attribute change
          </label>
          {draft && (
            <div>
              <label htmlFor="user-attr-reason" className="mb-1 block text-xs font-medium text-slate-600">Reason for change</label>
              <input id="user-attr-reason" className="ctl w-full" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this changing? Recorded in the audit trail." />
            </div>
          )}
          <Button type="button" size="sm" disabled={!draft || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={reauth.cancel} />
    </div>
  );
}
```

- [ ] **Step 5: The page** (`attribute-access.tsx`)

```tsx
import { useState } from 'react';
import { PageHero } from '@/components/ui/page-hero';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { AttributeAccessTab } from './roles-components/attribute-access-tab';
import { UserAttributeAccess } from './roles-components/user-attribute-access';

/**
 * Configuration → ATTRIBUTE EDIT ACCESS (2026-10-24, operator: "who can edit
 * which attributes … configurable role wise or user wise"). Moved here from
 * Roles & Access → Attribute Access, plus a per-USER rule combined with the
 * role's. One rule, enforced wherever an attribute is edited (Settings page,
 * instrument detail, bulk upload, profile key removal). SUPER_ADMIN only.
 */
type Tab = 'roles' | 'users';
const TABS: { id: Tab; label: string }[] = [{ id: 'roles', label: 'Roles' }, { id: 'users', label: 'Users' }];

export function AttributeAccessConfigPage() {
  const [tab, setTab] = useState<Tab>('roles');
  return (
    <div className="space-y-6">
      <PageHero
        title="Attribute Edit Access"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Attribute Edit Access' }]}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} idPrefix="attribute-access" variant="segmented" aria-label="Attribute edit access" className="w-full sm:w-fit" />
      <TabPanel id={tab} idPrefix="attribute-access">
        {tab === 'roles' && <AttributeAccessTab />}
        {tab === 'users' && <UserAttributeAccess />}
      </TabPanel>
    </div>
  );
}
```

- [ ] **Step 6: Wire it in, remove the old tab**
- `main.tsx`: `const AttributeAccessConfigPage = lazy(() => import('./routes/config/attribute-access').then(m => ({ default: m.AttributeAccessConfigPage })));` and beside `/config/report-settings`:
  `<Route path="/config/attribute-access" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><AttributeAccessConfigPage /></Suspense></RequireRole>} />`
- `config/index.tsx` `superAdminCards`, after the Instrument Attributes card:
  `{ title: 'Attribute Edit Access', description: 'Which roles and users may change which instrument attributes', href: '/config/attribute-access', icon: (<svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>) },`
- `role-access.tsx`: remove `'attribute-access'` from `TabId`, the tab entry, the render line + its comment, and the `AttributeAccessTab` import.
- `tabs-reauth.test.tsx` "Attribute Access tab signs as UPDATE_ROLE_CONFIG": after making the card dirty, type a reason into `Reason for change` before clicking Save; expect the PUT body to include `reason`.

- [ ] **Step 7: Run the web tests, one file at a time, then lint**

```bash
cd apps/web
for f in src/routes/config/__tests__/attribute-access-page.test.tsx src/routes/config/roles-components/__tests__/tabs-reauth.test.tsx src/routes/config/roles-components/__tests__/attribute-access-tab-labels.test.tsx src/routes/config/__tests__/pages-hero.test.tsx src/__tests__/route-guard-coverage.test.ts src/routes/settings/__tests__/settings-page.test.tsx; do npx vitest run $f; echo "exit=$?"; done
npm run lint
```
Expected: every exit=0; lint exit 0.

- [ ] **Step 8: Mutation checks** — (a) make the user save skip the reason check → the reason case fails; (b) render the warning unconditionally false → the Users-tab case fails. Restore each from a backup copy.

---

### Task 5: Docs, counts, final verification, commit

**Files:**
- Modify: `CHANGELOG.md`, `docs/feature-notes.md` (the Instrument ATTRIBUTE ACCESS note), `docs/recreation/06-api/endpoints.md`, `CLAUDE.md` + `apps/web/CLAUDE.md` (config pages 22 → 23, `<Route`s 53 → 54), `tasks/todo.md`

- [ ] **Step 1: Re-derive counts**

```bash
ls apps/web/src/routes/config/*.tsx | wc -l     # expect 23
grep -cE "<Route" apps/web/src/main.tsx          # expect 54
```
Sweep the active doc set for the old values in context ("22 pages", "**22** files in `routes/config/`", "**53** `<Route`") and update each live mention.

- [ ] **Step 2: Write the docs**
- CHANGELOG entry: the request, the decisions (everywhere / moved / combine), the column + migration, the routes, the page, the reason now required on the role save, tests + mutation checks, AWS: migration applies with the next deploy.
- feature-notes: extend the ATTRIBUTE ACCESS note — user layer (`user_configs.attribute_access`), the combine table in one line, `loadAttributeAccess(role, userId)` (userId required), new location Configuration → Attribute Edit Access, reason required.
- endpoints.md: the two new routes; the role PUT now requires `reason`.

- [ ] **Step 3: Final verification**

```bash
cd packages/shared && npx vitest run && npx tsc
cd ../../apps/api && npm run lint
```
Expected: all pass. (API e2e and web files were run per task.)

- [ ] **Step 4: Commit** (explicit paths; never `.claude/scheduled_tasks.lock`)

```bash
git add <every file touched in Tasks 1–5>
git commit -m "feat(attributes): attribute edit access per role and per user"
```
Not pushed.
