# Phase 5 — Database Reverse Engineering

*Verified against the live `compliance_core_db` and `schema.prisma`, 2026-07-25.
Re-verified 2026-08-01 after the Data Injection (P1) migration — see §11.
Re-verified 2026-08-03 after the Data Injection (P3) migration — see §13.*

```bash
grep -cE '^model ' apps/api/prisma/schema.prisma   # → 36 (2026-08-03; was 30 after P1, 23 pre-P1)
grep -cE '^enum '  apps/api/prisma/schema.prisma   # → 12 (2026-08-03; was 8 after P1, 6 pre-P1)
```

> The audit chain is documented separately in
> [`audit-chain.md`](audit-chain.md) — it is the compliance core of the product
> and deserves more than a table row.

---

## 1. The models, by bounded context

> **CURRENT COUNT: 36 models, 12 enums** (verified `grep -cE "^model " ` /
> `grep -cE "^enum "` against `apps/api/prisma/schema.prisma`, 2026-08-03).
> The breakdown below predates Data Injection. P1 added 7 models + 2 enums
> (hierarchy, gateways, instruments, communication profiles, protocols);
> **P2 added 3 more** — `InstrumentTelemetryLatest`, `InstrumentTelemetryHistory`
> (monthly RANGE partitions) and `DeadLetter`; **P3 added 3 more models + 4
> enums** — `AlarmThreshold`, `Alarm`, `InstrumentLiveness`; `AlarmState`,
> `AlarmSeverity`, `ThresholdOperator`, `LivenessState` (§13).
>
> Telemetry timestamps are `timestamptz`, matching `audit_trail`. They were
> briefly `timestamp` and that produced a 5.5-hour skew on an IST host — see the
> CHANGELOG entry for 2026-08-02.
>
> Telemetry is NOT audited (spec D5): it is process data, not a §11 electronic
> record. Resolving a dead letter IS audited (`DEAD_LETTER_RESOLVED`). Alarm
> acknowledgement IS audited AND is itself the §11.50 electronic signature
> (§13) — a different posture from telemetry/dead-letters, deliberately.

### Pre-Data-Injection models, by bounded context

### Identity & access (7)
| Model | Table | Purpose |
|---|---|---|
| `User` | `users` | Accounts; `UserStatus` lifecycle |
| `Role` | `roles` | 6 seeded + custom; `hierarchy_level`, `permissions` jsonb |
| `Session` | `sessions` | Active sessions; single-session enforcement |
| `PasswordHistory` | `password_history` | Reuse prevention (`preventReuseCount`) |
| `PasswordResetRequest` | `password_reset_requests` | Reset workflow |
| `UserGroup` | `user_groups` | Notification/assignment grouping |
| `UserGroupMember` | `user_group_members` | Membership join |

### Compliance record (1)
| Model | Table | Purpose |
|---|---|---|
| `AuditTrail` | `audit_trail` | **Hash-chained, append-only.** See [`audit-chain.md`](audit-chain.md) |

### Configuration (4)
| Model | Table | Purpose |
|---|---|---|
| `SystemConfig` | `system_config` | Key→jsonb for all 21 config surfaces |
| `FieldIdConfig` | `field_id_config` | Per-field label/ID overrides (17 rows) |
| `RoleConfig` | `role_configs` | Per-role sidebar / widgets / permissions |
| `UserConfig` | `user_configs` | Per-user overrides, merged over role config |

### Workflow (1)
| Model | Table | Purpose |
|---|---|---|
| `AdminRequest` | `admin_requests` | Self-service request → approve/reject |

### Notifications (5)
| Model | Table | Purpose |
|---|---|---|
| `Notification` | `notifications` | Per-user inbox |
| `NotificationTemplate` | `notification_templates` | Message templates |
| `NotificationLog` | `notification_logs` | Delivery attempts + status |
| `NotificationRule` | `notification_rules` | Event → recipients binding |
| `NotificationRuleRecipient` | `notification_rule_recipients` | Recipient rows (user/role/group) |

### Dashboards (3)
| Model | Table | Purpose |
|---|---|---|
| `Dashboard` | `dashboards` | Definition |
| `DashboardWidget` | `dashboard_widgets` | Widgets (cascade on dashboard delete) |
| `DashboardAssignment` | `dashboard_assignments` | Role/user assignment |

