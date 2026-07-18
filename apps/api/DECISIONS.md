# Backend Architecture Decisions

## 1. Role as Enum Column (not separate table)
**Decision:** Store role as a Prisma enum on the `users` table rather than a separate `roles` table with join.
**Rationale:** Phase 1 has 6 fixed roles. This simplifies queries, avoids JOINs on every auth check, and roles are checked on nearly every request. A roles table would add complexity without benefit at this stage. Can be migrated to a table in later phases if custom roles are needed.

## 2. Template-Based Entity Architecture (not hardcoded hierarchy)
**Decision:** Entities are created from configurable templates (blueprints) rather than hardcoded Block > Area > Module > Instrument hierarchy tables.
**Rationale:** The requirements doc specifies flexible entity types (CCTV cameras, clean rooms, reactors, etc.) that vary per deployment. Templates define attribute schemas (with 9 data types and numeric constraints), telemetry schemas, expected identifiers, expected relationships, and status lifecycles. Instances are created from templates and validated against their schema. This supports unlimited entity types without schema changes.

## 3. JWT + DB Sessions (not stateless JWT only)
**Decision:** Issue JWT tokens but also create a `sessions` record in the database.
**Rationale:** 21 CFR Part 11 requires the ability to immediately invalidate sessions (e.g., when admin disables a user, on logout, concurrent session prevention). Pure stateless JWT cannot support instant invalidation. The session DB check on every request adds a small overhead but is essential for compliance.

## 4. SHA-256 Checksum (not full hash chain)
**Decision:** Each audit record gets a SHA-256 checksum of its key fields. Not a chained hash (where each hash includes the previous).
**Rationale:** Full hash chaining requires sequential writes and breaks under concurrent audit logging. The checksum still provides tamper evidence for individual records. The Phase 1 spec references both approaches; we chose individual checksums for reliability under concurrent load. Hash chaining can be added as a background verification job later.

## 5. SUPER_ADMIN Audit Exemption
**Decision:** The audit logger plugin checks `userRole === 'SUPER_ADMIN'` and skips logging entirely.
**Rationale:** Per the business requirements, SUPER_ADMIN is the system owner whose actions are intentionally not recorded. This is a core compliance design choice from the spec documents.

## 6. Password Policy as System Config (not code)
**Decision:** Password policy rules (min length, uppercase count, history depth, etc.) are stored in the `system_config` table and loaded at runtime.
**Rationale:** 21 CFR Part 11 requires configurable password policies that admins can adjust without code changes. Storing in DB with a Zod schema for validation ensures policies are always valid while remaining configurable via the UI.

## 7. Prisma ORM with JSONB for Flexible Schemas
**Decision:** Use Prisma for all database operations. Asset template schemas and instance attribute values stored as JSONB columns.
**Rationale:** Prisma provides type-safe queries, migrations, and seeding. JSONB columns allow each template to define its own attribute schema without requiring database migrations per template. Validation happens at the API layer using the template's attributeSchema definition. This gives flexibility while keeping the database schema stable.

## 8. Fastify over Express
**Decision:** Fastify 5 as the HTTP framework.
**Rationale:** Per the Phase 1 tech stack doc. Fastify provides built-in schema validation, plugin system, better performance than Express, and first-class TypeScript support. The plugin architecture cleanly separates auth, audit, and RBAC concerns.

## 9. Dynamic Roles via Database (not hardcoded enum)
**Decision:** Roles are stored in a `roles` table with dynamic properties (name, displayName, color, hierarchyLevel, permissions). Role validation uses `z.string()` instead of `z.enum()`.
**Rationale:** Custom roles (e.g., "QA", "ENGINEER") need to be created by SUPER_ADMIN without code changes. Hardcoded Zod enums and `CREATABLE_ROLES` were replaced with dynamic DB lookups that check role existence and hierarchy level at runtime.

