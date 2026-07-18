# Consolidated code review — 2026-05-04

Six adversarial reviewers, 2261 lines of findings, ~26 Critical / ~46 High / ~30 Medium / ~24 Low / ~25 Design challenges across the codebase. Two independent reviewers converged on the worst-impact bug.

## Per-domain reports

| Domain | File | C / H / M / L / D |
|---|---|---|
| API core (auth/filter-ops/assets/checklist/pm/admin-requests) | [api-core.md](CODE-REVIEW-2026-05-04-api-core.md) | 3 / 6 / 8 / 6 / 7 |
| API supporting (config/reports/sync/ingestion/reauth/lib) | [api-supporting.md](CODE-REVIEW-2026-05-04-api-supporting.md) | 5 / 11 / 11 / 9 / 5 |
| Web routes (~85 pages) | [web-routes.md](CODE-REVIEW-2026-05-04-web-routes.md) | ~6 / ~8 / — / — / — |
| Web plumbing (lib/hooks/components/sw) | [web-plumbing.md](CODE-REVIEW-2026-05-04-web-plumbing.md) | 3 / ~8 / — / — / — |
| Shared (perms/privileges/reauth/sidebar) | [shared.md](CODE-REVIEW-2026-05-04-shared.md) | 4 / ~6 / — / — / — |
| Data layer (db/queue/prisma/migrations) | [data-queue.md](CODE-REVIEW-2026-05-04-data-queue.md) | 3 / 4 / — / — / — |

## The big finding — convergent across two independent reviewers

**[CRIT-CONVERGED] `x-offline-replay: true` header is an unauthenticated, blanket reauth bypass.**

- Source: `apps/api/src/lib/reauth-check.ts:101`
- Flagged independently by **api-core** (C1) and **api-supporting** (C1) reviewers
- Any authenticated client (or anyone with a stolen JWT) sets a single header and skips ALL reauth gates: `RETIRE_FILTER`, `REPLACE_FILTER`, `BULK_UPLOAD_FILTERS`, `BYPASS_FILTER_STAGE`, `APPROVE_ADMIN_REQUEST`, `UPDATE_PROFILE`, `UPDATE_FILTER_LIFECYCLE`
- **Silently negates every recent reauth-hardening fix** (H1, C2, M1, M2 from the prior 2026-05-04 audit)
- The 21 CFR Part 11 attestation is meaningless while this header stands
- **Fix:** HMAC-signed replay token, session-bound MAC, or at minimum a route allowlist for the bypass

## 21 CFR Part 11 compliance crisis (theme)

The reauth + audit story has **multiple independent failures** that compound:

| # | File | Finding | Impact |
|---|---|---|---|
| 1 | `lib/reauth-check.ts:101` | Header bypass (above) | Total reauth defeat |
| 2 | (server) | Unbounded `offlinePerformedAt` | User can back-date forged records |
| 3 | (audit module) | No tamper-evident hash-chain | Forged backdated rows undetectable |
| 4 | `web/routes/approvals`, `mobile/mobile-wrapper`, `config/equipment-groups`, `rule-chains/editor`, **`config/action-reauth.tsx:255`** | 6 FE sites skip `reauth.execute()` | Reauth-config-save itself bypasses reauth — privilege escalation |
| 5 | `apps/api/src/modules/filter-operations/routes.ts:307,458` | **No FE caller for `/bypass` or `/terminate-cycle`** | Operators **cannot record cleaning-cycle deviations** as § 11.10(k) requires |
| 6 | `packages/shared/src/types/feature-privileges.ts:127,279` | `'admin_requests.view'` → `['USER_CREATE']` | Anyone given "view admin requests" can create users |
| 7 | `notification-delivery/routes.ts` | `enforceReauth('UPDATE_EMAIL_CONFIG'/'UPDATE_SMS_CONFIG')` | Both action keys **don't exist** in `REAUTH_ACTIONS` — step-up auth silently disabled |
| 8 | `apps/api/src/modules/roles/role.service.ts` | `PERMISSION_META` missing 15 perms (5 FILTER_*, 9 REPORT_*, VERSION_HISTORY_VIEW) | Role-edit UI shows them as "Other" with raw key — operators can't grant safely |
| 9 | (backup module) | Restore silently rewrites audit trail | Backup not replay-protected — anyone with restore can rewrite history |

Together, items 1–3 mean **any authenticated user can forge audit records with arbitrary timestamps and the system has no way to detect it.** This contradicts the "21 CFR Part 11 compliance" marketing posture at the system architecture level.

## Race conditions

