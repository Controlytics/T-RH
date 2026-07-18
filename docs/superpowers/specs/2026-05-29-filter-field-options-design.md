# Filter Field Options — Configurable dropdowns + Last Cleaning Date on filter add/edit

**Status:** Approved design (2026-05-29) — ready for implementation plan
**Owner:** sivamunnangi1211
**Branch:** RFID

---

## 1. Goal

Let SUPER_ADMIN define the value lists for three filter dropdowns (**AHU Type**, **Filter Type**, **Micron Size**) in one Configuration page, and surface those dropdowns — plus a **Last Cleaning Date** field with an explicit "NA" option — on the single-filter Add and Edit dialogs. Update the filters table to show the new column and rename the existing "Type" header.

---

## 2. Scope

### In scope
- **One new Config page** `Filter Field Options` (`/config/filter-field-options`) managing three named value-lists.
- **CreateFilterDialog** (`apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx`): four new inputs.
- **EditFilterDialog** (`apps/web/src/routes/filter-management/filter-list/dialogs/EditFilterDialog.tsx`): same four inputs, so values can be corrected later (per user decision).
- **Filters table** (`apps/web/src/routes/filter-management/filter-list.tsx`): rename `Type` → `Filter Type`; add `Micron Size` column.
- New config def + page + discovery wiring + reauth action + shared package rebuild (the standard config touchpoints — see §10).

### Out of scope
- Bulk-upload CSV columns for the new fields (user picked Add + Edit, not bulk).
- Filter-detail / trace page changes (user pointed at table as the "filter view").
- Required-field validation on the new inputs — all four are optional on create (user did not flag any as required).
- Migrating historic filters to populate the new attributes (they stay `null` until edited).
- Deriving AHU Type from the parent AHU. Per user: the value is selected on the filter and stored with the filter, regardless of which AHU it sits under.

---

## 3. Data model

### 3.1 Where the selected values live
Stored on the filter instance's existing `attributes` JSONB, under these exact keys (the filters table already reads them — see `filter-list.tsx:370–372`):

| Key | Type | Notes |
|---|---|---|
| `ahuType` | `string` | One of the configured AHU Type options, or unset. |
| `filterType` | `string` | One of the configured Filter Type options, or unset. |
| `micronSize` | `string` | One of the configured Micron Size options, or unset. Stored as string for consistency with the other dropdowns (the config edits strings). |
| `lastCleaningDate` | `string` | Either an ISO date string (`"2026-04-15"`) **or** the literal `"NA"`. Unset means the operator left the field blank — distinct from the explicit `"NA"`. |

No schema migration needed: `asset_instances.attributes` is JSONB and currently `{}` for every filter (verified live).

### 3.2 Where the dropdown options live
One row in `system_config` under config key `filter-field-options`. Value shape:

```json
{
  "ahuType":    ["Process", "Non Process"],
  "filterType": [],
  "micronSize": []
}
```

- The value is a plain object with three string-array fields, edited atomically via the existing dynamic-config endpoint (`/api/config/dynamic/filter-field-options`), exactly like `filter-cleaning-reasons`.
- Initial seed: `ahuType` defaults to `["Process", "Non Process"]` (user-supplied defaults). The other two arrays seed empty — admin fills them on first use. (An empty list means the dropdown shows an empty `Select…` placeholder with no options; the field is optional so this still permits create.)
- Trim + dedupe (case-insensitive) on save to keep lists clean. Order preserved as entered (admin controls ordering).

---

## 4. Configuration page UX

**Route:** `/config/filter-field-options` (registered as a card on `/config`).

**Page structure** — single page, three labelled sections one above the other. Each section is a vertically stacked list with reorder/edit/remove controls and an "+ Add value" button at the bottom. A single "Save Changes" button at the top-right writes the whole JSON object atomically (matches the cleaning-reasons save pattern).

```
┌──────────────────────────────────────────────────────┐
│ ← Back   ▣  Filter Field Options       [ Save Changes ] │
│        Configure the dropdown values shown on the      │
│        single-filter add/edit screens.                 │
├──────────────────────────────────────────────────────┤
│  AHU TYPE                              + Add value    │
│   ▦  Process            [Edit] [Remove] [↑] [↓]      │
│   ▦  Non Process        [Edit] [Remove] [↑] [↓]      │
├──────────────────────────────────────────────────────┤
│  FILTER TYPE                           + Add value    │
│   (no values configured yet)                          │
├──────────────────────────────────────────────────────┤
│  MICRON SIZE                           + Add value    │
│   (no values configured yet)                          │
└──────────────────────────────────────────────────────┘
```

Reuses the visual language of `apps/web/src/routes/config/filter-cleaning-reasons.tsx` (header chip, list rows, modal edit).