## 10. Action Re-authentication with In-Memory Cache
**Decision:** Re-authentication config (`action-reauth`) is loaded from DB with a 10-second in-memory cache. Cache is invalidated on config update.
**Rationale:** Re-auth checks happen on every sensitive mutation. Hitting the DB on every request would be expensive. A short TTL cache provides good performance while ensuring config changes take effect quickly.

## 11. Configurable Audit Text Templates
**Decision:** Audit trail action descriptions are stored as configurable templates in `system_config`, with defaults defined in the shared package.
**Rationale:** Different organizations may want different wording for audit entries. Templates use a placeholder system (`{actor}`, `{targetUser}`, etc.) that gets replaced at display time. Defaults are always available as fallback.

## 12. Configurable Pagination
**Decision:** Per-page record count options are stored in `system_config` as a 3-element tuple, configurable by SUPER_ADMIN.
**Rationale:** Different deployments may have different data volumes. A single centralized config (rather than per-page hardcoded values) ensures consistency across all paginated views.

## 13. Bidirectional Relationships with Auto-Inverse
**Decision:** When creating an entity relationship (e.g., A CONTAINS B), the API automatically creates the inverse (B CONTAINED_IN A). Deleting either side deletes both.
**Rationale:** Bidirectional relationships are essential for navigating the entity hierarchy from either direction. Auto-inverse creation prevents orphaned one-way relationships. The INVERSE_RELATIONSHIP_MAP in the shared package defines all inverse pairs: CONTAINS<->CONTAINED_IN, FEEDS<->FED_BY, DEPENDS_ON<->DEPENDED_ON_BY, BACKS_UP<->BACKED_UP_BY, MONITORS<->MONITORED_BY, CONNECTED_TO<->CONNECTED_TO (symmetric).

## 14. CONTAINS Cycle Detection
**Decision:** Before creating a CONTAINS relationship from A to B, the API walks the parent chain from A to detect if B is already an ancestor of A.
**Rationale:** Circular containment (A contains B contains A) would create infinite loops in the tree view and break the parent-child hierarchy. The `hasContainsCycle()` helper performs an iterative ancestor walk via DB queries, returning true if a cycle is detected. The API returns 400 if a cycle would be created.

## 15. Template Versioning with Snapshots
**Decision:** Each template update creates an AssetTemplateVersion record containing a full JSON snapshot of the template at that point in time.
**Rationale:** Entity instances record which template version they were created from (`templateVersion` field). When a template is updated, existing instances should still reference the schema they were created against. Full snapshots avoid complex diff/migration logic and allow viewing the exact template definition at any point in history.

## 16. Paginated API Responses
**Decision:** List endpoints return `{ data: [], total, page, limit, totalPages }`. Tree endpoints return plain arrays.
**Rationale:** Pagination is essential for large datasets. The consistent wrapper format makes it easy for the frontend to handle pagination state. Tree endpoints return flat arrays because they return the full hierarchy (no pagination needed) and the frontend builds the tree structure client-side.

## 17. requirePermission vs requireRole for Authorization
**Decision:** Entity routes use `requirePermission` (checks `role.permissions` JSON array in DB). Other routes may use `requireRole` (checks role name string).
**Rationale:** Permission-based checks are more granular and support custom roles. A role named "QA" can have `ASSET_CREATE` permission without needing to be listed in a hardcoded role-name allow list. `requirePermission` fetches the role from DB on each request and checks the `permissions` JSON array. `requireRole` is a simpler name-based check used where role identity matters (e.g., SUPER_ADMIN bypass logic). Both are Fastify decorators registered by the rbac plugin.

## 18. Reauth Enforcement on All Mutations
**Decision:** All entity mutation endpoints call `enforceReauth()` from `src/lib/reauth-check.ts` after permission checks. Read endpoints do not require reauth. This includes templates (CREATE/UPDATE/DELETE_ASSET_TEMPLATE), instances (CREATE/UPDATE/DELETE_ASSET), relationships (CREATE/DELETE_ASSET_RELATIONSHIP), and identifiers (CREATE/DELETE_ASSET_IDENTIFIER) — 10 reauth actions total.
**Rationale:** Re-authentication adds a second verification step before destructive or sensitive operations. The reauth config is action-based and can be enabled/disabled per action by admins. The `enforceReauth` function checks the in-memory cache (10s TTL) to determine if the action requires reauth, and validates the provided password if so.

