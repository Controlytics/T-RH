# compliance-core — Strict Technical Audit

**Date:** 2026-10-03
**Branch audited:** `data-layer` @ `e6d1e5d`
**Mode:** READ-ONLY. No source, config, schema or database object was changed.
The only file created is this report.

**Method.** Six parallel read-only reviews (API security, API correctness,
data layer and §11 records, web app, ingest and alarm pipeline, docs and
tooling), each required to cite file and line and a grep hit count for every
claim. The lead then re-derived the HIGH findings and a sample of the rest
against the live tree by grep and read (marked **[verified]** below); the
others are reported as found (**[reported]**). Where an answer needs the
database or a running process the finding says so. Nothing is rated HIGH
on a claim that was not re-derived.

Previous audit: `docs/audit/2026-08-29-technical-audit.md` (health 74/100).
Items it raised that are still open are marked **(open since 08-29)**.

---

## 1. Executive summary

The codebase remains well built and unusually well commented, and the three
structural risks of August are largely addressed (the partitioned telemetry
table now has a migration-safety guard on `npm run db:migrate`; the audit
hard-delete surface is documented and rate-limited; the root docs' counts all
match the live tree today). What this audit finds is a different class of
problem: **rules that were established in one place and never carried to
their siblings.** Visibility scoping is on the reads but not the writes;
lockout parity is on every password surface but one; the `signature_meaning`
bound was applied to one route in a file whose two neighbours still
overflow; the reading-coercion rule is in the overview but not in the
range-alarm pass; the audit-chain field set grew in July and the backup
verifier still hashes the old one.

**105 findings across the six reviews** (ingest 18, security 8, API 20,
data 18, web 18, docs and tooling 23); 36 of them were re-derived by the
lead, including every HIGH. **Sixteen runtime findings are rated HIGH**
(four more in documentation and repository hygiene, §2.6). In order of what
they cost:

1. **A fresh customer install this month cannot store a reading.** Migrations
   create telemetry partitions for August and September 2026 only; nothing
   creates the current month's at boot or install, and the cron that would
   runs on the 1st/15th with no backfill. Every reading is rejected and, on
   MQTT/TCP/WebSocket, LOST with no dead letter — because one bad row fails
   the whole batch's single INSERT and that failure is not caught. (INGEST-1,
   INGEST-2 / DATA-2)
2. **Privilege escalation through Roles & Access.** `PUT /api/config/roles/:role`
   rewrites a role's stored permissions with no check that the caller holds
   what it grants; an ADMIN can give ADMIN `AUDIT_DELETE`, `BACKUP_RESTORE`
   or `ROLE_MANAGE`. (API-1)
3. **A scope save with an empty body widens a role to the whole plant, then
   500s with no audit row.** (API-2)
4. **Backup restore's tamper check cannot pass on real data**, so every
   restore is done with `force`, which disables the check. (DATA-1)
5. **Every upgrade silently resets the six system roles' permissions to the
   shipped defaults.** (DATA-4)
6. **Audited actions by any user in a role whose name exceeds 20 characters
   fail**, including login. (DATA-3)
7. **SMTP, SMS, LDAP bind credentials and webhook headers leave in every
   backup in clear text.** (DATA-5)
8. **Renaming a functional location that holds instruments returns 500 after
   the rename and its audit row have committed.** (API-3)
9. **A long location name overflows the audit column after the write has
   committed**, leaving a created or renamed location with no audit row.
   (API-4)
10. **Any instrument's attributes are readable by id regardless of
    visibility, and the route confirms existence.** (API-5)
11. **The public admin-request endpoint stamps a caller-typed identity into
    the hash-chained audit trail as the acting user.** (API-6)
12. **Two alarm evaluation passes run concurrently and can both clear one
    alarm**, doubling every email, SMS and hooter "off" post. (INGEST-4)
13. **The sensor-range alarm never fires for the plant's own devices**, which
    send quoted numbers; the pass judges the raw value by type while the
    dashboard coerces it. (INGEST-3)
14. **The Super Admin API-access password boxes invite browser autofill**, the
    exact mechanism that bit the acknowledge dialog on 08-31. (WEB-1)
15. **A re-auth password can be stored in plaintext in `system_config`** and
    read back by anyone with config read, through an early return that
    skips the strip. (SEC-1; rated MEDIUM by the reviewer, raised here
    because the stored value is a login password)
16. **Four config saves verify the password with a bare bcrypt compare**,
    bypassing account lockout and breaking directory users. (SEC-2 / API-11)

Nothing found is an active outage on the local installation. The AWS
instance runs the August build and inherits everything here that predates
it.

**Overall health: 70 / 100** (August: 74). The drop is not regression — most
of these defects were present in August and not found — it is the cost of
looking harder at the write paths and the §11 record paths.

---

## 2. Findings by domain

Severity: HIGH / MEDIUM / LOW. Confidence as the reviewer rated it.
**[verified]** = re-derived by the lead against the tree; **[reported]** =
reviewer's evidence, not independently re-run.

### 2.1 Ingest and alarm pipeline (18)

