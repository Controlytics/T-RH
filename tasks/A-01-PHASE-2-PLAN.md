# A-01 Phase 2 — Backend Write-Path Cutover (Execution Plan)

**Status:** Drafted 2026-05-29. Awaiting D-decisions (see `A-01-D-DECISIONS.md`) before execution.
**Goal:** Migrate the 107 `prisma.assetInstance.*` call sites across 39 files from the legacy `asset_instances` table to the typed `blocks`/`areas`/`ahus`/`filters` tables.
**Estimated effort:** 4–6 focused engineer-days. Not safe to compress into one session.

> **All counts verified live against branch `RFID` 2026-05-29** via `grep -cE "prisma\.assetInstance\." apps/api/src/**`. Re-verify before each batch — counts drift as fixes land.

---

## Why this can't be done in one session

Backend write-path migration is qualitatively different from the read-path migration (Phase 3) that succeeded today:

| | Phase 3 — Read migration | Phase 2 — Write migration |
|---|---|---|
| Risk on failure | Stale data shown to operator | Data inconsistency between legacy + typed tables; audit chain disruption |
| Reversibility | Trivial — revert frontend URL | Hard — each write site that flips needs the reverse mirror to keep legacy populated, or the legacy table goes stale |
| Testability | Browse UI for 30 seconds | Need to exercise the actual mutation paths (cycle start, filter create, retire, replace, bulk upload) with real DB rows |
| Concurrency | None — read SWR | Concurrent operators hitting the same FilterDetails row mid-migration could see split-brain |

Doing 107 sites in a parallel sprint = guaranteed split-brain on a 21 CFR Part 11 audit chain. **Bad idea.**

---

## Strategy — Reverse-Mirror

Already drafted in `A-01-ASSET-CUTOVER-PLAN.md` §4 Phase 2:

> *(preferred) Reverse the mirror. New writes go to `prisma.block/area/ahu/filter.*`; a reverse trigger keeps `asset_instances` in sync during transition so un-migrated read sites don't break.*

**Sequence:**
1. Write the reverse-mirror trigger (`fn_mirror_typed_to_asset_instance`) — fires on INSERT/UPDATE/DELETE of `blocks`/`areas`/`ahus`/`filters`, syncs to `asset_instances`. Identity preserved by UUID reuse.
2. Disable the forward mirror (`fn_mirror_asset_instance`) — it would loop with the new reverse one. Document the swap.
3. Migrate 107 call sites batch-by-batch (see batching below). After each batch: integration-test the affected write paths.
4. Once all 107 sites migrated, drop the reverse mirror. `asset_instances` is now read-only.
5. Phase 5 (legacy drop) can then proceed.

**Fallback:** If the reverse trigger proves fragile (Postgres trigger ordering across cascade FKs), fall back to dual-write in app code via a small `writeAssetMirror()` helper called after every typed-table mutation.

---

## Call-site inventory (live grep, 2026-05-29)

107 occurrences across 39 files. Grouped by module + risk:

### Tier 1 — Foundational (do FIRST, gates everything below)

| File | Sites | Concern |
|---|---|---|
| `apps/api/src/modules/assets/repositories/instance.repository.ts` | 10 | The canonical CRUD wrapper. Every other module that creates/updates an asset goes through here. Migrate to typed-table-aware repository. |
| `apps/api/src/modules/assets/services/instance.service.ts` | 2 | Service layer over repository. Thin once repository is migrated. |
| `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts` | 3 | The just-shipped pre-existing user feature. Coordination required with whoever owns that change. |
| `apps/api/src/modules/assets/repositories/relationship.repository.ts` | 2 | Asset relationships. Re-anchor or drop per D5. |
| `apps/api/src/modules/assets/helpers/descendant-collector.ts` | 1 | Helper used by delete-cascade. Replace with typed-table parent-FK walk. |
| `apps/api/src/modules/assets/helpers/cycle-detection.ts` | 1 | Helper used by relationship validation. |
| `apps/api/src/lib/filter-details.ts` | 1 | FilterDetails sidecar wrapper. Stays — FilterDetails table itself isn't a legacy concept. |

**Subtotal: 7 files, 20 sites. ~1 day.**

### Tier 2 — Cycle / Filter Operations (HIGHEST risk: operator-facing cycle workflow)