## 19. Cascade Soft-Delete for Entity Instances
**Decision:** Deleting an entity instance soft-deletes (sets `isActive: false`) all descendant instances by recursively collecting child IDs via `collectDescendantIds()`.
**Rationale:** Hard-deleting parent entities while leaving orphaned children would create an inconsistent hierarchy. Soft-delete preserves data for audit purposes while removing items from active views. The recursive helper walks the `parentId` tree to collect all descendants before performing a batch update.

## 20. Entity Creation from Any Template (no isActive filter)
**Decision:** `POST /instances` checks only that the template exists, not that it's active. Entities can be created from active or inactive templates.
**Rationale:** The `isActive` flag on templates controls whether the template blueprint itself is editable/visible in template management, not whether entities can be instantiated from it. An inactive template may still have a valid schema that users need to create entities against. The frontend shows all templates in the Add Entity wizard, so the API must accept them. Filtering would cause confusing 400 errors.

## 21. Dual Hierarchy: parentId vs CONTAINS Relationships
**Decision:** The entity system maintains two independent hierarchies: `parentId` (direct field on AssetInstance) and CONTAINS relationships (in AssetRelationship table). The sidebar tree uses `parentId`, while the diagram tree uses CONTAINS relationships.
**Rationale:** `parentId` provides a simple, fast single-parent hierarchy for the sidebar navigation tree. CONTAINS relationships provide a richer, many-to-many containment model visible in the Relationships tab diagram. Both serve different UI purposes. The "Unlink from Parent" action sets `parentId=null`, while "Remove from Tree" in the diagram deletes the CONTAINS relationship.

## 24. Per-cycle EquipmentGroup version pinning (P1 — 2026-05-02)
**Decision:** `CleaningCycle.equipmentGroupVersionPin` (nullable Int) is set at cycle-start (or first lazy-bind during reading-submit) to the live group's `version`. Reading validation reads operating-range from the pinned `EquipmentGroupVersion.snapshot`, NOT the live row. Legacy cycles with a NULL pin fall back to the live row.
**Rationale:** Without this, admin edits to operating ranges between cycle-start and reading-submit would silently change the rules a cycle is held to — audit replay couldn't reproduce why a reading was accepted or rejected. Pinning makes the validation byte-correct against the rules in effect at cycle start. Mirrors the Phase A.1 ChecklistProfile cycle-pinning pattern. Tablet/offline app continues to consume live ranges in the short term (slight UX inconsistency); next APK cycle will pick up the Slice B contract documented in `future/offline-version-sync-contract.md` so the tablet sends `expectedGroupVersion`, server returns 409 SCHEMA_DRIFT on mismatch, and the tablet self-heals — same shape as A.1.

## 23. FilterProfile applicable-templates: join table over JSONB array (Step 4 — 2026-05-02)
**Decision:** `FilterProfile.applicableTemplates` is a proper join table (`FilterProfileApplicableTemplate`) with cascade FKs to `AssetTemplate`, NOT a JSONB array. AssetTemplate delete is blocked with `409 IN_USE` if any FilterProfile still binds it; the cascade FK is the safety net for hard deletes (super-admin / backup-restore), not the user-facing path.
**Rationale:** The previous JSONB array carried no FK enforcement — deleting a template left orphan UUIDs in every JSON array, the JOIN-via-IN silently dropped them, and there was no audit trail. The join table makes orphan refs structurally impossible. Block-with-409 over silent cascade matches the existing FilterProfile-delete guard against FilterDetails references and gives the operator a chance to see what they'd break before committing. Wire shape preserved: API responses still carry `applicableTemplates: string[]` via a flatten helper, so the FE didn't need to change. `allowedBlocks` stays JSONB because it's a conditional field (only used when `blockRestriction = SPECIFIC_BLOCKS`).

