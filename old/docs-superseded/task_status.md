# DigiLog — Development Status

## Infrastructure

| Component | Status | Details |
|-----------|--------|---------|
| Turborepo Monorepo | Done | `apps/api`, `apps/web`, `packages/shared`, `packages/db`, `packages/queue` |
| Docker Compose | Done | PostgreSQL 18 + TimescaleDB + Redis 5 + EMQX |
| Prisma Schema | Done | 57 models, 17 enums, migrations applied |
| Database Seed | Done | Default admin, system configs, field IDs, 33 ingestion configs, 40+ help articles, 52+ permissions |
| EC2 Deployment | Done | API :3000, nginx frontend, PostgreSQL :5432, Redis :6379, EMQX :1883 |
| PM2 Process Manager | Done | `digilog-api` cluster mode |
| GitHub Actions CI/CD | Done | PostgreSQL 15, Redis 7, Node 20, 1344 tests |
| TimescaleDB | Done | 7 hypertables (ts_telemetry, ts_attributes, ts_device_events, ts_checklist_responses, ts_pipeline_traces, ts_binary_data, ts_alarm_history) |

## Backend (`apps/api`) — Fastify 5

### Plugins
| Plugin | Status | Notes |
|--------|--------|-------|
| Auth (JWT + Sessions) | Done | Token verify, session validation, user status check |
| Audit Logger | Done | SHA-256 checksummed, SUPER_ADMIN exempt |
| RBAC | Done | `requirePermission()` + `requireRole()` decorators |

### API Modules
| Module | Endpoints | Status | Architecture |
|--------|-----------|--------|--------------|
| **Auth** (8) | login, logout, beacon-logout, me, profile, change-password, verify, forgot-password | Done | Routes → Services → Repositories |
| **Users** (14) | CRUD + enable/disable/unlock/reset-password + reset-requests + bulk-delete + stats | Done | Routes → Services → Repositories |
| **Roles** (8) | CRUD + active list + creatable roles + permissions | Done | Routes → Services → Repositories |
| **Config** (33) | password-policy, login-security, session, datetime, user-id, branding, roles, users, field-ids, action-reauth, audit-templates, pagination | Done | Routes → Services → Repositories |
| **Entity Templates** (6) | CRUD + versioning + checklistSchema (14 question types) | Done | Routes → Services → Repositories |
| **Entity Instances** (8) | CRUD + tree + children + status change + cascade soft-delete | Done | Routes → Services → Repositories |
| **Entity Relationships** (3) | List + create (auto-inverse, cycle detection, connection limits) + delete | Done | Routes → Services → Repositories |
| **Entity Identifiers** (4) | List + lookup + create + delete | Done | Routes → Services → Repositories |
| **Audit** (4) | GET list (filtered/paginated), GET detail, DELETE, POST bulk-delete | Done | Monolithic routes |
| **Notifications** (9) | List, unread-count, mark read/unread, bulk ops, delete | Done | Monolithic routes |
| **Uploads** (2) | Photo upload + serve | Done | Monolithic routes |
| **Backup** (3) | Export + Restore + Validate | Done | Monolithic routes |
| **MQTT Auth** (3) | auth, acl, webhook | Done | Transport |
| **Data Ingestion** (8) | HTTP telemetry/attributes/events + RPC + config | Done | Transport |
| **Rule Chains** (14) | CRUD + nodes + connections + versions + activate/deactivate + debug | Done | Monolithic routes |
| **UNS** (6) | tree, entity mapping, move, search | Done | Monolithic routes |
| **Telemetry Queries** (7) | latest, timeseries, keys, attributes, attribute history, checklists | Done | Monolithic routes |
| **Alarms** (5) | list, entity alarms, acknowledge, clear, manual clear (MANUALLY_CLEARED) | Done | Monolithic routes |
| **Export** (5) | telemetry, checklists, alarms, attributes CSV/JSON + status | Done | Monolithic routes |
| **Retention** (4) | config GET/PUT, archive, execute | Done | Monolithic routes |
| **Connectivity** (6) | status, test, snippets, token generate/revoke, history | Done | Monolithic routes |
| **QR Codes** (4) | generate, get, SVG, delete | Done | Monolithic routes |
| **Help Articles** (6) | list, get by key, create, update with versioning, version history, delete | Done | Monolithic routes |

