# Offline-app version-sync contract (design note — recorded 2026-05-02)

## Context
Across Phases A.1–A.4 + Step 4 + P1, the server now versions every mutable definition that feeds a cleaning cycle:

- ChecklistProfile (A.1) — sidecar + cycle pin via `cycle.checklistVersionPins`
- FilterCleaningProfile (A.2) — rowful immutable + lineageId
- FilterProfile (A.3) — sidecar + version on the live row
- EquipmentGroup composite (A.4) — sidecar
- EquipmentGroup cycle pin (P1, this work) — `cleaning_cycles.equipmentGroupVersionPin`
- FilterProfileApplicableTemplate (Step 4) — join table with cascade FKs

P1 ships **server-side only**. The tablet / offline app keeps its current behaviour: caches whatever responses it sees, submits readings without sending a version number. Server validates against the cycle's pinned version regardless. This closes the audit-replay correctness bug everyone agreed needs closing, with zero APK rebuild required.

## What's NOT yet done — and what this memo locks in for the next APK cycle

The tablet / offline app must learn to participate in the version contract. This was already done for A.1 ChecklistProfile (the tablet sends `expectedProfileVersions` on `submit-checklist`, server returns `409 SCHEMA_DRIFT` with the diff, tablet self-heals). The same pattern needs to be extended to:

1. **EquipmentGroup version sync** (P1 follow-up — Slice B)
2. **FilterProfile version sync** (Phase A.3 follow-up — currently no per-cycle pin, but the tablet caches FilterProfile and could surface stale-cache drift when it tries to start a cycle against an admin-edited profile)
3. **FilterCleaningProfile lineage awareness** (Phase A.2 follow-up — tablet should pin to the version that was active at cycle start and refuse to render against a stale cache)

## The contract every offline-versioned entity should follow

For every mutable definition `X` that feeds a cleaning cycle:

1. **Server emits version on cache-fill.** Every list / detail endpoint that the tablet caches MUST include the entity's current `version` int (or `lineageId + version` for rowful-immutable entities).

2. **Server emits the cycle-side pin.** `getCurrentState()` (and any other "what should the operator see right now" response) MUST embed both:
   - The pinned snapshot's payload (NOT the live row).
   - An explicit `<entity>VersionPin: <int>` field so the tablet knows what it just rendered.

3. **Tablet sends its version on every mutation.** Every offline-replayable POST / PUT body MUST include `expected<Entity>Version: <int>` (or `expectedVersions: { [id]: int }` for the multi-entity checklist case). This is what the tablet *thinks* the server's pinned version is.

4. **Server compares expected vs pinned.** If they match, proceed. If they drift, return:
   - HTTP `409 SCHEMA_DRIFT`
   - Body: `{ error, message, pinnedVersion, livePinnedSnapshot, diff? }`
   - The `livePinnedSnapshot` is the pinned version's full snapshot so the tablet can self-heal without an extra round trip.

5. **Tablet self-heals.** On 409, replace its local cache with the snapshot from the response, re-render the operator-facing UI against the correct version, prompt the operator to confirm / re-enter, then retry the submit.

6. **`x-offline-replay: true` does NOT bypass version checks.** It bypasses reauth (operator was already authenticated when they performed the action offline) but version checks are domain integrity, not security. Replay must hit the same pin comparison as a live request.

7. **Long-tail offline (hours-to-days):** the contract's correctness depends only on the cycle's server-side pin staying immutable. The tablet's cache can drift arbitrarily; the 409 self-heal flow recovers from any cache age.

## Per-entity status