| File | Finding |
|---|---|
| `start-cycle.ts:107-176` | Claimed in-tx race protection uses `findUnique`, NOT `FOR UPDATE`. Two concurrent startCycle calls can both succeed. (advance/bypass/terminate use `lockAndVerifyFilterState` correctly — only start is broken.) |
| `submit-checklist.ts:160` | `equals: currentState ?? undefined` — Prisma drops the path filter when `currentState === null`, producing false-positive 409 ALREADY_SUBMITTED. Operators get locked out of cycles. |

## Data layer integrity

| # | Finding | Impact |
|---|---|---|
| C1 | Drift migration `20260503162127_capture_schema_vs_db_drift` drops `asset_instances` cols + adds `lineage_id NOT NULL` with no backfill | **Silent unrecoverable data loss** on populated DB without the manual `prisma migrate resolve --applied` workaround already documented in DEPLOY-WINDOWS.md § 10.1 |
| C2 | One-IN_PROGRESS-per-filter index + 2 triggers live in `seed.ts`, not migrations | A `prisma migrate deploy`-only production cutover ships **without 21 CFR Part 11 invariant enforcement** |
| C3 | ~140 of ~176 UUID columns lack `@relation` → bare-string FKs across `CleaningCycle.filterId`, `FilterEvent.*`, `Alarm.entityId`, `LatestTelemetry.entityId`, `UnsMapping.entityId`, `BlockChangeRequest.*` | Enables the documented `cwhf0500-01` orphan-UnsMapping bug class |

## Offline / Capacitor / sync

| # | File | Finding |
|---|---|---|
| C1 | `offline-sync-service.ts` | Catches exceptions on 5 sync steps, **then advances `currentStep++` anyway** and reports "All data synced". Operators get green check while master-data caches are stale |
| C2 | `offline-store.ts:270` | Uses raw `navigator.onLine` — defeats the Capacitor connectivity engine on Android WebViews |
| C3 | `sync-since.ts:217,222` | Same bug — raw `navigator.onLine` for cache eviction + 60s polling |
| H | `use-auth.ts` (30-min refresh interval) | Bypasses `apiClient`, hits the WebView origin → **silent no-op on tablet APK**. Three independent JWT refresh sites; only `sync-engine.ts:206` actually works on tablet |
| H | `vite.config.ts` PWA `autoUpdate` | No `skipWaiting`/reload-prompt → operators submit stale contracts to upgraded server after a deploy |
| H | `connectivity.ts:84` catch-all | Swallows non-load Capacitor errors → silent degrade to `navigator.onLine` if native bridge breaks |

## Decision-tape engine soundness

The decision-tape architecture is **fundamentally sound** (server tape → local executor → empty fallback), but has two staleness/integer issues:

- **[H8a]** `assertTapeVersionFresh` returns `ok` when `tapeVersion === null` — pre-Wave-2 tablets with null tapeVersion bypass the freshness check
- **[H8b]** `tapeVersion` is an integer that aliases past 1e6 events per cycle — long-running cycles eventually wrap

## Documentation drift (CLAUDE.md doc-sync rule violations)

CLAUDE.md "System Stats" claims **must be re-verified**. Live-code reality (verified by reviewers via grep):

| Stat | CLAUDE.md says | Actual | Drift |
|---|---|---|---|
| Permission constants | 109 | **106** | -3 |
| Feature privileges | 91 | **90** | -1 |
| Reauth actions | 81 | **87** | +6 (this session added them but doc not updated) |
| Sidebar items | 26 | **26** ✓ | OK |
| **SIDEBAR_PRIVILEGE_MAP entries** | (implicit 26) | **27** | +1 stale |
| Prisma models | 64 | **69** | +5 |
| Enums | 22 | **23** | +1 |
| TimescaleDB hypertables | 7 | **6** | -1 |
| Queues | 5 (BullMQ) | **3 (graphile-worker)** | Phase 2 left two queue counts wrong |

The doc-sync rule we adopted on 2026-04-29 was already broken by 2026-05-04. Either the rule is too strict for the work pace or the verification step was skipped during recent commits.

## Operational / supporting