## 22. Dual Connection Limits (maxParentConnections + maxConnections)
**Decision:** Entity templates have two independent connection limit fields: `maxParentConnections` (limits CONTAINS parent relationships) and `maxConnections` (limits total relationships of all types).
**Rationale:** Parent connection limits control the tree hierarchy structure (0=no parents, 1=single parent, N=multiple). Total connection limits cap the overall number of relationships an entity can have, preventing unbounded growth. Both are enforced independently: `maxParentConnections` is checked only for CONTAINS relationships, while `maxConnections` is checked for all relationship types. A value of 0 means "not allowed" for parent connections but "unlimited" for total connections.

## 23. Connection Info in API Responses
**Decision:** POST /relationships success responses include `connectionInfo` with `{ source: { used, allowed, remaining }, target: { used, allowed, remaining } }`. Error responses include `connectionInfo` identifying which entity hit its limit.
**Rationale:** The frontend needs connection status data to display meaningful toast notifications ("3/10 connections used, 7 remaining") without making additional API calls. Including this in the response avoids an N+1 problem where the UI would need to fetch template limits and count relationships separately after each operation.

## 24. User-Facing "Entity" Terminology (Code Retains "Asset")
**Decision:** All user-facing text (UI labels, API Swagger docs, error messages, audit descriptions) uses "Entity" terminology, while code identifiers (Prisma models, variable names, permission constants, file paths) retain "Asset" naming.
**Rationale:** Renaming code identifiers would require a database migration (table/column renames), Prisma schema changes, and extensive refactoring across all files with no functional benefit. The user-facing rename from "Asset" to "Entity" better matches the domain vocabulary without the risk and effort of a full codebase rename. This is a common pattern in long-lived codebases where the domain language evolves.

> **⚠️ SUPERSEDED CLUSTER (retained as historical decision-records — the features are GONE):** Decisions **§25, §27–§30, §33–§35, §37** below document subsystems that have since been **removed**: TimescaleDB + the data-ingestion/telemetry/connectivity pipeline (Phase 7, 2026-06-11..17 — `digilog_tsdb` + hypertables dropped, `data-ingestion`/`uns`/`connectivity`/`queries` modules deleted) and the rule-chain + alarm subsystems (2026-05-17). §26's queue survives (graphile-worker now runs notification/PM/session-sweep jobs, not ingestion). §31/§32/§36/§38 are unaffected and still live (their rule-chain/alarm/connectivity *examples* are historical). The rationale below is kept for the "why"; do not treat these as current architecture.

## 25. TimescaleDB for Time-Series Data (not plain PostgreSQL tables)
**Decision:** Convert high-volume tables to TimescaleDB hypertables (7 hypertables total) with automatic time partitioning.
**Rationale:** Time-series data (telemetry readings, alarms, events) grows unboundedly. TimescaleDB provides automatic partitioning by time (7-day chunks), compression, and retention policies without application code changes. Queries filtering by time range benefit from chunk pruning. The `digilog_tsdb` database runs alongside `digilog_db` on the same PostgreSQL instance.

## 26. Out-of-process queue for Ingestion (not inline)
**Decision:** Use an out-of-process job queue for the ingestion pipeline rather than processing data inline in the HTTP handler. Originally BullMQ + Redis; **swapped to graphile-worker on Postgres in Phase 2 of the windows-friendly-rewrite (commit `7832af1`, 2026-04-29)** to drop the Redis/Memurai dependency on Windows.
**Rationale:** Data ingestion from IoT devices can burst to high volumes. Queueing decouples HTTP acceptance (fast 202 response) from processing (pipeline stages). Both queue backends provide job persistence, retry with backoff, dead letter queue, and rate limiting. graphile-worker uses PG `LISTEN/NOTIFY` for instant dispatch, `SELECT … FOR UPDATE SKIP LOCKED` for concurrency, and `pg_advisory_lock` for cron leader election — all native PG18 features, no extensions. `addJob()` runs in the caller's PG transaction, so jobs don't fire if the business txn rolls back (a feature BullMQ never offered). Two workers: ingestion (processes payloads) and maintenance (DLQ cleanup, connectivity staleness checks).

