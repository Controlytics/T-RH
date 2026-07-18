# Server / online-side worklist (post-audit, 2026-05-02)

Per user direction: work only on server-side / online issues. Tablet/APK/offline items deferred — see `future/offline-version-sync-contract.md` § "Addendum".

Each item below has been audited against live code (line-number evidence). Items are ranked by user impact + cost.

## Items

### L1 — `getCurrentState()` returns pinned EquipmentGroupVersion snapshot ✅ DONE (commit `dbce282`, 2026-05-02)

**What:** Today `filter-operations.service.ts:488` returns `prisma.equipmentGroup.findUnique` (the **live** group). When `cycle.equipmentGroupVersionPin` is set, it should return the snapshot from `EquipmentGroupVersion(groupId, versionNumber=pin)` instead.

**Status:** Closed by commit `dbce282`. Snapshot resolution + lazy-first-version fallback + legacy null-pin fallback all delivered. Regression coverage added in B7.3 (commit `0b2821f`).

**Why:** Closes the operator-visible drift surface from P1 — today the FE renders dropdowns from live operating ranges (`mobile-operations.tsx:2062` calls `genOpts(inst.operatingMin, inst.operatingMax, inst.leastCount)`), but server validation reads from the pinned snapshot inside `advance()`. Operator can pick a value the server rejects with no warning. After L1, the dropdown automatically picks up pinned ranges and the operator sees what they're held to.

**This also implicitly closes the offline reading-submit replay drift** — once the tablet caches the pinned snapshot per-cycle, subsequent admin edits to the live group don't reach the tablet's cache. Slice B's primary motivation evaporates.

**Touchpoints:**
- `apps/api/src/modules/filter-operations/filter-operations.service.ts:486-511` (the `equipmentGroup` resolution block in `getCurrentState`).
- Lazy first-version handling: when pin is set but no `EquipmentGroupVersion` row exists yet (live row IS v1), fall through to live row IFF `live.version === pin`. Mirrors the validation-time logic at `:1101`.
- Legacy fallback: when `pin === null` (cycles started before P1), keep returning the live row.
- The `blockEquipmentGroups` array (line 506-510) — used when no specific group is bound to the cycle. Stays as live data; no cycle to pin against yet.

**Test plan:**
- Seed a cycle with `equipmentGroupVersionPin = 1`, edit the group to v2, GET `/current-state`, assert response carries v1 ranges (not v2).
- Set `equipmentGroupVersionPin = NULL`, GET `/current-state`, assert response carries live group (legacy fallback).
- Set `equipmentGroupVersionPin = 99` (nonexistent snapshot) on a v1 live row, assert the lazy first-version fallback fires correctly.

**Effort:** ~half day including curl tests + doc sync. **Tablet/APK touch: NONE.** The APK consumes the same `{operatingMin, operatingMax, leastCount, uom, id}` field shape from the snapshot as it does from the live row — no rebuild required.

---

### L2 — Same pinned-snapshot read for the `getCurrentState()` `cleaningProfileGraph` field ✅ DONE (commit `63101d5`, 2026-05-02)

**What:** `getCurrentState()` returns `pipelineGraph` and `pipelineStages` derived from `getProfilePipeline(resolvedProfileId, false)` (line 403). `resolvedProfileId` is sourced from `resolveFilterProfile(filter)` — the live filter profile binding, not the cycle's pinned `profileId`.

**Effect:** Operator's UI shows the live cleaning-pipeline graph for the cycle's filter, not the graph the cycle was actually started against. This is currently mitigated by `profileSyncWarning` (line 553-577) which detects mismatch and recommends `TERMINATE_AND_RESTART`, but the actual rendered pipeline is still the live one. Operator sees a stage layout that doesn't match the cycle's pin.

**Touchpoint:** `filter-operations.service.ts:403` — call `getProfilePipeline(currentCycle.profileId, false)` instead when `currentCycle` exists (pinned), falling back to the live `resolvedProfileId` only when no cycle is active.