**INGEST-1 · HIGH · [verified] — One out-of-partition timestamp loses the
whole gateway batch, with no dead letter.** `telemetry.repository.ts:74-90`
writes every reading of a batch in one multi-row INSERT inside one
transaction; `ingest-core.ts:168` and `:210` call `writeBatch` with no catch,
and `safeWriteDeadLetters` wraps only parse and fan-out failures. The MQTT
bridge (`mqtt-bridge.ts:456-461`) only logs; TCP kills the socket; WS logs.
A gateway batch of 30 children with one block carrying `"ts":"2019-01-01…"`
(buffered reading, dead RTC, or INGEST-5) is rejected whole, every minute,
after the broker has already acked. Fix: catch the write failure in
`ingestPayload`, dead-letter the raw payload with the DB error against the
gateway, drop or server-stamp the offending rows, rethrow only on HTTP.

**INGEST-2 / DATA-2 · HIGH · [verified] — No partition for the current month
on a fresh install until the 15th.** `migrations/20260804120000_instruments_p1`
creates `2026_08` and `2026_09` only (`grep "PARTITION OF" migrations/` → 2
hits, both there). `ensurePartitions` is called from nothing but its own
worker and two tests; `app.ts` registers the task and never calls it; no
installer script creates partitions. `crontab.txt` runs it `5 0 1 * *` and
`5 0 15 * *` with `fill=0s`, so a machine that is off at that minute skips
the run for good. Also: the worker reads a `telemetry-retention` config row
for which no def exists, so `monthsAhead` cannot be administered. Whether
the LOCAL database has `2026_10` is unknown (DB access was not available to
this audit). Fix: call `ensurePartitions(monthsAhead)` once at boot after
the job runner starts and from `apply-schema.ps1` / `digilog-lib.sh`; give
the two partition crons a bounded `fill` (`4w`); create the missing def.

**INGEST-3 · HIGH · [verified] — The sensor-range pass judges the raw value
by `typeof === 'number'`.** `alarm-evaluation.worker.ts:824`, `:838`, `:912`
test `raw.value` from `row.rawSlots` (the pre-coercion slot) with a plain
number check, while `telemetry-overview.ts:231-243` uses the shared
`coerceReading`. The plant firmware sends strings (`"t":"20.3"`,
`ingest-core.ts:99`), so on every gateway-fed instrument a range fault
neither raises nor clears, while the dashboard shows `OL`. The range e2e
seeds only numbers. Fix: `coerceReading` in all three places.

**INGEST-4 · HIGH · [verified] — Two evaluation passes can both clear one
alarm.** On-ingest enqueue uses `jobKey 'alarm_evaluation:on-ingest'`
(`enqueue-evaluation.ts:34`); the cron uses `id=alarm_evaluation`; the
worker runs `concurrency: 10` (`packages/queue/src/connection.ts:58`). Raise
paths are guarded by the partial unique indexes; the five CLEAR paths
(`worker :209, :359, :568, :742, :913`) are plain `prisma.alarm.update`
with no state guard, each followed by a notification and a webhook enqueue.
A recovery at hh:mm:59.5 is announced twice and counted twice. Fix:
`updateMany({ where: { id, state: 'ACTIVE' } })`, skip fan-out on `count === 0`.

**INGEST-5 · MEDIUM · [reported] — A numeric epoch-seconds device timestamp
is read as 1970.** `payload-parser.ts:298-311` applies the 10/13-digit rule
to strings only; a number goes straight to `new Date(raw)`. `{"ts":1788599495}`
→ `1970-01-21` → INGEST-1. Fix: same width rule for numbers; reject outside a
sane window.

**INGEST-6 · MEDIUM · [reported] — A future device timestamp pins the
latest-reading table.** `telemetry.repository.ts:86-89` applies `latest` only
when `ts <= EXCLUDED.ts`; no upper bound on device ts. One message two days
ahead makes every later correct reading "older", and every alarm pass
judges the pinned value for two days while `lastSeenAt` (server-stamped)
keeps inactivity quiet. Fix: reject or server-stamp a ts more than N minutes
ahead.

**INGEST-7 · MEDIUM · [reported] — The MQTT queue cap counts the bridge's own
retained downlinks and the reconnect backlog.** `mqtt-bridge.ts:374-385`
drops at `maxQueued` before `:430-437` classifies and discards downlinks;
with `clean: false` a reconnect replays the backlog plus ~200 retained slots
in one burst and everything past slot 500 is dropped and already acked.
Fix: classify the topic in the `message` handler before it takes a slot.

**INGEST-8 · MEDIUM · [reported] — A JSON `null` reading is dropped
silently.** `payload-parser.ts:382` skips nulls, so `{"t":null,"h":45}`
leaves yesterday's temperature as current and no alarm source sees the
probe failure (`rs485-decide.ts:31-35` notes a stored null "IS a failure"
but nulls never reach it). Fix: store the null or dead-letter the key.

**INGEST-9 · MEDIUM · [reported] — Two SQL paths still count only
`jsonb_typeof = 'number'`.** `telemetry-aggregate.ts:35, :201` and
`floorplans/room-history.ts:87, :126, :136`; the widened cast lives only in
`getRangeSummary`. The dashboard trend card and room history are empty for
string-sending instruments. Fix: one shared CASE expression.

**INGEST-10 · MEDIUM · [reported] — TCP has no message-rate cap and
`dead_letters` has no retention.** `tcp-listener.ts:43-52` vs the 600/min
on WS and HTTP; `grep deadLetter.deleteMany apps/api/src` → tests only.

