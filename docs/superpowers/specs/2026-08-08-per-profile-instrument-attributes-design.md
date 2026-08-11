# Per-profile instrument attributes — design

**Date:** 2026-08-08
**Branch:** `data-injection`
**Supersedes:** the "profiles inherit nothing" scope line in
`2026-08-08-instrument-profiles-design.md` §6 (lines 147-149)

## 1. The problem

Instrument attribute keys are **global**: one newline-separated list in
`system_config['instrument-attributes'].keys`, edited at Configuration →
Instrument Attributes, asked for on every New Instrument form regardless of what
kind of device is being registered.

This install's live list is twelve keys:

```
Block, Area, Location,
Low Temperature Limit, High Temperature Limit,
Low Humidity Limit, High Humidity Limit,
Low Temperature Range, High Temperature Range,
Low Humidity Range, High Humidity Range,
Slave ID
```

Half of those are temperature/humidity limits and one is a Modbus slave address.
No single device needs all twelve, so every registration form is mostly fields
the operator tabs past — and "blank but asked for" is worse data than never
asked, which is the reasoning the config page already states for its own 20-key
advisory.

Instrument profiles already exist as the natural grouping. This gives each
profile its own list.

## 2. This reverses a documented decision

`schema.prisma:751-760` and `instrument-profiles/routes.ts:12-14` both state:

> GROUPING ONLY — a profile carries no settings and instruments inherit nothing
> from it, deliberately: adding inheritance later raises "what happens to
> existing members when the default changes?", which is a real design question
> and not this one.

That question is now in scope, and the answer is:

> **No inheritance of values, only of prompts.** A profile's list decides what
> the form *asks*. Nothing is ever back-filled, rewritten or deleted on an
> instrument that already exists. Moving an instrument between profiles changes
> which keys are *suggested* and touches none of its recorded attributes.

Both comments and the superseded spec section are rewritten as part of this
work. A spec left contradicting the code is the trap `CLAUDE.md` records against
`certs/rootCA.pem` — a false line that cost two agents an investigation each.

## 3. Decisions

Each chosen explicitly by the operator on 2026-08-08.

| Decision | Choice | Consequence |
|---|---|---|
| Scope | **Replace** — each profile owns its complete list | The global list becomes the template for new profiles only |
| Edit surface | **Configuration page with a profile picker** | One home; lists comparable side by side; existing row editor reused |
| Storage | **A column on `InstrumentProfile`** | Same newline wire format, one parser, per-profile audit for free |
| Create form before a profile is picked | **Hide the attribute fields** | Nothing typed can be discarded, because nothing can be typed early |
| Placement keys (Block/Area/Location) | **Not pinned** — a profile may omit them | Those instruments have empty placement columns; the Instruments list filter is blank for them. Accepted, with an on-screen advisory |

### Why not the alternatives

**A child table** (`InstrumentProfileAttributeKey`, one row per key with
`sortOrder`) is relationally tidier and individually queryable, but it is a 30th
Prisma model, needs new endpoints or nested writes, and re-implements ordering
that a newline string already encodes for free. It also contradicts the storage
principle stated at `instrument-attributes.tsx:15-20` — *"changing the wire
format to make an editor nicer would be the tail wagging the dog."* Real
complexity for a query nothing asks.

**Everything in `system_config`** (`{ default, byProfile: { <uuid>: "..." } }`)
needs no migration, but there is no foreign key — deleting a profile leaves an
orphan entry forever — and the audit trail would record "the instrument-attributes
config changed" rather than "this profile changed", which is weaker §11
traceability for data that now describes a specific group of instruments.

## 4. Data model

```prisma
model InstrumentProfile {
  ...
  /// The attribute keys the New Instrument form asks for in THIS profile.
  /// Newline-separated, the same wire format as the default template, so
  /// `parseInstrumentAttributeKeys` stays the one definition of what a line
  /// means and the config page, create form and attributes panel cannot
  /// disagree.
  attributeKeys String? @map("attribute_keys")
}
```