### Help (2)
| Model | Table | Purpose |
|---|---|---|
| `HelpArticle` | `help_articles` | In-app documentation, keyed for deep-links |
| `HelpArticleVersion` | `help_article_versions` | Version history (cascade) |

## 2. The 6 enums

`AssigneeType`, `UserStatus`, `NotificationType`, `NotificationChannel`,
`NotificationDeliveryStatus`, `NotificationEventType`.

- `UserStatus` = `ENABLED | DISABLED | LOCKED | EXPIRED`
- `NotificationEventType` still contains **6 dead upstream values**
  (`DEVICE_ONLINE`, `DEVICE_OFFLINE`, `DEVICE_INACTIVITY`,
  `CHECKLIST_SUBMITTED`, `CHECKLIST_APPROVED`, `CHECKLIST_REJECTED`). Live
  values are `USER_LOGIN`, `USER_CREATED`, `USER_LOCKED`, `SYSTEM_ERROR`.
  A rebuild should model **only the live four**.
- `AssigneeType` was trimmed upstream during multi-tenancy removal and retains
  more values than are used.

## 3. Relationships

**8 declared foreign keys** in the pre-P1 schema — this was a deliberately
shallow schema. **Data Injection P1 adds 9 more** (§11.3), all `onDelete:
Restrict` except the two cascade-on-parent-instrument sidecars — bringing the
live total to **17**. The "deliberately shallow" characterization above still
holds for the original 23-model core; P1 is a genuinely relational subsystem
layered on top of it, not a continuation of the shallow style.

| Child | → Parent | On delete |
|---|---|---|
| `DashboardWidget` → `Dashboard` | Cascade |
| `DashboardAssignment` → `Dashboard` | Cascade |
| `PasswordHistory` → `User` | Cascade |
| `Session` → `User` | Cascade |
| `HelpArticleVersion` → `HelpArticle` | Cascade |
| `UserGroupMember` → `UserGroup` | Cascade |
| `NotificationRuleRecipient` → `NotificationRule` | Cascade |
| `NotificationRuleRecipient` → `UserGroup` | **SetNull** |

**`AuditTrail` has no foreign keys — by design.** It stores `user_id` /
`user_name` / `user_role` as denormalised **strings**, not a relation. If it
were an FK, deleting a user would either cascade-destroy audit history or be
blocked forever. Denormalising preserves the record independently of the actors
in it, which is exactly what §11.10(e) requires. **A rebuild must not "fix" this
into a foreign key.**

`SystemConfig`, `RoleConfig`, and `UserConfig` similarly key by string
(`configKey`, `role`) rather than FK, so a role rename does not orphan config.

## 4. Indexing strategy

`audit_trail` carries **7 secondary indexes** — the heaviest-indexed table,
because it is the largest and the most queried:

```
audit_trail_action_idx                 btree (action)
audit_trail_chain_position_idx         btree (chain_position)
audit_trail_session_id_idx             btree (session_id)
audit_trail_target_type_target_id_idx  btree (target_type, target_id)
audit_trail_timestamp_idx              btree (timestamp DESC)
audit_trail_user_id_idx                btree (user_id)
audit_trail_user_id_timestamp_idx      btree (user_id, timestamp DESC)
```

Note the deliberate pairing: a single-column `user_id` index **and** a composite
`(user_id, timestamp DESC)`. The composite serves the dominant "this user's
recent activity" query without a sort; the singleton serves counting/filtering.

`admin_requests` indexes `status`, `request_type`, and `requested_at DESC` —
matching its three list filters exactly.

## 5. Database objects — the complete list

```sql
select count(*) from information_schema.views where table_schema='public';  -- 0
```

| Object type | Count | Detail |
|---|---|---|
| Views | **0** | — |
| Triggers | **1** | `audit_trail_no_delete` BEFORE DELETE ON `audit_trail` |
| Custom functions | **1** | `block_audit_trail_delete()` |
| Sequences | **1** | `audit_trail_chain_position_seq` |
| Extensions | **2** | `ltree`, `pgcrypto` |

Every remaining function in `pg_proc` belongs to `pgcrypto` (`crypt`, `digest`,
`hmac`, `gen_random_uuid`, the `pgp_*` family).

