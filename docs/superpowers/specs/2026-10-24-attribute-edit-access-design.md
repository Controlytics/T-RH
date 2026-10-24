# Attribute Edit Access — per role AND per user (design)

**Date:** 2026-10-24
**Operator request:** "add one new configuration, in that configuration in settings who can edit which attributes that should configurable role wise or user wise"
**Decisions taken (asked):**
- The rule applies **everywhere** an attribute is edited (Settings page, Instrument detail Attributes panel, bulk upload, profile key removal) — one rule for one §11 record.
- Today's **Roles & Access → Attribute Access** tab **moves** into the new configuration.
- A user rule and the role rule **combine**: the user may edit a key if EITHER allows it.
- Design approved in chat 2026-10-24.

## 1. What exists today

- `role_configs.attribute_access` JSONB, nullable. `parseAttributeAccess` reads it into `{mode: ALL_EDIT | ALL_VIEW | SELECTED, keys[], requireReauth}`; `null` = not configured = everything editable for a role holding `INSTRUMENT_UPDATE` (`@digilog/shared` `attribute-access.ts`).
- The rule NARROWS `INSTRUMENT_UPDATE` and never widens it (`canEditAttributeKey`, `canAddAttribute`). SUPER_ADMIN is NOT exempt.
- `loadAttributeAccess(role)` (`apps/api/src/modules/instruments/attribute-access.ts`) is called from four places, each with the ROLE only:
  `instruments/routes.ts` attribute writes (POST/PUT/DELETE gate), `GET /api/instruments/attribute-access/me`, the bulk-upload path, and `instrument-profiles/routes.ts` (key removal cascade).
- Admin: `GET /api/roles/attribute-access`, `PUT /api/roles/attribute-access/:name` (ROLE_MANAGE, `UPDATE_ROLE_CONFIG` re-auth, `assertCanConfigureRole`, `CONFIG_CHANGED` audit, **no reason**). UI: `routes/config/roles-components/attribute-access-tab.tsx` on Roles & Access.
- The Settings page and the Attributes panel read `/attribute-access/me` and call the same shared functions the gate calls.

## 2. The rule

New pure function in `@digilog/shared` `attribute-access.ts`:

```ts
effectiveAttributeAccess(role: AttributeAccess | null, user: AttributeAccess | null): AttributeAccess | null
```

| role rule | user rule | effective |
|---|---|---|
| any | `null` (none) | the role rule — today's behaviour |
| `null` (not configured = all editable) | any | `ALL_EDIT` with the user's `requireReauth` — editing is unchanged (all editable), only the user's re-auth switch can add a prompt |
| `ALL_EDIT` | any | `ALL_EDIT` |
| any | `ALL_EDIT` | `ALL_EDIT` |
| `ALL_VIEW` | `ALL_VIEW` | `ALL_VIEW` |
| `ALL_VIEW` | `SELECTED k` | `SELECTED k` |
| `SELECTED a` | `ALL_VIEW` | `SELECTED a` |
| `SELECTED a` | `SELECTED b` | `SELECTED a ∪ b` (case-insensitive, de-duplicated) |

- `requireReauth` = role's OR user's (a safety prompt is never dropped by combining).
- Adding a new key: allowed unless the effective mode is `ALL_VIEW` (unchanged `canAddAttribute`).
- **Still requires `INSTRUMENT_UPDATE` on the user's ROLE** — the effective rule is passed to the unchanged `canEditAttributeKey(access, key, hasUpdatePermission)`.

**Consequences, stated so nobody is surprised:**
- A user rule can only ADD editing. To restrict one person more than their role, they need a different role.
- A role with no rule (all editable) keeps everything editable for its users; a user rule there can only add a re-auth prompt.
- A user rule does nothing for a user whose role lacks Edit Instruments; the admin screen says so.

## 3. Data

- `user_configs.attribute_access` JSONB, nullable — same shape as the role column, read by `parseAttributeAccess`.
- One hand-authored migration `20261024120000_user_attribute_access` (strip the partitioned-table DROP Prisma emits; the migration guard must pass). Applied to `compliance_core_db` and `compliance_core_db_test`; AWS on the next deploy.
- Models / enums unchanged in count (a column, not a model).
- Writing "none": `Prisma.DbNull`, never `JsonNull`.

## 4. Server