## 27. Sandboxed VM for Rule Chain Scripts (not eval/Function)
**Decision:** Execute user-defined rule chain scripts (77 node types total across 8 categories) in Node.js `vm.runInNewContext()` with a 1-second timeout and restricted global scope (no `process`, `require`, `global`, `Buffer`, `setTimeout`).
**Rationale:** Rule chain "script" nodes allow users to write custom transformation/filtering logic. Running untrusted code requires isolation to prevent: infinite loops (1s timeout), file system access (no `require`/`process`), memory exhaustion (restricted scope), and global state pollution (new context per execution). The VM sandbox is lightweight compared to worker threads or child processes.

## 28. Sub-Chain Delegation with Depth Tracking (not unlimited nesting)
**Decision:** Rule chains can delegate to other chains via "delegate-chain" nodes. A `depth` counter tracks nesting level and prevents infinite recursion (max depth configurable).
**Rationale:** Complex rule logic benefits from composition — a "temperature alarm" chain can delegate to a "notification" chain. Without depth tracking, circular delegation (chain A -> chain B -> chain A) would cause stack overflow. The depth counter increments on each delegation and rejects execution when the limit is reached.

## 29. Atomic SQL for Telemetry Upsert (not Prisma upsert)
**Decision:** Use raw SQL `INSERT ... ON CONFLICT (entityId, key) DO UPDATE SET value = EXCLUDED.value WHERE ...` for telemetry updates instead of Prisma's `upsert()`.
**Rationale:** Prisma's upsert performs a SELECT then INSERT/UPDATE in two separate statements, creating a race condition window where concurrent updates to the same entity+key can conflict. The atomic SQL approach handles the conflict in a single statement, ensuring exactly one row exists per entity+key combination. This is critical for high-frequency telemetry data from multiple devices.

## 30. Alarm Deduplication (not create-on-every-trigger)
**Decision:** When the rule engine generates an alarm, the system first checks if an ACTIVE alarm of the same type already exists for the entity. Only creates a new alarm if none exists.
**Rationale:** Without deduplication, a continuously-out-of-range sensor would create hundreds of alarm records per minute. Deduplication ensures one active alarm per type per entity. The alarm is only created when transitioning from "no alarm" to "alarm state". Clearing happens when the value returns to range or via manual acknowledgement/clear.

## 31. Absolute Session Timeout (24h hard limit)
**Decision:** Sessions have both a sliding window (configurable idle timeout) and an absolute 24-hour hard timeout. The absolute timeout cannot be extended by activity.
**Rationale:** 21 CFR Part 11 requires that sessions cannot remain active indefinitely. The sliding window handles idle users (e.g., 15 minutes of inactivity). The absolute timeout ensures that even continuously active sessions expire after 24 hours, forcing re-authentication. This prevents "forever sessions" from shared workstations.

## 32. Permission-Based Route Authorization (migrated from role-based)
**Decision:** All routes (including rule chains, data ingestion, debug traces, help articles, UNS) use `requirePermission()` instead of `requireRole()`. Each route checks specific permission constants from the role's `permissions` JSON array.
**Rationale:** Role-based checks (`requireRole('SUPER_ADMIN', 'ADMIN')`) are inflexible — adding a new role requires code changes to every route. Permission-based checks allow any role to have any permission combination. A custom "QA Engineer" role can have `RULE_CHAIN_MANAGE` permission without being listed in hardcoded role name arrays. This was migrated across all modules for consistency.

