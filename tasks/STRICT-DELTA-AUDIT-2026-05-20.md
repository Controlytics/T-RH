# DigiLog — Strict Delta Audit (2026-05-20)

**Scope:** delta layer on top of `tasks/STRICT-AUDIT-2026-05-16.md` (76 findings, 4 days prior). 5 parallel specialist agents (Security, Backend/Runtime, Frontend, DB/Migrations, Removal-Cleanliness) against the codebase at HEAD = `c4fc1c8` + uncommitted working tree.

**Branch:** `RFID` (single-tenant DigiLog). **Method:** static analysis, no runtime instrumentation. Each agent explicitly instructed NOT to re-find May 16 issues — only status-check those, and surface NEW findings from the past 4 days of work (Day 3-5 dialog-state refactor, 2026-05-17 Phase-6 rule-chain/alarm tear-out, 2026-05-17 typed-hierarchy migration, 2026-05-18 7-issue offline fix bundle, uncommitted temp-password + dryer-anchor fixes).

---

## 0. Executive summary — scope reconciliation

Two parts of the requested scope conflict with codebase reality:

1. **Asset / AssetInstance / AssetTemplate / Entity / EntityTemplate removal is structurally impossible.** Filters *are* `AssetInstance` rows distinguished by `AssetTemplate.kind`; the Block → Area → AHU → Filter hierarchy is implemented as `AssetInstance.parentId` chains. Full programme cost in `tasks/ENTITY-REMOVAL-IMPACT-ANALYSIS.md` (307 lines, 6-12 months, breaks 21 CFR Part 11). The 2026-05-17 typed-hierarchy migration added `Block`/`Area`/`AHU`/`Filter` *sidecar* tables that FK back to `AssetInstance.id` — they extend the model, they don't replace it. **No findings are produced on the premise that these can vanish.**

2. **Alarms + rule-chains are already removed** (Phase 6, 2026-05-17, plan at `tasks/REMOVE-RULECHAIN-ALARM-PLAN.md`, git tag `pre-rulechain-alarm-drop`). Verified clean below.

The actual delta over 4 days: **1 new HIGH** (auth-cache invalidation gap on admin-force-reset), **3 new MED** (SWR error suppression over-broad, uncommitted working tree, doc count drift), **2 new LOW** (4 unused enum values, stale dist artifacts). **6 of 11 May 16 CRITs remain open and have not regressed.** **5 of 11 May 16 CRITs have shipped fixes** (§1.1 transaction boundary, §1.7 auth caching, §1.8 unbounded list limits, §1.10 cycleId-scoped idempotency, §1.11 backup credential stripping).

**The Phase 6 tear-out is structurally sound.** Two unused enum values and dist/ artifacts are the only residue.

---

## 1. CRITICAL — carried over from 2026-05-16, all STILL OPEN

These are NOT new findings; they are status confirmations. Full evidence in `STRICT-AUDIT-2026-05-16.md` §1.

| # | Title | File:Line | Status 2026-05-20 |
|---|---|---|---|
| C1 | §1.2 Audit DELETE creates permanent chain gap (no re-link) | `audit/routes.ts:266-269, 323-327` | **STILL OPEN** — unchanged |
| C2 | §1.3 SUPER_ADMIN audit-trail PUT/DELETE w/o reauth + no audit-of-the-audit | `super-admin/routes.ts:352-371` | **STILL OPEN** — unchanged |
| C3 | §1.4 WS SUBSCRIBE has no per-entity authz (telemetry broadcast leak) | `transport/ws-handler.ts:210-225` | **STILL OPEN** — unchanged |
| C4 | §1.5 Drift migration drops cols w/o idempotent backfill | `prisma/migrations/20260503162127_capture_schema_vs_db_drift/migration.sql:14-22, 107-112, 146` | **STILL OPEN** — destructive blocks not gated by `IF EXISTS` |
| C5 | §1.6 `audit_trail.userId` nullable; no CHECK constraint | `schema.prisma:270`, `lib/audit.ts:6` | **STILL OPEN** — unchanged |
| C6 | §1.9 Backup loads entire DB into memory; no streaming | `backup/backup.service.ts:296-510` | **STILL OPEN** — unchanged |

**5 CRITs CLOSED since May 16** (verified during delta backend audit):