**All three custom objects serve the audit chain.** Business logic lives in the
application tier — with the deliberate exception of delete-blocking, which must
be enforced *below* the application to mean anything against a DB-level actor.

`pgcrypto` is required for `gen_random_uuid()` defaults. `ltree` was flagged
as a removal candidate in the 2026-07-25 pass (no live consumer at the time)
— **that is no longer true as of 2026-08-01**: `hierarchy_nodes.path` (§11)
is an `ltree` column, GiST- and btree-indexed, and is the mechanism the
hierarchy repository uses for single-query ancestor/descendant lookups. Do
not remove the extension.

## 6. Migration strategy — read before any schema change

**The schema is migration-driven. `prisma db push` and `prisma migrate dev`
auto-generation are forbidden against any populated database** — they can
silently drop audit data, which is a regulatory incident, not a bug.

**The baseline is a `pg_dump`, never regenerated.**
`prisma/migrations/00000000000000_baseline/migration.sql` includes triggers,
functions, and the manual sequence — none of which `schema.prisma` can express.
Regenerating it from the datamodel would silently delete them.

### Applying schema to a fresh database
```bash
psql -f prisma/sql/extensions.sql          # ltree + pgcrypto — REQUIRED first
npx prisma migrate deploy                  # baseline fails on a bare DB without them
INITIAL_ADMIN_PASSWORD=... npx prisma db seed
```

### Authoring a new migration
```bash
# 1. edit schema.prisma
# 2. generate a candidate diff
npx prisma migrate diff --from-migrations prisma/migrations \
    --to-schema-datamodel prisma/schema.prisma --script
# 3. hand-author the reviewed SQL into prisma/migrations/<UTC>_<name>/migration.sql
#    (strip trigger/function/sequence noise — those live in prisma/sql/*)
# 4. THE DRIFT GUARD — must PASS before commit
npm run db:verify-migrations
# 5. on already-populated DBs:
npx prisma migrate resolve --applied <name>
```

`verify-migrations.ps1` builds a scratch DB from migrations and asserts it diffs
empty against the dev DB. **This is the safety net that makes the hand-authored
migration flow trustworthy — a rebuild must keep an equivalent.**

## 7. Seed data

`prisma/seed.ts` (+ `default-roles.ts`) is **all upserts**, so it is
upgrade-safe and never overwrites an existing admin password.

Seeds: 6 roles · 1 admin user (`superadmin`, forced password change) ·
21 system configs · 17 field-ID configs · 4 help articles · DB invariants.

**The seed throws if `INITIAL_ADMIN_PASSWORD` is unset** — a deliberate refusal
to let a hardcoded default credential reach an install. Preserve this.

## 8. Live table sizes (fresh install + this session's activity)

```
audit_trail 232 · sessions 67 · system_config 21 · field_id_config 17
users 14 · roles 6 · notifications 5 · help_articles 4
help_article_versions 4 · role_configs 1 · user_configs 1
password_history 1 · password_reset_requests 1
admin_requests 0 · dashboards 0 · user_groups 0 · notification_* 0
```

The shape is characteristic: **`audit_trail` dominates from day one** and grows
monotonically (it can never be pruned by deletion). Capacity planning and
archival strategy must assume this.

`_private_jobs` / `_private_tasks` / `_private_known_crontabs` are
graphile-worker's own tables, co-resident in the same database.

## 9. Backup & recovery

- `scripts/backup-db.ps1` + `register-backup-task.ps1` — scheduled OS-level dumps.
- In-app backup/restore covers all tables dynamically and **includes
  `password_hash`**, so a restore is a genuine point-in-time recovery rather than
  one that locks every user out.
- Three permissions: `BACKUP_MANAGE`, `BACKUP_EXPORT`, `BACKUP_RESTORE`.

**Recovery caveat a rebuild must document:** restoring `audit_trail` from a
backup restores a *valid* chain, but any rows written after the backup are lost.
Since the chain is positional, a partial restore cannot be merged with newer
rows. Backup cadence is therefore an audit-completeness decision, not just an
availability one.

## 10. Test database isolation