| Entity | Server-side pinning | Tablet sends `expected<Entity>Version` | Tablet self-heals on 409 |
|---|---|---|---|
| ChecklistProfile | ✅ A.1 (cycle.checklistVersionPins JSONB) | ✅ A.1 (`expectedProfileVersions`) | ✅ A.1 |
| FilterCleaningProfile | ✅ A.2 (cycle.profileId pins to archived row) | ❌ — tablet doesn't send the lineage version | ❌ |
| FilterProfile | N/A — cycle doesn't pin (cycles already pin FilterCleaningProfile.id) | ❌ — tablet might submit start-cycle against a stale FilterProfile | ❌ |
| EquipmentGroup composite | ✅ P1 (cleaning_cycles.equipmentGroupVersionPin) | ❌ — Slice B (next APK) | ❌ — Slice B |
| FilterProfileApplicableTemplate | N/A — cascade FKs handle drift | ❌ — tablet should refuse to render stale template list | ❌ |

## Bundle this with the next APK build

Slice B is the right packaging:
- One APK rebuild touches all four offline-versioning gaps (EquipmentGroup, FilterProfile, FilterCleaningProfile lineage awareness, ApplicableTemplate-list freshness).
- Web + tablet ship the same code per `feedback_unified_tablet_web` — single change set.
- Server response shape changes are additive (new fields), so Slice B can roll out before the new APK lands without breaking older APK installs.

## Affected response shapes (for Slice B)

When Slice B lands, these endpoints add explicit version fields:

- `GET /api/filters/:id/current-state` — adds `equipmentGroupVersionPin`, returns pinned snapshot in `equipmentGroup`. (Today returns live group.)
- `POST /api/filters/:id/advance` — body adds `expectedGroupVersion: number`. Server returns `409 SCHEMA_DRIFT` if mismatch.
- `POST /api/filters/:id/start-cycle` — body adds `expectedGroupVersion: number` (tablet sends what it thinks is current; server pins whatever IS current; mismatch → 409).
- `GET /api/equipment-groups` (list) + `/api/equipment-groups/:id` (detail) — already returns `version` after Phase A.4. Tablet caches it.
- `POST /api/filters/:id/start-cycle` — body adds `expectedFilterProfileVersion: number` for stale-cache detection.

## Open questions deferred to Slice B implementation
- Does the tablet need to cache historical versions of EquipmentGroup, or only the version it's currently pinned to? Decision: only currently-pinned + currently-live (for the *next* cycle's start-time comparison). Historical lookup goes to the network.
- For `start-cycle`, what does the tablet send as `expectedGroupVersion` — the cached version, or no version (server picks live)? Decision: tablet sends what it cached. Server returns 409 if its live version differs from the cached one, so the tablet knows the cache is stale before the cycle starts.
- For long-offline scenarios, do queued ops re-evaluate versions when the tablet syncs? No — the cycle's pin is set at start-cycle time, and submissions reference that pin. Cache freshness only matters at cycle-start time.

---

## Addendum (2026-05-02, post-audit) — offline / tab work items deferred from the audit

A strict-evidence read of the codebase against the "online cleaning issues" list surfaced a handful of items that are **offline or tablet/APK** in nature, not server-side. Recorded here so they don't get lost when the APK build window opens; **do NOT pick these up without explicit user direction**, since the user has paused all tablet/android work.

### O1 — Tier-2 client-side graph walking (`mobile-operations.tsx:583-602`)

**What:** When `stageLookup` is absent from a cached `getCurrentState()` response, the FE falls back to walking `graph.connections` itself — same code path that historically drifted from the server's interpretation pre-Phase-5.

**Why offline-relevant:** Today this fallback only fires for cached/offline-replay scenarios. Fresh online flows always carry `stageLookup`. Step 8 (decision-tape) eliminates this surface entirely; until then, the fallback is the only place client/server pipeline drift can happen.

**Touchpoints:** `apps/web/src/routes/mobile/mobile-operations.tsx` (and the equivalent in `filter-operations.tsx`). Independent of the server.

**Effort:** Subsumed by Step 8. Don't fix in isolation.

### O2 — Slice B as a whole (already documented above)

Tablet sends `expected<Entity>Version` on every mutation; server returns `409 SCHEMA_DRIFT` with the pinned snapshot; tablet self-heals. Bundled with the next APK build per the existing Slice B plan above.