**INGEST-11 · MEDIUM · [reported] — Offset failure stores UNCORRECTED
readings as if corrected**, and a corrected row carries `valueType:
'number'`, outside the parser's vocabulary (`load-offsets.ts:91-94`,
`sensor-offsets.ts:125`). The documented RS485 probe query would count
every corrected reading as a failure.

**INGEST-12 · MEDIUM · [reported] — Webhook cooldown is consumed when all
three delivery attempts fail** (`cooldown.ts:28-31` before any send).

**INGEST-13 · LOW · [reported]** — flat-path reading keyed `__proto__`
vanishes (`payload-parser.ts:372-375` uses `{}`; the gateway path guards
this). **INGEST-14 · LOW** — two readings at one instant: history keeps the
first, latest keeps the last. **INGEST-15 · LOW** — operator regex tested
against the unbounded response body. **INGEST-16 · LOW** — RS485 clear
writes `clearedValue = null` for a quoted number (`worker:741` uses the
type-strict `finiteOrNull`). **INGEST-17 · LOW** — overview reads the whole
`instrument_telemetry_latest` table per call (`telemetry-overview.ts:436`).
**INGEST-18 · LOW (UNCONFIRMED)** — reconnect backoff mutates
`client.options.reconnectPeriod` after connect; whether mqtt.js 5 re-reads
it was not checked.

Done right: one shared `coerceReading` everywhere but the three places
above; offsets applied once before both writes with `raw_value` kept and no
read-time correction anywhere; each decide rule matches its documentation
and each raise is backed by a partial unique index; acknowledge is an
atomic claim before fan-out; the MQTT auth hook is constant-time and
exact-match; byte caps are checked before any parse on all four transports.

### 2.2 API security and auth (8)

**SEC-1 · MEDIUM (lead: treat as HIGH) · [verified] — A re-auth password can
be stored in plaintext.** `lib/reauth-check.ts:154` returns `{ ok: true }`
when the role does not require re-auth, before the `delete
body._currentPassword` at `:179`; `config/dynamic-routes.ts:109` then does
`const newValue = { ...body }` and stores it; the email/SMS/LDAP saves do the
same. A stale client (or any direct caller) that sends `_currentPassword`
unprompted leaves the user's login password in `system_config`, returned by
every later GET to anyone with `CONFIG_READ`. The audit row is safe. Fix:
delete the key unconditionally before any early return; strip underscore
keys at the four write sites.

**SEC-2 / API-11 · MEDIUM · [verified] — Four config saves bypass lockout and
directory auth.** `config/routes.ts:128` is a bare
`verifyPassword(currentPassword, user.passwordHash)` for `password-policy`,
`login-security`, `session`, `datetime`; no `applyFailedPasswordAttempt`,
no `verifyCredential`. A stolen `CONFIG_UPDATE` session can guess at ~83/s
with no lockout; an LDAP user can never save those four. Fix: route through
`verifyReauthPassword`.

**SEC-3 · MEDIUM · [verified] — The upload magic-byte check is skipped for
any MIME type added via `UPLOAD_ALLOWED_TYPES`.** `uploads/routes.ts:103-104`
checks `if (expectedMagic && …)`; an env entry with no `MAGIC_BYTES` row
gets no content check and is saved as `.jpg` into a publicly served folder.
With `image/svg+xml` in the env (documented in `.env.example`) that is
stored XSS on the app origin. Fix: refuse at startup any allowed type with
no magic entry.

**SEC-4 · LOW · [verified] — The SUPER_ADMIN kill-switch and forced-password
gates use bare `startsWith`.** `plugins/auth.ts:382, :414` admit
`PUT /api/config/password-policy` because the allow-lists name the prefix
intended for the public GET. A "locked" super admin can still rewrite the
password policy. Fix: segment-match, list `/current` explicitly.

**SEC-5 · LOW · [reported]** — `/api/auth/verify` issues a token nothing
consumes and never checks `purpose`. **SEC-6 · LOW** — OAuth2 redirect URI
built from `X-Forwarded-*` regardless of `trustProxy` (impact limited by the
server-minted `state`). **SEC-7 · LOW** — instrument create/update/delete
and profile update/delete carry no e-signature while functional locations
do; no reauth action exists to configure one. **SEC-8 · LOW (open since
08-29)** — `/api/admin-requests/user-lookup` remains a public username
oracle, by recorded product decision.

Verified NOT findings: alarm-webhook SSRF stance unchanged and deliberate;
all 23 `$queryRawUnsafe` sites are constant SQL or catalog-sourced
identifiers; no `.passthrough()`; no secret reaches a log or an audit row;
no hardcoded credentials; every route without a guard is public by design
or self-scoped.

### 2.3 API correctness (20; includes the users/roles/config and
webhooks/notifications/backup/uploads sub-reviews)

**API-1 · HIGH · [verified] — Privilege escalation via `PUT /api/config/roles/:role`.**
`config.service.ts:175-217` expands the toggles and writes
`prisma.role.updateMany({ data: { permissions } })` behind `ROLE_MANAGE`
only; `assertRoleWithinCallerPrivilege` has two callers, both in
`role.service.ts`, none here. `audit.delete`, `backup.restore` and
`roles.manage` are `configurable: true` in the tree (`permission-tree.ts:183,
:191, :291`). An ADMIN sends `{permissions:{"audit.delete":true}}` for
ADMIN and holds `AUDIT_DELETE` at once (`invalidateRolePermsCache`). No e2e
covers the route. Fix: assert the expanded set is within the caller's
privilege; refuse editing one's own role unless SUPER_ADMIN.