### Key Backend Features
- Temporary password flow with forced change on first login
- Account lockout (temporary/permanent) after failed attempts
- Password history enforcement (configurable reuse prevention)
- Session-based auth with immediate invalidation on disable/logout
- SHA-256 audit trail checksums (tamper-evident)
- Template-driven entity creation with JSONB attribute merging
- Checklist schemas on templates (14 question types: PASS_FAIL, YES_NO, YES_NO_NA, MCQ, MULTI_SELECT, TEXT, NUMERIC, DROPDOWN, PHOTO, DATE_TIME, SIGNATURE, YES_NO_COMMENT, CALCULATED, CONDITIONAL)
- Parent-child hierarchy via `parentId` self-reference
- Bidirectional relationships with auto-inverse creation (12 types)
- Connection limits (`maxParentConnections`, `maxConnections`) enforced on create
- Cycle detection for CONTAINS relationships
- Dynamic role management (create/edit/delete custom roles)
- Action re-authentication with in-memory cache
- Configurable audit text templates (Entity Management category)
- Configurable pagination options
- Re-auth enforcement helper (`apps/api/src/lib/reauth-check.ts`)
- Global error handler mapping `AppError` subclasses to HTTP responses
- `RequestContext` abstraction decouples services from Fastify request object

## Frontend (`apps/web`) — React 19 + Vite + Tailwind 4

### UI Components
| Component | Status |
|-----------|--------|
| Button, Input, Card, Badge, Select, Dialog, Table | Done |
| Sidebar (role-filtered nav) | Done |
| Header (user info, logout) | Done |
| AppLayout (auth guard, session timeout dialog) | Done |
| Error Boundary | Done |
| Re-auth Dialog | Done |
| Require Role Guard | Done |

### Pages
| Route | Page | Status |
|-------|------|--------|
| `/login` | Login form (secure password field) | Done |
| `/forgot-password` | Forgot password request | Done |
| `/change-password` | Forced password change with strength indicators | Done |
| `/` | Dashboard with role-based stats | Done |
| `/profile` | User profile | Done |
| `/users` | User list with search/filter/pagination | Done |
| `/users/create` | Create user form | Done |
| `/users/:id` | Edit user + reset password | Done |
| `/users/reset-requests` | Password reset requests | Done |
| `/config` | Config dashboard (general + super admin sections) | Done |
| `/config/password-policy` | Password policy + login security + session settings | Done |
| `/config/datetime` | Date/time format settings | Done |
| `/config/branding` | Logo, colors, company name config | Done |
| `/config/user-id` | User ID format + auto-generation config | Done |
| `/config/roles` | Role management (create/edit/delete) | Done |
| `/config/role-privileges` | Per-role feature permissions (dynamic roles) | Done |
| `/config/sidebar` | Per-user sidebar config | Done |
| `/config/field-ids` | Field display name config | Done |
| `/config/backup` | Database backup & restore | Done |
| `/config/action-reauth` | Action re-authentication matrix | Done |
| `/config/audit-templates` | Audit text template editor | Done |
| `/config/pagination` | Pagination settings (3 options) | Done |
| `/assets` | Entity Explorer with dynamic tree diagram, detail panel, CRUD dialogs | Done |
| `/assets/templates` | Entity Template Manager with 6-section editor + checklist builder | Done |
| `/notifications` | Notifications list | Done |
| `/audit` | Audit trail table with filters + detail dialog | Done |
| `/rule-chains` | Rule Chain management (table, CRUD, pagination) | Done |
| `/rule-chains/:id` | Rule Chain Editor (React Flow canvas, 31 node types) | Done |
| `/alarms` | Alarm Dashboard (role-based columns, MANUALLY_CLEARED status) | Done |
| `/config/uns` | UNS Config (tree, wildcard search, detail panel, path override) | Done |
| `/config/alarm-columns` | Alarm Column Visibility per role (11 columns) | Done |
| `/debug` | Pipeline Debug Traces | Done |
| `/checklist/:entityId` | Checklist Submission (14 question types) | Done |

