# Instrument Profiles — Design

**Date:** 2026-08-08
**Status:** Approved (design), pending implementation
**Scope:** Grouping layer for instruments. Profiles logic only — no change to how
instruments themselves are registered, addressed, authenticated, or ingested.

---

## 1. Problem

Instruments are a flat registry. There is no way to say "these instruments belong
together" — the only existing groupings are free-text `block`/`area`/`location`
(placement, not membership) and the gateway parent→child relation (an
authorisation rule, not a folder).

The operator wants named profiles: create a profile first, then register
instruments inside it.

## 2. Decisions taken

Each of these was chosen explicitly by the operator on 2026-08-08.

| Decision | Choice | Consequence |
|---|---|---|
| Membership | **Exactly one profile per instrument** (a folder, not tags) | One `profileId` column, no join table |
| Required? | **Required for every instrument**, existing rows backfilled | `NOT NULL` column + data migration |
| Profile contents | **Name + description only** — *and since 2026-08-08 an attribute-key list* | See `2026-08-08-per-profile-instrument-attributes-design.md` |
| Delete a non-empty profile | **Blocked — must be empty first** | `ON DELETE RESTRICT` + a 409 with the count |
| Navigation | **Profiles first, drill in to instruments** | `/instruments` becomes the profile list |

Constraint from the operator: *"current instruments creation and everything
should be same."* Honoured as far as a required field allows — see §7.

## 3. Data model

### New: `InstrumentProfile`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar, **unique** | The grouping label |
| `description` | text, nullable | |
| `isActive` | boolean, default true | Mirrors `Instrument.isActive`; does not cascade |
| `createdAt` / `updatedAt` | timestamptz | |
| `createdBy` / `updatedBy` | varchar, nullable | |

### Changed: `Instrument`

```prisma
profileId String            @map("profile_id")          // NOT NULL
profile   InstrumentProfile @relation(fields: [profileId], references: [id], onDelete: Restrict)
@@index([profileId])
```

`ON DELETE RESTRICT` is deliberate: the "must be empty first" rule is enforced by
the **database**, not only by the service. A future code path that forgets the
check cannot orphan an instrument or delete a populated profile.

### Migration

Hand-authored per `apps/api/CLAUDE.md` (the baseline is a `pg_dump`, so
`migrate dev` auto-generation is not used; `migrate diff` → review →
`npm run db:verify-migrations` drift guard must pass before commit).

Four ordered steps in one migration:

1. `CREATE TABLE instrument_profiles (…)` + unique index on `name`
2. `INSERT INTO instrument_profiles (name, description) VALUES ('Default', 'Instruments registered before profiles existed')`
3. `ALTER TABLE instruments ADD COLUMN profile_id uuid` (nullable), then
   `UPDATE instruments SET profile_id = (SELECT id FROM instrument_profiles WHERE name = 'Default')`
4. `ALTER TABLE instruments ALTER COLUMN profile_id SET NOT NULL`, add the FK
   with `ON DELETE RESTRICT`, add the index

Steps 3–4 are split because a `NOT NULL` column cannot be added to a populated
table without a default, and we want the backfill to be explicit and reviewable
rather than hidden in a column default.

**Not reversible without data loss on down-migration** — dropping the column
loses every assignment. Acceptable: the assignments are re-derivable only by a
human, and this repo does not run down-migrations against populated databases.

## 4. Backend

New module `apps/api/src/modules/instrument-profiles/` — `routes.ts`,
`profile.service.ts`, `profile.repository.ts` — registered in `app.ts` at
`/api/instrument-profiles`.

| Endpoint | Permission | Behaviour |
|---|---|---|
| `GET /` | `INSTRUMENT_READ` | List profiles with `instrumentCount` and `activeCount` |
| `GET /:id` | `INSTRUMENT_READ` | One profile |
| `POST /` | `INSTRUMENT_CREATE` | Create; 409 on duplicate name |
| `PUT /:id` | `INSTRUMENT_UPDATE` | Rename / edit description / toggle active |
| `DELETE /:id` | `INSTRUMENT_DELETE` | **409 with the instrument count if non-empty** |

**No new permission constants.** Reusing `INSTRUMENT_*` keeps
`PERMISSION_TREE`, the derived `FEATURE_PRIVILEGES`, the frozen-snapshot test and
every documented count untouched. A profile is not a capability boundary of its
own — anyone who may create an instrument may create the folder it sits in.

**No new reauth actions.** Instruments have none today (the token actions moved to
an always-on gate); profiles are less sensitive than the instruments inside them.

### Audit

Three new actions in `packages/shared/src/types/audit-actions.ts`:
`INSTRUMENT_PROFILE_CREATED`, `INSTRUMENT_PROFILE_UPDATED`,
`INSTRUMENT_PROFILE_DELETED`. A profile rename changes what an inspector sees
against every instrument in it, so it is an auditable event.

Moving an instrument between profiles is recorded by the **existing**
`INSTRUMENT_UPDATED` audit row, whose before/after already carries changed fields.

### Instrument changes

Exactly one choke point: `createWithCredential()` in
`modules/instruments/routes.ts` builds the draft for **both** `POST /` and
`POST /bulk`. `profileId` joins the draft there.

- `POST /instruments` — `profileId` required in the body schema
- `POST /instruments/bulk` — `profileId` taken **once for the whole upload**, as a
  sibling field to `csv`. **The CSV format does not change.**
