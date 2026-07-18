# DigiLog — Strict Enterprise Audit (2026-05-16)

**Scope:** 4 parallel specialist agents (Security, Performance, Database, Architecture+Concurrency) against the codebase at HEAD = `bd93d6b` (post-Wave-1 + Wave-2 + Wave-3.1 + Wave-4.2 + Wave-4.5 + Phase-1 + replacement-list fix).
**Method:** static analysis + cross-reference against prior audit docs (`CLEANUP-ANALYSIS-2026-05-16.md`, `CODE-REVIEW-2026-05-04-*`, `AUDIT-2026-05-09-crud-coverage.md`, `CIRCULAR-DEPS-BASELINE-2026-05-16.md`) to avoid re-flagging known items.
**Deliberately excluded:** dead-code / file-size / dep-cleanup (already covered) and the entity/asset/alarm/rule-chain *removal* scope (separate `REWRITE-SPEC-2026-05-16.md`).

## 0. Executive summary

**81 distinct findings** across 4 categories. **11 CRITICAL** form the must-fix-before-prod-deploy tier. Most CRITICALs cluster around one root cause: **the 21 CFR Part 11 audit machinery is partially decorative** — the SHA-256 hash chain, the immutability triggers, and the chain verifier are all present and correct in isolation, but at least four separate code paths bypass or defeat them:

1. Cycle / user mutations write audit rows in a SEPARATE transaction from the mutation they audit — partial-failure scenarios leave state changed with no audit record (DB-CRIT-2, ARCH-CRIT-1, SEC-HIGH-3, all the same root issue from 3 angles).
2. The audit `DELETE` endpoints disable the immutability trigger then physically delete rows without re-linking the chain — first deletion permanently breaks `verifyAuditChain` (DB-CRIT-1, SEC-HIGH-2).
3. The `/api/super-admin/data/audit-trail` PUT/DELETE routes let SUPER_ADMIN rewrite any audit row's checksum/action/userId/timestamp/payload directly, with no reauth and no audit-of-the-audit (SEC-CRIT-2).
4. Backup `restore` re-checks chain integrity per-row but does not verify the backup file itself was signed, so any SUPER_ADMIN-export → edit-JSON-and-recompute-checksums → restore loop trivially rewrites all live audit history (SEC-MED-8).

Until **all four** are closed, any inspector with regulatory savvy can demonstrate the audit chain is unenforceable. Fix order in §3.

The other CRITICALs cluster around DoS surface (unbounded list endpoints), perf cliffs (per-request auth tax, monolithic backup loader), confidentiality (WS broadcast leak, backup password-hash export), and a single nasty data-corruption path (idempotency dedup not cycle-scoped).

---

## 1. CRITICAL findings — must fix before next production-style deploy

### 1.1 — Audit row written outside the transaction it documents
**Sources:** DB-CRIT-2, ARCH-CRIT-1, SEC-HIGH-3, SEC-HIGH-6.

**Files:** every cycle-write — `apps/api/src/modules/filter-operations/cycle-write/{advance,bypass,start-cycle,submit-checklist,terminate-cycle}.ts`. Every user mutation — `apps/api/src/modules/users/user.service.ts` (9 sites). Audit deletion path — `apps/api/src/modules/audit/routes.ts:249-263, 306-323`.

**Pattern:** business mutation runs in `prisma.$transaction(...)`. After the tx commits, code calls `await auditLog(...)` which opens its own separate `$transaction`. If the second tx fails (advisory-lock timeout, transient blip, hash-chain mismatch, client cancellation between the two awaits) the business state is changed with no audit row.

**Impact:** Direct § 11.10(e) violation. A `CYCLE_STARTED` or `STATE_TRANSITION` or `CHECKLIST_COMPLETED` row can exist in `cleaning_cycles` + `filter_events` with no corresponding `audit_trail` entry. `verifyAuditChain` does not detect missing rows (only tampering) so the gap is invisible.

**Fix:** add `auditLog(entry, tx?)` overload — when `tx` is passed, share the caller's transaction (the `pg_advisory_xact_lock` just bumps the per-tx counter, no functional issue). Migrate all ~15 sites in one PR. **Effort: 1 day.**