### Key Frontend Features
- Copy/paste/cut/drag disabled on password fields (21 CFR Part 11)
- Idle session timeout with warning countdown
- Role-based navigation (different menus per role)
- SWR for data fetching with auto-revalidation
- Dynamic role support (custom roles in all dropdowns and config pages)
- Global SWR cache invalidation for role changes
- Toast notification system (success/error/warning/info with auto-dismiss)
- Dynamic tree diagram with create child, attach existing, remove from tree
- Connection limit enforcement in entity creation/linking
- Single-tab enforcement via localStorage heartbeat

## Shared Package (`packages/shared`)
- Zod schemas for all API payloads (auth, users, assets/entities, config, audit, action-reauth) — **Done**
- TypeScript types (roles, permissions, permission-categories, feature-privileges, sidebar-items, audit actions, reauth actions, audit templates) — **Done**
- Constants: ATTRIBUTE_DATA_TYPES (9), TELEMETRY_DATA_TYPES (5), RELATIONSHIP_TYPES (12), IDENTIFIER_TYPES (5), ASSET_STATUSES (5), ALARM_RULE_TYPES (7), ALARM_SEVERITIES (3), CHECKLIST_QUESTION_TYPES (14) — **Done**

## Documentation
- `CLAUDE.md` in root, api, web, shared — **Done**
- `DECISIONS.md` in api and web — **Done**
- `CHANGELOG.md` — **Done**
- `API_GUIDE.md` — **Done**
- `BUSINESS_CONTEXT.md` — **Done**
- `PLAN.md` — **Done**
- `documentation/Bug_Resolution_Log.md` — **Done**
- `documentation/Project_Summary.md` — **Done**
- `.github/ISSUE_TEMPLATE/bug_report.md` — **Done**

### Testing Documentation (centralized at `documentation/testing/`)
- `documentation/testing/manual/TEST.md` — **Done**
- `documentation/testing/manual/TEST_CASES.md` — **Done**
- `documentation/testing/manual/TEST_SUMMARY.md` — **Done**
- `documentation/testing/reports/TEST_REPORT.md` — **Done**
- `documentation/testing/reports/TREE_DIAGRAM_TEST_REPORT.md` — **Done**
- `documentation/testing/reports/RBAC_TEST_RESULTS.md` — **Done**
- `documentation/testing/automation/rbac-test.sh` — **Done**
- `documentation/testing/validation/21CFR_PART11_VERIFICATION.md` — **Done**

## Tests

### Unit Tests (`packages/shared`)
| Suite | Tests | Status |
|-------|-------|--------|
| `schemas/assets.test.ts` | Checklist schema validation (20 tests) | Passing |
| `schemas/auth.test.ts` | Auth schema validation | Passing |
| `schemas/config.test.ts` | Config schema validation | Passing |
| `schemas/users.test.ts` | User schema validation | Passing |
| `types/audit-templates.test.ts` | Audit template categories, defaults, getDefaultTemplates (17 tests) | Passing |
| **Total** | **151 tests** | **All passing** |

### Unit Tests (`packages/db`) — Phase K
| Suite | Tests | Status |
|-------|-------|--------|
| `__tests__/telemetry-batcher.test.ts` | Multi-row INSERT batcher | Passing |

