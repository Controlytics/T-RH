# Functional Locations — design (Project A)

**Date:** 2026-08-13
**Branch:** `data-injection`
**Status:** awaiting operator review

## Goal

A sidebar feature for creating **Functional Locations** — a two-level Block → Area
tree — and linking instruments to them. An instrument belongs to **at most one**
functional location. This becomes the authoritative logical grouping of
instruments, replacing the free-text `block` / `area` columns.

## Scope of this spec

The operator's request covers four projects. This spec is **A only**:

| | Project | Depends on | Status |
|---|---|---|---|
| **A** | **Functional Locations** — model, tree, exclusive linking, page, sidebar item, free-text migration | — | **this spec** |
| B | Dashboard drill-down — 3 entry cards, FL filter, Block → Area drill, tabular/graphical only | A | later spec |
| C | Alarm subsystem — rules, evaluation, acknowledgement, history, notifications | — | later spec, large |
| D | Role/user instrument visibility, keyed to functional locations | A | later spec |

A is first because B and D both key off it, and because the operator should see it
before three more things are built on top. C is independent of A apart from one
dashboard card; the previous alarm subsystem in this lineage was 5 models and 22
files, so it does not belong inside another feature's spec.

**D supersedes an earlier design.** Role/user visibility was being designed against
the free-text `block`/`area` fields. Once functional locations exist, D scopes by
them instead — which removes the typo and rename fragility that made free-text
scoping a bad foundation. The free-text design is abandoned, not deferred.

## Operator decisions

1. **Type is `Block` or `Area`**, and Areas sit under Blocks — a two-level tree.
2. **An instrument linked to one functional location cannot be linked to another.**
3. **Functional Locations REPLACE the free-text `block`/`area` fields.** Existing
   values migrate in. `location` survives as descriptive text.
4. **Graphical view under a functional location draws the rooms of that location's
   instruments** — floorplans stay the source of geometry, functional locations
   stay the logical grouping. (Consumed by B; recorded here because it constrains
   what A must expose.)

## Data model

```prisma
enum FunctionalLocationType {
  BLOCK
  AREA
}

model FunctionalLocation {
  id       String                 @id @default(uuid())
  name     String
  type     FunctionalLocationType
  /// NULL for a BLOCK, required for an AREA. Self-relation, capped at one level
  /// deep — see the invariants below.
  parentId String?                @map("parent_id")

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy String?  @map("created_by")
  updatedBy String?  @map("updated_by")

  parent      FunctionalLocation?  @relation("FlTree", fields: [parentId], references: [id], onDelete: Restrict)
  children    FunctionalLocation[] @relation("FlTree")
  instruments Instrument[]

  @@unique([parentId, name])
  @@index([type])
  @@map("functional_locations")
}
```

And on `Instrument`:

```prisma
  functionalLocationId String?             @map("functional_location_id")
  functionalLocation   FunctionalLocation? @relation(fields: [functionalLocationId], references: [id], onDelete: Restrict)
  // plus @@index([functionalLocationId])
```

### Why a single nullable FK, and not a join table

"An instrument in one functional location cannot be linked to another" is a
**one-to-many**, so one nullable FK expresses it exactly. Exclusivity is then a
property of the schema rather than a rule that has to be enforced and tested:
there is no state in which an instrument has two locations. Linking an
already-linked instrument **moves** it, and the UI says so before saving.

A join table would permit the illegal state and then need a partial unique index
to forbid it. Rejected.

### `@@unique([parentId, name])` — what it does and does not do

Names are unique **within a parent**, so two Blocks may each own an area called
`QC`. Postgres treats NULLs as distinct in a unique index, so this does **not**
prevent two Blocks both named `CWH` — top-level uniqueness is enforced in the
service layer instead, and that gap is called out here because a reader will
otherwise assume the constraint covers it.

## Invariants, enforced server-side

Validation lives in `functional-locations/validation.ts` as pure functions, so it
is unit-testable independently of Prisma. Enforced on create and update:

1. `BLOCK` must have `parentId === null`.
2. `AREA` must have a `parentId` that references an existing `BLOCK`.
3. **No third level.** An `AREA` may not parent anything. Depth is capped at 2.
4. Name required, trimmed, unique within its parent (and unique among Blocks).
5. A location may not be its own parent, and re-parenting may not create a cycle.
   With depth capped at 2 a cycle is already impossible, but the check stays: the
   cap is the thing most likely to be relaxed later, and the cycle guard must not
   arrive only after it has been.

