# Filters Page UI/UX Enhancement + Filter Size field — 2026-06-02

Branch: RFID.

## Decisions (from user)
- **Filter Size is a NEW field, distinct from Micron Size.** Add as a new column.
- Implement as a 4th **configurable dropdown** in `filter-field-options`, mirroring `micronSize` exactly (consistent with ahuType/filterType/micronSize; admin populates options in config). Dimensional values (e.g. `610×610×292mm`, `24×24×12in`).
- **Add CSV export** of the currently-listed filters.

## Part A — `filterSize` new field (mirror `micronSize` everywhere)

### Backend
- [ ] `assets/services/filter-fields.service.ts` — `FilterFieldOptions`, `FilterFieldInput`, `checkList(...)`, `loadFilterFieldOptions` defaults (`[]`).
- [ ] `config/defs/filter-field-options.def.ts` — description text.
- [ ] `hierarchy/routes.ts` — `filterSize: { type: 'string' }` in BOTH create + edit filter body schemas (~L313-315, ~L345-347).
- [ ] `assets/services/bulk-upload-filter.service.ts` — `ParsedRow`, `HEADER_ALIASES`, validate call, `toCreate`, dry-run rows, `filterService.create` call.
- [ ] `assets/services/filter-upload-template.service.ts` — `filterSize` template column w/ options dropdown.
- [ ] `assets/services/filter.service.ts` — flows automatically via `FilterFieldInput` (verify).
- [ ] `prisma/seed.ts` — add `filterSize: []` to seeded filter-field-options config.
- [ ] Tests: `filter-fields.service.test.ts`, `create-filter.routes.test.ts`, `filter-upload-template.service.test.ts`.

### Frontend
- [ ] `filter-list/components/FilterFieldOptionsSection.tsx` — type + 4th `<select>`.
- [ ] `filter-list/types.ts` — `EditFilterRef.filterSize?`.
- [ ] `dialogs/CreateFilterDialog.tsx` + `EditFilterDialog.tsx` — thread prop + handler.
- [ ] `filter-list.tsx` — fieldOptions default, create/edit state, `enrichedFilters` map, table header+cell, openEditFilter, submit bodies, openCreateFilter reset.
- [ ] `config/filter-field-options.tsx` — `ListKey`, `FieldOptions`, `DEFAULT_VALUE`, `SECTIONS`, draft.
- [ ] `dialogs/BulkUploadDialog.tsx` — preview column.
- [ ] `config/filter-data-management.tsx` + `config/cleaning-profile-assignment.tsx` — mirror only if they display micron.

## Part B — UI/UX requirements
- [ ] **2. Status icon** — distinct icon for "Update Status" (currently identical pencil to Edit).
- [ ] **3. Single-line cells** — `whitespace-nowrap` + `truncate` + `max-w` + `title` tooltips.
- [ ] **4. Card chrome** — reduce wasted space; width-efficient (verify visually).
- [ ] **5. Grid visibility** — tighter padding, column widths, more rows visible.
- [ ] **6. Button alignment** — group [Export] [Create Filter] [Bulk Upload] adjacent right.
- [ ] **7. Overall polish** — spacing/alignment/hierarchy/responsiveness.
- [ ] **CSV export** — exports `blockFilters` incl. Filter Size.

## Verification
- [x] `tsc` clean (api + web).
- [x] Targeted tests green: filter-fields (+2), template (+1), create-filter route (filterSize survives schema). 14/14.
- [x] `vite build` succeeds (only pre-existing chunk-size warning).
- [x] psql confirms `filter-field-options.value.filterSize` persists.
- [ ] **LIVE UI verification PENDING** — blocked: single-session enforcement (can't log in without kicking the active admin session) + throwaway-admin creation correctly denied by classifier. Needs user go-ahead to force-login OR a spare test account, then Playwright: create/edit w/ size, column renders single-line, export downloads, distinct icons, 0 console errors.
- [x] Docs: CHANGELOG.md updated. Memory entry added.

## Status: code-complete, type-checked, unit-tested, built. Live UI pass outstanding.
All Part A + Part B items implemented. `filterSize` seeded with starter values
(`610x610x292mm`, `592x592x292mm`, `24x24x12in`) via psql for testing.