**Why this matters online:** if an admin updates a cleaning profile mid-cycle (creates v2, archiving v1), the cycle is correctly pinned to v1 (rowful immutability A.2), `advance()` correctly enforces v1's transitions, but the operator's tablet display shows v2's stage layout. Visual mismatch with no functional consequence — `advance()` still rejects bad transitions — but operator confusion.

**Effort:** ~half day. Server-only.

**Closed by:** commit `63101d5` (`getProfilePipeline()` now reads from `currentCycle.profileId` when a cycle is active; legacy live binding is preserved for the pre-cycle preview path). Regression coverage added in B7.3.

---

### L3 — `profileSyncWarning` should also surface for in-flight `EquipmentGroupVersion` divergence ✅ DONE (commit `d7026ce`, 2026-05-02; FE rendering closed by B7.4 commit `1d6ec6b`)

**What:** `profileSyncWarning` (line 553-577) detects FilterCleaningProfile drift against the cycle's pin. There's no equivalent for EquipmentGroup. After L1 lands, the tablet sees pinned ranges in the UI; after admin edits, the operator has no signal that the rules they're working under aren't the latest.

**Why low priority:** L1 alone delivers correct enforcement. This is purely advisory ("admin updated the equipment group; you're still on v1") — useful for transparency but not for correctness.

**Touchpoint:** `filter-operations.service.ts:553-577` — extend the warning block to also compare `cycle.equipmentGroupVersionPin` against the live group's version, emit a sibling warning if they differ.

**Effort:** ~2 hours. Server-only.

**Closed by:** server-side `equipmentGroupSyncWarning` field in commit `d7026ce` (sibling to `profileSyncWarning`); FE rendering of the amber advisory delivered in B7.4 (commit `1d6ec6b`, mobile + desktop). Deferred follow-up — `DryingFiltersPanel`'s 15s SWR poller does not surface the advisory; tracked under "Deferred follow-ups" below.

---

### L4 — Audit `advance()`'s reading-validation lazy-first-version path ✅ DONE — NO CODE CHANGE (commit `a42fa54`, 2026-05-02)

**What:** `advance()` at line 1101+ reads `EquipmentGroupVersion.findUnique` for the cycle's pin. If the row doesn't exist (lazy first-version), it falls back to live row + asserts `live.version === pin`. Concern: `instruments[].id` differs between snapshot.instruments (snapshot json) and live `equipmentGroupInstrument` rows. Field shape is the same but the snapshot stores the instrument's row ID at the time of snapshot — if admin replaces an instrument between cycle start and this read, the live instrument list could have new IDs. The `inst.id` referenced in submitted `instrumentReadings` is the operator's tablet-cached id; if it doesn't match the snapshot's id, the lookup `instrumentReadings[inst.id]` fails.

**Real-world likelihood:** very low — admin would have to fully replace an instrument (delete + create new) mid-cycle. Hard to do via the existing `equipment-groups.service.ts` `update()` path because it only mutates fields, not row identity.

**Touchpoint:** `filter-operations.service.ts:1101-1175`. Defense-in-depth review of the snapshot-vs-live equality assertion.

**Effort:** ~1 hour read + 1 hour test. Server-only.

**Closed by:** doc-only audit commit `a42fa54`. Finding: instrument IDs are stable across edits (`equipment-groups.service.ts:163-178` mutates by id; no replace path), so `instrumentReadings[inst.id]` lookups stay correct under the snapshot/live/legacy branches. Full audit reasoning preserved in CHANGELOG entry "L4: advance() reading-validation snapshot/live equality audit — NO CHANGE".

---

### L5 — Browser smoke test of the new Version History page on a live cycle (NICE-TO-HAVE)

**What:** Build, tsc, and unit tests are clean. Never opened the page in a browser with seeded data. Covers visual layout, sidebar render gating, deep-link query parameter behavior, snapshot modal scrolling.

**Effort:** ~30 min once data is seeded.

**Touchpoint:** none (verification only).

---

### L6 — `apps/web` Vitest setup ✅ DONE (B7.1, 2026-05-02)

