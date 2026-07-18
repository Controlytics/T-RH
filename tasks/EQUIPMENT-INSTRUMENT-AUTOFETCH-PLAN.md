# Equipment-Instrument Auto-Fetch — Implementation Plan

**Branch:** RFID · **Status:** PLAN (no code yet) · **Created:** 2026-06-13

Auto-populate cleaning-stage instrument readings from per-instrument REST endpoints,
with a manual fallback. Server-proxied fetch, snapshot-pinned URLs, manual flow
preserved when disabled / offline / unreachable.

---

## 0. CONTRACT REVISION (user 2026-06-13) — supersedes D2
The instrument sends **ALL readings from ONE endpoint per group**, keyed by name under a
`reading` object: `{ "reading": { "air_pressure": 6.2, "ro_water_pressure": 4.1, "dryer_temperature": 75 } }`.
So the model is **one `EquipmentGroup.readingUrl` + a per-instrument `responseKey`** (NOT 3 URLs ×
`{value}`). `autoFetchEnabled` is DERIVED server-side (group has readingUrl AND instrument has key).
Migration `20260613140000` dropped the per-instrument `url`, added `equipment_groups.reading_url` +
`equipment_group_instruments.response_key`. Proxy fetches the one URL ONCE and distributes by key.
Operator reading dialogs (4a) UNCHANGED — proxy still returns per-instrument results. Config editor:
ONE "Readings URL" + a response-key field per instrument + Get Latest Values shows the mapped values.
Verified e2e: test-url returns the reading object; create derives auto=true ×3; WASH_IN→air+ro,
DRY_IN→dryer mapped by key. API+web tsc 0, vite build clean.

## 1. Decisions (confirmed with user 2026-06-13)

| # | Decision | Choice |
|---|---|---|
| D1 | Who calls the instrument URL | **Server-proxied** (backend fetches; URL/secrets hidden from client; audited) |
| D2 | Instrument API response shape | **Same fixed JSON** — contract: `{ "value": <number> }`, already in the instrument's UoM, no conversion |
| D3 | Out-of-range auto value | **Accept but warn** at the fetch/fill step (see DECISION-A below) |
| D4 | "Get Values" button scope | **One button for the whole stage** (fetches all enabled auto instruments for that stage) |