| Finding | Impact |
|---|---|
| Reports leak via unauthorized `entitySlots` + `report.id` lookup (C4/C5) | Cross-tenant data leak in PDF render |
| Backup OOMs at 100MB upload; trusts attacker-supplied metadata (H3/H4/H5) | DoS + privilege escalation |
| Puppeteer browser singleton + orphan-PDF lifecycle (H6/H7) | Operational footguns under load |
| Idempotency JSON-path scan unindexed + not cycle-scoped at start-cycle (H1/H2) | Replay attack surface |
| Config auto-discovery silently drops 3 real defs (H9) | Whole config surfaces missing without warning |
| Legacy-shape reauth normalize warns nothing (H10) | Misformed config undetected |
| Per-request RBAC = 4 sequential DB queries before every handler (M11) | Latency on every API call |
| `QUEUES.*.defaultJobOptions.{backoff,removeOnComplete,removeOnFail}` (queue H1) | Dead BullMQ leftovers — graphile-worker silently ignores them |
| `* * * * * dlq_check` + `connectivity_check` cron (queue H2) | No overlap protection — feedback loop on slow handler |
| O(n²) `unshift`-loop requeue in telemetry-batcher (queue H3) | Stalls under sustained TSDB outage |
| Dropped telemetry rows get `console.warn` only — no DLQ row, no counter, no alarm (queue H4) | **Undocumented 21 CFR Part 11 compliance loss on backpressure** |

## Architecture / design challenges (worth deciding on, not bugs)

- D1: Server-side decision-tape engine should emit a `degraded` signal when forced to fall back, not silently succeed
- D2: Build-time test asserting every `REAUTH_ACTION` key has at least one call site (currently shipped 6 dead reauth declarations)
- D3: Centralize JWT refresh via `apiClient.refreshToken()` with in-flight Promise guard
- D4: Replace tablet/web duplicate handlers with shared hooks (`useBlockChangeApproval()`)
- D5: Build-time test asserting `FEATURE_TO_PERMISSION_MAP` FE→BE pairs both exist
- Cycle-write decomposition + shared pure-guard executor judged sound — the issues are gaps, not the design

## Recommended fix order

### P0 — fix before next deploy (compliance + data integrity)

1. **Remove `x-offline-replay: true` header bypass** OR replace with HMAC-signed replay token (api-core C1, api-supporting C1)
2. **Server-side timestamp policy** — server clock for `performedAt`, accept client `clientTime` only as advisory metadata (api-supporting C2)
3. **Remove `admin_requests.view` → `['USER_CREATE']` mapping** (shared C4)
4. **Fix the 6 FE sites that skip `reauth.execute()`** (web-routes C1) — esp. `config/action-reauth.tsx:255` (the reauth-config save itself)
5. **Add UI for `/bypass` and `/terminate-cycle`** (web-routes C2) — § 11.10(k) compliance
6. **Move compliance invariants from `seed.ts` to migrations** (data-layer C2)
7. **Document drift migration recovery in DEPLOY-WINDOWS.md** (data-layer C1) — already done, but verify operators have run it before any future `migrate deploy`
8. **Fix `start-cycle` to use `lockAndVerifyFilterState`** (api-core C2)
9. **Fix submit-checklist null-state false 409** (api-core C3)

### P1 — fix this sprint

- Fix offline-sync-service silent partial-success (web-plumbing C1)
- Replace remaining `navigator.onLine` with connectivity engine (web-plumbing C2/C3)
- Add `enforceReauth` for the 8 sensitive-config surfaces (web-routes H)
- Fix `enforceReauth('UPDATE_EMAIL_CONFIG'/'UPDATE_SMS_CONFIG')` — declare actions or remove calls (shared C3)
- Add 15 missing `PERMISSION_META` entries (shared C2)
- Remove stale `organizations` SIDEBAR_PRIVILEGE_MAP entry (shared C1)
- Add audit hash-chain (api-supporting C3)
- Centralize JWT refresh (web-plumbing H)
- Add PWA `skipWaiting` + reload-prompt (web-plumbing H)

### P2 — technical debt this quarter

- ~140 bare-string FKs → add `@relation` (data-layer C3)
- Reports authz layer (api-supporting C4/C5)
- Backup hardening (api-supporting H3/H4/H5)
- Tablet/web hook extraction (web-routes H, web-plumbing H)
- Build-time tests (D1/D2/D5)
- Update CLAUDE.md System Stats to reality + investigate why doc-sync rule failed

### P3 — design decisions

- Decision-tape `tapeVersion` integer overflow — switch to bigint or design TTL (api-supporting H8b)
- Per-request RBAC caching strategy (api-supporting M11)
- Telemetry batcher DLQ + alerting on backpressure drop (queue H4)

## What this review did NOT cover

- Mosquitto broker config / dynsec ACLs (Phase 1)
- Multipart plugin / error plugin (carved out of api-supporting scope)
- Decision-tape engine code itself if it lives outside the listed lib/ paths
- APK Java/Kotlin code in `apps/android/` and `rfid_scan_app/`
- TimescaleDB query plans / index health
- E2E tests, vitest configuration, mocks
- Performance profiling
- Bundle size / Lighthouse / accessibility
- Visual / UX review
