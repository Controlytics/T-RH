# Impact Analysis — Removing Entities and Entity Templates from DigiLog

**Status:** Architectural assessment
**Date:** 2026-05-15
**Subject:** Removing `AssetInstance` (entities) and `AssetTemplate` (entity templates)
**Recommendation:** **Do not remove.** See §11.

---

## 0. Executive Summary

These two concepts are the load-bearing skeleton of DigiLog — not features of it. Every other domain object in the system (telemetry, alarms, cleaning cycles, PM schedules, reports, dashboards, RFID identifiers, UNS paths, permission grants, audit trail) is anchored to them.

Removal is not a refactor. It is the discontinuation of the platform combined with a forbidden mutation of the 21 CFR Part 11 audit chain.

If there is a real underlying pain point (rigidity, UX, performance), §11 lists surgical alternatives that preserve compliance.

---

## 1. What Entities and Entity Templates mean in DigiLog

| Concept | Prisma model | Real-world meaning |
|---|---|---|
| **Entity Template** | `AssetTemplate` + `AssetTemplateVersion` (snapshots) + `TemplateKind` (code-validated kind lookup: BLOCK / AREA / AHU / FILTER / EQUIPMENT / OTHER) | The *type definition* — attribute schema, telemetry config, alarm rules, default rule-chain. Versioned. |
| **Entity** | `AssetInstance` + `FilterDetails` (1:1 sidecar for cycle state) | A concrete cleanroom object created from a template. Forms the containment tree via `parentId` and the typed-link graph via `AssetRelationship`. |

These are not generic IoT constructs replaceable with ad-hoc tables — they are the **digital-twin identity model**. Templates define the shape, instances are the things, the rest of the platform is bookkeeping anchored to those things.

---

## 2. Component-wise impact map

### 2.1 Database

**Direct FK relations (Prisma `@relation`):**

| Table | Column | Refs | onDelete | Concept |
|---|---|---|---|---|
| `asset_instances` | `template_id` | AssetTemplate | Restrict | Every instance |
| `asset_instances` | `parent_id` | AssetInstance | SetNull | Containment tree |
| `asset_template_versions` | `template_id` | AssetTemplate | Cascade | Template snapshots |
| `template_assignments` | `template_id` | AssetTemplate | Cascade | Per-user scope |
| `filter_profile_applicable_template` | `template_id` | AssetTemplate | Cascade | Profile↔template join |
| `entity_assignments` | `entity_id` | AssetInstance | Cascade | Per-user scope |
| `asset_relationships` | `source_asset_id`, `target_asset_id` | AssetInstance | Cascade | Typed links |
| `asset_identifiers` | `asset_id` | AssetInstance | Cascade | RFID / QR / NFC / Barcode |
| `filter_details` | `asset_instance_id` | AssetInstance | Cascade | Cycle state sidecar |
| `equipment_groups` | `block_id` | AssetInstance | Restrict | Instrument groups |

**App-managed UUID refs (no FK, but logically dependent — high-volume tables):**

`device_credentials.entity_id`, `alarms.entity_id`, `checklist_reviews.entity_id`/`template_id`, `latest_telemetry.entity_id`, `uns_mapping.entity_id`, `connectivity_status.entity_id`, `qr_codes.entity_id`, `data_streams.entity_id`, `dead_letter_queue.entity_id`, `pm_schedules.entity_id`, `pm_executions.entity_id`, `cleaning_cycles.{filter_id, ahu_id, cleaning_area_id}`, `filter_events.{filter_id, cleaning_area_id, equipment_id, block_id}`, `block_change_requests.{filter_id, from_block_id, to_block_id}`, `audit_trail.target_id` (when `target_type` ∈ {`asset_instance`, `asset_template`, `asset_template_version`, `asset_relationship`, `asset_identifier`}).

**TimescaleDB hypertables** (`ts_telemetry`, `ts_events`, etc., in `digilog_tsdb`) are **partitioned by `entity_id`**. Removing entities orphans every chunk.