---

### 1.2 — Audit `DELETE` endpoints create permanent chain gaps
**Sources:** DB-CRIT-1, SEC-HIGH-2.

**Files:** `apps/api/src/modules/audit/routes.ts:259-263` (single), `:316-323` (bulk). Chain definition: `apps/api/src/lib/audit.ts:43-102`.

**Pattern:** both routes `DISABLE TRIGGER audit_trail_no_delete`, run `delete`/`deleteMany`, re-enable. After deletion, the row at `chain_position = min(positions > deleted.position)` still carries the deleted row's `previous_checksum` value. The chain is broken from that point onward forever.

**Impact:** `GET /api/audit/verify-chain` returns `intact: false` for the entire post-gap tail after a single legitimate delete. An inspector querying this endpoint sees a non-compliant chain.

**Fix:** two options, pick one:
- **(a) Forbid audit deletion entirely.** REVOKE DELETE on `audit_trail` at the DB role level. Replace with REDACT (NULL the payload, keep checksum + chain link). The Part 11–defensible choice.
- **(b) Re-link on delete.** Inside the same transaction as the delete, recompute `previous_checksum` + `checksum` on the row immediately after the gap, under the same advisory lock. Preserves the chain. Allowed if your regulatory posture permits deletion at all (most don't).

**Effort: ~6 h either way. Recommend (a).**

---

### 1.3 — SUPER_ADMIN data-management routes mutate `audit_trail` with no reauth and no audit-of-the-audit
**Source:** SEC-CRIT-2.

**Files:** `apps/api/src/modules/super-admin/routes.ts:347-371` (audit-trail PUT + DELETE), `:286-345` (cleaning-cycles + filter-events), `:373-493` (alarms/notifications/admin-requests/block-changes/pm-entries), `:75-94` (retirements auto-prune audit), `:197-203` (unretire silently deletes audit rows).

**Pattern:** `PUT /api/super-admin/data/audit-trail/:id` lets SUPER_ADMIN edit `checksum`, `action`, `userId`, `timestamp`, `beforeValue`, `afterValue` of any audit row. `DELETE` calls `prisma.auditTrail.delete()` directly, bypassing the trigger via the SUPER_ADMIN session's own privileges. The unretire path silently `deleteMany`s associated `FILTER_RETIRED` / `FILTER_REPLACED` audit rows.

**Impact:** A SUPER_ADMIN (or an attacker who gains that session) can rewrite history, falsify checksums, or delete entire compliance records with zero forensic trace. The hash chain at `lib/audit.ts` and `verify-chain` endpoint become decorative.

**Fix:** Delete the SUPER_ADMIN audit-trail edit/delete routes entirely. For the other data-mgmt tables (cleaning_cycles / filter_events / alarms / notifications / block-changes / pm-entries), require reauth + `auditLog()` with the prior row snapshotted into `beforeValue`. Remove the silent prunes at routes.ts:88-90, :198-200, :256. **Effort: 1 day.**

---

### 1.4 — WebSocket SUBSCRIBE has no per-entity authorization (telemetry broadcast leak)
**Source:** SEC-CRIT-1.

**File:** `apps/api/src/transport/ws-handler.ts:60-83, 211-225`.

**Pattern:** After AUTH, any authenticated user (OPERATOR + above) can `SUBSCRIBE` to any `entityId` string. The bus relay only checks `client.subscriptions.has(event.entityId)` — pure FE-side trust. Telemetry, alarms, RPC responses, attributes for every entity stream to any subscriber.

**Impact:** Lowest-tier operator can subscribe to high-value entity IDs (regulated cleanroom feeds, device-config attributes) and receive real-time data outside their role scope. Confidentiality break for the entire telemetry surface.

**Fix:** On SUBSCRIBE, look up the entity (or its `EntityAssignment` row) and reject if the user's role lacks `ASSET_VIEW`/`ASSET_READ` and the entity isn't visible to them. Cache permitted-user set per entityId. **Effort: ~6 h.**

---

### 1.5 — Migration `20260503162127_capture_schema_vs_db_drift` will lose data on any populated DB
**Source:** DB-CRIT-3.

**File:** `apps/api/prisma/migrations/20260503162127_capture_schema_vs_db_drift/migration.sql:14-22, 107-112, 146`.

**Pattern:** The migration's own header comment warns "Applying against a populated DB will fail on at least: `filter_cleaning_profiles.lineage_id` NOT NULL (no default backfill); `asset_instances` column drops (no migration of data into filter_details sidecar)." That guidance is encoded in a comment, not in code. Any `prisma migrate deploy` against an existing DB either crashes or silently drops three filter-state columns without rehoming them.

**Impact:** Cycle state for every in-flight filter destroyed (`current_cycle_id`, `current_lifecycle_state`, `filter_set`). Cycle history reconstruction broken.

**Fix:** Split into `*_data_move` (idempotent backfill, ordered first) + `*_drop_columns` (destructive, ordered second). Or wrap the destructive block in `DO $$ BEGIN IF EXISTS (...) THEN RAISE ...` to fail loudly on populated DBs that haven't been migrated. **Effort: 3 h.**

---

### 1.6 — `audit_trail.userId` is nullable; nothing prevents unattributable audit writes
**Source:** DB-CRIT-4.

**File:** `apps/api/prisma/schema.prisma:270` (`userId String?`), `apps/api/src/lib/audit.ts:5` (`userId?: string`).

**Pattern:** `auditLog` accepts `userId?: string`. No app-side check enforces presence on user-attributable actions. A NULL `userId` row also passes the `userRole != 'SUPER_ADMIN' OR userRole IS NULL` filter at `audit/routes.ts:73` — attributes the action to nobody.

**Impact:** § 11.10(e) requires audit rows identify the individual. NULL userId on a state-changing action is a finding.

**Fix:** Add a CHECK constraint: `CHECK (user_id IS NOT NULL OR action IN ('SYSTEM_BOOT', 'SYSTEM_HEALTH_CHECK', ...))` with an explicit allow-list of anonymous actions. Add a unit test calling `auditLog({})` without `userId` and asserting throw. **Effort: 3 h.**

---

### 1.7 — Auth plugin runs 3 reads + 1 write on EVERY authenticated request
**Source:** PERF-C1.

**File:** `apps/api/src/plugins/auth.ts:55-157`.

**Pattern:** Every authenticated request hits `prisma.session.findFirst` + `prisma.user.findUnique` + `prisma.session.update` (sliding `lastActiveAt`), plus a 4th/5th conditional write on password-expired or session-timeout. The session UPDATE dirties the same row on every poll, so concurrent requests from the same user serialise via row lock.

**Impact:** Every `/current-state` poll, alarm refresh, offline-cache prime pays 3–4 DB round-trips before route logic runs. With Prisma's default pool size (`physical_cpus * 2 + 1` = ~9 connections on a 4-core box), 50 concurrent users at 1 req/s × 4 queries = 200 q/s contending for 9 pool slots. The compound effect with PERF-C3 below is real DoS.

**Fix:** Cache user + session lookups for 30 s each (invalidate on user mutation via internal-bus). Debounce `lastActiveAt` updates to background batched flush every 30–60 s per session. **Effort: 4–6 h.**

---

### 1.8 — Unbounded list endpoints (any user can pull the entire `audit_trail` in one request)
**Source:** PERF-C3.

**Files:**
- `apps/api/src/modules/audit/routes.ts:21,133` — `limit` schema has no default; handler does `...(query.limit ? { skip, take } : {})` so missing limit returns the entire table
- `apps/api/src/modules/queries/alarm.routes.ts:29,99-105` — same pattern
- `apps/api/src/modules/queries/telemetry.routes.ts:128,199-200` — raw TSDB `SELECT * FROM ts_telemetry WHERE entity_id=... ORDER BY time DESC` with conditional `LIMIT`
- `apps/api/src/modules/queries/telemetry.routes.ts:424,446-449` — attribute history same
- `apps/api/src/modules/filter-operations/filter-operations.service.ts:533-612` — retirements + replacements unpaginated

**Impact:** Any authenticated user with `AUDIT_READ` / `ALARM_VIEW` / `ASSET_VIEW` can issue `GET /api/audit` with no params and pull the entire hash-chained audit_trail. With monotonic growth this is a guaranteed eventual OOM. TSDB endpoint without LIMIT materialises gigabytes.

**Fix:** Add `default: 20, maximum: 200` to every `limit` querystring schema. Defensive cap in handler regardless of schema: `const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);` For audit, switch to keyset pagination on `chainPosition`. **Effort: 2–3 h.**

---

### 1.9 — Backup loads entire DB into memory twice; no streaming
**Source:** PERF-C2.

**File:** `apps/api/src/modules/backup/backup.service.ts:296-510`.

**Pattern:** `exportJson` / `exportBak` / `exportSql` / `exportCsv` all start with `fetchAllTablesRaw()` returning one big `Record<string, any[]>` in heap. `exportSql` builds the SQL line-by-line as `sqlParts: string[]` — second full copy. `exportBak` calls `JSON.stringify(backup)` then `gzipSync(...)` — third + fourth peak.

**Impact:** With `audit_trail` at 1M rows (~500 MB JSON) the SQL path OOMs the Node process (default 1.5 GB heap) at <3M rows. Backup currently has zero pagination, zero streaming. Silent failure — the request just dies.

**Fix:** Stream each table via cursor-paginated `prisma.*.findMany({ cursor, take: 1000 })` writing to a temp file as you go; pipe the final file through gzip. Or use `pg_dump --table` from a child process. **Effort: 1–2 days.**

---

### 1.10 — Idempotency replay-dedup is NOT cycle-scoped in 3 of 4 cycle-writers
**Source:** ARCH-CRIT-2.

**Files:** `apps/api/src/lib/idempotency.ts:38-52` (signature); `cycle-write/advance.ts:39`, `bypass.ts:38`, `start-cycle.ts:48` all call `findExistingByClientOpId(filterId, clientOpId)` WITHOUT `cycleId`. Only `submit-checklist.ts:50` passes `filterCurrentCycleId` (correct).

**Pattern:** Without `cycleId`, the helper matches across the filter's entire history. An operator can complete cycle A, start cycle B, then have an offline-queued operation from cycle A replay against cycle B (IndexedDB persistence on tablets is per-filter, not per-cycle). The clientOpId already exists in cycle A's filter_events → helper returns "duplicate" → mutation silently no-ops → server-tablet state divergence.

**Impact:** Under offline-heavy field conditions, a STATE TRANSITION may silently no-op. Subsequent operations 409 STATE_CHANGED. Operator-experience and tape-version invariants break. Audit trail itself stays consistent (no double-write) but the cycle-write workflow corrupts mid-stream.

**Fix:** Make `cycleId` REQUIRED in `findExistingByClientOpId` (TS won't compile until every caller provides it). advance/bypass pass `filterCurrentCycleId` from loadLocalContext. start-cycle gets a separate `findExistingStartByClientOpId(filterId, clientOpId)` that filters on `eventType = 'CYCLE_STARTED'`. **Effort: 3 h including regression test.**

---

### 1.11 — Backup exports leak every user's bcrypt password hash
**Source:** SEC-HIGH-7.

**File:** `apps/api/src/modules/backup/backup.repository.ts:141-152` (`fetchAllTablesRaw` does `SELECT *` per table), `apps/api/src/modules/backup/routes.ts:16-62` (export route).

**Pattern:** `users` table includes `passwordHash`, `email`, `passwordHistoryHashes`. JSON/SQL/CSV/BAK exports include all of them. Gate is `BACKUP_EXPORT`, which any role with `BACKUP_MANAGE` gets via `MANAGE_PERMISSION_SUFFIXES` — including ADMIN by default seed.

**Impact:** Offline bcrypt cracker against a leaked backup recovers any operator/admin password. § 11.10(d) violation (system must protect identification codes). If a backup ever leaves the appliance (email, USB, "send to vendor"), the entire credential set is compromised.

**Fix:** Strip `passwordHash` + `passwordHistoryHashes` from `users` exports in `fetchAllTablesRaw` (substitute placeholder + flag as `credential-stripped`). Restore must re-issue temporary passwords or refuse without a force flag. Apply across CSV/SQL/JSON/BAK. **Effort: 4 h.**

---

## 2. HIGH findings (cross-deduplicated)

Compressed list — each entry consolidates duplicates across agents. See full per-agent reports if expansion needed.

| # | Title | Sources | Fix effort | Impact |
|---|---|---|---|---|
| H1 | Unauth user enumeration via `/api/admin-requests/user-lookup` returns distinguishable responses + leaks email/role/dept | SEC-HIGH-1 | 3 h | Phishing target list for whole org |
| H2 | XFF forgery via `trustProxy: 1` when API serves browsers directly → audit-trail IP + rate-limit keys attacker-controlled | SEC-HIGH-4 | 2 h | Audit forgery + brute-force unbounded |
| H3 | 13 SUPER_ADMIN-only routes (branding, access-matrix, action-reauth, audit-templates, alarm-columns, retention, etc.) BE-checked only on CONFIG_UPDATE; ADMIN can hit them directly | SEC-HIGH-9 | 6 h | ADMIN→SUPER_ADMIN policy escalation (can disable reauth gates for everyone) |
| H4 | WS subscription DoS — single client can `Set.add` 10M synthetic entityIds, relay walks them on every emit | SEC-HIGH-10 | 1 h | Memory exhaustion crash by any authenticated user |
| H5 | Reauth `_reauthVerified` flag is set but unused → 2nd reauth in same request silently re-prompts (or fails) | SEC-HIGH-8 | 2 h | Inconsistent reauth coverage |
| H6 | `FilterEvent.filterId/cleaningAreaId/equipmentId/blockId` are app-managed UUIDs with no FK → orphan-record creep | DB-HIGH-1 | 2 h | Reports filtering by area/block silently drop rows |
| H7 | `Alarm.entityId` + ~14 other tables have UUID columns without FK (ChecklistReview, ElectronicSignature, LatestTelemetry, UnsMapping, ConnectivityStatus, QrCode, DataStream, DeviceCredential, BlockChangeRequest, PmSchedule, PmExecution, EquipmentGroupInstrument) | DB-HIGH-2, DB-HIGH-3 | 1 day | Cumulative orphan creep + dashboard "Unknown entity" or crash |
| H8 | `AssetInstance.parentId onDelete: SetNull` — accidental block delete silently re-roots all children | DB-HIGH-4 | 1 h | Hierarchy corruption; filters lose block context |
| H9 | Retention policy not enforced on `notifications`, `notification_logs`, `dead_letter_queue`, `pipeline_traces` Prisma side (only 5 TSDB tables covered) | DB-HIGH-5 | 6 h | Inevitable unbounded table growth |
| H10 | TimescaleDB compression policies declared nowhere | DB-HIGH-6 | 2 h | `ts_telemetry` grows uncompressed forever |
| H11 | `schema.prisma.bak` (39-model pre-MT-removal snapshot) still in source — risk of accidental `prisma db push` | DB-HIGH-7 | 15 min | Schema drop catastrophe |
| H12 | `template_kinds.code` FK has `ON UPDATE CASCADE`; direct SQL rename silently rewrites every `asset_templates.template_kind` row | DB-HIGH-8 | 1 h | Filter Management stops resolving entities |
| H13 | Audit chain advisory lock serialises every audit write, including high-rate ingestion path → ingestion latency under burst | ARCH-HIGH-3 | 3–5 days | Ingestion saturation at >100 audit/s |
| H14 | Notification retries lost on process restart (`setTimeout`-based, not graphile delayed jobs) | ARCH-HIGH-1 | 1–2 days | Silent notification loss on every deploy/crash |
| H15 | Unbounded fan-out in notification dispatcher (200 concurrent SMTP for role broadcast) | ARCH-HIGH-2, PERF-H4 | 4 h | SMTP rate-limit triggers + retry storms |
| H16 | MQTT handler fire-and-forget — no in-flight cap; floodgate event OOMs the API process | ARCH-HIGH-4 | 1 day | Memory exhaustion under broker-replay |
| H17 | `getCurrentState()` 9–13 sequential Prisma reads per call; batch warmup of 500 filters takes ~36 s | PERF-H1 | 1–2 days | Login + visibility-resume UX blocker |
| H18 | Main JS bundle 1.47 MB — jspdf + html2canvas + AuditTrailPage + FilterOperationsPage all eager | PERF-H2 | 4 h | Multi-second TTI on tablet WebView |
| H19 | Aggressive SWR polling (rule-chains 3 s, ahu-dashboard 10 s × 1000-children, identifiers 30 s × 1000) | PERF-H3 | 2 h tuning | 4,000 q/min for 50 operators idle |
| H20 | `getDashboardStats` 7 independent queries serial; `getCycleById` 5 serial reads | PERF-H5 | 1–2 h | Dashboard load 7× single-query time |
| H21 | Puppeteer `waitUntil: 'networkidle0'` adds forced 500 ms per report (charts are inline data URIs) + first report pays browser cold launch | PERF-H6 | 2 h | First-report latency 1–2 s; subsequent +500 ms penalty |

**HIGH total: 21 findings. ~7 dev-days of fix work.**

---

## 3. Recommended fix order

Highest ROI first; each line is a single PR.

| Order | Fix | Effort | Why first |
|---|---|---|---|
| 1 | §1.7 Auth-plugin caching | 4–6 h | Compounds every other perf finding; multiplier on all other work |
| 2 | §1.8 Default `limit=20, max=200` on audit/alarm/telemetry endpoints | 2 h | Closes DoS surface; one PR |
| 3 | §1.1 Pass tx into `auditLog` (overload) | 1 d | First step on the regulatory cluster; unblocks §1.3 |
| 4 | §1.3 Delete SUPER_ADMIN audit-trail edit/delete routes | 1 d | Closes the most egregious audit-tamper path |
| 5 | §1.2 REVOKE DELETE on audit_trail + replace with REDACT | 6 h | Closes the chain-gap path |
| 6 | §1.4 WS subscribe per-entity auth check | 6 h | Closes telemetry-broadcast confidentiality leak |
| 7 | §1.10 Make `cycleId` required in idempotency dedup | 3 h | Closes cross-cycle replay data-corruption |
| 8 | §1.11 Strip password hashes from backups | 4 h | Critical credential-handling gap |
| 9 | §1.6 CHECK constraint enforcing `audit_trail.userId NOT NULL` | 3 h | Closes the unattributable-write path |
| 10 | §1.5 Split drift migration into data-move + drop-columns | 3 h | Production-deploy safety; gate any new deploy on this |
| 11 | §1.9 Stream backup export | 1–2 d | Lower urgency; current DB likely small enough |

**Total CRITICAL fix effort: ~7 dev-days.** All 11 should land before next production-style deploy.

After CRITICALs land, work through HIGH list (~7 dev-days) in the order above. MEDIUM + LOW = backlog.

---

## 4. What was AUDITED — CLEAN (no findings, deliberately noted)

To prevent re-investigation in the next audit cycle:

- **CORS** — `app.ts:103-108` resolves origin from `ALLOWED_ORIGINS`; throws on prod without it; no wildcard hardcoded.
- **Path traversal in uploads** — `uploads/routes.ts:75-114` validates magic bytes + derives filename server-side; user input never reaches disk.
- **MQTT auth callbacks** — `mqtt-auth-routes.ts:50-272` uses `timingSafeEqual` + per-entity-topic ACL.
- **HMAC-signed offline-replay grant** — bound to `(user.sub, session.id)`; can't be reused across sessions.
- **SQL injection via `$queryRawUnsafe`** — every dynamic identifier is whitelisted/regex-validated; values use `$1, $2` placeholders.
- **Audit-chain genesis + advisory-lock + previous_checksum + chain_position** — implementation is correct in isolation; the bypasses are in OTHER files (see §1.1–1.3).
- **Sanitization coverage** — every audited mutation service imports `sanitizeStrings`.
- **Cycle-start race condition** — `start-cycle.ts:128-139` does `SELECT FOR UPDATE` before recheck; concurrent calls serialise correctly.
- **Cycle advance/bypass/terminate races** — `lockAndVerifyFilterState()` in `cycle-write/locking.ts` is the shared lock helper; all four write paths properly serialise.
- **`Internal-bus` error isolation** — handler exceptions wrapped in try/catch + Promise.catch; one throwing subscriber can't kill the publisher.
- **`PrismaClient` global singleton** — single export point; no multiple-instance footgun.
- **Module coupling** — no cross-module reach (`filter-operations` ↔ `users` = 0 hits); routes don't bypass services to import repositories.
- **`rpc-cache.ts` eviction race** — read-after-stale-delete is benign; next read re-queries.
- **WS handler shutdown order** — `closeWsBus` runs before `app.close()`; subscriber unregistered before HTTP server closes.
- **`AssetRelationship` inverse-pair invariant** — DB-level deferred constraint trigger correctly handles create-pair-in-one-tx case.
- **`cleaning_cycles` one-IN_PROGRESS-per-filter** — partial unique index at DB level (not just app).
- **`ts_checklist_responses` REVOKE UPDATE,DELETE** — Part 11 immutability enforced at the role-grant level. Solid.
- **Phase A versioning sidecars** (`ChecklistProfileVersion`, `FilterProfileVersion`, `EquipmentGroupVersion`, `FilterCleaningProfile.lineageId`) — sound snapshot-then-bump with cycle pinning insulating in-flight cycles from admin edits.

---

## 5. Per-category MEDIUM / LOW lists

Compressed — see full per-agent reports for evidence.

### Database (8 MED + 5 LOW)
- MED: missing composite indexes on `(action, timestamp)`, `(status, severity, createdAt DESC)`, `(entityId)` for DLQ
- MED: enums-as-strings (Alarm.severity, Alarm.status, DeviceCredential.status, AssetInstance.status, etc.) — no CHECK constraints
- MED: `Notification.targetUserId/forUserId` and `ElectronicSignature.signerUserId` are `VarChar(50)` not `Uuid` — can't FK
- MED: `NotificationRule.eventType` (single) coexists with `eventTypes` (array) — schema redundancy
- MED: JSONB columns without write-side validation (telemetryConfig, customAttributes, etc.)
- MED: `RuleNode.ruleChainId → RuleChain` cascade can wipe 77-node graph silently
- MED: SUPER_ADMIN audit filter pattern is in two route handlers; should be a Postgres view + REVOKE SELECT
- MED: `ts_pipeline_traces (id, time)` PK — `id` isn't unique alone
- LOW: inconsistent naming (snake_case vs camelCase, plural vs singular, enum mapping)
- LOW: `ChecklistReview.checklistId` is cross-DB reference (TSDB) — no FK possible, add comment
- LOW: `Role.permissions Json` array — promote to relation for queryability
- LOW: `RoleConfig` keyed by `role String` not `roleId`
- LOW: `cleaning_reasons Json?` on `FilterCleaningProfile` redundancy

### Security (8 MED + 3 LOW)
- MED: XSS in `notification-rules/index.tsx:931` + `notification-logs.tsx:199` — `dangerouslySetInnerHTML` with insufficient escaping
- MED: Helmet CSP fully disabled (`app.ts:110 contentSecurityPolicy: false`) — no defense-in-depth for XSS
- MED: `PUBLIC_PATHS` uses `startsWith` — future `/api/data/telemetry-stats` route added without auth
- MED: Reset-password approval returns plaintext password in JSON response
- MED: `PUT /api/auth/profile` allows email change without verifying the new address → account-takeover vector
- MED: Generator rule-chain node's `safeExecuteScript` uses substring blocklist — trivially bypassable for VM escape
- MED: Custom-table-insert rule-chain node accepts arbitrary tableName/columns → can inject into `ts_*` hypertables
- MED: Snippet generator returns device access token in plaintext to any `ASSET_VIEW` user → device impersonation
- LOW: JWT secret falls back to per-process random in dev mode → sessions die on every restart
- LOW: `req.device.accessToken` decorated on request object → future logger middleware leak
- LOW: Forgot-password rate-limit response leaks "pending request exists" vs "first time"

### Performance (7 MED + 3 LOW)
- MED: 3× duplicate PWA icon PNGs (85 KB each, byte-identical) bloat SW precache
- MED: `assetIdentifier?limit=1000` polled every 30 s on mobile-wrapper
- MED: `instanceRepository.findTree()` has no `take` — returns entire entity tree
- MED: `getMaxConnectionsPerUser()` reads systemConfig on every WS AUTH (no cache)
- MED: Telemetry batcher self-flush at exactly `batchSize` may stall under sustained burst
- MED: `cacheLogo()` re-fetches branding on every PDF report
- MED: `pmDueTasks` fetches ALL cleaning_cycles for matched filters (no time bound) → grows monotonically
- LOW: `enforceReauth` cache TTL of 10 s is short — bump to 60 s
- LOW: `connectivity.ts` + `sync-engine.ts` keep `setInterval` alive for app lifetime
- LOW: `cooldownMap` in notification-dispatcher unbounded by time (only by ruleId)

### Architecture (6 MED + 4 LOW)
- MED: PrismaClient instantiated with no pool/timeout tuning → default 9 connections on 4-core box
- MED: WebSocket bus subscriber blocks event loop O(subscribers) per emit
- MED: Reauth gate is opt-in at every route handler — no preHandler factory
- MED: In-memory rateLimitMap + cooldownMap have documented single-process assumption
- MED: 21 CFR audit row for high-frequency POST_ATTRIBUTES happens at ingestion stage 10 → 86,400 rows/day/device
- MED: `enqueueNotificationJob`/`enqueueIngestionJob` don't propagate transactional rollback → orphan jobs
- LOW: WebSocket AUTH-message race (theoretical) — two concurrent AUTH messages double-count
- LOW: `findManyByIds` returns first 100 only (silent truncation at >1000 ids)
- LOW: DLQ_OVERFLOW alarm uses sentinel UUID that violates FK in most installs
- LOW: PWA SW `skipWaiting:true` + `clientsClaim:true` can mid-session swap bundles → ChunkLoadError

---

## 6. Risk distribution

| Severity | Count | Estimated fix effort |
|---|---|---|
| CRITICAL | 11 | ~7 dev-days |
| HIGH | 21 | ~7 dev-days |
| MEDIUM | 29 | ~10 dev-days (backlog) |
| LOW | 15 | ~4 dev-days (backlog) |
| **Total** | **76** | **~28 dev-days** |

Note: 11 ≠ 11 individual files — many are 3-agent convergences on the same root cause. After dedup the actual fix surface is ~9 distinct PRs for the CRITICALs.

---

## 7. Methodology + caveats

- **4 parallel general-purpose agents** ran ~10 min each over backend, frontend, schema, and dependency surfaces. Each had explicit instructions to read prior audit docs and skip already-flagged items.
- **No runtime instrumentation** — all findings are static analysis. Production telemetry (actual N+1 hit rates, actual lock contention, actual memory peaks under load) would refine severity rankings.
- **`tsx watch` reload behavior** for the new fixes assumed reliable; per memory `feedback_tsx_watch_windows_unreliable` you may need to restart the API process after applying §1.7 to actually exercise the cache.
- **Multi-tenant isolation** flagged only opportunistically — DigiLog is now single-tenant per `single_tenant_decision` memory; revisit if multi-tenancy returns.
- **TimescaleDB**-specific tuning (chunk size, compression policies, retention triggers) needs a TSDB specialist; the findings here are static-surface only.

---

*Generated 2026-05-16. Source agents archived in `C:\Users\hello\AppData\Local\Temp\claude\…\tasks\*.output`. Per-agent reports cross-referenced inline.*