- `loadAttributeAccess(role, userId)` → reads `role_configs` and `user_configs` (by user id = `ctx.userSub`) and returns `effectiveAttributeAccess(...)`. All four callers pass the user. Read per request, no cache (as today).
- `GET /api/instruments/attribute-access/me` returns the EFFECTIVE rule — the Settings page and the panel need no change.
- Refusal message wording: "You may view … but not change it" (it is no longer only "your role").
- New admin routes beside the role ones (same gate: `ROLE_MANAGE`, `UPDATE_ROLE_CONFIG` re-auth):
  - `GET /api/roles/attribute-access/users` — every enabled user: `{userId, username, fullName, role, mode, keys, requireReauth, effective: {mode, keys, requireReauth}, roleHasUpdate}`; `effective` is computed by the server with `effectiveAttributeAccess`, `roleHasUpdate` by `roleHasPermission(role, 'INSTRUMENT_UPDATE')`.
  - `PUT /api/roles/attribute-access/user/:userId` — body `{mode|null, keys, requireReauth, reason}`; `assertCanConfigureUser` (404 unknown, privilege rule); upsert `user_configs.attribute_access`; `CONFIG_CHANGED` audit, `targetType: 'user_config'`, before/after, the reason, bounded signature meaning — write and audit in ONE transaction.
- **Reason required on BOTH saves** (role and user) — `requireReason`, as every other access-control change since DATA-11. *This changes the existing role save, which took none.*
- Response schemas DECLARE every field (`effective` with inner keys, `roleHasUpdate`) — Fastify strips undeclared ones.

## 5. Screen — Configuration → Attribute Edit Access

- New page `apps/web/src/routes/config/attribute-access.tsx`, route `/config/attribute-access` (`RequireRole roles={['SUPER_ADMIN']}`), card in **Super Admin Settings** on the Configuration index.
- Two tabs:
  - **Roles** — today's editor (moved from `attribute-access-tab.tsx`), plus the reason input.
  - **Users** — a searchable user picker (EVERY user, with status when not enabled); for the chosen user: their own rule (Not set / All editable / Selected keys + re-auth — **no View only**, see the amendment below), their ROLE's rule shown read-only, the EFFECTIVE result (from the server), and an amber line when `roleHasUpdate` is false ("their role lacks Edit Instruments — this rule cannot take effect").
- Every save through `useReauth` with the reason; revalidate after.
- Roles & Access loses the **Attribute Access** tab (the `TabId` and the render line).

## 6. Testing

- Shared: the full combination table above, `requireReauth` OR, key union case-folding; mutation-checked.
- API e2e (`compliance_core_db_test`, throwaway role + users):
  - role SELECTED [a] + user SELECTED [b] → the user may PUT b; another user of the role may not;
  - role not configured → a user ALL_VIEW rule leaves everything editable (and its re-auth switch, if on, is honoured);
  - role without INSTRUMENT_UPDATE → user ALL_EDIT still 403;
  - `/attribute-access/me` equals what the gate enforces;
  - user PUT: reason required (400), privilege refusal, 404 unknown user, audit row with reason;
  - role PUT now requires a reason.
- Web: the page's two tabs (role save sends reason; user tab shows role rule, effective result, the warning); Roles & Access no longer renders the tab.
- Mutation checks on the combine function, the user-layer read, the reason requirement and the warning.

## 7. Docs and counts

- CHANGELOG; `docs/feature-notes.md` (the Instrument ATTRIBUTE ACCESS note — user layer, combine rule, new location); `docs/recreation/06-api/endpoints.md` (two routes).
- Counts: config pages 22 → 23, `<Route`s 53 → 54, migrations +1; models / enums / permissions / reauth actions unchanged. Stale-stat sweep over the active doc set.
- AWS: the migration applies with the next deploy; no data step.

## Amendment after the whole-branch review (2026-10-24)

- **No View only for a USER.** Under "combine" a user ALL_VIEW rule can never restrict anything, yet its audit row read as a restriction. The user editor does not offer it and `PUT …/user/:userId` refuses it (400 VALIDATION_ERROR, naming the way: give the user a View only role).
- **Re-auth only where a rule grants editing.** Both PUTs store `requireReauth` false on ALL_VIEW, and `effectiveAttributeAccess` counts a side's flag only if that side is not ALL_VIEW — a forgotten flag on a view-only role cannot become a live prompt. "What applies" prints "password required".
- **Every user is listed, with status** — a rule stored for a user later locked or disabled stays visible and revocable (it applies again when the account returns). The PUT accepts any existing user; 404 only for an unknown id. (Review Focus #4's "disabled → 404" is superseded.)
- **A user's rule survives a role change** — the Users tab says so beside every user rule; nothing clears it automatically.
- The page stays SUPER_ADMIN-only while the API keeps `ROLE_MANAGE` (as approved): ADMIN, which could use the old Roles & Access tab, no longer has the screen.

## Out of scope

- A user rule that NARROWS below the role (the operator chose combine).
- Per-instrument or per-profile attribute rules.
- Changing SUPER_ADMIN's non-exemption.