### API Tests (`apps/api`)
| Suite | Tests | Status |
|-------|-------|--------|
| `e2e/auth.test.ts` | Auth login/logout/me/change-password E2E | Passing |
| `e2e/users.test.ts` | User CRUD + enable/disable/unlock E2E | Passing |
| `e2e/roles.test.ts` | Role CRUD + permissions E2E | Passing |
| `e2e/config.test.ts` | Config CRUD E2E | Passing |
| `e2e/audit.test.ts` | Audit trail list/detail E2E | Passing |
| `e2e/notifications.test.ts` | Notification list/read/delete E2E | Passing |
| `e2e/health.test.ts` | Health endpoint E2E | Passing |
| `e2e/checklist-templates.test.ts` | Checklist CRUD lifecycle (14 tests) | Passing |
| `e2e/entities.test.ts` | Entity instance + relationship + identifier E2E | Passing |
| `modules/data-ingestion/__tests__/ingestion.service.test.ts` | Pipeline stages 3/6/9/10/11 | Passing |
| `modules/data-ingestion/__tests__/ingestion-config.service.test.ts` | IngestionSystemConfig reader | Passing |
| `modules/data-ingestion/__tests__/connectivity-tracker.test.ts` | Online/offline tracking | Passing |
| `modules/data-ingestion/__tests__/dlq-manager.test.ts` | Dead letter queue | Passing |
| `modules/data-ingestion/__tests__/pipeline-tracer.test.ts` | Debug trace recorder | Passing |
| `lib/hash-chain.test.ts` | Hash chain utilities | Passing |
| `lib/jwt.test.ts` | JWT utilities | Passing |
| `lib/password.test.ts` | Password hashing | Passing |
| **Total** | **274 tests** | **All passing** |

### Test Suite Summary (Phase K + v3.0)
| Metric | Value |
|--------|-------|
| Total tests | 1,344 |
| Test files | 83+ |
| Packages with tests | 3 (packages/shared, packages/db, apps/api) |
| CI/CD | GitHub Actions (PostgreSQL 15, Redis 7, Node 20) |
| Status | COMPLETE — 0 failures |

### Test Infrastructure
- Vitest with `globals: true`, `environment: 'node'`
- E2E tests use `buildApp()` + `app.inject()` (no HTTP server)
- `vitest.config.ts` in both `packages/shared` and `apps/api`
- `vi.hoisted()` for hoisting mock variables above imports
- Class-based mocks for `ioredis` and `bullmq` (avoids real Redis connections)
- `__tests__/` directories co-located with source modules

## API Refactoring Status

| Module | Old Pattern | New Pattern | Status |
|--------|-------------|-------------|--------|
| **Entity Management** (assets) | Monolithic `routes.ts` (2,088 lines) | Routes → Services → Repositories (16 files) | Done |
| **Auth** | Monolithic `routes.ts` | Routes → Services → Repositories | Done |
| **Config** | Monolithic `routes.ts` | Routes → Services → Repositories | Done |
| **Users** | Monolithic `routes.ts` | Monolithic routes | Pending |
| **Roles** | Monolithic `routes.ts` | Monolithic routes | Pending |
| **Backup** | Monolithic `routes.ts` | Monolithic routes | Pending |
| **Notifications** | Monolithic `routes.ts` | Monolithic routes | Pending |
| **Audit** | Monolithic `routes.ts` | Monolithic routes | Pending |

### Shared Infrastructure (Phase 0)
| Component | Status |
|-----------|--------|
| `types/context.ts` — RequestContext interface | Done |
| `lib/errors.ts` — AppError, NotFoundError, ValidationError, ConflictError, ForbiddenError | Done |
| `lib/build-context.ts` — extract user info from request | Done |
| `lib/error-schemas.ts` — reusable Swagger error response schemas | Done |
| Global error handler in `app.ts` | Done |

## Recent Changes (Phase 2+)

### 1. Checklist Feature — Entity Templates
Add 14-type checklist schema to entity template definitions, enabling structured inspection/verification questions.

| File | Change |
|------|--------|
| `packages/shared/src/schemas/assets.ts` | Added `CHECKLIST_QUESTION_TYPES` constant (14 types), `checklistItemSchema` Zod schema, `checklistSchema` field to `createAssetTemplateSchema` and `updateAssetTemplateSchema` |
| `apps/api/src/modules/assets/routes/template.routes.ts` | Added `checklistSchema` to Swagger request body and all response schemas (POST, PUT, GET list, GET by ID) |
| `apps/api/src/modules/assets/services/template.service.ts` | Passes `checklistSchema` through CRUD operations and version snapshots |
| `apps/web/src/routes/assets/templates.tsx` | Checklist builder section in create/edit dialog; read-only checklist display in view dialog |

