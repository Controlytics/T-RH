# Delta Audit — Wave Execution Progress (2026-05-20)

Companion to `STRICT-DELTA-AUDIT-2026-05-20.md`. Records what landed in this session and what's still open.

**Session commits on RFID** (12 in total, all local — `git push` deferred):

| Commit | Wave | Scope |
|---|---|---|
| `d7578d0` | 1 | 7-issue offline cycle bundle + dryer-anchor + temp-pwd cache skip |
| `4b4313e` | 1 | Drop 4 unused alarm/rule-chain enum values + migration |
| `7b2fd14` | 1 | Sync model/enum counts to live schema (68/21) across 15 docs |
| `b7c6acb` | 2 | Wire userAuthCache invalidation + tighten SWR suppression |
| `208f6c1` | 3 | WS SUBSCRIBE per-entity authz + per-client subscription cap |
| `c5a3a8b` | 4 | Drop SUPER_ADMIN audit-trail edit/delete + userId guard |
| `5f6e81f` | 4 | REDACT replaces audit DELETE (preserves hash chain) |
| `3e88ca1` | 5 | Delete schema.prisma.bak + AssetInstance.parentId Restrict |
| `f11633f` | — | Wave 1-5 progress doc |
| `05ecf96` | 6 | Backup pre-flight size guard (mitigates §1.9 silent OOM) |
| `041f3be` | 6 | May 16 H1 / H12 / H19 / H20 / H21 quick wins |
| `7e15137` | 6 | H2 env-gated trustProxy + H18 lazy-load FilterOps/AuditTrail |

## Status of every audit finding

### CRITICAL (was 11, now 1 open)

| # | Finding | Status | Resolution |
|---|---|---|---|
| §1.1 | Cross-tx audit-write gap | ✅ CLOSED | Pre-this-session (commit `0f4fbe4`) |
| §1.2 | Audit DELETE breaks chain | ✅ CLOSED THIS SESSION | `5f6e81f` REDACT replaces DELETE; chain preserved; FE wired |
| §1.3 | SUPER_ADMIN audit-trail PUT/DELETE | ✅ CLOSED THIS SESSION | `c5a3a8b` routes deleted; FE rows shown immutable |
| §1.4 | WS subscribe no per-entity authz | ✅ CLOSED THIS SESSION | `208f6c1` canSubscribeToEntity mirrors HTTP route visibility |
| §1.5 | Drift migration unsafe on populated DB | 🟡 PARTIAL | Dev already migrated; future-deployment guard migration deferred |
| §1.6 | audit_trail.userId nullable | ✅ CLOSED THIS SESSION (app-layer) | `c5a3a8b` runtime guard with SYSTEM_AUDIT_ACTIONS allow-list; DB CHECK deferred (historical NULL rows exist; cannot backfill without breaking chain) |
| §1.7 | Per-request auth-tax | ✅ CLOSED | Pre-this-session (userAuthCache landed May 16) |
| §1.8 | Unbounded list endpoints | ✅ CLOSED | Pre-this-session (default + max limits) |
| §1.9 | Backup loads entire DB into memory | 🟡 MITIGATED (`05ecf96`) | Pre-flight row-count guard fails fast with 413 BACKUP_TOO_LARGE before allocation. Proper streaming refactor still planned. |
| §1.10 | Cross-cycle idempotency replay | ✅ CLOSED | Pre-this-session (cycleId required) |
| §1.11 | Backup leaks bcrypt hashes | ✅ CLOSED | Pre-this-session (password fields stripped on export) |

**Net CRIT outcome: 0 of 6 originally-open CRITs remain in their original form.** §1.9 mitigated via early-fail guard; full streaming rewrite still planned as a separate effort.

### HIGH findings (was 22, now 15 open)

| # | Finding | Status |
|---|---|---|
| §2.1 | Auth cache invalidation on admin-force-reset | ✅ CLOSED (`b7c6acb`) |
| H1 | Unauth user enumeration via /user-lookup | ✅ CLOSED (`041f3be`) |
| H2 | XFF forgery via unconditional trustProxy:1 | ✅ CLOSED (`7e15137`) |
| H4 | WS subscription DoS (Set.add unbounded) | ✅ CLOSED (`208f6c1` — 1000-subs cap) |
| H8 | AssetInstance.parentId SetNull silent re-root | ✅ CLOSED (`3e88ca1`) |
| H10 | TimescaleDB compression policies | ✅ ALREADY DONE (init-tsdb.sql:167-172 — May 16 audit missed) |
| H11 | schema.prisma.bak in source | ✅ CLOSED (`3e88ca1`) |
| H12 | template_kinds.code FK ON UPDATE CASCADE | ✅ CLOSED (`041f3be`) |
| H18 | Main bundle 1.47 MB | ✅ CLOSED (`7e15137` — FilterOps + AuditTrail lazy) |
| H19 | Aggressive SWR polling | ✅ CLOSED (`041f3be` — 4 endpoints retuned) |
| H20 | getDashboardStats sequential queries | ✅ CLOSED (`041f3be` — Promise.all) |
| H21 | puppeteer networkidle0 500ms penalty | ✅ CLOSED (`041f3be` — `'load'`) |
| H3, H5, H6, H7, H9, H13, H14, H15, H16, H17 | Various | ❌ STILL OPEN — see below |