| # | Title | Closed by |
|---|---|---|
| ✓ | §1.1 Cross-tx audit-write gap | Commit `0f4fbe4` — `auditLog()` now reuses caller tx via overload, called inside `prisma.$transaction()` callback at `advance.ts:376-382` |
| ✓ | §1.7 Per-request auth-tax 3 reads + 1 write | `auth.ts:55-157` — 30s `userAuthCache` + batched `lastActiveAt` flush |
| ✓ | §1.8 Unbounded list endpoints | `default: 20, maximum: 200` added to audit/alarm/telemetry limit schemas |
| ✓ | §1.10 Cross-cycle idempotency replay | `lib/idempotency.ts:45-59` — `cycleId` REQUIRED arg; all 4 callers pass `filterCurrentCycleId` |
| ✓ | §1.11 Backup leaks bcrypt hashes | `backup.repository.ts` — `passwordHash` + `passwordHistoryHashes` stripped on export |

**Total CRITICAL fix backlog: ~5 dev-days** (down from ~7 on May 16).

---

## 2. NEW — delta findings 2026-05-16 → 2026-05-20

### 2.1 HIGH — Auth cache invalidation gap on admin-force-reset
**Severity:** HIGH (delayed enforcement, not auth-bypass)
**File:** `apps/api/src/modules/auth/auth.service.ts:373`; cache at `apps/api/src/plugins/auth.ts:55-157`
**Pattern:** The temp-password "page refresh" bug was fixed (uncommitted) by *skipping* the 30s `userAuthCache` for any user with `forcePasswordChange: true` (`auth.ts:~87`). That closes the user-changes-own-password path correctly — those users were never cached, so there's no stale entry to serve.

But the **admin-force-reset path** is still exposed: a user with an active session has `forcePasswordChange: false` cached. Admin force-resets their password → DB flips to `forcePasswordChange: true`. For up to 30 s, the cache continues to serve `forcePasswordChange: false`, so the user keeps operating instead of being kicked to the change-password screen. § 11.10(g) considers this a delayed-enforcement window for password lifecycle.

The deferred wire-up of `invalidateUserAuthCache(userId)` (per memory `feedback-auth-cache-invalidation-gap`) was never landed.

**Impact:** Up to 30 s of stale auth state on any DB mutation that flips `forcePasswordChange`, `disabled`, `roleId`, or `passwordResetRequired`. Not a bypass — DB is correct — but the cached principal continues authorizing requests with stale flags.

**Fix:** Import `invalidateUserAuthCache` from `plugins/auth.ts` and call it from every mutation path that flips the cached fields: `auth.service.ts:373` (changePassword), `user.service.ts` (force-reset, disable, role-update — 9 sites per May 16 §1.1 evidence). Effort: 3 h.

---

### 2.2 MEDIUM — SWR onError suppression pattern is over-broad
**Severity:** MEDIUM
**File:** `apps/web/src/lib/swr-config.ts:27-33`
**Pattern:** Issue #6 from the 2026-05-18 bundle added a substring-match suppression to silence the Capacitor "Unexpected token '<', '<!DOCTYPE' ... is not valid JSON" toast that fires when the offline APK's WebView serves bundled `index.html` for unresolvable API fetches:

```ts
if (msg.includes('unexpected token') || msg.includes('doctype') ||
    msg.includes('failed to parse server response')) return;
```

The substring match is broader than the actual failure mode. Any legitimate JSON-parse failure from a real API bug (badly-encoded error payload, misconfigured reverse-proxy returning HTML 500, malformed UTF-8 in user-controlled content) will now silently disappear — no toast, console-only, operators don't see it.

**Impact:** real API bugs disappear from operator-facing UI; degrades incident-detection on production. Low blast-radius (no data loss), but pollutes the "the app feels fine" mental model.

**Fix:** Tighten to detect the actual `<!DOCTYPE` HTML-fallback signature only, AND gate on `!navigator.onLine` or a URL-origin check. Suggested:
```ts
if (msg.includes('<!DOCTYPE') && (!navigator.onLine || err.url?.startsWith('/api/'))) return;
```
Effort: 30 min + manual offline-launch QA on tablet.

---