### 2. Audit Log Descriptions — Entity Management
Update audit trail text templates so entity/template actions produce clear human-readable log entries.

| File | Change |
|------|--------|
| `packages/shared/src/types/audit-templates.ts` | Updated `AUDIT_TEMPLATE_DEFAULTS` — 12 entity actions (ASSET_TEMPLATE_CREATED/UPDATED/DELETED, ASSET_TEMPLATE_VERSION_CREATED, ASSET_CREATED/UPDATED/STATUS_CHANGED/DELETED, ASSET_RELATIONSHIP_CREATED/DELETED, ASSET_IDENTIFIER_CREATED/DELETED) with descriptive templates and placeholder arrays |
| `apps/api/src/plugins/audit-logger.ts` | Aligned audit log calls with updated template placeholders |

### 3. Privileges & Reauth Configuration
Ensure entity/template operations appear correctly in role-privilege and action-reauth config pages.

| File | Change |
|------|--------|
| `packages/shared/src/types/feature-privileges.ts` | Added/updated entity privileges: `assets.view`, `assets.create`, `assets.edit`, `assets.delete`, `assets.templates`, `assets.relationships`, `assets.identifiers` |
| `packages/shared/src/types/reauth-actions.ts` | Fixed entity reauth actions: `CREATE/UPDATE/DELETE_ASSET_TEMPLATE`, `CREATE/UPDATE/DELETE_ASSET`, `CREATE/DELETE_ASSET_RELATIONSHIP`, `CREATE/DELETE_ASSET_IDENTIFIER` |
| `apps/web/src/routes/audit/index.tsx` | Aligned audit filter categories with updated action names |

### 4. Unit & E2E Tests
Add test coverage for checklist schemas, audit templates, and checklist CRUD lifecycle.

| File | Tests | Type |
|------|-------|------|
| `packages/shared/src/schemas/assets.test.ts` | 20 tests — checklist constants, valid/invalid items, all 14 types, edge cases | Unit |
| `packages/shared/src/types/audit-templates.test.ts` | 17 tests — categories, required fields, placeholder-template consistency, action groups | Unit |
| `apps/api/src/e2e/checklist-templates.test.ts` | 14 tests — create/read/update/delete with checklistSchema, version snapshots, validation, all 14 types | E2E |

### 5. Bug Fix — GET /templates/:id Response Schema
Fix Fastify stripping `checklistSchema` from GET-by-ID responses due to missing Swagger response declaration.

| File | Change |
|------|--------|
| `apps/api/src/modules/assets/routes/template.routes.ts` | Added `checklistSchema: { type: 'array' }` to GET `/templates/:id` 200 response schema (was already present in GET list but missing from GET by ID) |

## What's NOT Done (Future Phases)
- API refactoring: Users, Roles, Backup, Notifications, Audit modules (pending Routes → Services → Repositories)
- Electronic signatures (e-sign with re-authentication)
- Logbook entries / digital forms
- HTTPS/TLS certificates
- Reports & Exports (PDF/Excel)
- Frontend component tests (Vitest + React Testing Library)

---

## Governance Task Log

### TASK-GOV-001: Documentation Governance Enforcement Activation

| Field | Details |
|-------|---------|
| **Task Name** | Activate documentation governance enforcement |
| **Status** | Completed |
| **Module** | Documentation / Governance |
| **Date** | 2026-02-25 |
| **Version** | 2.1.1 |
| **Description** | Activated permanent self-enforcing documentation synchronization. All 7 core documents (CHANGELOG.md, API_GUIDE.md, task_status.md, BUSINESS_CONTEXT.md, CODEBASE_CONTEXT.md, PLAN.md, Project_Summary.md) now auto-updated on every prompt. |
| **Technical Notes** | Process-only change. No code, API, or schema modifications. Establishes audit-ready documentation governance for enterprise compliance. |