**API-2 · HIGH · [verified] — Scope and panel saves with `{}` widen to
everything, then 500 with no audit row.** `roles/routes.ts:561` (and `:772`,
`:894`, `:930`) declare `body: { properties: { scope } }` with no
`required`; `scope ?? Prisma.DbNull` writes SQL NULL (= unrestricted / all
panels) and commits; then `describeScope(undefined)` throws before
`auditLog`. Fix: `required: ['scope']` / `['panels']` (the dashboard-layout
route already does).

**API-3 · HIGH · [verified] — `PUT /api/functional-locations/:id` 500s after
the rename committed.** `routes.ts:533` returns `ownCount: counts.get(id)`,
a `LocationCount` object, into a schema field declared `integer`; the
serializer throws. The GET at `:268` correctly reads `.total`. The web calls
this on every rename; the operator sees "could not save", retries, and
writes a second audit row. No PUT e2e exists. Fix: `c?.total ?? 0`, add the
e2e.

**API-4 · HIGH · [verified] — Location `name` is unbounded and three audit
rows are written outside the transaction with the path in
`signature_meaning VARCHAR(255)`.** `validation.ts` checks only `!name`;
`boundedMeaning()` (added 2026-10-03) is used in 2 places, not on create
(`:328`) or update (`:529`). A long name under a long block commits the row
and fails the audit insert — a §11.10(e) gap. Fix: bound the name, route
every meaning through `boundedMeaning`, move the writes into the
transaction.

**API-5 · HIGH · [verified] — `GET /api/instruments/:id/attributes` ignores
visibility and is an existence oracle.** `routes.ts:2614` is a bare
`findUnique`, unlike `GET /:id`, `/telemetry`, `/telemetry-keys` and
`/dead-letters`. Attributes carry Location, Building, every limit and range.
Fix: `findFirst({ where: withVisibility({ id }, visibility) })`.

**API-6 · HIGH · [verified] — The public admin-request endpoint writes a
caller-supplied identity into `audit_trail.user_id`.**
`admin-request.service.ts:56-57` sets `userId: request.requesterEmployeeId`
on `ADMIN_REQUEST_SUBMITTED` behind a `skipAuth: true` route; an anonymous
POST with `requesterEmployeeId: "superadmin"` attributes a chained row to
superadmin. Fix: add the action to `SYSTEM_AUDIT_ACTIONS`, pass no `userId`
(the id is already in `afterValue`).

**API-7 · MEDIUM · [reported] — Mutation and `auditLog` not in one
transaction outside the instruments module.** Users (delete audits BEFORE
the delete, `user.service.ts:257-268`), roles, alarm-webhooks,
instrument-profiles, admin-requests; none passes `tx` to `auditLog`
contrary to `lib/audit.ts:74-80`. Fix: `$transaction` + `auditLog(entry, tx)`.

**API-8 · MEDIUM · [reported] — Unscoped pickers and the location DETAIL
route disclose the whole estate.** `instruments/routes.ts:550-571`
(`/eligible-children`), `:574-598` (`/:id/children`),
`functional-locations/routes.ts:172-213` (`/linkable-instruments`), and
`GET /:id` at `:247` calling `loadOwnCounts()` without `visibility` while
the list passes it. Fix: pass visibility; scope or document the pickers.

**API-9 · MEDIUM · [verified] — Instrument WRITE routes ignore visibility.**
`PUT /:id` (`:1654`), `DELETE /:id` (`:1906`), token routes and the three
attribute writes all use `findUnique({ where: { id } })`. A supervisor
scoped to Block A can rename, delete or set limits on a Block B instrument
by id. Unconfirmed whether this is an accepted design; if so, write it
beside the visibility note. Fix: resolve visibility once per handler.

**API-10 · MEDIUM · [verified] — Profile key-removal cascade bypasses the
attribute-access gate and visibility.** `instrument-profiles/routes.ts:423-431`
deletes the attribute from every instrument of the profile; `grep
attribute-access` in the file → 0. A SELECTED-keys role that cannot delete
a limit on one instrument removes it from all 101 via the profile.

**API-12 · MEDIUM · [reported]** — audit and notification list dates reach
Prisma as `Invalid Date` → 500 + a SYSTEM_ERROR notification
(`audit/routes.ts:142`, `notification.service.ts:404`); `.parse` not
`safeParse` at `audit/routes.ts:99`. **API-13 · MEDIUM** — redact and
bulk-redact are check-then-write (no `AND redacted_at IS NULL`). **API-14 ·
MEDIUM · [verified]** — response-schema stripping: notifications list drops
`targetUserId`/`forRole`/`forUserId`/`metadata` (the web renders the first,
`notifications/index.tsx:520`); `readAt`, audit detail `userId`/`userRole`,
`users.email`, `roles.description` not `nullable` → `""`. **API-15 · MEDIUM**
— deactivating a role changes nothing (`rbac.ts getRolePerms` ignores
`isActive`); system-role field drops are silent. **API-16 · MEDIUM** —
single/bulk notification access is wider than list visibility. **API-17 ·
LOW · [verified]** — `system-health` disk metrics shell out to `wmic`, absent
on this Windows (`where wmic` → not found); the empty catch returns zeros.
**API-18 · LOW** — `access-matrix`, `export-options`, `report-page-titles`
static config routes have no validation and no re-auth; export-options
fails open to BOTH. **API-19 · LOW** — N+1 in `eligibleApprovers` (~6
queries per candidate per PDF request); alarm summary loads every
attribute. **API-20 · LOW** — smaller items: `MAX_FILE_SIZE` env never
applied and `/photo` drifted to 400 vs 413; backup restore returns raw
error text; a second `PrismaClient` in admin-requests and the email
channel; webhook delete race → unmapped P2003; webhook headers unvalidated
(CR/LF breaks every delivery); location instrument-link ignores unknown
ids; role-keyed upserts never check the role exists; role delete is
check-then-delete; unescaped `LIKE` in id generation; `/users/stats` and
`/users` hide different accounts; `MODIFY_USER` request forwards an
untyped `role` (UNCONFIRMED — verify `user.service.ts:173` refuses
SUPER_ADMIN).