**No new model and no new enum.** Counts do not move: 29 models, 6 enums, 22
config defs, 102 permissions, 83 feature privileges, 92 reauth actions, 27
sidebar items. Stated explicitly so nobody later "corrects" a count that was
right.

### Three distinguishable states

| Value | Meaning | How it arises |
|---|---|---|
| non-empty string | this profile's own list | an admin edited it |
| `''` | asks for **no** attributes | an admin deleted every row |
| `NULL` | asks for **no** attributes (same as `''`) | a profile created out-of-band |

> **AMENDED 2026-08-08, same day.** This table originally read `NULL` → "falls
> back to the default template". There was never such a fallback in code —
> `parseInstrumentAttributeKeys` returns `[]` for `NULL` and `''` alike — and
> with seeding removed there is nothing to fall back TO. Two states, not three.

`NULL` should not occur in practice: the migration backfilled every existing
profile and `POST` writes `''`. Keeping the column nullable (rather than
`NOT NULL DEFAULT ''`) costs nothing now that both values mean the same thing.

`''` must be storable and distinct from `NULL`, because "this profile
deliberately asks for nothing" is a legitimate configuration the current page
already supports.

**`NULL` collapses to `''` on any save, by design.** The distinction is invisible
in the editor — `parseInstrumentAttributeKeys` returns `[]` for both `''` and
`NULL` (`config.ts:230-231`), so a `NULL` profile and an empty-list profile both
render as zero rows, and saving writes `''`. That is accepted rather than worked
around: post-migration no profile is `NULL`, so the only way to reach this is a
code path that skipped seeding, and having an admin's explicit save win over an
unintended `NULL` is the right outcome. `NULL` is a read-side safety net, not a
state the UI maintains.

**Length guard:** `max(2000)` on the Zod schema, matching
`instrumentAttributesConfigSchema` (`config.ts:212-215`), so a per-profile list
cannot exceed what the default template could hold.

## 5. Migration

`prisma/migrations/<UTC-timestamp>_instrument_profile_attribute_keys/migration.sql`,
hand-authored:

```sql
ALTER TABLE "instrument_profiles" ADD COLUMN "attribute_keys" TEXT;

-- Every existing profile starts as an exact copy of the list that was global
-- until now, so day-one behaviour is identical and a profile diverges only when
-- an admin edits it. Reads the LIVE config row, NOT the code default: this
-- install's list is 12 keys and INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT is 6, so
-- seeding from the constant would quietly reset every profile to a list nobody
-- configured.
UPDATE "instrument_profiles"
SET "attribute_keys" = COALESCE(
  (SELECT c."config_value"->>'keys'
     FROM "system_config" c
    WHERE c."config_key" = 'instrument-attributes'),
  E'Block\nArea\nLocation\nRoom\nCalibration Due\nAsset Tag'
)
WHERE "attribute_keys" IS NULL;
```

The `COALESCE` fallback covers a fresh install where the config row is not
seeded yet. `WHERE ... IS NULL` makes a re-run harmless.

**Constraints from `apps/api/CLAUDE.md` — not optional:**

- `prisma db push` and `prisma migrate dev` auto-generation are **forbidden**;
  both can drop hash-chained audit data.
- `npm run db:verify-migrations` (the drift guard) must **PASS** before commit.
- `npx prisma migrate resolve --applied <name>` on the populated
  `compliance_core_db` and on the test DB so neither re-runs it.
- Nothing goes in `prisma/sql/*` — this adds no trigger, function or sequence.

## 6. API

No new endpoints, no new permission constants, no new reauth actions.

### `instrument-profiles/routes.ts`

- `profileProps` and `ProfileRow` gain `attributeKeys: string | null`;
  `present()` passes it through. `GET /` therefore returns every profile's list
  in one fetch, which is all the config page's picker needs.
- **`POST`** accepts an optional `attributeKeys`. Omitted, it stores `''` — a new
  profile IS born empty.

  > **AMENDED 2026-08-08, same day (operator decision).** This originally seeded
  > from the live global template via
  > `configService.getConfig('instrument-attributes', …)`. In use that defeated
  > the feature: the second profile opened showing the first profile's twelve
  > keys, so the list still read as global. Seeding is gone, the config key is
  > inert, and the "Default for new profiles" entry was dropped from the page's
  > picker. Regression guard:
  > `instrument-profiles.e2e.test.ts` → "does NOT copy the global
  > instrument-attributes config into a new profile".