**Documentation Update Checklist:**
- CHANGELOG.md ✅
- API_GUIDE.md ✅
- task_status.md ✅
- BUSINESS_CONTEXT.md ✅
- CODEBASE_CONTEXT.md ✅
- PLAN.md ✅
- Project_Summary.md ✅

### TASK-GOV-002: Testing Documentation Centralization

| Field | Details |
|-------|---------|
| **Task Name** | Centralize testing documents to /documentation/testing/ |
| **Status** | Completed |
| **Module** | Documentation |
| **Date** | 2026-02-25 |
| **Version** | 2.1.1 |
| **Description** | Moved 8 testing documents from root to centralized `/documentation/testing/` with subfolders. Created Bug_Resolution_Log.md (12 bugs), Project_Summary.md, and Git issue template. Updated all cross-references. |
| **Technical Notes** | Git mv used for history preservation. Subfolders: manual/, reports/, automation/, validation/, regression/. |

**Documentation Update Checklist:**
- CHANGELOG.md ✅
- API_GUIDE.md ✅
- task_status.md ✅
- BUSINESS_CONTEXT.md ✅
- CODEBASE_CONTEXT.md ✅
- PLAN.md ✅
- Project_Summary.md ✅

### TASK-GOV-003: Git Issue Lifecycle for Bug Resolution Log