The vitest suite runs against **`digilog_test_db`**, forced by `vitest.env.ts`
rewriting `DATABASE_URL` before Prisma connects. This exists because e2e tests
previously wrote **permanent, immutable, hash-chained rows into the real
`audit_trail`** — orphaned records that then surfaced in the live Audit UI.

**This is a compliance requirement, not a convenience.** A rebuild must isolate
test writes from any database holding regulated records.

## 11. Data Injection (P1) — 7 models + 2 enums, landed 2026-08-01

Migrations: `20260801120000_data_injection_p1` (models, seed, the `ltree`
column, the CHECK constraint) + `20260801130000_data_injection_p1_indexes`
(the deferred partial-unique index). Both pass the drift guard.

### 11.1 The 7 models

| Model | Table | Purpose |
|---|---|---|
| `HierarchyNode` | `hierarchy_nodes` | Self-referencing location tree — `COMPANY → SITE → PLANT → BUILDING → BLOCK → AREA → LINE` (`HierarchyLevel` enum, 7 values). Backs UNS topic paths. |
| `Protocol` | `protocols` | Lookup table of communication protocols; `key` is the PK (e.g. `mqtt`, `opcua`). Seeded, not user-creatable. |
| `CommunicationProfile` | `communication_profiles` | A named, reusable set of connection credentials/config (broker URL, auth) for one `Protocol`. |
| `Gateway` | `gateways` | A physical/logical edge device at a `HierarchyNode`, using one `CommunicationProfile`. |
| `Instrument` | `instruments` | A sensor/device — either hangs off a `Gateway` or communicates independently with its own `CommunicationProfile` (§11.4). |
| `InstrumentSetting` | `instrument_settings` | 1:1 sidecar — arbitrary `values Json` per instrument, cascade-deletes with it. |
| `InstrumentTopic` | `instrument_topics` | Per-`TopicCategory` override row (13 categories, one row max per instrument+category via `@@unique`); presence of a row means "don't derive, use this string" (§11.5). |

### 11.2 The 2 enums

- `HierarchyLevel` — `COMPANY | SITE | PLANT | BUILDING | BLOCK | AREA | LINE` (7 values, ordered root→leaf).
- `TopicCategory` — `TELEMETRY | ATTRIBUTES | ALARM | COMMAND | RPC | HEARTBEAT | EVENT | STATUS | CONFIG | RESPONSE | SETTINGS | PUBLISH | SUBSCRIBE` (13 values).

### 11.3 The 9 new foreign keys

| Child | → Parent | On delete |
|---|---|---|
| `HierarchyNode.parent` (self, named relation `"NodeTree"`) | → `HierarchyNode` | Restrict |
| `CommunicationProfile.protocol` | → `Protocol` | Restrict |
| `Gateway.hierarchyNode` | → `HierarchyNode` | Restrict |
| `Gateway.profile` | → `CommunicationProfile` | Restrict |
| `Instrument.hierarchyNode` | → `HierarchyNode` | Restrict |
| `Instrument.gateway` (nullable) | → `Gateway` | Restrict |
| `Instrument.profile` (nullable) | → `CommunicationProfile` | Restrict |
| `InstrumentSetting.instrument` | → `Instrument` | Cascade |
| `InstrumentTopic.instrument` | → `Instrument` | Cascade |

**Every reference is `Restrict`, not `Cascade`, except the two 1:1/1:many
sidecars keyed directly off `Instrument.id`.** Deleting a `HierarchyNode`,
`CommunicationProfile`, or `Gateway` that still has children/dependents fails
loudly rather than silently orphaning or cascading — the same conservatism
the rest of the schema applies to `AuditTrail`. `Instrument` rows delete
their own `InstrumentSetting`/`InstrumentTopic` rows on delete (they have no
independent identity).

### 11.4 The `instruments_reachable_chk` CHECK constraint

```sql
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_reachable_chk"
  CHECK ("gateway_id" IS NOT NULL OR "communication_profile_id" IS NOT NULL);
```