| File | Sites | Concern |
|---|---|---|
| `apps/api/src/modules/filter-operations/filter-resolver.ts` | 5 | Resolves filter → cleaning profile. Already partially typed-aware (FilterDetails). Migrate AssetInstance lookups to `prisma.filter`. |
| `apps/api/src/modules/filter-operations/filter-operations.service.ts` | 9 | Orchestrator for cycle ops. |
| `apps/api/src/modules/filter-operations/current-state.ts` | 2 | Operator's tablet-side state read. |
| `apps/api/src/modules/filter-operations/local-context.ts` | 1 | Shared context loader. |

**Subtotal: 4 files, 17 sites. ~1 day. Requires careful end-to-end test on the tablet workflow before commit.**

### Tier 3 — PM / Equipment / Connectivity / UNS

| File | Sites | Concern |
|---|---|---|
| `apps/api/src/modules/pm-schedules/pm-ahu-config.ts` | 4 | PM scheduling per-AHU. |
| `apps/api/src/modules/pm-schedules/pm-due-tasks.ts` | 2 | PM due-task computation. |
| `apps/api/src/modules/pm-schedules/pm-approval.ts` | 1 | PM approval workflow. |
| `apps/api/src/modules/pm-schedules/pm-import.ts` | 1 | PM CSV import. |
| `apps/api/src/modules/equipment-groups/equipment-groups.service.ts` | 1 | EG service. After D3 (re-FK), simplifies. |
| `apps/api/src/modules/connectivity/routes.ts` | 4 | Connectivity status by entity. After D5 (drop), this module may itself disappear. |
| `apps/api/src/modules/uns/uns.service.ts` | 12 | UNS path manipulation. **Highest single-file count.** Each site walks the asset tree to build/resolve UNS paths. |
| `apps/api/src/modules/uns/uns-path-builder.ts` | 2 | UNS path builder helper. |
| `apps/api/src/modules/uns/routes.ts` | 3 | UNS route handlers. |
| `apps/api/src/modules/sync/sync.service.ts` | 1 | Sync layer. |

**Subtotal: 10 files, 31 sites. ~1.5 days.**

### Tier 4 — Reports / Audit / Dashboards / Admin

| File | Sites | Concern |
|---|---|---|
| `apps/api/src/modules/super-admin/routes.ts` | 10 | Super-admin tools (list/inspect/delete). |
| `apps/api/src/modules/audit/routes.ts` | 2 | Audit list. After D4(i) resolver fix, may need no further change. |
| `apps/api/src/modules/reports/service.ts` | 1 | Report generation. |
| `apps/api/src/modules/reports/data-sources/attribute-source.ts` | 1 | Report attribute resolver. **D2-gated** — replacement for attributeSchema. |
| `apps/api/src/modules/dashboards/routes.ts` | 1 | Dashboard. After D5 drops dashboards (per existing PENDING-FIXES M-01), may disappear. |
| `apps/api/src/modules/qr-code/routes.ts` | 1 | QR code lookups. |

**Subtotal: 6 files, 16 sites. ~1 day.**

### Tier 5 — Transport / Ingestion (D5-gated)

After D5 drops empty telemetry tables, most of this tier disappears.

| File | Sites | Concern |
|---|---|---|
| `apps/api/src/transport/mqtt-handler.ts` | 2 | MQTT message → entity resolver. **D5: if telemetry drops, this whole transport disappears.** |
| `apps/api/src/transport/mqtt-auth-routes.ts` | 1 | MQTT auth callback. Same. |
| `apps/api/src/transport/mosquitto-refresh-routes.ts` | 1 | Mosquitto ACL refresh. Same. |
| `apps/api/src/transport/ws-handler.ts` | 1 | WebSocket entity resolution. |
| `apps/api/src/modules/data-ingestion/entity-resolver.ts` | 1 | Ingest path entity resolver. |
| `apps/api/src/modules/data-ingestion/routes.ts` | 2 | Ingest routes. |
| `apps/api/src/modules/data-ingestion/ingestion.repository.ts` | 2 | Ingest repo. |
| `apps/api/src/modules/data-ingestion/connectivity-tracker.ts` | 4 | Connectivity tracker. |
| `apps/api/src/modules/data-ingestion/rpc-handler.ts` | 1 | RPC handler. |

**Subtotal: 9 files, 15 sites. If D5=A, drop entirely (zero migration needed). If D5=B, ~1 day to reanchor.**

### Tier 6 — Tests (migrate last)