### 2.3 MEDIUM — Working tree not committed (rollback hazard)
**Severity:** MEDIUM (process / rollback risk)
**Files (uncommitted on RFID):**
- `apps/api/src/modules/filter-operations/cycle-write/advance.ts` (dryer-anchor + issues #1/#2)
- `apps/api/src/plugins/auth.ts` (temp-password cache skip)
- `apps/web/src/lib/filter-ops/validate-offline-gate.ts` (leaving-DRY_IN guard)
- `apps/web/src/lib/swr-config.ts` (issue #6 suppression — *and* finding 2.2 above)
- `apps/web/src/routes/mobile/mobile-operations.tsx` (issues #3/#4/#5/#7 + dryer-gate plumbing; ~2,627 lines, draft state)
- `apps/web/src/routes/mobile/mobile-wrapper.tsx` (#5 + #7 view)
- `DigiLog-FilterOps.apk` (rebuilt 2026-05-18 18:51)
- `certs/server.crt`

**Why this is a finding:** Each of these has been tablet-verified and a tag (`pre-dialog-state-refactor`) anchors rollback BEFORE these changes, but no commit anchors the current state. If anything breaks tomorrow, the diff has to be reverse-engineered from working-tree state. If the working tree gets accidentally clobbered (Windows file-lock, IDE recovery, `git stash` mistake), all 8 fixes vanish.

**Fix:** commit-now (one logical bundle: "feat(filter-ops/offline): 7-issue bundle + dryer-anchor + temp-pwd cache skip"). Effort: 15 min including review of each hunk.

---

### 2.4 MEDIUM — Documentation count drift (CLAUDE.md vs live schema)
**Severity:** MEDIUM (doc-sync violates CLAUDE.md hard rule)
**File:** `CLAUDE.md` "System Stats" line (claims 64 Prisma models / 21 enums)
**Live count:** 68 models / 21 enums per `grep -cE '^model ' apps/api/prisma/schema.prisma`. Wave 1 (2026-05-17) added `Block`, `Area`, `AHU`, `Filter` typed-hierarchy sidecar tables.

**Why it matters:** CLAUDE.md explicitly says "every numerical claim in any doc must be backed by `grep`/`ls` against live code at the moment the doc is touched. Don't trust prior docs — verify." That rule is being violated by its own header. Other docs (`README`, `PROJECT_SUMMARY`, `PROJECT_ARCHITECTURE`, `API_REFERENCE`, `BACKEND_GUIDE`) likely carry the same drift.

**Fix:** stale-stat sweep per CLAUDE.md ritual:
```bash
grep -cE "^model " apps/api/prisma/schema.prisma   # → 68
grep -cE "^enum " apps/api/prisma/schema.prisma    # → 21
```
Update every doc in the "Active doc set" with the new numbers. Effort: 30 min.

---

### 2.5 MEDIUM — H6 orphan-FK regression (FilterEvent stays soft-keyed despite typed-hierarchy migration)
**Severity:** MEDIUM (carried-over HIGH; arguably regressed because the typed-hierarchy migration would have been the natural fix moment)
**File:** `apps/api/prisma/schema.prisma` — `FilterEvent.{filterId, cleaningAreaId, equipmentId, blockId}`; migration `20260517110000_add_typed_hierarchy_tables`
**Pattern:** Wave 1 introduced typed `Block`/`Area`/`AHU`/`Filter` tables with FK to `AssetInstance.id`. `FilterEvent`'s soft-keyed UUID columns could have been re-typed with FK constraints in the same migration. They were not.

**Impact:** Reports filtering by area/block silently drop rows when a parent is deleted. Orphan creep accumulates. The "delete-block-deletes-children" path (§1 H8 from May 16, still `SetNull`) compounds the problem.

**Fix:** Either backfill + add FK in a follow-up migration, or accept-and-document. Effort: 2 h.

---

### 2.6 LOW — 4 unused enum values still in schema (alarm/rule-chain residue)
**Severity:** LOW (cosmetic)
**File:** `apps/api/prisma/schema.prisma:320-322` (`NotificationType`) and `:1026-1028` (`NotificationEventType`)
**Pattern:** Values `ALARM_CREATED`, `ALARM_ACKNOWLEDGED`, `ALARM_CLEARED`, `RULE_CHAIN_TRIGGERED` remain defined but are never written. Live notification creation uses a hardcoded TS union that excludes them.

**Fix:** drop 8 lines + add a one-line migration. Effort: 15 min.

---

### 2.7 LOW — Stale apps/api/dist/ artifacts from removed subsystems
**Severity:** LOW (cosmetic)
**Files:** `apps/api/dist/modules/config/defs/alarm-columns.*`, `apps/api/dist/modules/queries/alarm.routes.*`, `apps/api/dist/modules/rule-chain/`
**Pattern:** Pre-2026-05-17 compiled artifacts. Source deleted, dist not rebuilt. Local Windows dev (`tsx watch`) reads source, not dist, so runtime is unaffected — but anyone who runs the prod-style local build (`npx tsc -p apps/api/tsconfig.json && node apps/api/dist/app.js`) will pull dead code into the process.

**Fix:** `rm -rf apps/api/dist && npx tsc -p apps/api/tsconfig.json` once. Effort: 5 min.

---

## 3. Filter-hierarchy validation (Block → Area → AHU → Filter)

Verified across schema / API / web / sidebar / reports:

- **Schema:** typed tables exist as of 2026-05-17 (`Block`, `Area`, `AHU`, `Filter` per `20260517110000_add_typed_hierarchy_tables`), each FK-bound to its parent's `AssetInstance.id`. `AssetInstance.parentId` underlay preserved.
- **API:** cycle-write paths key off `filterId` (an `AssetInstance.id`); identifier→filter resolution uses cached map. No phantom hierarchy.
- **Frontend:** sidebar removed `alarms` + `rule-chains` items 2026-05-17. Hierarchy editor at `/hierarchy` uses Block/Area/AHU/Filter only. No `entities` or `templates` UI route remains live (deleted Phase 1 on 2026-05-16, restored to no UI access).
- **Reports:** templates key off `AssetInstance` hierarchy walk; no rule-chain or alarm sections.

**Conclusion:** the user-facing hierarchy is exactly Block → Area → AHU → Filter. The underlying storage is still `AssetInstance` rows — this is non-negotiable per the entity-removal impact analysis.

---

## 4. Wave execution plan

Ordered by ROI (highest blast-radius first). Each wave = one PR.

### Wave 1 — Safe cleanup (~1 h)
- **2.7** clean stale `apps/api/dist/` artifacts
- **2.6** drop 4 unused alarm/rule-chain enum values + migration
- **2.4** update CLAUDE.md model/enum counts + stale-stat sweep across active doc set
- **2.3** commit the working tree as one logical bundle (`feat(filter-ops/offline): bundle`)

**Verify after:** `npx tsc -p apps/api/tsconfig.json` clean, `npx vite build` clean, `npm run test --workspace=apps/api` baseline (expect 1080/22/8 — 2 pre-existing in `user.service`, 4 in `auth.plugin`).

### Wave 2 — Bug fixes (~5 h)
- **2.1** wire `invalidateUserAuthCache` into every cached-field mutation (`changePassword`, force-reset, disable, role-update — ~10 sites)
- **2.2** tighten SWR onError suppression to `<!DOCTYPE`-specific + offline guard

**Verify after:** Playwright (or manual on tablet): admin force-resets user with active session → cached principal kicks to /change-password within 1 request, not 30 s. Offline-launch toast still suppressed; bad-JSON middleware bug surfaces a toast in dev.

### Wave 3 — Integration fixes (~6 h)
- **C3 §1.4** WS SUBSCRIBE per-entity authz check (lookup `EntityAssignment` or default-visible, reject otherwise) — this is the highest-impact CRIT still open

**Verify after:** Two-user Playwright: OPERATOR subscribes to a high-value entityId they're not assigned to → 403 / connection closed. Existing SUBSCRIBE for owned entities still works. WS smoke through `/api/ws`.

### Wave 4 — Architecture cleanup — audit-chain hardening (~3 dev-days)
- **C1 §1.2** REVOKE DELETE on `audit_trail` + replace with REDACT (NULL payload, preserve chain links)
- **C2 §1.3** delete SUPER_ADMIN audit-trail PUT/DELETE routes; gate remaining data-mgmt edits behind reauth + meta-audit
- **C5 §1.6** CHECK constraint enforcing `audit_trail.user_id NOT NULL` (allow-list for SYSTEM_BOOT / SYSTEM_HEALTH_CHECK / etc.)
- **2.5** add FK constraints to `FilterEvent.{filterId, cleaningAreaId, equipmentId, blockId}` in follow-up migration; backfill orphans

**Verify after:** `GET /api/audit/verify-chain` returns `intact: true` after a REDACT operation (chain preserved). `auditLog({})` (no userId) throws at app layer AND fails CHECK at DB layer. FilterEvent migration completes on local dev DB without orphan errors.

### Wave 5 — DB cleanup (~3 h)
- **C4 §1.5** split `20260503162127_capture_schema_vs_db_drift` into `*_backfill` + `*_drop` migrations OR wrap destructive block in `DO $$ BEGIN IF EXISTS ...` guard
- May 16 **H11** delete `schema.prisma.bak` from source tree + worktrees
- May 16 **H8** flip `AssetInstance.parentId onDelete: SetNull` → `Restrict` (forces explicit detach before block delete)

**Verify after:** clone fresh DB → `prisma migrate deploy` → no errors. Attempt to delete a populated block → fails with FK constraint, not silent re-root.

### Wave 6 — Optimization & stabilization (~2 dev-days)
- **C6 §1.9** stream backup export via cursor-paginated `findMany` → temp file → gzip pipe; or shell out to `pg_dump --table`
- May 16 **H17** rewrite `getCurrentState()` to single-roundtrip joined query (cuts 9-13 seq reads to 1)
- May 16 **H18** code-split `jspdf` + `html2canvas` + `AuditTrailPage` + `FilterOperationsPage` (1.47 MB → ~700 KB main bundle)

**Verify after:** backup of 100k-row audit_trail completes without OOM (peak heap < 500 MB). Login → batch warmup of 500 filters completes in <8 s (down from ~36 s). Main bundle <800 KB after gzip.

---

## 5. Verification gates (run after EVERY wave)

| Check | Command |
|---|---|
| API type-check | `npx tsc -p apps/api/tsconfig.json --noEmit` |
| Web type-check | `npx tsc -p apps/web/tsconfig.json --noEmit` |
| Web build | `cd apps/web && npx vite build` |
| Unit + integration | `INTEGRATION_TEST=1 npm test --workspace=apps/api` (baseline 1080/22/8) |
| API health | `curl -sk -o NUL -w "%{http_code}" https://localhost:3000/health` (expect 200/401) |
| DB integrity | `psql ... -c "SELECT verify_audit_chain();"` (post-Wave-4) |
| WS connectivity | manual Playwright SUBSCRIBE / UNSUBSCRIBE flow |
| Frontend render | `npx playwright test apps/web/playwright/` smoke |
| Mobile responsive | `/m` route on tablet HA28H13Z (manual, see [[reference-mobile-tablet-entry]]) |
| RBAC | login as 101114 (SUPERVISOR) — verify only allowed routes visible |
| Reports | generate PDF — expect `%PDF-` magic bytes |
| Dashboards | login as superadmin — dashboard renders within 3 s |

---

## 6. Risk distribution (full picture = May 16 baseline + this delta)

| Severity | May 16 | Delta +/- | Net open |
|---|---|---|---|
| CRITICAL | 11 (5 closed) | 0 new | **6 open** |
| HIGH | 21 (verify list below) | +1 (auth cache invalidation) | ~22 open |
| MEDIUM | 29 | +3 (SWR suppression, working-tree, doc drift) | ~32 open |
| LOW | 15 | +2 (4 enum values, dist artifacts) | ~17 open |
| **Total open** | — | — | **~77** |

**Estimated remaining fix effort:** ~22 dev-days (down from May 16's ~28 dev-days × ~25% completed).

---

## 7. What this audit deliberately did NOT do

- **No runtime instrumentation.** All findings are static + spot-tested. Real lock contention, real memory peaks, real N+1 cost would refine severity rankings.
- **No re-walk of the 76 May 16 findings beyond CRITs.** Trust that doc.
- **No re-derivation of the entity-removal impossibility.** Already 307 lines in `ENTITY-REMOVAL-IMPACT-ANALYSIS.md`.
- **No mobile device farm pass.** Tablet HA28H13Z + Capacitor APK rebuild covered in the 2026-05-18 session; this audit didn't re-run it.
- **No multi-tenant audit.** Single-tenant per `single_tenant_decision` memory. If multi-tenancy returns, redo this whole exercise.

---

## 8. Recommended immediate action

If only the next 24 hours of effort are available:

1. **Wave 1** (1 h) — commit the working tree, clean dist, fix doc counts, drop 4 enum values. Zero risk.
2. **2.1** auth cache invalidation (3 h) — closes the admin-force-reset window.
3. **C3 §1.4** WS subscribe authz (6 h) — closes the highest-impact open CRIT (telemetry confidentiality leak).

Everything else in Waves 4-6 is genuine engineering work (3-10 dev-days each); plan accordingly.

---

*Generated 2026-05-20. Companion document to `tasks/STRICT-AUDIT-2026-05-16.md`. 5 specialist agent transcripts in `tasks/{ae09fc4b34ac8b20a,a11402d9ef8fdad21,a8f6d2577aff14ccd,a3ab5e0724c5338c2,a000cd9c5e2f11712}.output` (Claude Code temp).*