Done right: hard-delete and redact write their meta-row in the same
transaction under the advisory lock and scope non-SA away from SA rows;
`normalizeScope` / `normalizePanels` are the single readers of the two-shape
columns; the users list fails to 400 with `safeParse`; `configService`
fails closed on a corrupt row; the alarm-webhook deliveries route IS
scoped; every instruments/alarms/floorplans/report-reviews/webhooks schema
declares what its handler returns.

### 2.4 Data layer and §11 records (18)

**DATA-1 · HIGH · [verified] — Backup restore's audit-chain check hashes the
wrong field set.** `backup.repository.ts:375-387` passes `timestamp, userId,
action, targetType, targetId, afterValue, checksum, previousChecksum,
checksumVersion`; since 2026-07-04 `lib/audit.ts:116-131` hashes also
`userName, userRole, beforeValue, reason, ipAddress, userAgent, sessionId,
signatureMeaning` (and `redactedAt`). No real row can match, so every
restore returns `BACKUP_AUDIT_CHAIN_INVALID` and is run with `force: true`
— which both restore e2e calls do. A forged archive installs the same way.
Fix: map every column as `audit-verify.ts:161-191` does; add a restore e2e
WITHOUT `force`.

**DATA-3 · HIGH · [verified] — `audit_trail.user_role` is `VARCHAR(20)`;
role names may be 50.** `baseline/migration.sql:207`, `schema.prisma:241` vs
`roles.name VarChar(50)` (`:87`) and `createRoleSchema.name max(50)`; the
insert is raw with no clamp. A role `QUALITY_ASSURANCE_LEAD` (22 chars)
cannot log in (`LOGIN_SUCCESS` throws 22001) and every regulated write 500s.
Same class as the `signature_meaning` 255 defect fixed today. Fix: widen to
50 by migration.

**DATA-4 · HIGH · [verified] — Every upgrade reseeds and resets system role
permissions.** `seed.ts:47-56` upserts each default role with `update: {
permissions }`; `upgrade.ps1` and `digilog-lib.sh` run "migrate deploy +
seed" on every upgrade; Roles & Access writes the expanded set into the
same column. Grant SUPERVISOR `REPORT_REVIEW_APPROVE`, upgrade, and the
grant is gone with no audit row while the toggle still shows on. Fix:
update only non-authorisation fields on an existing role; re-run the
`role_configs` expansion after seeding.

**DATA-5 · HIGH · [verified] — Credentials leave in every backup in clear
text.** `stripSensitiveColumns` (`backup.repository.ts:257-276`) strips only
`password_hash`; SMTP `password`, SMS credentials, LDAP `bindPassword`
(`ldap.service.ts:109-113`) and `alarm_webhook_targets.headers` are stored
unencrypted and exported as is. `grep encrypt` in those modules → 0. Fix:
extend the strip with a sentinel and re-apply on restore, as
`password_hash` already does, or encrypt at rest.

**DATA-6 · MEDIUM · [verified] — No UPDATE guard on `audit_trail`.** Only
`BEFORE DELETE` exists (`baseline:585`, `invariants.sql:23`).
`hash-chain.ts:494-496` short-circuits a redacted row before the HMAC check,
so `UPDATE audit_trail SET before_value=NULL, after_value=NULL,
redacted_at=now()` from any DB session passes verify-chain with no meta row.
Fix: a `BEFORE UPDATE` trigger allowing only the NULL→value redaction
transition; cross-check each redacted row against a meta row.

**DATA-7 · MEDIUM · [reported] — The approved report snapshot has no
tamper evidence.** `data_snapshot` JSONB, no hash column, no trigger; the
audit rows carry title and status, never a digest. Fix: `sha256` of the
canonical snapshot on the row and in both audit rows; refuse download on
mismatch.

**DATA-8 · MEDIUM (open since 08-29) · [reported]** — audit hard-delete
enabled by default (`audit-immutability.ts:623-625` `!== 'false'`). Fix:
ship `AUDIT_HARD_DELETE_ENABLED=false` in the installer `.env` templates.