`apps/api/src/e2e/*.test.ts` + `apps/api/src/transport/__tests__/*.test.ts` + `tests/integration/*` collectively have ~8 sites. They reference `prisma.assetInstance.*` for test fixtures. Migrate to typed tables after the production code lands.

---

## Per-call-site pattern

For each `prisma.assetInstance.*` call:

| Legacy | Typed-table replacement |
|---|---|
| `prisma.assetInstance.findUnique({ where: { id } })` | Walk all four typed tables: try `prisma.filter.findUnique`, then `ahu`, `area`, `block`. Or, if the call site knows the kind upfront, single direct call. |
| `prisma.assetInstance.findMany({ where: { template: { templateKind: 'AHU' } } })` | `prisma.ahu.findMany()` — direct, no template join |
| `prisma.assetInstance.findFirst({ where: { unsPath } })` | All four typed tables have `unsPath`; query each + return first. Or, push UNS lookup into a single helper `findByUnsPath()` that searches all four. |
| `prisma.assetInstance.create({ data })` | Determine kind from `data.templateId` → call `prisma.<kind>.create({ data })` |
| `prisma.assetInstance.update({ where: { id }, data })` | Same kind-dispatch |
| `prisma.assetInstance.delete({ where: { id } })` | Same |
| `prisma.assetInstance.findMany({ where: { parentId } })` | `prisma.<child-kind>.findMany({ where: { <parent-fk>: parentId } })` — using typed FKs `block_id` / `area_id` / `ahu_id` |

A small **kind-dispatch helper** in `apps/api/src/lib/typed-asset-dispatch.ts` would centralise this — every modules calls `await findById(id)` instead of trying each typed table.

---

## Execution order (per session)

1. **Session A (~1 day):** Tier 1 (foundational repositories) + write the typed-asset-dispatch helper. Then deploy the reverse-mirror trigger. After this session, every call site has a clean migration target.
2. **Session B (~1 day):** Tier 2 (cycle / filter operations). Highest risk — needs a full tablet smoke test after each commit. Pause for verification between commits.
3. **Session C (~1.5 days):** Tier 3 (PM / Equipment / UNS / Sync). Each module is independent — can dispatch in parallel subagents.
4. **Session D (~1 day):** Tier 4 (Reports / Audit / Dashboards / Admin). D2-blocked for the attribute-source piece — defer that one until D2 is decided.
5. **Session E (variable):** Tier 5 — if D5=A (drop telemetry tables), skip entirely. If D5=B, ~1 day to reanchor.
6. **Session F (~0.5 day):** Tier 6 (tests). Update fixtures + verify.
7. **Session G (~0.5 day):** Drop the reverse mirror. `asset_instances` now read-only. Wave 6 (Phase 5) gated only on D1/D2/D4(ii).

**Realistic total: 5–6 dedicated engineer-days.** That's the same estimate as in `A-01-ASSET-CUTOVER-PLAN.md` §7, now broken down by tier.

---

## Verification gates per session

- After Tier 1: `npm test` in `apps/api` — typed-asset-dispatch helper has unit-tests; nothing else regressed.
- After Tier 2: manual operator-flow on tablet — start cycle → advance through all stages → terminate. Check audit_trail hash chain still verifies.
- After Tier 3: PM auto-schedule trigger; bulk-upload a PM CSV.
- After Tier 4: super-admin tool inspection of a few rows.
- After Tier 5: skip (D5=A) or telemetry ingest test (D5=B).
- After Tier 6: `apps/api` full vitest run — 1080+ tests should still pass.
- After Tier 7 (mirror drop): manual smoke on tablet + chain hash verify on 100 random audit rows.

---

## Rollback per tier

Each tier is its own set of commits. To rollback Tier N: `git revert` those commits, the reverse mirror keeps `asset_instances` populated, so reverted sites continue to work. Only Tier 7 (mirror drop) is point-of-no-return.

---

## Why a single session can't deliver this

- Tier 2 alone is 17 sites in operator-critical cycle code. Each site needs end-to-end verification against the audit chain.
- Concurrent-cycle race tests (which we verified earlier this session — `superpowers:concurrent-cycle race source review` → TRANSACTION-SAFE) only protect AGAINST OTHER OPERATORS, not against a half-migrated write path. Mid-migration, a write to legacy + a write to typed could split-brain a cycle.
- Tablet QA (mobile-operations.tsx) needs a real device — the only way to know the migration didn't break operator workflow.

**Honest scope: this is a discrete week of work that should be planned as its own engagement.**