- **`PUT`** accepts `attributeKeys` as a nullable string.
- **Audit** records the **parsed key array**, not the raw string:
  `attributeKeys: ['Block','Area',…]`. An inspector reads keys, not newlines,
  and the audit UI already diffs keyed arrays. `signatureMeaning`:
  `Instrument profile "Cleanroom AHU" attribute keys changed (12 → 5)`. This
  fits: `audit_trail.signature_meaning` is `varchar(255)` (verified via `\d
  audit_trail`), the fixed text is ~50 characters, and the profile name is capped
  at 120 by `createInstrumentProfileSchema`, so the worst case is ~170.

### The sanitiser divergence — and the fix

The two write paths disagree today:

- The dynamic-config `PUT` does **not** HTML-strip values. `config.service.ts:87-93`
  only drops `_`-prefixed transport fields, so the global keys are stored
  verbatim.
- The profile `PUT` **does** strip, via `sanitizeStrings` (`routes.ts:187`), and
  `stripHtml` *discards* tag-shaped content rather than escaping it — `Temp <5C`
  becomes `Temp`.

Left alone, the same key would survive on the config page and be silently
truncated on the profile page.

**Resolution:** `POST` and `PUT` pass `['attributeKeys']` as the `skipKeys`
argument, so the field is stored exactly as the config path stores it today.
Deliberate: making the two paths agree matters more than adding stripping to one,
and stripping corrupts legitimate keys. It is not a new exposure — the SPA
escapes on output, and this is the same data the config endpoint already stores
unstripped. Changing the config path's sanitisation was out of scope and would
risk mangling existing keys.

The e2e test asserting a `<`-bearing key round-trips verbatim is the regression
guard for this skip. It is the thing most likely to rot if someone later "tidies"
the skip list away.

### `GET /api/config/instrument-attributes/current` becomes orphaned

Its only two callers anywhere are `create.tsx:56` and `attributes-panel.tsx:49`
(verified by grep across `apps/web/src` and `apps/api/src`), and this change
removes both. So after this change the endpoint has **zero callers** —
and after the same-day seeding amendment (§7) so does the config key itself: the
config page reads only `/api/instrument-profiles`, and `POST` no longer calls
`configService.getConfig()`. The def and route were kept anyway; deleting the
config module is a separate decision that must first confirm the per-profile
editor page keeps its discoverability through config auto-discovery and the
Configuration Access matrix.

Recommendation: **keep it**, with a comment recording that it is currently
uncalled and what it means now ("the default template for new profiles").
Deleting a live endpoint is a public-surface change with its own
`API_REFERENCE.md` churn and belongs to a separate decision, and this repo's
pre-deletion rule wants receipts before removal. Flagged here so it does not rot
unnoticed — an endpoint nobody calls and nobody documents is how the orphans this
project has spent months deleting got created.

### Unchanged

The create form reads the
selected profile through the existing `GET /api/instrument-profiles/:id`;
`INSTRUMENT_CREATE`'s grant set already includes `INSTRUMENT_READ`
(`permission-tree.ts:323`), so anyone who can reach the create form can read the
profile.

## 7. Configuration page

`apps/web/src/routes/config/instrument-attributes.tsx` keeps its row editor —
stable ids, per-row case-insensitive duplicate detection, reorder, the 20-key
advisory — and gains a target selector above it.

```
Configuration > Instrument Attributes

 Editing:  [ Cleanroom AHU  (12 instruments)   v ]
             Default for new profiles
             ─────────────────────────
             Cleanroom AHU        (12 instruments)
             Warehouse Sensors    (3 instruments)

 1  Block                        ^ v  X
 2  Low Temperature Limit        ^ v  X
 3  Slave ID                     ^ v  X
    [ Add attribute key ]

 Changes apply to the next instrument registered in
 Cleanroom AHU. Attributes already recorded are untouched.
                                      [ Save changes ]
```