**Permissions / Reauth:** `CONFIG_READ` to view, `CONFIG_UPDATE` to write. Reauth gated via `UPDATE_CONFIG_PAGE` (same umbrella action used by Cleaning Reasons).

---

## 5. Filter Add / Edit dialog UX

Append four inputs **below** the existing "Filter Set" buttons in both `CreateFilterDialog.tsx` and `EditFilterDialog.tsx`. Group them under a header `Filter Details` (matching the existing `Filter Attributes` section style; this section is shown whether or not template `attributeSchema` is empty, since these four are first-class).

| Field | Control | Source of options | Stored as |
|---|---|---|---|
| AHU Type | `<select>` | `config.value.ahuType` | `attributes.ahuType` |
| Filter Type | `<select>` | `config.value.filterType` | `attributes.filterType` |
| Micron Size | `<select>` (label `Micron Size (µm)`) | `config.value.micronSize` | `attributes.micronSize` |
| Last Cleaning Date | `<input type="date">` + sibling `[ ] NA` checkbox | n/a | `attributes.lastCleaningDate` = ISO date **or** `"NA"` |

**Last Cleaning Date control behavior:**
- Date input + "NA" checkbox side-by-side.
- When NA is **unchecked**: the date input is enabled; the value submitted is the ISO date (or `undefined` if blank).
- When NA is **checked**: the date input clears + disables (`value=""`, `disabled`); the value submitted is the literal `"NA"`.
- Unticking NA re-enables the date input with empty value.
- When editing a filter whose stored `lastCleaningDate === "NA"`, mount with the NA checkbox pre-ticked.

**All four fields are optional** on create and edit. Empty selection = the key is omitted from `attributes` (not stored as empty string).

**Options loading:** Both dialogs (or the parent `filter-list.tsx`) fetch `/api/config/dynamic/filter-field-options` via SWR once when the dialog opens; cached across opens by SWR. If the config has not been initialized yet (404 or no value), fall back to `{ ahuType: ["Process", "Non Process"], filterType: [], micronSize: [] }` so the AHU Type defaults still work out of the box.

---

## 6. Filters table changes (`filter-list.tsx`)

- **Rename header**: `Type` → `Filter Type` (single string change on line 1427).
- **Add column**: `Micron Size`, positioned **between** `Filter Type` and `Set`. Renders `f.micronSize ?? '--'` (with the µm suffix appended when present).
- **Existing reads unchanged**: `f.ahuType`, `f.filterType`, `f.lastCleaningDate` already pulled from `attributes` (lines 370–372); they just start showing real data once filters are saved with the new fields.
- **`lastCleaningDate` column display**: extend `f.lastCleaningDate ? formatDate(f.lastCleaningDate) : '--'` to also render the literal `"NA"` as `"NA"` (the formatter would otherwise produce `Invalid Date`).
- The new `micronSize` field must also be projected in the data-shaping step (`apps/web/src/routes/filter-management/filter-list.tsx:~370`) the same way `filterType`/`ahuType` are.

---

## 7. API surface

No new endpoints — entirely on existing infra.

- `GET  /api/config/dynamic/filter-field-options` — returns `{ value: { ahuType: [], filterType: [], micronSize: [] } }`.
- `PUT  /api/config/dynamic/filter-field-options` — body `{ value: {…} }`, gated by `CONFIG_UPDATE` + reauth via the dynamic-config route's `reauthAction` lookup.
- Filter create/update — existing `POST /api/assets/instances` / `PUT /api/assets/instances/:id`. The added attribute keys are passed through the existing `attributes` JSONB; no API contract change.

---

## 8. Validation

- **Config save** (`PUT /api/config/dynamic/filter-field-options`):
  - Shape: `{ ahuType: string[], filterType: string[], micronSize: string[] }` — reject anything else (400).
  - Each entry: non-empty string after trim; duplicates within a list collapsed case-insensitively; per-entry length cap (e.g. 100 chars) consistent with other config strings.
- **Filter create/edit**: no server-side enforcement that the picked value is in the config list — the value is free-form text in `attributes`. This keeps the API simple, lets admins remove a list value without invalidating existing filters, and matches how the table already tolerates `'-'`. The dropdown UI is what constrains the choice on entry.
- **Last Cleaning Date**: when not `"NA"`, must parse as an ISO date and must not be in the future (cleaning happened in the past). Empty is allowed (field optional).

---

## 9. Permissions / Reauth

| Surface | Permission | Reauth |
|---|---|---|
| View config page | `CONFIG_READ` | — |
| Save config page | `CONFIG_UPDATE` | `UPDATE_CONFIG_PAGE` |
| Create filter | existing `ASSET_CREATE` / filter-create perm — unchanged | unchanged |
| Edit filter | existing perm — unchanged | unchanged |

No new permission constants. No new reauth action — `UPDATE_CONFIG_PAGE` already covers dynamic config edits (per `filter-cleaning-reasons.def.ts`).