## 33. MANUALLY_CLEARED Alarm Status (separate from CLEARED)
**Decision:** Alarms have 4 statuses: ACTIVE, ACKNOWLEDGED, CLEARED, MANUALLY_CLEARED. MANUALLY_CLEARED is used when a user clears an alarm that hasn't auto-cleared.
**Rationale:** Regulatory environments require distinguishing between alarms that cleared naturally (sensor returned to range -> CLEARED) and alarms cleared by operator action (MANUALLY_CLEARED). The `clearDetails` JSON field stores the user, timestamp, and reason for manual clears. This distinction is important for root cause analysis and compliance audits.

## 34. Connectivity Tracker with Atomic SQL Upsert
**Decision:** Device connectivity tracking (firstConnectedAt, lastConnectedAt, lastSourceIp) uses atomic SQL `INSERT ... ON CONFLICT ... DO UPDATE` rather than Prisma upsert.
**Rationale:** Same rationale as telemetry upsert (Decision 29). Multiple devices connecting concurrently could cause race conditions with Prisma's two-step upsert. The atomic SQL approach ensures consistent state for device credential records, especially important for `firstConnectedAt` which should never be overwritten once set.

## 35. Default Chain Builder (auto-create from template alarm rules)
**Decision:** When an entity template has alarm rules defined, the system auto-generates a default rule chain with dual create-alarm/clear-alarm paths per alarm rule.
**Rationale:** Users shouldn't need to manually build rule chains for standard alarm scenarios. The default chain builder creates a chain with: input -> filter (check key match) -> threshold check -> create-alarm node (if violated) / clear-alarm node (if normal). This covers 90% of use cases. Users can customize by editing the auto-generated chain in the visual editor.

## 36. Static Routes Before Parameterized Routes (Fastify route ordering)
**Decision:** All static path routes (e.g., `/stats`, `/tree`, `/search`) must be registered before parameterized routes (e.g., `/:id`, `/:entityId`) in the same route prefix.
**Rationale:** Fastify matches routes in registration order. A parameterized route like `/:id` will capture any string, including "stats", causing validation errors when "stats" is parsed as a UUID. Discovered during system validation (BUG-V003, BUG-V004): `/api/connectivity/stats` was captured by `/:entityId` and `/api/alarms/stats` was captured by `/:id`. Fix: Reorder route registrations so static paths come first.

## 37. Rule Chain Save with Temp ID Remapping
**Decision:** The rule chain save endpoint (POST /:id/save) accepts temporary node IDs in the payload (e.g., "t1", "t2") and remaps them to real UUIDs via a `nodeIdMap` during atomic creation.
**Rationale:** The frontend rule chain editor doesn't know the server-assigned UUIDs before saving. Using temp IDs in the save payload allows the backend to create nodes first, build a mapping, then use it to resolve connection references and `firstRuleNodeId`. This avoids requiring a two-step create-then-connect flow.

## 38. Multi-Select Event Types for Notification Rules
**Decision:** Changed notification rules from single `eventType` (enum) to `eventTypes` (enum array). Both fields are maintained: `eventType` = first element (backward compat), `eventTypes` = full array.
**Rationale:** Users need a single rule to trigger on multiple event types (e.g., all alarm events). Storing as PostgreSQL enum array with Prisma `NotificationEventType[]` allows efficient `has` queries. The dispatcher uses `eventTypes: { has: eventType }` to match. Frontend uses a grouped checkbox dropdown component (`MultiSelectEventTypes`).

## 39. Force IPv4 for SMTP Connections (historical — was an EC2 era fix)
**Decision:** Added `family: 4` to all nodemailer `createTransport()` options (both OAuth2 and basic auth) via `as any` type cast.
**Rationale:** Originally added because EC2 instances in ap-south-1 could not reach IPv6 addresses — when `smtp.office365.com` resolved to IPv6 first (e.g., `2603:1036:30d:401::2:587`), connections failed with `ENETUNREACH`. The setting still applies in the current Windows-local-only deployment (EC2 was retired in commit `251be95`); IPv4 SMTP is universally reachable so the cast remains a safe defensive default. The `as any` cast is needed because nodemailer's TypeScript types don't expose the `family` option from Node.js `net.connect`.