**Data:** one fetch of `/api/instrument-profiles` (now carrying every profile's
`attributeKeys`) plus the existing `/api/config/dynamic/instrument-attributes`
for the default. **Save** routes by target — the config `PUT` for the default,
`PUT /api/instrument-profiles/:id` with `{ attributeKeys }` for a profile.

Three changes that are not cosmetic:

1. **Switching target while dirty must not discard edits silently.** The page
   seeds `rows` once and deliberately never lets a revalidation overwrite them
   (`instrument-attributes.tsx:48-56`); a selector adds a second way to lose
   work. Switching while `dirty` prompts to discard, and declining leaves the
   selector where it was. `rows` and the `saved` baseline reset per target so
   the Save button's dirty check stays honest.
2. **A placement advisory.** When the selected list omits Block, Area or
   Location, the page says so: instruments registered in this profile will have
   empty placement columns, so the Instruments list Placement column and its
   filters are blank for them. **Advisory, not a block** — matching the page's
   existing stance on the 20-key note. The consequence belongs on screen where
   the decision is made, not only in this document.
3. **Copy that stops lying.** "Default for new profiles" is what the global list
   now is; the footer note (`instrument-attributes.tsx:219-226`) becomes
   profile-specific; a profile's empty state reads *"This profile will ask for
   no attributes"*, because for a profile empty is a real configuration stored
   as `''`.

## 8. New Instrument form

`create.tsx` drops the global config fetch (`create.tsx:53-57`) and reads the
selected profile:

```ts
const { data: profile, error: profileError, isLoading } =
  useSWR(profileId ? `/api/instrument-profiles/${profileId}` : null);
const attributeKeys = parseInstrumentAttributeKeys(profile?.attributeKeys);
```

Placement routing at submit (`create.tsx:75-84`) is untouched — Block/Area/Location
still go to their columns, everything else becomes an attribute row.

### Four states, each distinct

| State | Shows |
|---|---|
| no profile chosen | "Choose a profile to see the attributes it asks for." |
| chosen, fetch in flight | a loading line — **not** "no attributes" |
| chosen, list empty | "This profile asks for no attributes." |
| fetch failed | an explicit warning that the list could not be loaded |

The last two matter. Today a failed config read "simply yields no attribute
fields" (`create.tsx:53-55`) — acceptable when the list was global and a blip was
obviously a blip. Per-profile, silently rendering no fields is
indistinguishable from *this profile asks for nothing*, and the operator
registers an instrument missing every attribute without knowing. A failed fetch
therefore says so, and still does not block registration: same non-blocking
posture, honest signal.

### Switching profile after typing

Arriving from inside a profile shows a chip rather than a dropdown
(`create.tsx:44-51`), so this cannot arise on the normal route — only on a bare
`/instruments/new`. Since values are not carried across profiles, changing the
profile clears typed attribute values, but **confirms first** if anything was
typed. Same principle as the config page's dirty guard.

## 9. Attributes panel

`attributes-panel.tsx` takes `profileId` as a prop from `detail.tsx` — the
instrument payload already returns it (`instruments/routes.ts:864`) — and reads
that profile's list for its missing-key suggestions (`attributes-panel.tsx:77-79`).
Placement keys stay excluded, as now.

**Consequence, stated rather than discovered:** an instrument moved to a profile
that does not ask for an attribute it already has **keeps that attribute**. It is
recorded data, it renders as a normal row, it is simply no longer suggested.
Nothing is deleted or hidden by a profile change — §2's rule applied.

## 10. Testing

All target test files already exist; this extends them.

`packages/shared/src/schemas/instrument-profiles.test.ts`
- `attributeKeys` accepted on create and update
- `''` accepted, and distinct from omitted
- over 2000 characters rejected

`apps/api/src/e2e/instrument-profiles.e2e.test.ts`
- `POST` without `attributeKeys` starts the profile **empty**, and specifically
  does NOT copy the global `instrument-attributes` config value (amended
  2026-08-08 — see §7)
- `POST`/`PUT` store a key containing `<` **verbatim** — the regression guard for
  the `sanitizeStrings` skip