Net DB impact: ≈ **25 application models and 6 hypertables** either FK to or carry an entity/template UUID. `AuditTrail` hash chain (`previous_checksum`, `chain_position`) means historical rows **cannot be deleted** without breaking tamper-evidence.

### 2.2 API (37 modules total under `apps/api/src/modules/`)

| Tier | Modules | Status if removed |
|---|---|---|
| **A — Manage entities/templates exclusively** | `assets/`, `entity-assignments/`, `template-kinds/` | Delete outright |
| **B — Business logic pivots on entity ID** | `filter-operations/`, `filter-profiles/`, `cleaning-profiles/`, `equipment-groups/`, `pm-schedules/`, `checklist-profiles/`, `data-ingestion/` (11-file pipeline), `uns/`, `rule-chain/` (77 node types; ≥ 5 nodes filter on `templateId`), `reports/`, `dashboards/`, `qr-code/`, `connectivity/`, `sync/`, `block-change-requests/`, `admin-requests/` (filter-bulk-upload approval), `queries/alarm.routes.ts`, `notification-rules/` | Rewrite needed; most have nothing left without an entity anchor |
| **C — Incidental references (opaque target/audit field)** | `audit/`, `backup/`, `notifications/`, `super-admin/`, `users/`, `roles/`, `auth/`, `system-health/`, `help/`, `uploads/`, `ldap/`, `deployment-check/`, `config/` | Light cleanup |

**≈ 25 of 37 modules are Tier A or B.**

### 2.3 Frontend (`apps/web/src/routes/` — ≈ 83 pages across 22 folders)

Pages that only make sense with entities:

- **Filter Management (≈ 15):** filter-list, filter-operations, filter-scan, filter-status, filter-traceability, ahu-dashboard, cleaning-profile-list, cleaning-profile-editor, filter-profile-list, retirement-list, replacement-list, bulk-upload-dialog, stage-scan-dialog
- **Asset management:** assets/, assets/templates/, assets/:id/
- **Mobile wrapper + mobile-operations** (entire mobile path is entity-tree → cycle UI)
- **Config bound to entities:** equipment-groups, cleaning-profile-assignment, filter-data-management, ahu-filter-set-config, template-kinds, uns, tablet-access
- **Workflows:** pm-schedules + /:entityId, my-tasks, approvals, admin-requests, checklist-form/:entityId
- **Reports / Cycles / Alarms / Version-history** — bind to entity IDs

`apps/web/src/main.tsx` has **≈ 30 route guards** keyed on `ASSET_*`/`FILTER_*`/`PM_*`/`CYCLE_READ`/`EVENT_READ`/`UNS_VIEW`/`EG_VIEW`.

Shared hooks/libs that vanish: `hooks/use-entity-websocket`, `lib/offline-sync-service`, `lib/sync-engine`, `lib/offline-cache`, `lib/local-context`, `lib/filter-ops/*`, `lib/action-tape/*`.

### 2.4 Role-based access

- **107 permission constants** — `ASSET_*`, `FILTER_*`, `FILTER_HIERARCHY_*`, `FILTER_RFID_MANAGE`, `FILTER_STATUS_UPDATE`, `FILTER_OPERATE`, `EG_*`, `FCP_*`, `FP_*`, `CP_*`, `PM_*`, `CYCLE_READ`, `EVENT_READ`, `BLOCK_CHANGE_*`, `UNS_VIEW`, `RFID_*` families → **≈ 50 permissions become meaningless**
- **90 feature privileges** → ≈ 35 lose their target
- **96 reauth actions** → ≈ 40 lose their target (CREATE_ASSET, CREATE_FILTER, RETIRE_FILTER, REPLACE_FILTER, BULK_UPLOAD_FILTERS, UPDATE_FILTER_LIFECYCLE, CREATE/EDIT/DELETE_HIERARCHY_NODE, START_CLEANING_CYCLE, etc.)
- **26 sidebar items** → ≈ 12 disappear
- `EntityAssignment` and `TemplateAssignment` tables and their `AssigneeType` enum — gone