## 40. Strip Computed Fields on Notification Rule Update
**Decision:** The PUT handler for notification rules destructures and removes `eventTypeMeta`, `eventTypesMeta`, `createdAt`, `updatedAt`, `createdBy`, and `id` before passing data to Prisma `update()`. Empty string values for UUID fields (`emailTemplateId`, `smsTemplateId`) are converted to `null`.
**Rationale:** The frontend sends the full rule object (including server-computed fields from the list endpoint) back when updating. Prisma rejects unknown fields. Empty strings for optional UUID columns cause PostgreSQL UUID parse errors.

## 41. Config Registry Pattern (2026-03-12)
**Decision:** Implemented self-registering config module architecture instead of hardcoded routes per config.
**Rationale:** With 23+ config modules, adding new ones required touching multiple files (routes, service, frontend routing). The registry pattern allows adding a new config by creating a single definition file.
**Trade-offs:** Slightly more complex startup (auto-discovery), but zero-touch addition of new config modules.

## Phase 2 Decisions

- **Pipeline as graph, not linear list**: Chose directed graph (stages + connections) over linear array to support future branching, parallel paths, and conditional flows
- **Checklist as pipeline node, not stage property**: Checklists are first-class CHECKLIST nodes in the graph, not attached to stages. This allows placing checklists between any stages, or multiple checklists in sequence
- **Versioning via create-new + archive-old**: Updating a cleaning profile creates a new version and archives the old one, preserving historical data for completed cycles. **Phase A.2 (2026-05-01)** added `lineageId UUID` to `FilterCleaningProfile` so version chains survive renames; `list()` groups by `distinct: ['lineageId']` (was `['name']`); endpoints `GET /:id/versions` and `/:id/versions/:n` expose history. Did NOT introduce a sidecar `*Version` table — the rowful approach is simpler and equivalent. Contrast with **Phase A.1 ChecklistProfile** which mutates in place and uses a sidecar `ChecklistProfileVersion` snapshot table. **Phase A.3 (2026-05-01)** extended the sidecar pattern to `FilterProfile`: live row mutates in place + version-bumped, OUTGOING state archived into `FilterProfileVersion` snapshot rows. Endpoints `GET /api/filter-profiles/:id/versions` and `/:id/versions/:n`. Per-block override is explicitly out of scope — FilterProfile is uniform across blocks. No cycle-side pin map needed because cycles already pin `cleaning_cycles.profileId` to a FilterCleaningProfile row at start. **Phase A.4 (2026-05-02)** extended the sidecar pattern to `EquipmentGroup` as a composite — `EquipmentGroupVersion.snapshot` carries the parent group plus all 3 instruments (ordered by sortOrder) in one row, because `update()` mutates them as a unit. Audit replay of submitted readings is already byte-exact via the immutable `FilterEvent.attributes.instrumentReadings` snapshot, so A.4 versioning is for admin-edit history only — no cycle-pinning of group versions. Cleaning reasons (config def values) were considered for A.4 but need no code: `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel` columns are written at cycle start and act as the per-cycle pin. **Two patterns coexist intentionally**: rowful-immutable for entities that are already designed to archive (FilterCleaningProfile, AssetTemplate); sidecar for entities that mutate in place (ChecklistProfile, FilterProfile, EquipmentGroup).
- **Events as immutable log**: filter_events table is append-only with SHA-256 checksums for 21 CFR Part 11 compliance
- **Auto-complete on last stage**: Cycle auto-completes when the last STAGE node leads to END, eliminating a separate "end cycle" step
- **Server-side checklist enforcement**: advance() checks for pending checklists and blocks if not completed, preventing API-level bypass
- **Organization scoping**: All filter queries use `orgWhere(ctx)` to scope data to the current organization
- **Equipment groups for AHU dashboard**: Filters grouped by equipment for operational overview
- **Retirement/replacement workflow**: Filters can be retired with reason tracking and replaced with new filters preserving traceability
- **Bulk upload**: CSV-based bulk filter import with validation and error reporting

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