| Field | Details |
|-------|---------|
| **Task Name** | Create Git issues for all bugs in Bug_Resolution_Log.md |
| **Status** | Completed |
| **Module** | Documentation / Bug Lifecycle |
| **Date** | 2026-02-25 |
| **Version** | 2.1.2 |
| **Description** | Created 12 structured GitHub issues (#2–#13) for all bugs. Closed 11 resolved issues with commit references. BUG-012 (#13) remains open (low priority). Updated Bug_Resolution_Log.md with linked Git Issue IDs. |
| **Technical Notes** | Process-only change. No code modifications. Labels applied: bug, severity, module. Full traceability chain: Bug_Resolution_Log → Git Issue → Commit. |

**Documentation Update Checklist:**
- CHANGELOG.md ✅
- API_GUIDE.md ✅
- task_status.md ✅
- BUSINESS_CONTEXT.md ✅
- CODEBASE_CONTEXT.md ✅
- PLAN.md ✅
- Project_Summary.md ✅

---

### Data Ingestion & Integration Layer (Phases A-K)

| Module | Files | Status |
|--------|-------|--------|
| Phase A: Infrastructure | Docker, TimescaleDB, 16 Prisma models, packages/db, packages/queue | Done |
| Phase B: Transport | MQTT auth, MQTT client, WS handler, HTTP data ingestion, RPC | Done |
| Phase C: Pipeline | BullMQ worker, 11 pipeline stages, telemetry batcher, DLQ, maintenance | Done |
| Phase D: Rule Chain Engine | 31 node types, BFS execution, sandboxed VM, sub-chain delegation, 14 endpoints | Done |
| Phase E: UNS | ISA-95 path builder, cascade moves, wildcard search, 6 endpoints | Done |
| Phase F: Queries & Export | Telemetry, alarms (5 endpoints), export, retention, 21 endpoints | Done |
| Phase G-J: Integration | Connectivity, QR codes, help articles, 3 frontend pages | Done |
| Phase K: Testing & Docs | 1,344 total tests, 83+ test files, 3 packages (shared, db, api) | Done |
| v3.0: Security & Refactoring | 8 security fixes, CI/CD, TimescaleDB, component extraction, RBAC fixes | Done |

---

## Summary
**All phases complete (Phase 1 through K + v3.0 + v3.1 System Validation + Phase 2 Digital FMS + Phase 3 enhancements).** As of 2026-04-04, the platform has ~200+ API endpoints across 34 modules, 20+ frontend route groups, 57 Prisma models (17 enums), 7 TimescaleDB hypertables, **77 rule chain node types** across 8 categories, 52+ permissions, and 1,344 automated tests (0 failures). Running on EC2 at `34.232.224.0` via PM2 + nginx.

### System Validation (2026-03-09)
- **System Health Score: 87/100**
- 48 rule chain nodes cataloged, 4 test chains created, 30+ APIs live-tested
- E2E workflow verified: Login → Template → Entity → Rule Chain → Telemetry → Alarm lifecycle
- Performance: 50 msg in 2.7s (0 failures), all APIs <100ms
- **7 bugs found** — see `tasks/system-validation-report.md`
- **Open bugs**: BUG-V002 (TimescaleDB write gap), BUG-V003/V004 (route conflicts), BUG-V005 (missing connectivity list), BUG-V007 (export params)

## 2026-04-14 Updates

### Completed Tasks
| Task | Details |
|------|---------|
| Permissions overhaul | Expanded to 95 permission constants and 82 feature privileges with FEATURE_TO_PERMISSION_MAP |
| Color themes | Centralized theme system via `lib/themes.ts` and `lib/theme-styles.ts`; applied to most pages |
| Report settings | New config definition (`report-settings.def.ts`), hook (`use-report-config.ts`), wrapper (`report-page-wrapper.tsx`), and config page (`report-settings.tsx`) |
| PM redesign | PM schedule UI overhaul with improved filter-set modes and past-date validation |
| Reauth fixes | Fixed reauth popup issues; removed stale reauth entries |
| SUPER_ADMIN bypass | RBAC plugin short-circuits all permission checks for SUPER_ADMIN role |
| Bulk upload template | Template download added for bulk filter CSV/Excel uploads |
| Bug fixes | Various fixes across config, filter operations, and mobile pages |

### Next Priority
1. HTTPS/TLS certificates for production
2. Multi-tenant isolation improvements
3. Reports & dashboards (PDF/Excel)
4. Frontend component tests (Vitest + React Testing Library)

## Phase 2: Digital Filter Management System

### Backend Modules
| Module | Status | Endpoints |
|--------|--------|-----------|
| cleaning-profiles | Done | CRUD, versioning, pipeline validation |
| filter-profiles | Done | CRUD, assign to filters |
| filter-operations | Done | start-cycle, advance, bypass, submit-checklist, current-state |
| filter-operations/events | Done | events, cycles, cycles/:id, reasons |
| pm-schedules | Done | CRUD, executions |
| checklist-profiles | Done | CRUD, questions, reorder, usage check on delete |

### Frontend Pages
| Page | Status | Route |
|------|--------|-------|
| Filter Operations | Done | /filters |
| Cleaning Profile List | Done | /filter-cleaning-profiles |
| Cleaning Profile Editor | Done | /filter-cleaning-profiles/:id/edit |
| Filter Profile List | Done | /filter-profiles |
| Cleaning Cycle History | Done | /cleaning-cycles |
| Cleaning Cycle Timeline | Done | /cleaning-cycles/:id |
| Checklist Profile List | Done | /checklists |
| Checklist Profile Detail | Done | /checklists/:id |
| PM Schedule List | Done | /pm-schedules |
| PM Schedule Detail | Done | /pm-schedules/:entityId |
| AHU Dashboard | Done | /ahus/:id |
| Filter Traceability | Done | /filters/:id/trace |
| Lifecycle Config | Done | /config/filter-lifecycle |
| Cleaning Reasons Config | Done | /config/filter-cleaning-reasons |

### Database
| Table | Status |
|-------|--------|
| filter_cleaning_profiles | Done |
| filter_pipeline_stages | Done |
| filter_pipeline_connections | Done |
| filter_profiles | Done |
| cleaning_cycles | Done |
| filter_events | Done |
| pm_schedules | Done |
| pm_schedule_entries | Done |
| pm_executions | Done |

### Quality Audit (2026-03-27)
- 43 issues found (7 CRITICAL, 11 HIGH, 16 MEDIUM, 9 LOW)
- 35 issues fixed, 30 GitHub issues created (#36-#65) and closed
- All fixes committed (429538f) and pushed to origin/DigitalFMS


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