### 2.5 Dashboards

`DashboardWidget.dataSource Json` is `{ entityIds, telemetryKeys, aggregation, timeWindow }`. Query path filters `LatestTelemetry` / `Alarm` / `AssetInstance` by `entityId IN (...)`. **Without entities, every widget reduces to "a number with no scope" — the dashboard product is gone.**

### 2.6 Device management / telemetry ingestion

Two ingestion paths, both entity-bound:

1. **MQTT** (`apps/api/src/transport/mqtt-handler.ts:123-166`): `parseTopic()` → ISA-95 path → `prisma.assetInstance.findFirst({ where: { unsPath } })`. **No entity → message dropped silently.**
2. **HTTP** (`data-ingestion/routes.ts:55`): `resolveEntityByToken()` → bearer token → `DeviceCredential` → entity + template + UnsMapping. **No entity → 401.**

Both funnel into `ingestion.service.ts`, which stamps `entityId` on every TSDB row (`ts_telemetry`, `ts_events`, `latest_telemetry`, `alarms`, `data_streams`, `connectivity_status`). **Telemetry ingestion stops working entirely if the resolver targets are removed.**

### 2.7 Reports

- `ReportInstance.entitySlots Json` stores `{ slotName: assetInstanceId }`.
- `reports/service.ts:38-67` validates every slot UUID against `AssetInstance`.
- Render-time data sources (`attribute-source.ts`, `identifier-source.ts`, `telemetry-source.ts`, `timestamp-source.ts`) call `ctx.entitySlots[slotName]` for every datum.

All historical reports in `report_instances` reference entity UUIDs in `entity_slots`. Re-rendering them post-removal returns 404 for every slot — including reports already signed and exported.

### 2.8 Workflows / Notifications / Cycles / PM

- `CleaningCycle.filterId`, `FilterEvent.filterId` — every cycle and event pinned to an entity (app-managed UUIDs).
- `BlockChangeRequest.{filterId, fromBlockId, toBlockId}` — cross-block transfer workflow has nothing to transfer.
- `pm_schedules.entity_id` — PM plans are *per entity-year*.
- `notification_rules` rule-chain `filter-nodes.ts:89,139` filters by `templateId`. Without templates, every rule matches all messages.

### 2.9 Data relationships

`AssetRelationship` is the typed-edge layer (`CONTAINS`, `CONTAINED_IN`, future `FEEDS`, `CONNECTED_TO`). The `INVERSE_RELATIONSHIP_MAP` invariant (enforced by `apps/api/prisma/sql/invariants.sql`) only makes sense in the context of entities. Removal → entire graph layer disappears.

### 2.10 Audit / version history

- `AuditTrail.target_type` enumerates `asset_instance`, `asset_template`, `asset_template_version`, `asset_relationship`, `asset_identifier` among its values.
- `AssetTemplateVersion`, `FilterProfileVersion`, `EquipmentGroupVersion`, `ChecklistProfileVersion` snapshots are immutable record-of-change for entity-anchored objects.
- The audit hash chain (`previous_checksum`, `chain_position`) means **rows cannot be physically deleted** without breaking 21 CFR Part 11 tamper-evidence. Audit and version-history endpoints must continue to render rows whose target no longer exists.

### 2.11 Configuration / dynamic mappings

- **30 config definitions** under `apps/api/src/modules/config/defs/`. ≈ 12 bind explicitly to entity/template surfaces (equipment-groups, cleaning-profile-assignment, ahu-filter-set-config, filter-data-management, filter-cleaning-reasons, filter-lifecycle, tablet-access, template-kinds, report-settings, uns, dashboard-cards).
- `UnsMapping` (1:1 with AssetInstance) is the dynamic ISA-95 path binding used by every MQTT topic.

### 2.12 Search / filtering