**Instruments may link to a `BLOCK` directly, not only to an `AREA`.** This is not
a convenience — the existing data requires it: one instrument has `block = CWH`
with no area. A Block's instrument set is therefore *its own* instruments plus all
its Areas' instruments, and every read path that resolves a Block must include
descendants. Forgetting that is the most likely bug in this feature, so it is one
function, `resolveLocationIds(id)`, used everywhere rather than an inline query.

## Deletion

Deleting a functional location that has instruments linked, or child areas, is
**refused with 409** and a message naming the count — `onDelete: Restrict` on both
relations, matching the posture `profileId` already takes. Silently orphaning
instruments would make them invisible in a feature whose entire job is grouping
them.

To delete, the operator unlinks the instruments (or moves them) first. That is
deliberate friction on a destructive action against regulated records.

## Migration of the existing free-text values

Verified against the live database on 2026-08-13 (20 instruments):

| block | area | instruments | becomes |
|---|---|---|---|
| `CWH` | `Module-E` | 3 | Block `CWH` > Area `Module-E` |
| `CWH` | *(null)* | 1 | Block `CWH` (direct) |
| `Block C` | `Sterile Core` | 1 | Block `Block C` > Area `Sterile Core` |
| *(null)* | *(null)* | 15 | **unlinked** |

So the migration creates **2 Blocks and 2 Areas** and links **5 instruments**. The
other 15 have no block/area at all and stay unlinked — visible on the Instruments
page and in All Instruments, but in no functional location until someone assigns
them.