- `PUT /instruments/:id` — accepts `profileId` to move an instrument
- `GET /instruments` and `GET /instruments/:id` — return `profileId` and
  `profileName`

> Fastify strips response properties not declared in the route schema. Every
> response schema that should carry the profile must declare it, or the UI
> silently sees nothing. (This exact trap cost time on the LDAP work.)

## 5. Frontend

| Route | Page | Content |
|---|---|---|
| `/instruments` | **new** `profile-list.tsx` | Profile cards: name, description, instrument count, active count. `+ New Profile`. |
| `/instruments/profiles/:id` | existing `list.tsx`, scoped | Today's tiles, search and table, filtered to the profile. `+ Add Instrument`. |
| `/instruments/new?profileId=…` | existing `create.tsx` | Profile pre-filled and shown as a read-only chip when it arrives in the query string; a required selector otherwise. |
| `/instruments/:id` | existing `detail.tsx` | Shows the profile; offers **Move to profile**. |
| `/instruments/bulk` | existing `bulk-create.tsx` | Gains one profile selector above the CSV box. |

Sidebar is unchanged — `instruments` remains a single item. No new sidebar entry,
so no `SIDEBAR_ITEMS` count change and no role-config backfill.

## 6. Explicitly out of scope

- **Profiles inherit PROMPTS but never VALUES.** ~~Profiles do not inherit
  anything. No default placement, no shared reporting interval.~~ **Superseded
  2026-08-08** by `2026-08-08-per-profile-instrument-attributes-design.md`: a
  profile now owns the attribute-key list its New Instrument form asks for. The
  question this section deferred — *"what happens to existing members when the
  default changes?"* — is answered there: **nothing**. No value is ever
  back-filled, rewritten or deleted on an instrument that already exists, and
  moving an instrument between profiles changes only which keys are suggested.
  Still out of scope: default placement values and a shared reporting interval.
- **Gateways and profiles stay independent.** A gateway may have children in other
  profiles. The gateway relation is an authorisation rule
  (`child.gatewayId = gateway.id`); entangling it with grouping would change who
  may write what, which is outside "profiles logic only".
- **No nesting.** Profiles are a flat list, not a tree.
- **No bulk move.** Instruments move one at a time from their detail page.

## 7. Known tension with "keep creation the same"

A required profile *necessarily* adds a field to the create page and the bulk
upload. Mitigated so the flow still feels unchanged:

- Creating from inside a profile pre-fills it — the operator sees a chip, not a
  decision.
- The bulk CSV **format is untouched**; the profile is chosen once for the upload.
- No other field, validation, token, topic or ingest behaviour changes.

If even that is too much, the alternative is a nullable `profileId` with an
"Unassigned" bucket — but that was explicitly rejected in favour of consistency.

## 8. Touchpoints to verify after the change

Per `CLAUDE.md`: list them before editing, test them all after.

| Touchpoint | Why it is at risk | Expected |
|---|---|---|
| `POST /instruments` | New required field | Creates with profile |
| `POST /instruments/bulk` | Shares `createWithCredential` | CSV unchanged, profile applied to all rows |
| Gateway child creation | Goes through the same choke point | Child created; gateway link unaffected by profile |
| `DELETE /instruments/:id` | FK now references it | Deletes; profile count drops |
| MQTT / TCP / WS ingest | **Must be unaffected** — devices are addressed by UUID | Unchanged |
| Instrument Activity config | Reads instruments | Unchanged |
| Backup / restore | Enumerates `pg_tables` and topologically sorts by FK | New table picked up automatically, ordered before `instruments` |
| Audit trail | Three new actions | Rows render with names, not UUIDs |
| 5 e2e files creating instruments | `instrument.create` now needs `profileId` | Fixtures updated |

The five e2e files are `instrument-ingest`, `mqtt-auth`, `mqtt-ingest`,
`tcp-ingest`, `ws-ingest`. These are the whole fixture cost — verified by
`grep -rn "instrument.create"`, which finds six call sites total, one of which is
the production choke point.

## 9. Documentation note — the counts in the root docs are wrong

`CLAUDE.md`, `apps/api/CLAUDE.md` and `packages/shared/CLAUDE.md` all state
**61 Prisma models**. The live count is **28**:

```
$ grep -cE "^model " apps/api/prisma/schema.prisma
28
```

The 61 figure is inherited from the upstream DigiLog project and was never true
in this fork. This change takes the real count to **29**. Per the Documentation
Sync Rule ("don't trust prior docs — verify"), the docs will be corrected to the
verified number rather than incremented from the stale one, with a note recording
why the number moves by more than one.

## 10. Testing

- **Unit** — profile service: duplicate name rejected; delete blocked when
  non-empty with the count in the message; delete allowed when empty.
- **Integration/e2e** — create a profile, register an instrument in it, confirm
  the count; attempt to delete a non-empty profile and expect 409; move an
  instrument and confirm both counts change; confirm the FK itself refuses a
  direct delete (proving the constraint, not just the service check).
- **Regression** — the full API suite must return to its known baseline: 14
  failures across 5 files (`auth-profile-reauth`, `entities`,
  `replacement-audit-enrichment`, `super-admin-unretire`,
  `block-change-approval-current`), all pre-existing and confirmed by
  `git stash` comparison on 2026-08-08.