Asset tree, filter list, RFID scan, telemetry queries, alarm dashboard, audit search — every search surface either pivots on `templateId` or `entityId`. Removing them removes the primary search dimension; users are reduced to text-search over names.

### 2.13 Multi-tenant architecture

Already single-tenant since 2026-04-30 (commit `5952b3f`). Not an additional concern here.

### 2.14 Third-party integrations

- **Mosquitto dynsec** (`POST /api/internal/mqtt/refresh-acl`) — issues per-`DeviceCredential` ACL rules; credentials are entity-bound. Without entities the dynsec regen produces an empty ACL → MQTT loses authorization granularity.
- **LDAP / SSO / email / SMS / Telegram / Slack** — unaffected directly, but every notification message references entity context.
- **Outbound webhook recipients** (if any external systems consume DigiLog audit/cycle events by entity UUID) — must be inventoried before any removal.

---

## 3. Dependency cascade

```
remove AssetInstance
  → Cascade FK delete: AssetRelationship, AssetIdentifier, EntityAssignment,
                       FilterDetails, EquipmentGroup (Restrict→needs prior cleanup)
  → App-managed orphans: 6 TSDB hypertables, DeviceCredential, Alarm,
                         LatestTelemetry, UnsMapping, ConnectivityStatus,
                         QrCode, DataStream, DeadLetterQueue,
                         PmSchedule, PmExecution, CleaningCycle,
                         FilterEvent, BlockChangeRequest, ChecklistReview
  → MQTT ingestion drops 100% of traffic (entity resolver returns null)
  → HTTP ingestion returns 401 on every device call
  → 25 of 37 API modules return 404/500 on every protected route
  → ≈ 30 frontend routes render empty / Access Denied / crash
  → Mobile APK unusable (offline cache keys all entity-scoped)
  → Reports historical rendering returns 404 for every slot
  → Dashboard widgets render empty
  → Audit hash chain references vanished targets
  → ≈ 50 permissions, ≈ 40 reauth actions, ≈ 12 sidebar items orphaned

remove AssetTemplate
  → Cascade FK delete: AssetTemplateVersion, TemplateAssignment,
                       AssetInstance (Restrict → hard stop, must remove instances first)
  → FilterProfileApplicableTemplate join cascades empty
  → Rule chains lose templateId filter → every chain reverts to "match all"
  → Bulk upload has no schema to validate against
```

---

## 4. Risk matrix

| Risk | Probability | Severity | Mitigation |
|---|---|---|---|
| **Telemetry ingestion stops** | Certain | Catastrophic — site stops collecting data; 21 CFR Part 11 record continuity broken | Cannot mitigate while removing entities |
| **Audit chain inconsistency** | Certain | Catastrophic — compliance loss; regulatory exposure | Hard-delete forbidden; logical deletion + tombstones required |
| **Historical reports unrenderable** | Certain | High — eDiscovery / inspection requests fail | Migrate `report_instances.entity_slots` to denormalized snapshots before any removal |
| **In-flight cleaning cycles orphaned** | Certain on any live filter | Catastrophic — operator-visible failure mid-cycle | Block removal until all cycles are COMPLETED / TERMINATED |
| **Permission set breaks all role grants** | Certain | High — `roles.permissions` JSON has dangling perms; users locked out or over-privileged | Coordinated seed migration |
| **Offline IDB caches stale on tablets** | Certain | Medium — devices show empty UI until refresh + cache clear | Force SW unregister + clear `digilog_offline` IDB |
| **MQTT dynsec ACL regen empty** | Certain | High — devices lose connect/publish rights | Pre-removal switch to static ACL |
| **Backup / restore breaks** | High | High — `dynamic-backup.ts` walks 64 tables in FK order; removing models reorders dependencies | Regenerate dependency graph; test restore on backup snapshot |
| **Third-party integrations referencing entity UUIDs** | Unknown | High | Inventory all outbound recipients before removal |

---

## 5. Data migration concerns