**DATA-9 · MEDIUM · [reported]** — retention drops partitions with no audit
row; `RETENTION_EXECUTED` is registered and never written. **DATA-10 ·
MEDIUM · [reported]** — audit action registry drift: 11 actions written in
production and absent from `AUDIT_ACTIONS` (`AUDIT_RECORD_REDACTED`,
`ROLE_CREATED/UPDATED/DELETED`, `ADMIN_REQUEST_SUBMITTED`,
`LDAP_CONFIG_UPDATED`, `SUPER_ADMIN_API_ACCESS_CHANGED`,
`UPDATE_EMAIL_CONFIG`, `UPDATE_SMS_CONFIG`, `DASHBOARD_CREATED`,
`AUDIT_RECORDS_BULK_REDACTED`); 29 registered and never written; the
header's "16 unemitted" list is stale; `SYSTEM_AUDIT_ACTIONS` allow-lists
NULL user for 9 names with no writer. Fix: add the 11, prune the dead, a
unit test asserting every `action:` literal is a key. **DATA-11 · MEDIUM**
— most re-authenticated writes record no operator reason (72 `enforceReauth`
sites, 9 require a reason; users, roles, floorplans, functional-locations
require none). **DATA-12 · MEDIUM** — restore cannot land readings for a
month whose partition is absent in the target (whole restore rolls back).
**DATA-13 · MEDIUM** — `audit_trail.user_id` holds usernames from routes
and a UUID from `purge-alarms.ts:93`. **DATA-14 · LOW** — `hash-chain.ts`
comments still say new writes use V1. **DATA-15 · LOW** — session sweep
is not atomic per session (duplicate LOGOUT rows after a crash). **DATA-16
· LOW** — `fill=0s` on the daily and partition crons; `dead_letters` never
purged. **DATA-17 · LOW** — an untracked stale `prisma/seed.mjs` with 217
filter-domain permissions that `apply-schema.ps1` prefers when present (dev
only; the installer rebuilds). **DATA-18 · LOW** — ranged `verify-chain`
treats its first row as genesis, so a break at `fromPosition` is invisible.

Schema vs migrations checked and consistent: `instrument_telemetry_history`
still has no Prisma model and every `DROP` of it in migrations is a comment;
the migration-safety guard runs on `npm run db:migrate` and in tests but
NOT on `apply-schema.ps1`, `deploy-on-ubuntu.sh` or `digilog-lib.sh`, which
call `prisma migrate deploy` directly (bounded risk: committed migrations
only). The four partial unique indexes and `instruments_code_lower_unique`
are present in migrations and absent from the datamodel as expected.
Counts re-derived: 37 models, 13 enums, 38 migrations, 25 modules, 6 worker
tasks = 6 crontab/enqueue identifiers.

Done right: chain writes serialised under an advisory lock inside the
caller's transaction with a keyed HMAC and an out-of-band anchor; report
review's one conditional `updateMany`; backup refuses incomplete archives,
bounds decompression, re-enables the trigger in `finally`; alarms are
`onDelete: Restrict` and the one purge is audited and dry-runs by default;
every cron identifier has a handler and vice versa; the seed refuses to run
without `INITIAL_ADMIN_PASSWORD`.

### 2.5 Web app (18)

**WEB-1 · HIGH · [verified] — Super Admin API-access password boxes invite
browser autofill.** `components/super-admin-api-access.tsx:68, :159` are
bare `<input type="password" autoComplete="current-password">` in no
`<form>`; every other signature box is `SignaturePasswordInput`. Whoever
sits at an unlocked super-admin workstation presses Enter and flips
privileged APIs with the super admin's name on the audit row — the
08-31 acknowledge-dialog mechanism. Fix: `SignaturePasswordInput`.

**WEB-2 · MEDIUM · [verified] — The chart axis prints the browser's locale
and zone, and the signed PDF inherits it.** `time-series-chart.tsx:327-328`
(`toLocaleDateString/TimeString(undefined, …)`) feed the axis labels;
`chart-image.ts` rasterises this chart into the Trend PDF. The hover table
beside it uses the administered formatter. Fix: use `useDatetimeFormat`'s
`formatDate`/`formatTime` in `fmtTime`.

**WEB-3 · MEDIUM · [reported] — Storage reads in the render path are
unwrapped.** `use-auth.ts:48` (`getToken` during render), `use-single-tab.ts`
(9 sites), `api-client.ts` (3); `app-layout.tsx:28-36` wraps its one read and
explains why. A browser blocking site data throws in `useAuth` and takes the
shell to the root error boundary. Fix: one `safeStorage` helper.

