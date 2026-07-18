# Full Application Audit — 2026-07-04

**Scope:** bugs, DB integrity, remaining dead-code, content — across the whole app
(~102K LoC: api 37.5K/221 files, web 64.5K/245 files, packages/shared).
**Method:** test suites (ground truth) + madge + DB integrity SQL + 3 adversarial
bug-hunting agents (filter-ops / offline-sync / auth-RBAC), each finding requiring a
concrete failure scenario. **Prioritized and report-only — NOT exhaustive** (a 102K-LoC
bug audit can't be). Dead-code was already swept exhaustively this session (14 commits);
this pass covers correctness + integrity + the few remaining dead-code categories.

---

## Test / build health (ground-truth regression check)
- **api suite: 844 passed / 0 failed / 15 skipped** (79 files) — GREEN. First full run
  since all 14 of this session's commits → clean regression check on the whole session.
- **web suite: 363 passed / 1 FAILED** (24 files) — the 1 failure is Finding #1 below.
- api tsc / web tsc / vite build: all pass (verified during the dead-code sweep).

---

## FINDINGS (prioritized)

### 🔴 #1 — RBAC nav-visibility divergence (checklists → operators) — CONFIRMED (failing test)
- **Where:** `packages/shared/src/types/permission-tree.ts:592` — the `checklists` sidebar
  node (checklist **profile management**) lists `checklists.submit` in `visibilityPrivilegeIds`.
- **Symptom:** `sidebar-visibility.test.ts` case `item="checklists" perms="operatorish"` fails:
  tree-based `isSidebarItemVisible` returns **true**, legacy `SIDEBAR_PRIVILEGE_MAP` returns **false**.
- **Cause:** `operatorish` = `[ASSET_VIEW, ASSET_READ, FILTER_OPERATE, CHECKLIST_SUBMIT, ...]`.
  `checklists.submit`'s gate is satisfied by an operator, so the checklist **management** nav
  item shows for operators — but submitting checklists (during cleaning) ≠ managing checklist
  templates. Semantically the submit privilege belongs to the filter-operations flow, not the
  checklist-admin sidebar.
- **Pre-existing:** yes — from Phase 5B commit `90d814c`; NOT introduced this session.
- **Severity pending the route-gate check** (auth agent): if the `/checklists` (checklist-admin)
  route is itself gated on CREATE/EDIT perms → cosmetic nav leak (operator sees item, gets 403 on
  click). If the route is unguarded → real access bug. **Fix:** remove `checklists.submit` from the
  checklists sidebar's `visibilityPrivilegeIds` (or, if intended, update the stale test expectation).

### 🟠 #2 — 10 circular dependencies (madge) — CONFIRMED
`npx madge --circular` (the configured `check:cycles`, not run in a while) reports 10 cycles:
- **6 in the core filter-operations money-path:** `filter-operations.service.ts` ↔
  `current-state.ts` and ↔ `cycle-write/{advance,bypass,start-cycle,submit-checklist,terminate-cycle}.ts`.
  Circular imports risk undefined-at-init / partial-module bugs. (filter-ops agent verifying whether
  any manifests as a real runtime bug.)
- 3 in the derived RBAC maps: `feature-privileges.ts` ↔ `permission-tree.ts` ↔ `sidebar-privilege-map.ts`.
- 1 in `pipeline-executor`: `types.ts` ↔ `context.ts`.
- **Impact:** code-smell + latent init-order risk; refactor to break the cycles (extract shared
  types/helpers). Not proven to crash today, but the money-path cycles are worth resolving.

### ℹ️ #3 — Audit hash-chain: 171 deleted rows / 41 breaks in dev DB — EXPECTED, not a bug
- The dev `digilog_db` audit chain has 171 missing `chain_position`s and 41 `previous_checksum`
  breaks — residue from testing the `AUDIT_DELETE` hard-delete feature (added 2026-07-01).
- This is the **documented design**: physical deletion breaks the tamper-evident chain and
  `verify-chain` reports it invalid *permanently* ("breakage stays loud"; REDACT is the compliant path).
- **So the design works as intended.** Flag only: in a *production* 21 CFR context, any hard-delete
  is a compliance event — ensure operators use REDACT, not DELETE, on real data.

### ✅ Clean surfaces (audited, no findings)
- Web components + hooks — no unused files.
- Prisma enums, permissions, config-defs — clean (from the dead-code sweep).

---

## Bug-hunt agent findings (filter-ops / offline-sync / auth-RBAC)
All verified/traced with a concrete failure scenario (adversarial discipline held).

### 🔴 #4 — HIGH — `submitChecklist` missing post-lock (state,cycle) recheck → contradictory 21 CFR record — ✅ FIXED (`d45c317`)
> Fixed 2026-07-04: routed the lock through `lockAndVerifyFilterState(tx, filterId, currentState, cycle.id)` (same recheck as advance/bypass/terminate), kept the ALREADY_SUBMITTED guard on top. Un-skipped the 2 placeholder tests → real STATE_CHANGED/CYCLE_CHANGED cases. Full api suite 846/0/13, tsc clean.
- **Where:** `apps/api/src/modules/filter-operations/cycle-write/submit-checklist.ts:190-259`.
- **Defect:** advance/bypass/terminate all call `lockAndVerifyFilterState` (409 on STATE_CHANGED/CYCLE_CHANGED); `submitChecklist` locks with a bare `SELECT 1 … FOR UPDATE` and **never re-reads state**. Its completion branch fires on the stale pre-lock `currentState`/`cycle.id`.
- **Scenario:** filter at final stage (`STAGE→CHECKLIST→END`, `shouldComplete=true`). Operator A calls submitChecklist (reads state=final, cycle=X). Operator B concurrently terminates cycle X (status=TERMINATED, currentCycleId=null). A then gets the lock, skips the recheck, passes ALREADY_SUBMITTED (no prior CHECKLIST_COMPLETED for that stage), and runs the completion writes: **flips the just-TERMINATED cycle back to COMPLETED**. Cycle X ends with BOTH `CYCLE_TERMINATED` and `CYCLE_COMPLETED` immutable events — self-contradictory. Same with a concurrent bypass out of the final stage.
- **Confidence:** verified (code asymmetry traced; `concurrent-operator.test.ts:268-276` explicitly `it.skip`s these recheck cases, documenting the known gap). Timing-dependent (needs 2 concurrent operators on 1 filter).
- **Fix:** route submitChecklist through the same `lockAndVerifyFilterState` recheck as the other writers.

### 🟠 #8 — MEDIUM-HIGH — orphaned `'syncing'` offline ops → silent data loss under tablet OOM-kill — ✅ FIXED (`125bb44`)
> Fixed 2026-07-04: `requeueStuckSyncing()` requeues `'syncing'` ops+tombstones→`'pending'` in `startAutoSync()` before the first drain (idempotent re-replay via clientOpId; no retryCount bump). web tsc 0, web suite 365 pass, vite build 0.
- **Where:** `apps/web/src/lib/sync-engine.ts:472` (+ :272 tombstones).
- **Defect:** drain sets op `'pending'→'syncing'` *before* the multi-second network POST; **nothing ever resets `'syncing'`→`'pending'`** (only two `'syncing'` writes exist repo-wide; no startup requeue). `getPendingOperations` queries the `'pending'` index only.
- **Scenario:** tablet is killed mid-replay (the documented OOM/429 auto-close from memory). The row stays `'syncing'` forever — the 30s retry, count refresh, and cleanup all skip it. If the crash preceded the server commit, the operator's cleaning advance/checklist is **silently lost while "Data Synced" shows green** — a 21 CFR data-integrity loss.
- **Confidence:** verified (traced; no `'syncing'`→`'pending'` reset anywhere).
- **Fix:** on app boot, requeue any `'syncing'` rows back to `'pending'` (they're idempotent via clientOpId, so re-replay is safe).

### 🟠 #6 — MEDIUM — replacement-execute route has no authorization guard — ✅ FIXED (`29263e3`)
> Fixed 2026-07-04: added `preHandler: [requirePermission('FILTER_REPLACE')]` (the same gate the direct replace endpoint uses). api suite 846/0/13. Role grants unchanged (policy).
- **Where:** `apps/api/src/modules/replacement-schedule/routes.ts:175` — `POST /api/replacement-schedules/entries/:id/execute`.
- **Defect:** no `requirePermission`/`requireRole` preHandler; the only control is `enforceReauth('REPLACE_FILTER')`, which returns `{ok:true}` **without a password** whenever `REPLACE_FILTER` isn't in the `action-reauth` config (the default/legacy state). So the JWT is the sole control.
- **Scenario:** any authenticated user with **zero filter perms** (viewer/auditor/notifications-only) POSTs a valid due-entry id → `executeReplacement()` retires the old filter + creates a replacement (21 CFR lifecycle mutation). Marked "intentional" in a 2026-06-04 comment, but a genuine broken-access-control.
- **Confidence:** verified (traced).
- **Fix:** add a `FILTER_REPLACE`/`REPLACEMENT_SCHEDULE_*` permission preHandler; don't rely on config-dependent reauth as the sole gate.

### 🟠 #9 — MEDIUM — online cycle-writes omit clientOpId → lost-response replay fails or duplicates — ✅ FIXED (`a87c6f6`)
> Fixed 2026-07-04: one clientOpId shared between the online body + the queued replay (start-and-advance uses `:start`/`:advance` sub-keys). web suite 366/0.
- **Where:** `apps/web/src/hooks/use-offline.ts:131-205` (online post paths) + `apps/api/src/lib/idempotency.ts:57-70`.
- **Defect:** online cycle-writes send no `clientOpId`, so if the op commits server-side but the HTTP response is lost (routine WiFi drop), the retry is queued with a *fresh* clientOpId that can't correlate to the committed op.
- **Scenario:** tap Start Cycle online → server creates cycle (no clientOpId) → response lost → op queued → replay POSTs start-cycle → `findExistingStartByClientOpId`=false → server sees `currentCycleId` set → **409 CYCLE_ACTIVE**, op burns 5 retries → `failed` with misleading "already has active cycle" toast (data is fine). **Worse:** if the cycle was terminated elsewhere first, the replay creates a **duplicate cycle**.
- **Confidence:** verified (traced).
- **Fix:** attach a clientOpId to online cycle-writes too (so online+offline share one idempotency key), or add benign-409 handling to the standalone start-cycle replay branch.

### 🟡 #5 — MEDIUM — stage-interlock QA gate skipped at a terminal interlock stage — ✅ FIXED (`33a7cfc`)
> Fixed 2026-07-04: fail-safe — advance() now rejects (422 INTERLOCK_TERMINAL_STAGE) a completing advance out of an interlock stage rather than auto-completing without QA sign-off. api suite 846/0/13. (Fuller gate-and-complete-on-approval left as a future enhancement.)
- **Where:** `apps/api/src/modules/filter-operations/cycle-write/advance.ts:379-384`.
- **Defect:** when a WASH_OUT/DRY_OUT interlock stage is *also* the final stage, `willComplete` zeroes `enteringInterlock` → no PENDING `CleaningStageApproval` created → cycle auto-completes with **no QA sign-off**.
- **Scenario:** admin configures `WASH_IN→WASH_OUT→END` with `stage-interlock.enabled=true`; advancing WASH_IN→WASH_OUT auto-completes, skipping the required WASH_OUT approver. Defeats the interlock's purpose for a terminal interlock stage.
- **Confidence:** verified (uncommon config, not prevented).
- **Fix:** create the interlock approval before the auto-complete when `enteringInterlock` on a terminal stage (or block that profile config).

### 🟡 #10 — LOW — `ensureCycleAlive` pre-empts server idempotency for the cycle-completing op — ✅ FIXED (`a0a0c9a`)
> Fixed 2026-07-04: neutral, accurate messaging ("cycle already ended — queued action skipped, no data lost") instead of "operation discarded". The cycle-scoped idempotency (intentional) can't confirm a completing op post-completion, so a behavioral auto-sync would be unsafe; the misreport was the message. web suite 366/0.
- **Where:** `apps/web/src/lib/sync-engine.ts:176-192` + :575.
- **Defect:** the pre-replay `ensureCycleAlive` guard fetches `/current-state`; if the cycle-completing op committed server-side but its response was lost, the next drain sees `currentCycle==null` and throws `CYCLE_ENDED` **without calling the server**, so `findExistingByClientOpId` (which would return the cached success) never runs → op misreported "failed/discarded" though server data is correct.
- **Confidence:** verified. Cosmetic (no data loss; misleading status only).

### 🟡 #7 — LOW/informational — PM deviation acknowledge gated on a read perm — ✅ FIXED (`75c4f91`)
> Fixed 2026-07-04: gate changed `PM_READ` → `PM_EXECUTE` (matches the completion action it precedes). api suite 846/0/13.
- `apps/api/src/modules/pm-schedules/routes.ts:569` — `POST /deviations/:id/acknowledge` gated on `PM_READ` (read) for a state change, but mitigated by always-on `enforceReauthAlways('ACKNOWLEDGE_PM_OVERDUE')` (password required, non-toggleable) and non-destructive. Borderline; identity-bound.

### 🟡 #1 (severity resolved) — LOW/cosmetic — checklists nav leak to operators — ✅ FIXED (`8d71b8e`)
> Fixed 2026-07-04: removed `checklists.submit` from the checklists-management sidebar's `visibilityPrivilegeIds` (+ updated the frozen snapshot). Web suite now fully green (366/0). Submit still drives the filter-ops group's visibility.
- Downgraded from #1: the auth agent verified `GET /api/checklist-profiles` requires `FCP_READ`/`CHECKLIST_TOGGLE`/`VERSION_HISTORY_VIEW`, so an operator clicking the leaked nav gets a **403 on data load** — no leak, no mutation. **Cosmetic nav artifact only.** Fix: remove `checklists.submit` from the node's `visibilityPrivilegeIds` (or update the stale test).

### ⚪ #2 (updated) — circular deps: filter-ops ones are NOT a runtime hazard
- The filter-ops agent cleared the 6 money-path cycles: `cycle-write/*` import the service as `import type` (compile-erased) + receive the live instance as a call-time arg → no init-order bug. The remaining cycles (RBAC maps, pipeline-executor types) are also type-level. **Code-smell, not a runtime bug.** Optional cleanup.

### Strong explicit clears (bounded false positives)
- **Auth-cache staleness: FIXED** — `invalidateUserAuthCache`/`invalidateSessionAuthCache`/`invalidateRolePermsCache` wired into all mutation + logout sites; plugin re-reads authoritative role from DB. Prior logout bug confirmed fixed (`3e87785`).
- Reauth result handling, gate-vs-grant (`useCan` uses the discriminating gate), SUPER_ADMIN bypass, JWT/session TTL clamps — all correct.
- Filter-ops: checklist gate, version pinning, advance/bypass/terminate concurrency recheck, idempotency scoping, dryer offline anchor — all correct.
- Offline: dryer time-anchor correct, batch/single parity maintained, FIFO replay ordering, no `navigator.onLine` misuse.

---

## ROUND 2 — backup/config, reports, assets, audit/versioning, notifications/frontend
5 more adversarial agents over the subsystems round 1 didn't cover. Verified findings:

### ✅ FIXED this pass
- 🔴 **CRITICAL — backup restore total lockout** (`backup.repository.ts`): export strips
  `password_hash`→sentinel for ALL users; `TRUNCATE`+reinsert wrote the sentinel over every
  real hash → nobody (incl. SUPER_ADMIN) could log in, recovery path unreachable. Fixed: snapshot
  current hashes pre-truncate, re-apply to sentinel rows on reinsert.
- 🟠 **HIGH — audit verify-chain false-FAIL on redaction** (`audit-verify.ts`): didn't plumb
  `redacted_at`, so a chain-preserving REDACT reported `intact:false` permanently while `GET /api/audit`
  showed it valid. Fixed: SELECT + pass `redactedAt`.
- 🟠 **HIGH — stale SMTP transporter on password rotation** (`email-channel.ts`): `configHash` excluded
  the password → cached transporter kept old creds after a rotation, all email failed until restart.
  Fixed: include password in the cache key.
- 🟠 **HIGH — report-review no assignee check + no separation-of-duties** (`report-reviews/service.ts`):
  review/approve checked only `status` → any holder could act on any item, and one user could
  submit→review→approve solo. Fixed: `assertIsAssignee` (SA may act as any assignee) + SoD
  (reviewer≠generator, approver≠reviewer/generator, no SA bypass).
- 🟡 **MEDIUM — connection-limit off-by-one** (`instance.service.ts`): counted a node's own upward
  `CONTAINED_IN` link → under-allowed children by 1 for any non-root parent. Fixed: `countContainsChildren`.
- 🟡 **MEDIUM — DATE attribute accepted impossible dates** (`attribute-validator.ts`): regex passed
  `2026-02-31`. Fixed: calendar round-trip (matches filter-fields).
- 🟡 **MEDIUM — CSV-restore numeric coercion corrupted text** (`backup.service.ts`): `"0055"→55`,
  `"+91…"`, `"1.0"→1`. Fixed: coerce only canonical numbers (`String(Number(v))===v`).

### ⚠️ FLAGGED
- ✅ **FIXED (9b345a3) 🟠 HIGH — audit per-row checksum omits `beforeValue`/`reason`/`signatureMeaning`/`userRole`**
  (+`userName`/`ipAddress`/`userAgent`/`sessionId`) (`audit.ts`/`hash-chain.ts`/`audit-verify.ts`/`audit/routes.ts`):
  those columns (incl. the §11.50 signature meaning) were outside tamper-evidence — a DB-level actor could
  rewrite them and verify-chain still passed. Fixed **without** a recompute-and-rechain migration, following
  the file's own V1/V2 versioning philosophy: new rows are hashed over the EXPANDED field set; the verifier
  tries expanded-then-reduced so all pre-expansion rows still verify via the reduced fallback (accepted
  limitation: extra columns not tamper-covered for historical rows). Chain walker SELECTs+passes all 8 columns.
  13-case proof (tamper on every newly-covered field now DETECTED) + hash-chain 24/24 + e2e audit-chain 4/4 + suite 846/0/13.
- ✅ **FIXED (361c4df) 🟠 HIGH — SQL-format restore silently drops/corrupts rows** with newlines or `);` in a value
  (`backup.service.ts`). Root cause was the OUTER statement regex (`.` can't cross `\n` → row dropped; lazy `\);`
  → row truncated). Replaced with a header-match + string-aware `findValuesClose()` scanner (the inner
  `parseSqlValues` tokenizer was already correct). 2 round-trip tests (newline/`);`/embedded-INSERT/`''`/jsonb/
  truncated-tail), all fail on the old regex. Suite 848/0/13.

### ⚠️ FLAGGED — real but need a design decision / bigger effort (NOT fixed)
- ✅ **FIXED (5bc6450) 🟡 MEDIUM — report-review cross-user snapshot read** (`getById()` unscoped): a
  SUBMIT-only user could read any report's `dataSnapshot` (reachable via the web "All Reports" tab's
  per-row Download PDF). Fixed: `getById(ctx, id)` enforces `canViewReportReview` (SUPER_ADMIN /
  generator / current assignee by user-or-role / past reviewer-approver-rejecter → else 403). `list()`
  left broad by design (SUMMARY_SELECT, no snapshot — the tracking board). FE `canDownloadReview`
  mirrors the scope so the Download button only renders for parties. Pure helpers unit-tested
  (8 api + 7 web). api 856/0/13, web 373/0.
- ✅ **FIXED (0577aa8) 🟡 MEDIUM — equipment-group version pin lazy-binds to the LIVE version** when no
  group was supplied at cycle start. Fixed: `start-cycle` now pins the version at START for the common
  single-active-group-per-block case (pure `resolveStartEquipmentGroupPin`, unit-tested) instead of
  lazy-binding to whatever's live at first readings; `advance` only honours the pin for its own group
  (defensive override guard). Corrects the out-of-range determination; recorded reading values were
  always immutable in `FilterEvent`. Accepted limits: offline-replay pins at replay time, legacy
  in-flight cycles still lazy-bind. api 861/0/13.
- ✅ **FIXED (1c0a6d5) 🟡 MEDIUM — SMS http-gateway marks SENT on any 2xx**, ignoring a body-level error.
  Fixed via `interpretHttpGatewayResult` (pure, unit-tested): optional `httpGatewaySuccessRegex`
  (authoritative body matcher, new SMS-settings field) + a conservative default that fails on an
  unambiguous JSON error body (`success:false`/`status:"error"`) — never false-positives a real send
  into a duplicate. Twilio/Vonage untouched. api 872/0/13, web 373/0.
- ⚪ **LOW (batch)** — swept 2026-07-04 (5 verification agents → triage → fix). Outcome:
  - ✅ **FIXED (0f4bc0e) P2002→409**: concurrent version-sidecar edits (equipment-groups / checklist- /
    cleaning- / filter-profiles) raised an unhandled 500 + spurious SYSTEM_ERROR; one systemic global-
    handler branch maps P2002 → 409 retryable.
  - ✅ **FIXED (0794a74) getConfig fail-open**: parse-failure returned `{}` not schema defaults →
    password-policy silently disabled; now re-derives `.default()`s (real schema fully defaulted). +2 tests.
  - ✅ **FIXED (3db3979) backup validate() false PASS**: SQL/CSV self-comparison always "VALID"; now
    honest `checksumSupported` flag + FE neutral "NOT VERIFIED" state (restore still allowed). +2 tests.
  - ✅ **FIXED (3f67d46) bulk-upload silent truncation**: @fastify/multipart truncates at 5 MB w/o
    throwing → confusing parse error; both handlers now 413 on `part.file.truncated` (verified v9 sets it).
  - ✅ **FIXED (b21232f) OAuth2 state/CSRF**: live mailbox-linking flow had no `state`; now minted server-
    side (unpredictable, 10-min TTL, one-time), verified in callback before token exchange, and stripped
    from GET /email so a CONFIG_READ user can't read+forge it (advisor-caught leak).
  - ⏸️ **DEFERRED — dormant** (orphaned reports/generate feature, no FE caller since 2026-06-08; API-only):
    pdf-renderer cold-start launch race, html-builder unescaped admin-authored style strings,
    PENDING_SIGNATURE stuck when no signer `required`. Real at code level; revisit only if reports revived.
  - ⏭️ **SKIPPED — by-design**: DROPDOWN with no `dropdownOptions` accepts any string (explicitly tested,
    `attribute-validator.test.ts:198`; the cleaner win is a template-save refine, not a value-validator change).
  - ↩️ **REVERTED — net-negative**: dynamic-routes `sanitizeStrings` — no security gain (SUPER_ADMIN-only,
    render sinks already escape) and `stripHtml` double-encodes/drops legitimate labels ("Wear & tear",
    "temp < 5"). Left unsanitized deliberately.

### Verified-clean (strong negatives, round 2)
Frontend hooks (`useCan`/`useReauth`/`useSession`/`use-single-tab`/`api-client`), notification
recipient-scoping + worker idempotency, cleaning-profile & checklist cycle-pinning, backup
FK-order/self-refs/BigInt/identifier-injection, config seedDefaults & merge semantics, cycle-detection.

---

## NOT COVERED (honest scope boundary)
- Exhaustive logic-bug coverage of all 102K LoC (only highest-risk subsystems hunted).
- Unused Prisma columns (Prisma `select *` makes this low-signal).
- Unused API endpoints vs client callers (200+ endpoints; noisy to match — deferred).
- Runtime/load/perf, penetration testing, and per-role curl 403/200 (no low-priv creds).
- Empty dev-DB tables are NOT findings (empty = not-exercised-in-dev, not dead).