- **Referential integrity:** Cascade deletes fire on `EntityAssignment`, `AssetRelationship`, `AssetIdentifier`, `FilterDetails`, `AssetTemplateVersion`, `TemplateAssignment`, `FilterProfileApplicableTemplate`. Restrict blocks `AssetInstance.template_id` and `EquipmentGroup.block_id` deletion — must drop or convert first.
- **Orphans:** Every app-managed UUID column becomes orphan ID. TSDB hypertables can be neither cleaned nor verified.
- **Backup / rollback:** `dynamic-backup.ts` produces backups walking all 69 models. Mid-removal backups will be inconsistent; rollback requires restoring an entire `digilog_db` + `digilog_tsdb` snapshot.
- **Audit chain:** Each `AuditTrail` row signs the previous row's checksum. Removing rows breaks every downstream row's verification — and the chain spans years of regulatory records.

---

## 6. Performance and scalability

- **Read perf:** Worse. Today `asset_instances` is indexed on `template_id`, `parent_id`, `status`, `is_active`; visibility-filter joins are sub-millisecond. Any replacement schema must rebuild equivalent indexes.
- **Ingestion perf:** Worse. TSDB hypertables partition on `entity_id`. Removing that partition key reduces compression ratio and query locality.
- **Maintainability:** Worse. `AssetTemplate.attributeSchema` is the schema-of-record for instance attributes; without it, attribute validation moves to per-table ad-hoc code.
- **Extensibility:** Worse. Today adding a new physical asset type = `INSERT INTO asset_templates` + register one config def. Without templates, every new type needs a new table + new validators + new permissions.

---

## 7. Security / access control

- `EntityAssignment` is the granular **view / control / configure** layer per-user-or-role per-entity.
- `TemplateAssignment` is the broader scope-by-type layer.
- Removal collapses scoping to "role + permission" only. Any deployment with scoped supervisors (e.g. "Supervisor A only sees Block 1") loses that capability.
- `DeviceCredential.entityId` is the basis for MQTT topic ACLs. Loss → no authorization granularity at the broker.

---

## 8. UI / UX

**Pages requiring complete redesign or removal:**

`routes/assets/*`, `routes/filter-management/*` (15 pages), `routes/mobile/*`, `routes/pm-schedules/*`, `routes/cleaning-cycles/*`, `routes/checklist-form/*`, `routes/config/{equipment-groups, cleaning-profile-assignment, filter-data-management, ahu-filter-set-config, template-kinds, uns, tablet-access}`, `routes/version-history`, `routes/alarms`, `routes/my-tasks`, `routes/approvals`.

**Navigation:** 12 of 26 sidebar items disappear. Top-level "Filter Management" group goes away.

**Broken user flows:** cleaning-cycle execution, PM execution, RFID scan, AHU dashboard browse, alarm acknowledge-by-asset, report generation with entity-bound slots, equipment-group setup, block-change-request workflow.

---

## 9. Required code changes (surface volume)

| Area | Surface | Approx volume |
|---|---|---|
| Backend modules to delete/rewrite | 25 modules (Tier A + B) | 60–80k LoC |
| Frontend routes to delete/redesign | ≈ 30 of ≈ 80 routes; mobile wrapper; offline IDB layer; sync engine | 40–60k LoC |
| Prisma schema | Drop ≈ 25 models, ≈ 15 enums; alter every app-managed UUID column policy | All 6 hypertables re-partition |
| Shared types | `permissions.ts` (−≈ 50), `feature-privileges.ts` (−≈ 35), `reauth-actions.ts` (−≈ 40), `sidebar-items.ts` (−≈ 12), all `schemas/assets.ts`, `hierarchy.ts`, `templates.ts` deleted | Whole files |
| Config defs | 12 of 30 deleted; `config-discovery.ts` reduced; `config/index.tsx` cards removed | 12 def files |
| API contracts | ≈ 120 of 200+ endpoints removed | OpenAPI rebuild |
| Tests | Entire `e2e/phase2-*`, `phase3-*`, `phase5-*`; ≈ 70% of unit tests in affected modules | ≈ 50% of test suite |