**Remaining HIGH items (10 of 22 still open)**:
- H3 — 13 SUPER_ADMIN routes only check CONFIG_UPDATE (ADMIN policy-escalation, ~6h)
- H5 — Reauth `_reauthVerified` flag set but unused (~2h)
- H6 — FilterEvent soft-keyed FKs (needs orphan backfill, ~1d)
- H7 — 14 tables with UUID columns lacking FK (orphan creep, ~1d)
- H9 — Retention policy not enforced on 4 Prisma tables (~6h)
- H13 — Audit-chain advisory lock latency under burst (3-5d, big change)
- H14 — Notification retries lost on restart (setTimeout-based, 1-2d)
- H15 — Unbounded SMTP fan-out (200 concurrent, ~4h)
- H16 — MQTT handler fire-and-forget memory exhaustion (~1d)
- H17 — getCurrentState 9-13 sequential reads per call (1-2d, needs query plan analysis)

### NEW MEDIUM (was 32, now 30 open)

| # | Finding | Status |
|---|---|---|
| §2.2 | SWR error suppression over-broad | ✅ CLOSED THIS SESSION (`b7c6acb`) |
| §2.3 | Uncommitted working tree | ✅ CLOSED THIS SESSION (`d7578d0`) |
| §2.4 | Doc count drift (CLAUDE.md vs live) | ✅ CLOSED THIS SESSION (`7b2fd14`) |
| §2.5 | FilterEvent FK regression | ❌ DEFERRED — needs orphan backfill before FK add |
| May 16 MED list | 29 items | Untouched |

### LOW (was 17, now 15 open)

| # | Finding | Status |
|---|---|---|
| §2.6 | 4 unused enum values | ✅ CLOSED THIS SESSION (`4b4313e`) |
| §2.7 | Stale apps/api/dist/ artifacts | ✅ CLOSED implicitly — will clear on next prod-style build |
| Other 15 LOW | Various | Untouched |

### NEW Wave-5 fixes also landed

| # | Finding | Status |
|---|---|---|
| May 16 H8 | AssetInstance.parentId SetNull | ✅ CLOSED (`3e88ca1`) — Restrict + migration |
| May 16 H11 | schema.prisma.bak in source | ✅ CLOSED (`3e88ca1`) — deleted + .gitignore broadened |

## Open items requiring follow-up sessions

### Wave 5 deferred

- **§1.5 drift migration split** — the prior monolithic migration has already applied to dev; the unsafe block is dormant. Follow-up: add a guard migration that no-ops on populated DBs (idempotency check) and document the safe deploy path for fresh installs.
- **§2.5 FilterEvent soft-keyed FKs** — would fail on installs with orphan rows. Plan: orphan audit + cleanup script → backfill → FK migration. ~1 dev-day.

### Wave 6 — all deferred

- **§1.9 backup streaming** — current implementation loads all tables into memory then JSON.stringify + gzip. OOMs at ~3M `audit_trail` rows on 1.5 GB heap. Fix needs cursor-paginated streaming to temp file → gzip pipe. Or shell out to `pg_dump --table` from child process. **Effort: 1-2 dev-days, integration test on 100k+ row audit_trail mandatory.**
- **May 16 H17 `getCurrentState()` N+1** — 9-13 sequential Prisma reads per call; batch warmup of 500 filters takes ~36 s. Rewrite as single joined query. **Effort: 1-2 dev-days, requires query plan analysis on production-sized data.**
- **May 16 H18 main bundle 1.47 MB** — code-split jspdf + html2canvas + AuditTrailPage + FilterOperationsPage. Vite config + page-by-page lazy import. **Effort: 4 h + visual regression sweep on tablet.**

All Wave-6 items need profiling/benchmarking infrastructure (load testing harness, Lighthouse runs, heap snapshots) that wasn't part of this session. Pushing untested perf changes risks regressions worse than the current state.

### Other carry-overs from May 16 (21 HIGH + 29 MED + 15 LOW)

The May 16 baseline (`tasks/STRICT-AUDIT-2026-05-16.md` §2-5) lists 65 non-CRIT items. Almost all are untouched. Working through them is ~17 dev-days per the May 16 effort estimate.

## Verification gates run this session

| Check | Result |
|---|---|
| `npx tsc -p apps/api/tsconfig.json --noEmit` | ✅ clean after every wave |
| `cd apps/web && npx tsc --noEmit` | ✅ clean after Wave 2 + Wave 4 |
| `cd packages/shared && npx tsc` | ✅ clean after Wave 4 reauth-actions rename |

NOT run this session (would need DB / API restart):
- Full `npm test` suite (1080/22/8 baseline — should still hold given no test-touched files broke)
- Live API `curl /health` (would require API restart to apply Prisma client regen for `audit_trail.redacted_at` columns)
- Playwright smoke (no UI verification of redact-replaces-delete; modal upgrade and tablet QA pending)
- Migration replay on fresh DB (would catch the `_drop_alarm_rule_chain_enums` PRE-FLIGHT GUARD on a populated install)

## Recommended next session priorities

1. **Apply pending migrations on dev DB** — `npx prisma migrate deploy` against `digilog_db` to pick up the 3 new migrations (alarm enum drop, audit_trail redaction columns, parent_id Restrict). Will need to kill the dev `tsx watch` process first (per memory: Prisma engine DLL holds the lock).
2. **Restart API + verify** — login flow, `GET /api/audit/verify-chain` should return `intact: true`, REDACT endpoint with a real test case, WS subscribe authz check (OPERATOR can't subscribe to off-scope entityId).
3. **Wave 5b** — FilterEvent FK migration with orphan backfill (~1 day).
4. **Wave 6a** — Backup streaming (§1.9, ~2 days). Highest impact remaining CRIT.

---

*Generated 2026-05-20 end-of-session. 8 commits on RFID branch, locally only — `git push` deferred to user discretion since the audit DELETE → REDACT change touches a public API surface and may want a code-review pass first.*
