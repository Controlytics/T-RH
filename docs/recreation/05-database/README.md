# Phase 5 — Database Reverse Engineering

*Verified against the live `compliance_core_db` and `schema.prisma`, 2026-07-25;
model count re-verified 2026-08-06 after the Instruments + instrument-gateway
work (never previously synced into this doc — see §1a).*

```bash
grep -cE '^model ' apps/api/prisma/schema.prisma   # → 27
grep -cE '^enum '  apps/api/prisma/schema.prisma   # → 6
```

> The audit chain is documented separately in
> [`audit-chain.md`](audit-chain.md) — it is the compliance core of the product
> and deserves more than a table row.

---

## 1. The 28 models, by bounded context

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

### Instruments (5)
| Model | Table | Purpose |
|---|---|---|
| `Instrument` | `instruments` | Device registry. See §1a below — the gateway/placement/last-seen columns landed after the 2026-07-25 count and were never previously documented here. |
| `InstrumentCredential` | `instrument_credentials` | Per-instrument device tokens. `tokenHash` (SHA-256) is the ONLY thing authentication consults. Since 2026-08-06 a second copy is stored in `tokenEncrypted` (AES-256-GCM under `INSTRUMENT_TOKEN_KEY`) purely so `GET /api/instruments/:id/token` can show it — nullable, so credentials issued earlier or on a key-less deployment simply stay unviewable. Cascades on instrument delete |
| `InstrumentAttribute` | `instrument_attributes` | Free-form operator-recorded facts per instrument (calibration due, asset tag, …). Unique on `(instrumentId, key)`, one audit row per key change; cascades on instrument delete |
| `InstrumentTelemetryLatest` | `instrument_telemetry_latest` | Most recent value per `(instrumentId, key)` — no FK, `instrumentId` is an indexed plain column |
| `DeadLetter` | `dead_letters` | Rejected/unparseable ingest payloads, kept for diagnosis; no FK |

## 1a. `Instrument` — placement, gateway link, and last-seen (added 2026-08-05)

Verified against `apps/api/prisma/schema.prisma:750-791` and migration
`20260805120000_instrument_gateway`:

| Column | Type | Notes |
|---|---|---|
| `location`, `area`, `block` | `TEXT?` | Free text by design (spec D8) — no lookup tables, no admin screens. `code` remains the unique identifier and the ingest topic segment. |
| `is_gateway` | `BOOLEAN NOT NULL DEFAULT false` | Marks an instrument as a relay that may submit telemetry on behalf of other instruments. |
| `gateway_id` | `TEXT?` | Self-referencing FK → `instruments.id`, `ON DELETE SET NULL`. **This column is the authorisation rule**: a gateway's device token may write instrument X's telemetry iff `X.gateway_id = gateway.id` — one comparison, no link table. Deleting a gateway unlinks its children; it never deletes them. |
| `last_seen_at` | `TIMESTAMPTZ(3)?` | When a reading last landed **for this instrument**, whether direct or via a gateway. |
| `last_seen_via` | `TEXT?` | `'direct'` or `'gateway'` — which path the last reading arrived by. |

**Behaviour change worth flagging:** last-seen used to live on the
credential (`InstrumentCredential.lastUsedAt`, "did this token authenticate
recently"). It now lives on the instrument and means "did a reading land" —
because a child instrument reported through its gateway never presents its
own credential, so a credential-derived value would permanently read "Never"
for exactly the instruments the gateway feature serves.

A `CHECK` constraint (`instruments_gateway_not_self`) blocks an instrument
from being its own gateway; the two richer invariants — a gateway has no
parent of its own, and only a gateway may be a parent — read another row and
are enforced in the service layer, not the database (`gateway-invariants.ts`).

**Transaction ordering:** any transaction that both locks an instrument row
and calls `auditLog` must take the row lock **first** — `auditLog` holds the
audit chain's advisory lock to commit, and locking a row after that cycles
against a concurrent writer (Postgres kills one side with `40P01`). See
`apps/api/DECISIONS.md` §4a for the full rationale and the reproduction case.

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

**10 declared foreign keys** (grep: `grep -cE 'fields: \[' apps/api/prisma/schema.prisma`
→ 10; was 8 at the 2026-07-25 count, +2 from the Instruments work below) — still
a deliberately shallow schema.

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
| `InstrumentCredential` → `Instrument` | Cascade |
| `InstrumentAttribute` → `Instrument` | Cascade |
| `Instrument.gatewayId` → `Instrument` (self) | **SetNull** — deleting a gateway unlinks, never cascades to, its children |

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

`pgcrypto` is required for `gen_random_uuid()` defaults; `ltree` is a leftover
from the upstream hierarchy feature and is a **removal candidate**.

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