The migration is **hand-written SQL**, not generated. Per the repo's standing trap,
`prisma migrate diff` here emits destructive statements (it wants to drop the
partitioned `instrument_telemetry_history` table and drop `audit_trail
.chain_position`'s NOT NULL); the header of
`20260811120000_instrument_floorplans/migration.sql` lists them. Read it before
authoring this one.

Migration name: `20260813HHMMSS_functional_locations`.

**The free-text columns are NOT dropped in this migration.** They are removed from
the instrument create/edit form and no longer read for grouping, but the columns
stay so the migration is reversible and so the values remain available for
comparison if a mapping turns out wrong. Dropping them is a follow-up once the
operator confirms the tree is right — data is deleted only after it is proven
redundant, not in the same step that stops using it.

## API

All under `/api/functional-locations`, new module
`apps/api/src/modules/functional-locations/`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `FUNCTIONAL_LOCATION_READ` | Full tree, each node with its own instrument count and a rolled-up count |
| GET | `/:id` | `FUNCTIONAL_LOCATION_READ` | One location with children and linked instruments |
| POST | `/` | `FUNCTIONAL_LOCATION_CREATE` | + reauth, audited |
| PUT | `/:id` | `FUNCTIONAL_LOCATION_UPDATE` | Rename / re-parent; + reauth, audited |
| DELETE | `/:id` | `FUNCTIONAL_LOCATION_DELETE` | 409 if it has instruments or children; + reauth, audited |
| PUT | `/:id/instruments` | `FUNCTIONAL_LOCATION_UPDATE` | Set membership wholesale; + reauth, audited |
| GET | `/linkable-instruments` | `FUNCTIONAL_LOCATION_READ` | Every instrument, each with its current location (NULL if unlinked) |

`PUT /:id/instruments` mirrors the existing
`PUT /api/floorplans/:id/rooms/:roomId/instruments`, which already sets room
membership wholesale — same shape, same audit style, so there is one way to do this
in the codebase rather than two.

**`/linkable-instruments` returns every instrument with its current location**, not
only the unlinked ones — because moving an instrument between locations is allowed
and is the documented behaviour. An endpoint that returned only unlinked
instruments would make moving impossible from the picker, which is why it is named
`linkable` rather than `unlinked`.

The picker therefore shows unlinked instruments as directly selectable, and ones
already linked elsewhere annotated with their current location (`CWH > Module-E`)
and requiring confirmation. Moving must be a visible choice, not a silent
reassignment. Response fields must be declared in the Fastify response schema —
anything absent from it is **stripped**, which has already cost two fields today
(`limits`, `profileName`).

## Frontend

`apps/web/src/routes/functional-locations/`:

- `index.tsx` — the tree: Blocks with their Areas nested, instrument counts, create / rename / delete actions
- `create-dialog.tsx` — name, type (Block/Area), parent (required and shown only when type is Area)
- `instrument-panel.tsx` — the Relation section: linked instruments plus an "Add instruments" picker, modelled on the existing `gateway-panel.tsx`, which solves the same problem (list children, pick from eligible, unlink)

Route `/functional-locations`, one `<Route>` (45 today).

**Removed from the instrument form:** the `block` and `area` inputs. Functional
location is set from this page, or from a picker on the instrument itself — one of
the two, not both, and this spec chooses **this page only** so there is a single
place membership is edited. `location` stays on the instrument form.

## Permissions, sidebar, reauth

Verified counts before this change: **34 permissions, 41 reauth actions, 11 sidebar
items, 31 models, 6 enums, 21 API modules, 45 routes.**

- **+4 permissions:** `FUNCTIONAL_LOCATION_READ` / `_CREATE` / `_UPDATE` / `_DELETE` → 38
- **+3 reauth actions:** `CREATE_FUNCTIONAL_LOCATION`, `UPDATE_FUNCTIONAL_LOCATION`, `DELETE_FUNCTIONAL_LOCATION` → 44
- **+1 sidebar item:** `functional-locations` → 12, with existing `role_configs` and
  `user_configs` backfilled so current roles do not silently lose or gain it
- **+1 `PERMISSION_TREE` group**, from which `FEATURE_PRIVILEGES`,
  `FEATURE_TO_PERMISSION_MAP` and `SIDEBAR_PRIVILEGE_MAP` derive — the tree is the
  single source of truth, and the frozen-snapshot test will need updating in the
  same commit or it fails
- **+1 model, +1 enum, +1 API module, +1 route** → 32 models, 7 enums, 22 modules, 46 routes

Audit actions: `FUNCTIONAL_LOCATION_CREATED` / `_UPDATED` / `_DELETED` /
`_INSTRUMENTS_CHANGED`, each with an audit template. **A template is two edits** —
the template in `packages/shared/src/types/audit-templates.ts` **and** a
substitution in `apps/web/src/routes/audit/audit-helpers.ts` — or the placeholder
renders literally in the Audit Trail and in the exported §11 record.
`template-placeholders.test.ts` catches it.

## Testing

Pure and therefore actually verifiable — this matters, because the repo has no
browser-based verification path and styling/UI assertions do not exist:

- **Validation** (`validation.test.ts`): Block with a parent rejected; Area without
  a parent rejected; Area parented to an Area rejected (the depth cap); third level
  rejected; blank and whitespace-only names rejected; duplicate name within a
  parent rejected; same name under two different parents allowed; self-parent
  rejected; cycle rejected.
- **`resolveLocationIds`**: a Block returns itself plus its Areas; an Area returns
  only itself; an empty Block returns itself.
- **Exclusivity**: linking an instrument that already has a location moves it —
  asserted as a count, so a duplicate would fail rather than pass silently.
- **Delete refusal**: 409 with instruments linked; 409 with child areas; 204 when
  empty.
- **Migration mapping**: the four-row table above, asserted from the real
  block/area combinations.
- **Frozen permission-tree snapshot** updated with the new group.

`npx tsc --noEmit` on both apps is mandatory — vitest runs through esbuild and does
not typecheck, so a green suite here proves nothing about compilation.

Known-failing web baseline is **5** (stale `url-utils` cases referencing
`routes/pm-schedules/*`, which never existed in this fork). Ratchet down only.

## Out of scope

- **Project B** (dashboard cards, drill-down, FL filter), **C** (alarms), **D**
  (role/user visibility) — separate specs.
- **Dropping the `block`/`area` columns** — a follow-up once the tree is confirmed.
- **A third level** below Area. The depth cap is deliberate and enforced; relaxing
  it is a schema decision, not a config toggle.
- **Instruments in more than one functional location.** The single FK forbids it by
  construction. If overlapping groups are ever needed, that is a different model
  and a different spec.
- **Any change to floorplans or rooms.** Geometry stays there; this is the logical
  grouping. The two are related only in Project B, where a location's graphical
  view draws the rooms its instruments occupy.

## Risks

| Risk | Mitigation |
|---|---|
| A Block's reads forget to include its Areas' instruments | One `resolveLocationIds()` used by every read path; unit-tested |
| Free-text migration mis-maps a value | Only 5 instruments and 4 locations are affected; the columns are kept, so a bad mapping is comparable and correctable |
| A fourth grouping concept adds confusion | Free text stops being read for grouping in this spec and is removed from the form; `roomId` keeps geometry, `profileId` keeps device type, and each has one stated job |
| New sidebar item invisible to existing roles | `role_configs` / `user_configs` backfill in the same migration, mirroring how `home` was added |
| Response fields silently stripped by Fastify | Every new field declared in the response schema; called out because it has already happened twice today |