---

## 10. Testing impact

- **Regression scope:** Effectively the entire app — telemetry ingestion, MQTT, alarms, dashboards, reports, PM, cleaning cycles, RFID, offline sync, mobile APK, audit verification.
- **Integration scope:** `tests/integration/windows-server-stack.test.ts` (broker + 100 telemetry publishes) rewritten end-to-end. `verify-windows-deployment.ps1` operator smoke breaks at health-check.
- **UAT:** Every operator workflow needs re-validation; QA-approver workflow needs re-validation; SUPER_ADMIN config flow needs re-validation; field RFID workflow needs re-validation. **Realistic UAT: 4–6 weeks** with the cleanroom user community.

---

## 11. Recommendation

**Do not remove `AssetInstance` and `AssetTemplate`.** They are not optional concepts — they are the canonical identity model of every telemetry row, every cycle, every alarm, every audit record, every permission grant, every offline-cache row. Removing them is equivalent to discarding the application and rebuilding from scratch, while also breaking the 21 CFR Part 11 audit chain you legally cannot break.

### 11.1 If there is a specific pain point, prefer the surgical alternative

| Symptom | Surgical alternative (no removal) |
|---|---|
| "Template `attributeSchema` is too rigid" | Use `AssetInstance.customAttributes` (already exists, underused). |
| "Operators struggle with template-vs-instance mental model" | UX-only: hide `AssetTemplate` from operator role; expose only to admin. |
| "Hierarchy maintenance is painful" | Bulk-upload UX (already exists in `bulk-upload-filter.service.ts`) + hierarchy builder UX polish. |
| "Performance issues" | Index review on hot columns (`asset_instances.template_id`, `parent_id`, `created_by`); TSDB compression tuning. |
| "Permission model too granular" | Collapse `EntityAssignment` to opt-in scoping (already done this session — instance.routes.ts visibility-filter fix). |
| "Want a different shape for new asset class" | Add a new `TemplateKind` row + new `AssetTemplate`. The platform was designed exactly for this. |
| "Migrating to a different platform" | This is a migration plan, not a removal. Estimate 6–12 months. |

### 11.2 If removal is non-negotiable — phased platform sunset (not a refactor)

| Phase | Calendar | Action |
|---|---|---|
| 0 — Freeze | 1 week | Stop new entity creation; mark all entities `isActive=false` on target date |
| 1 — Workflow drain | 1–2 weeks | Force-complete all `IN_PROGRESS` cycles; freeze PM scheduling |
| 2 — Telemetry stop | 2 weeks | Stop MQTT ingestion (announced window); export all telemetry to long-term archive |
| 3 — Regulatory close-out | 2 weeks | Generate final reports across all entities; archive `digilog_db` + `digilog_tsdb` snapshots |
| 4 — Replatform | 4–6 weeks engineering | Deploy successor application. Legacy DB stays read-only for the regulatory retention window (typically 7–10 years) |

### 11.3 Effort estimate (order of magnitude)

| Area | Effort |
|---|---|
| Backend rewrite/removal | 12–16 engineer-weeks |
| Frontend rewrite/removal | 10–14 engineer-weeks |
| Schema + TSDB migration | 4–6 engineer-weeks |
| Test rewrite | 6–8 engineer-weeks |
| UAT + operator retraining | 4–6 weeks calendar |
| Regulatory documentation update (CFR Part 11) | 2–4 weeks calendar |

**Total programme: 6–12 months** with executive sponsorship and operator sign-off at every phase.

---

## 12. Take-away

The question *"can we remove entities and entity templates"* is structurally the same as *"can we remove rows and columns from a relational database"*. The answer is yes, but the database stops being a database.

If there is a real underlying ask, name it — there is almost certainly a less destructive answer.

---

*Prepared from a code-grounded inventory of the DigiLog codebase at branch `RFID`, 2026-05-15. References to file paths and line numbers are accurate as of that snapshot.*