An instrument must be reachable one of two ways: hang off a `Gateway` (and
inherit that gateway's `CommunicationProfile`), or carry its own
`communication_profile_id` and talk independently. Prisma cannot express a
conditional NOT NULL, so this is hand-authored raw SQL in the migration —
same pattern as the partial unique index below. **A rebuild must not drop
this thinking it's redundant with the two nullable FK columns** — without it,
an instrument with both `gateway_id` and `communication_profile_id` NULL is a
device the system has no way to reach.

### 11.5 The `path ltree` column and its indexes

`path ltree` is **deliberately absent from `schema.prisma`** — Prisma maps
`ltree` to `Unsupported()`, which would make the column unselectable through
the typed client. It is added by raw SQL in the migration and read/written
only through `apps/api/src/modules/hierarchy/hierarchy.repository.ts`, which
issues raw SQL for ancestry/descendant queries (single-query, no recursive
CTE needed). Two indexes back it:

```sql
CREATE INDEX "hierarchy_nodes_path_gist_idx" ON "hierarchy_nodes" USING GIST ("path");
CREATE INDEX "hierarchy_nodes_path_btree_idx" ON "hierarchy_nodes" USING BTREE ("path");
```

GiST for ltree's `<@`/`@>` ancestor/descendant operators; btree for exact/
prefix path lookups. This is also why `ltree` is no longer a removal
candidate in §5 above — reverse the earlier flag.

### 11.6 The partial unique index — `hierarchy_nodes_root_slug_key`

```sql
CREATE UNIQUE INDEX "hierarchy_nodes_root_slug_key"
  ON "hierarchy_nodes" ("slug") WHERE "parent_id" IS NULL;
```

Root-level slug uniqueness (no two top-level `COMPANY` nodes sharing a slug)
is enforced by this partial unique index, added in the second, deferred
migration. Prisma cannot express a partial unique index as `@@unique`, so —
same as the CHECK constraint — it exists only in raw SQL and is **not**
visible in `schema.prisma`. Non-root uniqueness (siblings under the same
parent) IS expressible and IS in the schema: `@@unique([parentId, slug])`.
**Do not delete this index as "untracked"** — without it, two root nodes
could share a slug and produce identical UNS topic paths for two different
instrument trees, silently merging their data streams.

### 11.7 Other new indexes

```
hierarchy_nodes_level_idx                     btree (level)
gateways_hierarchy_node_id_idx                btree (hierarchy_node_id)
gateways_communication_profile_id_idx         btree (communication_profile_id)
instruments_gateway_id_idx                    btree (gateway_id)
instruments_communication_profile_id_idx      btree (communication_profile_id)
communication_profiles_protocol_key_idx       btree (protocol_key)
```

### 11.8 Seed data — the protocol registry

18 `Protocol` rows, **all `is_enabled = false`**: `mqtt`, `mqtts`, `http`,
`https`, `websocket`, `wss`, `tcp`, `udp`, `serial`, `modbus-tcp`,
`modbus-rtu`, `opcua`, `kafka`, `amqp`, `azure-iot`, `aws-iot`, `webhook`,
`rest`. Each carries a `capabilities` JSON blob (`publish`/`subscribe`/
`poll`/`write` booleans) describing what an eventual adapter *would* support
— none currently exist. **OPC-DA is deliberately absent** (COM/DCOM, no
viable Node implementation). Shipping any row enabled with no adapter behind
it would misrepresent working functionality; this is a scaffold for a later
phase, not a partial implementation of one.

### 11.9 What P1 does not do

No protocol adapter. No connection to any physical device, broker, or OPC
server. No telemetry table, no data ingestion path, no command dispatch. The
`CommunicationProfile.config Json` column stores credentials for a connection
that nothing in this codebase opens. Partitioning of a future telemetry table
is out of scope for P1 by design (deferred to a later phase) — there is no
telemetry table yet to partition.

> **Note (2026-08-03):** unlike P1, P2's own equivalent section (telemetry
> models, `InstrumentTelemetryLatest`/`History`/`DeadLetter`) was never
> written up here in the same §11-style detail — only the header note in §1
> and the CHANGELOG record it. That gap predates this pass and was not
> closed here (out of scope for the P3 doc sync); flagged for a future pass.

## 12. Data Injection (P2) — telemetry, landed 2026-08-02 (see note above)

Not documented in full here. See `CHANGELOG.md`'s 2026-08-02 entry for the
3 models (`InstrumentTelemetryLatest`, `InstrumentTelemetryHistory` —
monthly RANGE partitions — and `DeadLetter`), the `timestamptz` fix, and the
partition-maintenance worker.