**What:** No FE test config existed. Diff engine in `version-history/index.tsx` had zero coverage.

**Status:** Closed by B7.1 on `feature/phase5-verification`.

**Delivered:**
- `apps/web/vitest.config.ts` — fresh config (NOT derived from `vite.config.ts`); jsdom env, `@vitejs/plugin-react`, `@` alias.
- `apps/web/src/test-setup.ts` — `@testing-library/jest-dom/vitest` matcher registration.
- `apps/web/package.json` — `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom` devDeps + `test` / `test:watch` scripts.
- `apps/web/src/routes/version-history/__tests__/diff.test.ts` — 10 tests covering scalar change, keyed-array add/remove/recursive change, set-style add/remove, meta-field filtering, no-change deep-equal, plus checklist-profile + equipment-group cross-kind cases.
- `routes/version-history/index.tsx` — minimal export of `diffSnapshots`, `DiffChange`, `EntityKind` so the test can import without restructuring.
- `vitest.workspace.ts` — added `apps/web/vitest.config.ts` to the workspace list (touchpoint not in the original spec; flagged in commit body).

**Verification:** `cd apps/web && npx vitest run` → 10 / 10 passing. `npx tsc --noEmit` exit 0. No runtime change to the Version History page.

---

## Order of execution (recommended)

1. **L1** — fixes the only actively biting online drift; ~half day; no APK touch. ✅ DONE (`dbce282`).
2. **L2** — fixes pipeline-graph display drift; same touchpoint area as L1. ✅ DONE (`63101d5`).
3. **L5** — quick browser smoke once L1+L2 land. (still nice-to-have; never run in this batch — flagged in B7 resume note.)
4. **L3** — UX polish; can ship anytime. ✅ DONE server (`d7026ce`) + FE (`1d6ec6b`).
5. **L4** — defense-in-depth review. ✅ DONE — NO CODE CHANGE (`a42fa54`).
6. **L6** — ✅ DONE (B7.1, `1ab2a05`).

## Status snapshot — as of B7.5 (2026-05-02)

| Item | Status | Closing commit |
|---|---|---|
| L1 | DONE | `dbce282` |
| L2 | DONE | `63101d5` |
| L3 | DONE (server + FE) | `d7026ce` + `1d6ec6b` |
| L4 | DONE — NO CHANGE | `a42fa54` |
| L5 | OPEN — manual smoke deferred (no live data) | — |
| L6 | DONE | `1ab2a05` (B7.1) |
| B7.2 follow-up | DONE | `7a2f3b4` |
| B7.3 follow-up | DONE | `0b2821f` |

## Deferred follow-ups (out of scope for Batch 7 close)

- **B7.2 reviewer M1 — pre-existing `advanceBatch:422` closure-stale guard** in `apps/web/src/routes/filter-management/filter-operations.tsx`. The structural pattern was fixed inside the equipment-dialog batch + new PM auto-start loops in B7.2 (local `blockChangePopped` flag), but the original `advanceBatch` site still uses the older `if (!blockChangeDialog)` closure-captured guard. Cosmetically identical risk profile; not a regression introduced by Batch 7. Track as cleanup.
- **B7.4 reviewer Issue #2 — `DryingFiltersPanel` 15s SWR poller does not surface `equipmentGroupSyncWarning`**. The panel polls `/current-state` every 15s for in-progress DRY_IN cycles but only consumes the dryer-countdown shape, not the new advisory field. Operator parked on the DRY_IN screen would not see the advisory until the next scan. Documented in B7.4's CHANGELOG entry; defer until either CHVH-style chip rendering or a wider DRY_IN panel refactor.

## What NOT to start (per user direction)

- O1-O5 from `future/offline-version-sync-contract.md` § "Addendum" — all tablet/APK-related.
- Slice B as a whole — tablet contract change.
- Step 8 / Step 9 — APK rebuild + tablet rewrite.

---

Recorded 2026-05-02. Read this with `future/offline-version-sync-contract.md` § "Addendum" — together they partition the work cleanly into "server / online" (this doc) vs "tablet / offline" (the addendum).