**WEB-4 · MEDIUM · [verified] — The forced landing page (`/`) is unguarded.**
`main.tsx:110` has no `RequireRole`; the dashboard fetches three
INSTRUMENT_READ / FUNCTIONAL_LOCATION_READ routes, the 403 toast is
suppressed, and a user-admin role now lands there after every login
(today's change) seeing "0 instruments" and an error with no explanation.
Fix: guard `/` on `DASHBOARD_VIEW` as the tree declares, or land on the
first visible sidebar item; null-key the three fetches.

**WEB-5 · MEDIUM · [verified] — `/users` route guard is wider than its
API.** `main.tsx:114` admits seven USER_* permissions; `GET /api/users` and
`/stats` require `USER_READ` alone; the list destructures no `error`. Fix:
guard on `USER_READ`.

**WEB-6 · MEDIUM · [verified] — Instruments list turns a failed fetch into
"No instruments registered yet".** `instruments/list.tsx:133` omits
`error`; 157 of the app's `useSWR` destructures omit it; eight route files
never reference `error` at all. Fix: destructure and render the failure
line the dashboard table already renders.

**WEB-7 · MEDIUM · [reported] — Selection-alarms panel: Acknowledge sits
off-canvas with the only scrollbar at the table's foot.** Eleven nowrap
columns at `size="lg"`; the action column is deliberately not sticky
(tint). Not clipped; hidden with no cue. Fix: sticky cell painted from
`tint.plate`, or let Location wrap.

**WEB-8 · LOW · [verified]** — `routes/config/alarm-rule-dialog.tsx` (276
lines) survived the 08-31 alarm-rules removal; its only importer is its
test. **WEB-9 · LOW** — dead exports: `fetchReview`, `reviewSignatures`
(`apps/web/CLAUDE.md` still names it), `logReportExportOrWarn`,
`useFailureText`, `TimeSeriesChart.lastReading`, `ACTIVE_QUADRANTS`,
`card.gradient` ×13. **WEB-10 · LOW** — Capacitor remnants: `/m/login`
branch in `api-client.ts:73-77`, `window.Capacitor` check in
`change-password.tsx:92-95`, `access_token_backup` removed but never set.
**WEB-11 · LOW** — three files hand-roll `fetch` with a raw token read
(`pdf-report.ts:82`, `backup.tsx:116,156,185`), the pattern that 401'd
photo upload until 08-11. **WEB-12 · LOW** — readings "as of" tooltip uses
`toLocaleString()` (`telemetry-table.tsx:709`). **WEB-13 · LOW** —
Date/Time save revalidates `/current`, not the key it fetched. **WEB-14 ·
LOW** — index keys on deletable rows (ldap groups/mappings, webhook
headers, notification rules). **WEB-15 · LOW** — 46 route files write
without a client schema (server validates; cost is a generic toast).
**WEB-16 · LOW** — brand defaults still read `DigiLog` / `DL`
(`use-branding.ts:9-11`, `pdf-report.ts:60`, `email-settings.tsx:155,298`);
`apps/web/CLAUDE.md` still opens "DigiLog Web" on port 5175 / :3000.
**WEB-17 · LOW** — hard-coded colours where tokens exist (Settings slot
bars, history widget inks, permissions tab, `main.tsx:83` spinner).
**WEB-18 · info** — polling inventory; `use-single-tab` writes localStorage
every second; nothing pauses on `document.hidden`.

Done right: every `useCan` node id exists in the tree and the hook fails
closed; every §11 signature box is `SignaturePasswordInput` except WEB-1;
the hero popup containment was fixed at the source today; config surfaces
agree with the API's gates; 0 `console.log`; the full-screen floor is
portalled out of the grid's transform.

### 2.6 Documentation drift, scripts and tooling

Live counts re-derived by the lead on 2026-10-03 and all matching root
`CLAUDE.md` System Stats: 37 models, 13 enums, 44 permissions, 50 reauth
actions, 25 modules, 34 config defs, 23 config pages, 25 hooks, 21 lib
modules, 53 routes, 14 sidebar items.

The drift has moved out of root `CLAUDE.md` and into the secondary docs and
the tooling. 23 findings; the four rated HIGH are documentation and
repository hygiene, not runtime defects, and are listed apart from the
sixteen in §1 for that reason.

**DOCS-1 · HIGH · [reported] — `docs/recreation/` is a 2026-07-25 snapshot
wrong on every headline number** (23 models, 30 permissions, 39 reauth, 38
routes, 9 sidebar items, 3 tasks against 37 / 44 / 50 / 53 / 14 / 6 today),
while root `CLAUDE.md:14` still calls it "the verified inventory". Fix:
re-stamp it or change the sentence to "verified 2026-07-25; superseded by
System Stats".

**DOCS-2 · HIGH · [verified] — A git worktree is committed as a dangling
submodule gitlink.** `git ls-files -s .claude/worktrees` → `160000
80a2e35… .claude/worktrees/ui-redesign-stage2`; no `.gitmodules`; swept in
by `7ee1a27` (2026-09-18). Every fresh clone (the GitHub runner, the AWS
checkout) gets a pointer to a commit that exists nowhere, and repo-wide
greps find a second stale copy of the tree under that path. Fix: `git rm
--cached .claude/worktrees/ui-redesign-stage2`; add `.claude/worktrees/` to
`.gitignore`. Operator to confirm — it is an index change.

**DOCS-3 · HIGH · [verified] — Four scripts call `prisma.alarmRule`, removed
2026-08-31.** `demo-live-scenario.ts`, `probe-alarms.ts`,
`probe-live-alarm.ts`, `seed-demo-alarms.ts`. They never surfaced because
`apps/api/tsconfig.json` includes `src/**/*` only, so `npm run lint` never
type-checks `apps/api/scripts/` or `scripts/*.ts`; they fail at `tsx` run
time. Root `CLAUDE.md:92` still cites the first as the password reference.
Fix: delete or rewrite the four; add a scripts tsconfig to `lint`.

**DOCS-4 · HIGH · [reported] — `API_REFERENCE.md` documents none of the six
instrument-era modules and ten lines of the removed filters module**; its
own drift banner is stale (23 modules, 42 permissions, 47 reauth; port
3000). Fix: regenerate from `/docs/json` or archive it and point the Active
doc set at `docs/recreation/06-api/endpoints.md`.

**DOCS-5 · MEDIUM · [reported]** — count drift across the per-package and
root docs (the reviewer's table; root `CLAUDE.md` System Stats is the one
set that matches). **DOCS-6 · MEDIUM** — `docs/CONTRIBUTING.md`'s
12-touchpoint rule points at a file path that does not exist. **DOCS-7 ·
MEDIUM** — `BACKEND_GUIDE.md` names a test file that does not exist and a
worker purpose that was removed. **DOCS-8 · MEDIUM** —
`LOCAL_SETUP_WINDOWS.md` still walks a new developer through DigiLog.
**DOCS-9 · MEDIUM** — `windowsIssues.md` records retired components as
current. **DOCS-10 · MEDIUM** — `docs/deployment-methods/` says the MQTT
broker was removed; the installer bundles it. **DOCS-11 · MEDIUM ·
[verified by read]** — root `CLAUDE.md` contradicts itself three times: an
APK TLS-notes bullet (`:144`) and `:436` against "no Capacitor build"
(`:20-21`); "only one database now: `digilog_db`" (`:434`) against
`compliance_core_db` (`:98-101`); "debug recorder torn out" (`:47-48`)
against the live `debug-traces` module. **DOCS-12 · MEDIUM** —
`DEPLOY-WINDOWS.md` and `docs/PHARMA_DEPLOYMENT_21CFR.md` deploy to tablets
that do not exist. **DOCS-13 · MEDIUM (confidence MEDIUM)** —
`draw-cwh-floorplan.ts` grades rooms by attribute keys retired from every
profile on 2026-09-16. **DOCS-14 · MEDIUM · [verified]** — two phantom
dependencies ride on hoisting: `graphile-worker` imported by three API
workers and declared only in `packages/queue`; `react-resizable/css` imported
by `panel-grid.tsx` and declared nowhere in `apps/web`. **DOCS-15 · MEDIUM
(confidence MEDIUM)** — the CI workflow's stated glibc guarantee does not
match its runner. **DOCS-16 · LOW** — Node version pinned nowhere, stated
inconsistently. **DOCS-17 · LOW · [verified]** — `apps/web/approved.pdf`,
`draft.pdf`, `x.pdf` are tracked vitest outputs; the two decks (12 MB and
6.4 MB) are the only blobs over 2 MB and the second is about to land a
second copy. **DOCS-18 · LOW** — `.gitignore` carries DigiLog's rules
(`mosquitto/`, `RFID/`, `*.apk`, `*.jks`) and `/*.png` hides the root
`QC Layout.png` that root `CLAUDE.md` cites as a trace source. **DOCS-19 ·
LOW** — Phase 5 NSSM service scripts are orphaned. **DOCS-20 · LOW** — dead
or one-shot scripts sit beside live ones with no marker. **DOCS-21 · LOW** —
`vitest.workspace.ts` omits the queue package. **DOCS-22 · LOW** — a
load-bearing safety file carries a stale explanation. **DOCS-23 · LOW** —
`apps/api/CLAUDE.md` keeps a removed-modules list beside the live one.

Done right: root `CLAUDE.md` System Stats match the live tree on all eleven
counts; every cron identifier has a handler; `CHANGELOG.md` carries the
operator's words for each change; `scripts/check-migration-safety.mjs`
guards the partitioned table on the documented path.

---

## 3. Recommended order of work

Each line is one commit-sized unit; the HIGHs first.

1. **Partitions and batch loss (INGEST-1, INGEST-2):** `ensurePartitions` at
   boot and in both installers; bounded `fill`; catch `writeBatch` failures
   into a dead letter. Blocks every customer install this month.
2. **Role config privilege check (API-1)** and **required scope body
   (API-2).** Two small server changes, both with an e2e.
3. **Backup: chain verifier field set (DATA-1), secret stripping (DATA-5),
   restore partitions (DATA-12).**
4. **Seed must not reset permissions (DATA-4)** — before the next customer
   upgrade.
5. **`user_role` to 50 (DATA-3)** and **bound every `signature_meaning`
   centrally in `auditLog`** (closes API-4 and the whole class).
6. **Functional-location PUT serializer (API-3)**, with the missing e2e.
7. **Visibility on attribute read and the write routes (API-5, API-9,
   API-8, API-10)** — one pass over `instruments/routes.ts` and
   `instrument-profiles/routes.ts`.
8. **Public admin-request attribution (API-6).**
9. **Alarm double-clear (INGEST-4)** and **range pass coercion (INGEST-3)**;
   while there, INGEST-5/6/8/16.
10. **`_currentPassword` strip before early return (SEC-1)** and
    **`verifyReauthPassword` in the config PUT (SEC-2)**.
11. **`SignaturePasswordInput` on the SA API-access card (WEB-1)**; guard
    `/` and `/users` (WEB-4, WEB-5); chart axis formatter (WEB-2).
12. The MEDIUM/LOW remainder as a sweep per module, with the dead-code and
    stale-doc deletions last.

## 4. Health score

| Area | Aug 29 | Oct 3 | Note |
|---|---|---|---|
| Security posture | 82 | 74 | API-1, SEC-1, SEC-2, WEB-1 |
| Data integrity (§11) | 70 | 64 | DATA-1, -3, -4, -5, -6, API-4, API-6 |
| Correctness | 72 | 70 | API-3, INGEST-1..4 |
| Operability | 70 | 68 | partitions at install; backup restore |
| Documentation | 60 | 68 | root counts match; dossier, API reference and setup docs stale; a dangling gitlink in the index |
| Tests | 85 | 82 | the write paths above have no e2e; scripts never type-checked |
| **Overall** | **74** | **70** | |