## 13. Data Injection (P3) — alarms & instrument liveness, 3 models + 4 enums, landed 2026-08-03

Migration: hand-authored (Prisma cannot express the two partial unique
indexes below), drift guard PASS.

### 13.1 The 3 models

| Model | Table | Purpose |
|---|---|---|
| `AlarmThreshold` | `alarm_thresholds` | A configured limit for one instrument+key: `operator` (`GT/GTE/LT/LTE/EQ/NEQ/OUT_OF_RANGE`), `limit`/`limitLow`/`limitHigh`, `hysteresis`, `severity`. Evaluated against every flushed telemetry reading for that instrument+key. |
| `Alarm` | `alarms` | One row per open-or-historic deviation series, keyed `(instrument, key, threshold)` for a threshold breach, or `(instrument, key='liveness')` for an offline event. Carries the latching `AlarmState`, `severity`, first/last-breach timestamps, and (once acknowledged) the signer + note. |
| `InstrumentLiveness` | `instrument_liveness` | 1:1 sidecar per instrument — last-seen timestamp + current `LivenessState`; what the sweep reads and updates to stay idempotent. |

### 13.2 The 4 enums

- `AlarmState` — `ACTIVE | ACTIVE_ACKED | RESOLVED_UNACKED | CLOSED` (the latching state machine, §13.4).
- `AlarmSeverity` — `CRITICAL | MAJOR | MINOR | INFO`.
- `ThresholdOperator` — `GT | GTE | LT | LTE | EQ | NEQ | OUT_OF_RANGE`.
- `LivenessState` — `ONLINE | OFFLINE | UNKNOWN`.

### 13.3 The two hand-authored partial unique indexes

Migration `20260803060000_p3_alarms_liveness/migration.sql`:

```sql
CREATE UNIQUE INDEX alarms_one_open_per_threshold_key
  ON alarms (instrument_id, key, threshold_id)
  WHERE state <> 'CLOSED' AND threshold_id IS NOT NULL;

CREATE UNIQUE INDEX alarms_one_open_liveness_key
  ON alarms (instrument_id)
  WHERE state <> 'CLOSED' AND threshold_id IS NULL;
```

Prisma cannot express a partial unique index — same limitation as P1's
`hierarchy_nodes_root_slug_key` (§11.6). Purpose: at most one OPEN
(non-`CLOSED`) alarm per threshold-breach series `(instrument, key,
threshold)`, and at most one OPEN liveness alarm per instrument (the
liveness index has no `key` component — one instrument can only be OFFLINE
once at a time). A re-breach while an alarm is already open updates the
existing row instead of creating a duplicate queue entry. **Do not drop
these as "untracked"** — without them, a flapping threshold or a flapping
connection would spawn a new alarm row on every evaluation instead of
latching one.

### 13.4 The latching alarm state machine

Pure-function implementation, no DB access, in
`apps/api/src/modules/alarms/alarm-state.ts` (`nextTransition` for
raise/re-breach/resolve, called from the flush loop and the sweep;
`applyAck` for the operator-driven acknowledgement, called from the route):

```
            breach
  (none) ───────────▶ ACTIVE ───── recover ────▶ RESOLVED_UNACKED
                        │  ▲                          │      │
                   ack  │  └───── re-breach ──────────┘      │ ack
                        ▼                                    ▼
                  ACTIVE_ACKED ──── recover ──────────▶   CLOSED
```

A brand-new breach starts at `ACTIVE`. An alarm can be acknowledged while
still breaching (`ACTIVE` → `ACTIVE_ACKED`) — acknowledgement records that a
human has seen and is handling an ongoing deviation; it does not require the
deviation to have ended first. **Two invariants, both asserted in tests:**

1. **`CLOSED` is reachable only downstream of a human acknowledgement** —
   there are two paths in, `RESOLVED_UNACKED` **+ `applyAck`** → `CLOSED`
   (an operator acknowledging a since-recovered alarm), and `ACTIVE_ACKED`
   **+ recovery** → `CLOSED` (the flush loop auto-closing an alarm the
   operator already acknowledged while it was still breaching). Both routes
   require `applyAck` to have run at some point on that alarm — the only
   state the ingest flush can close on its own (`ACTIVE_ACKED`) is one a
   human already signed. A plain `ACTIVE` alarm recovering goes to
   `RESOLVED_UNACKED`, never straight to `CLOSED`, so an unacknowledged
   deviation can never leave the queue unseen.