### DECISION-A — Out-of-range submission (NEEDS REVIEW SIGN-OFF)
"Accept but warn" cleanly governs the **fetch/fill** step: an out-of-range auto value
fills the field with a warning and stays editable. **v1 keeps the existing hard range
guard (#29) at submit** — i.e. submission is governed exactly as manual entry is today;
the warning just previews what will fail. This is **no compliance change**.

The alternative — allowing out-of-range readings to be *submitted* as a recorded
deviation — is a materially larger, compliance-weighted change and is **deferred to a
possible later phase**, not in v1. **User: veto here at review if you want OOS-submittable.**

### Defaulted (stated, correctable)
- **D2 key** = `value`. If the upstream key differs, it's a one-line change.
- **Auth** = none in v1 (assume open on the cleanroom LAN). The proxy is designed so an
  optional per-instrument auth header can be added later without reshaping anything.

---

## 2. Core concepts / invariants

- **Snapshot-pinned URLs.** The URL + auto-fetch toggle live on `EquipmentGroupInstrument`
  and are captured into the `EquipmentGroupVersion` snapshot at cycle start (same as
  `operatingMin/Max`). The proxy reads the **cycle's pinned snapshot**, never the live row,
  so an admin editing a URL mid-cycle can't reach an in-flight cycle.
- **Backward-compat.** Existing `EquipmentGroupVersion` snapshots and instrument rows have
  no `url` / `autoFetchEnabled` fields → **missing = auto-fetch OFF** everywhere (readers,
  proxy, dialogs). No migration of historic snapshots.
- **Manual is the floor.** Auto-fetch is a convenience layer on top of the current manual
  flow. OFF / offline / unreachable / 2-min-timeout all converge on the unchanged manual path.
- **Provenance (ALCOA).** Each reading records how it was obtained:
  `source ∈ { MANUAL, AUTO, AUTO_OVERRIDDEN }`. If an operator auto-fetches **then edits**
  the field, source flips `AUTO → AUTO_OVERRIDDEN` (or `MANUAL`) — never stays `AUTO`.
  Store `fetchedAt` for AUTO/AUTO_OVERRIDDEN.
- **Submit path unchanged.** Once readings are present (auto / manual / instrument disabled),
  the existing `advance.ts` validation + event write + stage interlock run as today.

---

## 3. Group enable/disable RULE (resolves MULTIPLE_EQUIPMENT_GROUPS)

The whole point of the per-group toggle is the "multiple groups in one block" case. Today
`advance.ts` throws `MULTIPLE_EQUIPMENT_GROUPS` when a block has >1 active group.

**Rule (v1):** **enabling a group disables every other group in the same block** (enforced
server-side in the equipment-group update service, transactionally). Result: at most one
enabled group per block, so the existing single-active-group resolution keeps working and
the error path becomes unreachable in normal use. The `MULTIPLE_EQUIPMENT_GROUPS` guard
stays as a defensive backstop.

> Alternative considered: block *enabling* a second group with a 409. Rejected — the
> "enable flips the others off" UX matches how the user described switching between groups.

---

## 4. Phases

Each phase: implement → verify (per CLAUDE.md correctness rule) → only then next.

### Phase 1 — Schema + snapshot + group rule  ✅ DONE + VERIFIED (2026-06-13)
> Migration `20260613120000_add_instrument_autofetch` applied. `EquipmentGroupInstrument`
> gained `url String?` + `autoFetchEnabled Boolean @default(false)`; both flow through
> create/update + the `instrumentSchema` (Fastify strip-fix) + the version snapshot.
> New `setActive()` + `PATCH /:id/active` enforce one-active-group-per-block (enabling flips
> siblings off); create makes a group inactive if the block already has an active one.
> `list(includeInactive)` for the config UI. **Live-verified via curl+psql** on block L1
> (create→inactive+fields persisted, enable→sibling flipped, update→snapshot carried the new
> fields), then test group hard-deleted and L1 restored. tsc 0 errors.
- `EquipmentGroupInstrument`: add `url String?`, `autoFetchEnabled Boolean @default(false)`.
- `snapshotAndBump` (equipment-groups.service.ts): include `url` + `autoFetchEnabled` in the
  per-instrument snapshot map. Snapshot readers tolerate missing (= OFF).
- Group enable/disable service rule (Section 3) — transactional flip of siblings.
- **Windows gotchas:** hand-write the migration + apply via psql (`prisma migrate dev` is
  broken in repo); **stop the API** before `npx prisma generate` (DLL lock); **rebuild
  shared** if any shared type changes (`cd packages/shared && npx tsc`).
- **Verify:** migration applied; API boots; create/edit a group with URLs persists; editing
  bumps version and the new snapshot carries url+toggle; enabling group B in a block flips
  group A off.

### Phase 2 — Server proxy endpoint (SSRF-hardened)  ✅ DONE + VERIFIED (2026-06-13)
> `instrument-fetch.ts`: SSRF-hardened single fetch — scheme allowlist, DNS-resolved
> destination check blocking loopback / link-local+metadata (169.254/16) / unspecified
> (private LAN ALLOWED — instruments are on-LAN), `redirect:'error'`, 5s timeout, 64 KiB
> cap, strict `{value:number}` parse; never throws. Endpoint **`POST /api/equipment-groups/
> fetch-readings`** body `{filterId, stageKey}` (refined from the plan's `cycleId` — client
> has filterId, server resolves the cycle, safer). `service.fetchStageReadings` +
> `resolveStageInstruments` mirror advance.ts precedence READ-ONLY (no pin write — preview).
> Gated `FILTER_OPERATE`, no reauth. Verified: disposable script 9/9 fetch + 9/9 classifier
> cases; endpoint no-cycle→[], in-progress cycle→resolver clean, bad stageKey→400. tsc 0.
- New route, e.g. `POST /api/equipment-groups/fetch-reading`
  body `{ cycleId, stageKey }` → resolves the cycle's pinned snapshot, selects enabled +
  `autoFetchEnabled` instruments for `stageKey`, fetches each, returns per-instrument
  `{ instrumentId, ok, value?, error?, fetchedAt }`.
- **SSRF hardening (named requirements, not afterthought):**
  - short per-call timeout (≈5s — also serves the retry UX),
  - **no redirect-follow**,
  - **max response-size cap**,
  - **scheme allowlist** (http/https only) + **block loopback / link-local / cloud-metadata
    ranges** (169.254.0.0/16, 127.0.0.0/8, ::1, etc.); ideally an admin host allowlist.
  - parse strictly to `{ value: number }`; reject non-numeric / wrong shape as `ok:false`.
- One quick attempt per call — **the client owns the 1-min + 1-min retry loop**, not the server
  (no long-held HTTP requests).
- Permission-gated (reuse the filter-operations advance permission context; operator running
  the cycle can fetch). Audit the fetch attempt minimally if needed.
- **Verify:** with a local mock endpoint returning `{value:N}` → 200 + value; with mock down
  → `ok:false`; with `http://127.0.0.1/...` → blocked; oversized body → blocked; redirect → not
  followed.

### Phase 3 — Equipment Groups config UI  ✅ CODE DONE + REVISED (2026-06-13) — visual pass pending
> **REVISED per user 2026-06-13:** replaced the 3 per-instrument auto-fetch toggles with ONE
> group-level **main toggle**. Toggle ON → a consolidated **"Instrument Auto-Fetch URLs"** panel
> (all 3 URLs in one place) + a **"Get Latest Values"** button + read-only **latest-value display**
> fields per instrument. Toggle OFF → manual setup. Save derives per-instrument
> `autoFetchEnabled = mainToggle && url-filled` (blank URL = that instrument stays manual);
> needs ≥1 URL when on. New backend `POST /api/equipment-groups/test-url {url}` (EG_EDIT, SSRF-
> hardened via fetchInstrumentValue) powers Get Latest Values against TYPED (unsaved) URLs.
> Verified: API+web tsc 0, vite build clean, test-url e2e (LAN mock value 7.4 / loopback blocked).
> `apps/web/src/routes/config/equipment-groups.tsx`: per-instrument **auto-fetch toggle** +
> **Reading URL** field (shown when on; client validates required + http(s) when enabled; sent
> in the create/update payload). Per-group **enable/disable switch** + Active/Inactive badge,
> wired to `PATCH /:id/active` via reauth; enabling confirms "disables N others in this block".
> List switched to `includeInactive=true` (disabled groups stay visible/re-enableable); inactive
> cards dimmed. Read-only tiles show an "Auto" pill. Verified: web `tsc --noEmit` 0 errors +
> `vite build` clean; data path (url/autoFetchEnabled persist + version snapshot + toggle flips
> siblings) already proven via Phases 1-2 curl. **PENDING: in-browser visual pass** (no Playwright
> installed; HMR shows it live on :5175). Styling mirrors the file's existing light-theme tokens.
- Equipment Groups config page: per-instrument **URL** field + **auto-fetch** toggle; per-group
  **Enable/Disable** control reflecting the Section-3 rule (enabling shows "this turns the
  others off" affordance).
- Light theme; lint-clean; no console errors.
- **Verify:** in-browser save/edit round-trips; toggling group enable flips siblings in the UI
  + DB.

### Phase 4 — Reading dialogs (web + tablet, kept in SYNC)
**Split into 4a (UI flow) + 4b (provenance thread) to keep each commit safe.**

#### Phase 4a — Get Values UI in the shared dialog  ✅ DONE + VERIFIED (2026-06-13)
> All in the SHARED `equipment-dialog.tsx` (covers web + tablet at once) + a small Phase-2
> endpoint refinement. Auto instruments now render as free **numeric inputs** (hold off-step/
> out-of-range API values + serve as manual fallback); manual instruments keep the dropdown.
> **One "Get Values" button per stage** → polls `POST /fetch-readings {filterId, groupId, stageKey}`
> up to ~2 min (two 1-min windows, 5s interval), filling each auto instrument as it arrives,
> retrying only the still-pending ones, **aborting on dialog close** (cancelRef). Per-instrument
> **source** tracked in dialog state (MANUAL/AUTO/AUTO_OVERRIDDEN — edit of an auto value flips to
> AUTO_OVERRIDDEN) + "Auto"/"Auto·edited" badges. **Out-of-range warn** (DECISION-A): fills + warns
> + stays editable; submit still governed by the existing hard guard. Fetched value rides the
> EXISTING `instrumentReadings` path → zero critical-path/offline edits in 4a.
> Backend: `fetchStageReadings` gained a `groupId` fallback (cycle-start has no cycle to resolve;
> client sends ids only, server resolves the URL). Verified: API+web tsc 0, vite build clean,
> endpoint e2e via groupId fallback against a LAN mock → `AIR-1 ok value 6.2 +fetchedAt`, auto-only.
> **DISCOVERY:** the tablet does NOT use the shared dialog — `mobile-operations.tsx` has its own
> inline equipment dialog. Mirrored the full flow there (state + handleGetValuesMobile +
> setEquipReading + numeric inputs/badges/warn + Submit disabled while fetching). So 4a now covers
> BOTH surfaces. tsc+build clean.
> PENDING (batched with P3 visual): in-app drive of the dialog on a real cycle (tablet/APK) + APK rebuild.

#### Phase 4b — Provenance thread to the audit  ⏳ NEXT
Both `filter-operations.tsx` (web) and `mobile-operations.tsx` (tablet) — mirror every change.
- Stage reading dialog: if any enabled instrument for the stage has auto-fetch ON **and online**,
  show **one "Get Values" button** for the stage.
- Client retry loop: poll the proxy; **track per-instrument success** so retries only re-hit the
  ones still pending; up to 1 min, then a second 1 min; **abort the loop if the dialog closes**.
- On value: fill field, `source=AUTO`, show range warning if OOS (DECISION-A); field editable →
  on manual edit flip `source=AUTO_OVERRIDDEN`.
- On total failure (≈2 min) per instrument: that field falls back to manual.
- **DRY_IN:** the dryer-temp fetch belongs at the **SUBMIT_READINGS** sub-step (after half-time),
  **not** SET_DURATION.
- Submit sends `instrumentReadings` plus per-reading `source` + `fetchedAt`; `advance.ts` writes
  them into `FilterEvent.attributes.instrumentReadings[]`.
- **Verify:** browser + tablet — disabled→manual unchanged; enabled→fetch fills; mock-down→
  fallback to manual; OOS auto value warns; edited auto value records AUTO_OVERRIDDEN.

### Phase 5 — Offline
- Offline (Capacitor offline / no server contact) → **force manual**, hide/disable Get Values.
- Queued offline ops never attempt auto-fetch on replay (readings already captured as MANUAL).
- **Verify:** airplane-mode tablet → manual only; replay carries MANUAL source.

### Phase 6 — Tests + docs
- API tests: proxy happy path, mock-down, SSRF blocks (loopback/oversize/redirect), shape
  rejection — **upstream mocked** (no real network in tests).
- Unit: source-provenance transitions (AUTO→AUTO_OVERRIDDEN on edit), missing-field=OFF reader.
- Docs: CHANGELOG, apps/api + apps/web CLAUDE.md (schema field counts / new endpoint), this plan
  marked done, memory note.

---

## 5. Touchpoints (test all after change — CLAUDE.md correctness rule)
- `apps/api/prisma/schema.prisma` (EquipmentGroupInstrument)
- `apps/api/src/modules/equipment-groups/{equipment-groups.service.ts,routes.ts}` (snapshot,
  group rule, proxy)
- `apps/api/src/modules/filter-operations/cycle-write/advance.ts` (reading source/fetchedAt write)
- `packages/shared/src/pipeline-executor/instruments.ts` (only if reader shape touched)
- web: equipment-groups config page; `filter-operations.tsx`; `mobile-operations.tsx`
- offline: use-offline / sync paths (force-manual gate)
- APK rebuild after mobile-operations change (tablet QA)

## 6. Rollback
- Pre-work git tag before Phase 1. All flags default OFF / fields nullable, so the feature is
  inert until an admin sets a URL + toggle — safe to ship dark.