---

## 10. Touchpoints (the "12-touchpoint" config rule — confirmed by memory `feedback_config_sync.md`)

For the **new config def**, every one of these must be updated in the implementation:

1. `apps/api/src/modules/config/defs/filter-field-options.def.ts` — new file.
2. `apps/api/src/lib/config-discovery.ts` — import the new def.
3. `apps/web/src/routes/config/filter-field-options.tsx` — new page.
4. `apps/web/src/routes/config/index.tsx` — add card.
5. `apps/web/src/main.tsx` — add `<Route path="/config/filter-field-options" …>`.
6. `packages/shared/src/sidebar-items.ts` — **skip**. Page is reachable via the Config index card (matches the cleaning-reasons page, which is also not in the sidebar).
7. Seed defaults — `apps/api/prisma/seed.ts` (or wherever existing dynamic configs are seeded): insert `system_config` row `filter-field-options` with the default `ahuType` list if missing on startup.
8. Help article — **skip** for this iteration. Add only if/when the rest of the config pages get one as a batch.
9. Rebuild shared package — **skip**. No shared types change (no new permission constants, privileges, reauth actions, or sidebar entries; the existing `CONFIG_READ/UPDATE` perms and `UPDATE_CONFIG_PAGE` reauth action are reused).

Plus the **filter-list / dialog touchpoints**:

10. `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx` — 4 inputs + the NA toggle, options + config-config fetch wiring through props.
11. `apps/web/src/routes/filter-management/filter-list/dialogs/EditFilterDialog.tsx` — same 4 inputs.
12. `apps/web/src/routes/filter-management/filter-list.tsx` — fetch config (SWR), pass options into dialogs, build `attributes` body on submit, rename `Type`→`Filter Type` header, add `Micron Size` column + cell, extend `lastCleaningDate` formatter for `"NA"`, project `micronSize` in the data-shaping step.
13. `apps/web/src/routes/filter-management/filter-list/types.ts` — extend `Filter` / row type with `micronSize?: string | null` (and ensure `filterType`/`ahuType`/`lastCleaningDate` are typed) so the table cells type-check.

---

## 11. Testing

- **Vitest unit**: a small test that the config save handler accepts the right shape and rejects malformed input.
- **Vitest component**: render `CreateFilterDialog` with a mocked options config; assert all 4 inputs render, that picking NA disables the date input, that submit emits `attributes` with the chosen values.
- **Manual smoke**:
  1. Open `/config/filter-field-options`, add a Filter Type and a Micron Size, save (with reauth prompt).
  2. Open Create Filter dialog; the new dropdowns show the saved options.
  3. Create a filter with all 4 fields set (date selected, NA off).
  4. Create another with `lastCleaningDate = NA`.
  5. Verify the table shows the new `Filter Type` header, the `Micron Size` column with the entered value, and `Last Cleaned` shows the date for the first row and `NA` for the second.
  6. Edit the first filter, change Filter Type, save, verify the table updates.

---

## 12. Non-goals / explicit deferrals

- **AHU Type as a property of the AHU.** Considered and rejected per user decision. If later the team wants to enforce one AHU Type per AHU, that's a follow-up: move the field off `filter.attributes` and onto the AHU `asset_instance.attributes`, with read-only display on the filter dialog. Not done now.
- **Required-field validation** on any of the 4 inputs. Easy to flip later by adding a check in `handleSubmit` and a red asterisk in the label.
- **CSV bulk-upload columns** for the new fields. Add to `apps/web/.../bulk-upload-filters-dialog.tsx` + `bulk-upload-filter.service.ts` if/when requested.
- **Filter detail / trace page** rendering. The "filter view" referenced in the spec is the table on the filters page; trace/detail untouched.

---

## 13. Risks / known issues

- **Empty option lists** — until admin fills `filterType` / `micronSize`, those dropdowns are empty. Mitigated by treating fields as optional (so create still works) and surfacing a small "Configure options" hint inside the dropdown when empty.
- **Stale SWR cache after config edit** — when the config page saves, the dialogs may hold a stale SWR cache. Add `mutate('/api/config/dynamic/filter-field-options')` after the dialog opens, or accept that the user re-opens the dialog after editing config (cheap, common pattern in this repo).
- **Config key collision** — verify `filter-field-options` is not already a registered config def (a Grep against `apps/api/src/modules/config/defs/` during implementation; not expected to clash with the 27 existing defs).
- **Memory rule `feedback_remarks_mandatory.md`** — does not apply (no approval/decision flow added).
- **Memory rule `feedback_no_auto_sync_config.md`** — does not apply (a single dedicated config def, not auto-sync between tabs).

---

## 14. Open items (none blocking — defaulted)

- *(All design questions resolved during brainstorming.)*