2. **A re-breach on `RESOLVED_UNACKED` walks it back to `ACTIVE`**
   (`backToActive: true`), so a flapping sensor cannot have its excursion
   closed out from under the reviewing operator by a resolve that arrives
   just before the next breach.

`applyAck(state)` returns the post-acknowledgement state, or `null` to
reject (HTTP 409) if the alarm isn't in an acknowledgeable state (`ACTIVE` →
`ACTIVE_ACKED`; `RESOLVED_UNACKED` → `CLOSED`; anything else → `null`).
`null` is a rejection, not a silent no-op — re-signing an already-signed
record would put a second attributable signature on the same event.

### 13.5 Acknowledgement is the §11.50 signature

`POST /api/alarms/:id/acknowledge` uses `enforceReauthAlways`, not the
admin-configurable `enforceReauth` every other reauth-gated route in this
codebase uses. The distinction matters: `enforceReauth` consults the
`action-reauth` config surface and skips the password challenge entirely if
an administrator has not turned it on for the caller's role — appropriate
for actions where re-auth is a security *policy* choice. Acknowledgement
**is** the electronic signature §11.50 requires, not a policy an
administrator can opt out of, so it is hardcoded to always challenge.

The write is atomic with its audit row and protected by a **compare-and-set
on the alarm's current state** (the update's `WHERE` clause includes the
state the handler read), so two operators acknowledging the same alarm
concurrently cannot both succeed — the second write affects zero rows and
the handler surfaces a conflict rather than silently overwriting the first
signer.

### 13.6 Evaluation ordering and failure handling

Alarm evaluation is invoked from the ingest flush loop **strictly after**
`writeBatch` completes — see `apps/api/src/modules/alarms/alarm.service.ts`
and its call site in the P2 ingestion flush path. A threshold is never
evaluated against a reading that has not yet durably landed. An evaluation
failure (DB error, malformed threshold, etc.) writes an
`ALARM_EVALUATION_FAILED` dead letter (the same `DeadLetter` model P2
introduced) rather than throwing past the flush or silently dropping the
failure.

### 13.7 The liveness sweep

`instrument_liveness_sweep` — new 4th background job task, cron `*/5 * * * *`
in `packages/queue/crontab.txt`. Marks an instrument OFFLINE once
`now - lastSeenAt > expectedIntervalSec × gracePeriodMultiplier` (both
configurable; `gracePeriodMultiplier` via the new `liveness` config def, §12
of the inventory doc). The query excludes instruments already `OFFLINE`, so
persisted `InstrumentLiveness` state makes the sweep idempotent — a device
dark for a week produces exactly one OFFLINE transition, not one per 5-minute
tick. `Instrument.expectedIntervalSec` is nullable: liveness monitoring is
opt-in per instrument, not automatic for every row.

### 13.8 Two pre-existing bugs found and fixed while building P3

Neither is a P3 feature; both predate it and were caught during this work.
Full detail in `CHANGELOG.md`'s 2026-08-03 entry.

1. `packages/shared/src/types/reauth-actions.ts`'s `REAUTH_ACTION_CATEGORIES`
   was missing `'Data Injection'`, hiding all 12 P1 reauth actions from both
   reauth-policy editors since P1 landed.
2. `packages/queue/crontab.txt` had a duplicate `?id=` across the two
   `telemetry_partition_maintenance` cron lines, which made graphile-worker
   reject the **entire crontab file** at boot — every background job
   (`notification`, `password_expiry_check`, `session_sweep`, and
   partition maintenance itself) had been silently dead since P2.

### 13.9 What P3 does not do

No new protocol, no change to the P1/P2 ingestion path itself (evaluation
hooks onto the existing flush, it doesn't alter what gets written).
Alarm/threshold rows are audited on every mutating action, but **alarm
STATE transitions other than acknowledgement are never writable from the
REST surface** — raise, re-breach, and resolve are exclusively driven by the
flush loop and the sweep; see the deliberate-deviation note in
`apps/api/src/modules/alarms/routes.ts`'s file header.