- `PUT ''` reads back as "asks nothing", not as `NULL`
- `PUT` writes an audit row whose before/after hold parsed arrays and whose
  `signatureMeaning` carries the count change
- `GET /` returns `attributeKeys` for every profile in one fetch
- resolution falls back to the default template when the column is `NULL`

`apps/api/src/e2e/instrument-attributes.test.ts` — attribute-row behaviour
unchanged; confirm it passes untouched.

Web
- `create.test.tsx` — all four Attributes states, plus confirm-on-profile-switch
- `attributes-panel.test.tsx` — suggestions come from the profile
- `apps/web/src/routes/config/__tests__/instrument-attributes.test.tsx` — new
  file in a new directory (`routes/config/__tests__/` does not exist yet):
  target switch, the dirty guard, and the placement advisory

### Verification — tests alone are not it

Green vitest does not mean it compiles (`verification-gaps`).

- `npx tsc -p apps/api/tsconfig.json --noEmit`; `cd apps/web && npx vite build`
- `cd apps/api && npm test` (single-fork; `npm test` carries the right flags)
  against the documented baseline **1173 passing / 0 failed / 12 skipped, 113
  files**; web **573/573, 44 files**
- `npm run db:verify-migrations` must PASS
- In the browser: register an instrument in two profiles with different lists;
  change a profile's list and confirm existing attributes are untouched; move an
  instrument between profiles. Watch for unstyled elements and console responses
  that disagree with what the UI claims.

## 11. Touchpoints

| File | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | `attributeKeys` column; **rewrite the GROUPING-ONLY comment at 751-760** |
| `prisma/migrations/<ts>_instrument_profile_attribute_keys/` | new, hand-authored |
| `packages/shared/src/schemas/instrument-profiles.ts` | field on both schemas |
| `apps/api/src/modules/instrument-profiles/routes.ts` | props, `present()`, POST starts empty (no seed), PUT, audit, `skipKeys`; **header comment at 12-14 repeats the same false claim** |
| `apps/api/src/modules/config/defs/instrument-attributes.def.ts` | inert — seeds nothing, asked for on no form |
| `apps/web/src/routes/config/instrument-attributes.tsx` | profile selector (profiles only), no-profiles empty state, dirty guard, placement advisory, copy |
| `apps/web/src/routes/instruments/create.tsx` | per-profile keys, four states, switch confirm |
| `apps/web/src/routes/instruments/attributes-panel.tsx` | keys from the profile |
| `apps/web/src/routes/instruments/detail.tsx` | pass `profileId` down |

Rebuild `@digilog/shared` (`npm run build -w @digilog/shared`) before testing
api or web, per `packages/shared/CLAUDE.md`.

## 12. Docs

- `CHANGELOG.md`
- `apps/api/CLAUDE.md` — schema note plus the migration name
- `API_REFERENCE.md` — lines 177-181 list the five instrument-profile endpoints
  but no field-level payloads, so the only change is a note that `POST`/`PUT`
  accept `attributeKeys` and every read returns it
- `tasks/todo.md` — audit-log entry
- `docs/superpowers/specs/2026-08-08-instrument-profiles-design.md` §6 lines
  147-149 — amended to point here

No count changes anywhere (see §4).

## 13. Out of scope

- **No versioning sidecar.** No `InstrumentProfileVersion`. The audit trail
  records every change to the list with before/after; a frozen-snapshot sidecar
  would be for replaying what a form looked like at a past moment, which nobody
  has asked to do.
- **No bulk edit across profiles.** One profile at a time.
- **No per-profile value defaults.** Only which keys are asked, never what they
  are pre-filled with — §2's rule.
- **No change to the bulk CSV import.** It does not handle attributes at all
  (verified: no attribute references in `bulk-create.tsx` or `bulk-csv.ts`), so
  it is untouched.
- **No "copy keys from another profile" button.** Each profile's list is built
  on its own. With seeding removed this is the only way to populate a new
  profile, which is accepted — nobody has asked to clone one, and cloning is
  what made the lists read as global in the first place.