**Note:** if the server-side **L1 fix** (described in the parallel `tasks/SERVER-ONLINE-WORKLIST.md`) lands first, Slice B's reading-validation drift case becomes a non-issue for the tablet too — `getCurrentState()` will return the pinned snapshot, the tablet's dropdowns will be built from it, and there's no live/pinned divergence the tablet needs to detect or recover from. Slice B's value reduces to the FilterProfile / ChecklistProfile cases (which already work via cycle pinning) and to defense-in-depth on the EquipmentGroup case for racey edits between cycle-start and the tablet's first cache-fill.

### O3 — Offline replay reading-submit drift (was Slice B's original motivating case)

**What:** Today the tablet caches the equipment group at login + on `getCurrentState()`. Operator goes offline, submits readings using the cached live ranges. Sync replays the reading; server validates against the cycle's pinned snapshot. If admin edited operating ranges between cache-fill and replay, the queued reading might be rejected.

**Why this becomes mostly moot once L1 lands:** with `getCurrentState()` returning pinned snapshots, the tablet caches the pinned snapshot per cycle (not the live group). Subsequent admin edits to the live group don't reach the tablet's per-cycle cache. **Residual offline gap:** the very first `getCurrentState()` for a cycle that started while admin was actively editing — narrow window, but still a Slice B concern.

**Touchpoints:** offline IndexedDB cache layer + the sync engine (`apps/web/src/lib/offline-*.ts`).

**Effort:** Half-day, bundled with Slice B + APK rebuild.

### O4 — APK ships with current dropdown-option generation logic

**What:** The DigiLog APK in operators' hands today builds reading dropdowns from `inst.operatingMin / operatingMax / leastCount`. Once L1 lands server-side and the field shape is preserved (still `{operatingMin, operatingMax, leastCount}`, just sourced from the snapshot), the APK keeps working without rebuild — the dropdown will just naturally start showing the pinned ranges.

**Confirmation needed:** verify that L1's server change preserves the exact field shape the APK consumes. Quick read of `mobile-operations.tsx:2062` confirms it expects `inst.operatingMin / operatingMax / leastCount / uom / id` — same shape `EquipmentGroupVersion.snapshot.instruments[]` carries. **No APK rebuild required for L1.** Worth re-verifying before shipping L1 to be safe.

**Touchpoint check:** none — just visual code-read of the APK's expectations against the snapshot's shape.

### O5 — Operator UX during the L1 transition

**What:** L1 changes what `getCurrentState()` returns for `equipmentGroup`. If an operator is mid-cycle when L1 deploys, their next `getCurrentState()` poll will return the pinned snapshot instead of the live group. If admin had already edited the live group, the operator sees a "rollback" of the displayed ranges. This is *correct behavior* — those rollbacks reflect the actual rules they're being held to — but the operator may be confused mid-cycle.

**Mitigation:** none required for tablet; the pinned ranges have always been the truth, just hidden. If the field changes mid-cycle, the API spec (Slice B) for `409 SCHEMA_DRIFT` covers the edge case where the tablet's cache and the server's pin disagree.

---

## Recommended ordering (when APK window opens)

1. **L1 server-side** — already in the online worklist; lands first, no APK touch.
2. **L2 + L3 server-side** — tape adapter + cycle profileSyncWarning extensions; lands without APK.
3. **APK rebuild** with Slice B + O3 + O4 verification, all in one ship cycle.
4. **Step 8 (decision-tape)** if/when committed to multi-week work — fully replaces the `stageLookup`/Tier-2/Slice-B contract layer with a single server-emitted action tape.

---

Recorded 2026-05-02 alongside P1 server-side commit. Slice B (tablet-side) is its own future work item; do not start without an APK build cycle window. **The audit-discovered items O1-O5 above are offline/tablet-related** — they're tracked here intentionally to keep the online worklist clean.
