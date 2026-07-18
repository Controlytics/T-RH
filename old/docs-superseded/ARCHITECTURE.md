# DigiLog Architecture

## System Overview

```
                    ┌─────────────┐
                    │   Nginx     │ (HTTP/HTTPS reverse proxy)
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
        │  Vite SPA  │ │Fastify│ │   EMQX    │
        │ (React)    │ │ API   │ │ (MQTT)    │
        │ Port: 5175 │ │:3000  │ │:1883/8883 │
        │ (dev)      │ │       │ │           │
        └────────────┘ └───┬───┘ └─────┬─────┘
                           │           │
              ┌────────────┼───────────┤
              │            │           │
        ┌─────┴─────┐ ┌───┴────────┐ ┌────┴────┐
        │PostgreSQL  │ │TimescaleDB │ │ Redis 5 │
        │digilog_db  │ │digilog_tsdb│ │  :6379  │
        │:5432 (PG18)│ │:5432       │ └─────────┘
        └────────────┘ └────────────┘
```

## Backend Architecture (Fastify)

### Module Structure
34 API modules organized by domain:

| Module | Routes | Description |
|--------|--------|-------------|
| auth | `/api/auth/*` | Login, logout, profile, password, sessions |
| users | `/api/users/*` | User CRUD, stats, enable/disable, unlock |
| roles | `/api/roles/*` | Role CRUD with hierarchy and permissions |
| config | `/api/config/*` | 24 config definitions with auto-discovery |
| audit | `/api/audit/*` | Immutable audit trail with hash-chain |
| notifications | `/api/notifications/*` | In-app notifications and badges |
| notification-delivery | `/api/notification-settings/*` | Email/SMS/Telegram/Slack delivery config |
| notification-rules | `/api/notification-rules/*` | Event-based routing rules |
| assets (templates) | `/api/templates/*` | Entity template CRUD with versioning |
| assets (instances) | `/api/instances/*` | Entity CRUD, tree, hierarchy |
| assets (relationships) | `/api/relationships/*` | 12 relationship types with cycle detection |
| assets (identifiers) | `/api/identifiers/*` | QR/RFID/NFC/Barcode identifiers |
| data-ingestion | `/api/v1/*` | HTTP telemetry, attributes, events, binary |
| rule-chain | `/api/rule-chains/*` | Visual rule chain editor with 77 node types |
| uns | `/api/uns/*` | ISA-95 namespace management |
| queries (telemetry) | `/api/queries/telemetry/*` | Latest, history, aggregation, delta |
| queries (alarms) | `/api/alarms/*` | Alarm lifecycle with e-signatures |
| queries (export) | `/api/export/*` | CSV/JSON export with background jobs |
| queries (retention) | `/api/retention/*` | Per-table data retention policies |
| connectivity | `/api/connectivity/*` | Device status, credentials, snippets |
| qr-code | `/api/qr-codes/*` | QR code generation and management |
| help | `/api/help/*` | Versioned help articles |
| backup | `/api/backup/*` | Database backup and restore |
| uploads | `/api/uploads/*` | File upload handling |
| system-health | `/api/system-health/*` | Request tracking and metrics |
| debug-traces | `/api/debug/*` | Pipeline execution traces |
| user-groups | `/api/user-groups/*` | User group management |
| entity-assignments | `/api/entity-assignments/*` | Entity assignment management |
| ldap | `/api/ldap/*` | LDAP/Active Directory integration |
| admin-requests | `/api/admin-requests/*` | Admin approval requests |
| org-admin | `/api/org-admin/*` | Organization administration |
| tenant-admin | `/api/tenant-admin/*` | Tenant management |
| super-admin | `/api/super-admin/*` | Super admin operations |
| deployment-check | `/api/deployment-check/*` | Deployment verification |
| **cleaning-profiles** | `/api/filter-cleaning-profiles/*` | Pipeline profile CRUD (Phase 2) |
| **filter-profiles** | `/api/filter-profiles/*` | Filter-to-profile assignment (Phase 2) |
| **filter-operations** | `/api/filters/*` | Cycle lifecycle, advance, bypass, checklist (Phase 2) |
| **pm-schedules** | `/api/pm-schedules/*` | PM schedule CRUD, execution (Phase 2) |
| **checklist-profiles** | `/api/checklist-profiles/*` | Checklist template CRUD (Phase 2) |
| **equipment-groups** | `/api/equipment-groups/*` | Equipment group management (Phase 2) |

### Phase 3 — Offline & RFID
- **Offline Store** (`lib/offline-store.ts`) — IndexedDB wrapper with 3 object stores: `operations` (queued ops), `cache` (TTL-based data cache), `filters` (filter snapshot)
- **Sync Engine** (`lib/sync-engine.ts`) — auto-syncs pending operations on reconnect, FIFO order, skip-on-conflict
- **useOffline Hook** (`hooks/use-offline.ts`) — `executeOrQueue()` for offline-safe API calls
- **RFID Guard** (`hooks/use-rfid-guard.ts`) — global keydown interceptor blocks rapid UKB keyboard input from non `data-rfid="true"` fields
- **Mobile Operations** (`routes/mobile/mobile-operations.tsx`) — all cleaning operations use `executeOrQueue()`, caches templates/reasons/identifiers for offline

### Data Flow (Telemetry Ingestion)

```
Device -> MQTT/HTTP -> Entity Resolver (token->entity) -> Validation
  -> Rule Chain Execution (77 node types) -> Alarm Processing
  -> Data Persistence (TSDB + Latest Cache) -> Event Emission (Redis pub/sub + WebSocket)
```

### Key Libraries
- **Prisma** — ORM for PostgreSQL (digilog_db), 57 models
- **pg** — Direct connection to TimescaleDB (digilog_tsdb)
- **BullMQ** — Background job queue (ingestion workers)
- **node:vm** — Sandboxed JS execution for rule chain scripts
- **EMQX** — MQTT broker with custom auth/ACL hooks

## Frontend Architecture (React + Vite)

### Tech Stack
- React 19 with TypeScript
- React Router v7 (SPA routing)
- SWR for data fetching with real-time revalidation
- ReactFlow for rule chain visual editor and pipeline editor
- Tailwind CSS 4 for styling (light theme only)
- React Hook Form + Zod for form validation

### Key Pages
- Dashboard (home), Assets (entity tree + detail), Rule Chains (list + editor)
- Alarms, Audit Trail, Notifications, System Health
- Config (23 setting pages), Users, Profile
- Checklist (mobile-optimized, standalone auth)
- **Phase 2:** Filter Operations, Cleaning Profiles (with pipeline editor), Filter Profiles, Cleaning Cycles (history/timeline), PM Schedules, AHU Dashboard, Filter Traceability, Equipment Groups, Bulk Upload, Retirement/Replacement

### Frontend Routes/Pages
admin-requests, alarms, assets (with dialogs/tabs/hooks), audit, auth, checklist, checklists, cleaning-cycles (history/timeline), config (branding/notification-rules/notification-settings/roles), debug, filter-management (operations/profiles/status/scan/traceability/AHU dashboard/cleaning-profile-editor/retirement/replacement/bulk-upload/equipment), mobile, notifications, pm-schedules, profile, rule-chains, system-health, tenant, users

## Database Schema

### PostgreSQL (digilog_db) — 57 Prisma Models
Core application data: users, roles, sessions, entities, templates, relationships, identifiers, rule chains, alarms, audit trail, notifications, config, help articles, electronic signatures, checklist reviews, dashboards, notification rules/templates/logs, user groups.

**Phase 2 Models (11 tables):** FilterCleaningProfile, FilterPipelineStage, FilterPipelineConnection, FilterProfile, CleaningCycle, FilterEvent, PmSchedule, PmScheduleEntry, PmExecution, EquipmentGroup, EquipmentGroupInstrument, ChecklistProfile, ChecklistQuestion.

**17 Enums:** RoleScope, DashboardScope, AssigneeType, UserStatus, NotificationType, NotificationChannel, NotificationDeliveryStatus, NotificationEventType, PmScheduleStatus, PmExecutionStatus, FilterSetLabel, PipelineFlowMode, PipelineNodeType, CleaningCycleStatus, FilterEventType, BlockRestriction, ChecklistQuestionType.

### TimescaleDB (digilog_tsdb)
Time-series hypertables: ts_telemetry, ts_attributes, ts_checklist_responses, ts_device_events, ts_binary_data, ts_pipeline_traces, ts_alarm_history.

## Security

- JWT authentication with 30-minute auto-refresh
- Session management with idle timeout and single-tab enforcement
- Re-authentication for sensitive operations
- SHA-256 hash-chain audit trail
- Input sanitization (HTML stripping) on all text fields
- Rate limiting on device data ingestion
- IP allowlists for device credentials
- LDAP/Active Directory integration support

## Phase 2: Filter Management Module

### Backend Modules (6)
```
apps/api/src/modules/
  cleaning-profiles/      -- CRUD, versioning, pipeline validation
  filter-profiles/        -- CRUD, assign to filters
  filter-operations/      -- Cycle lifecycle, advance, bypass, checklist, events
  pm-schedules/           -- PM schedule CRUD, execution tracking
  checklist-profiles/     -- Checklist template CRUD, questions management
  equipment-groups/       -- Equipment group management
```

### Database Schema (11+ tables)
```
filter_cleaning_profiles  -- Pipeline profiles (name, flowMode, version, alarmFlags)
filter_pipeline_stages    -- Pipeline nodes (START, STAGE, CHECKLIST, END)
filter_pipeline_connections -- Directed edges between pipeline nodes
filter_profiles           -- Links cleaning profiles to filter instances
cleaning_cycles           -- Cycle tracking (status, reason, timestamps)
filter_events             -- Immutable event log (transitions, checklists, deviations)
pm_schedules              -- Annual PM schedules per AHU
pm_schedule_entries       -- Monthly PM entries with tolerance windows
pm_executions             -- PM execution records
equipment_groups          -- Equipment group definitions
equipment_group_instruments -- Instruments in groups
checklist_profiles        -- Checklist templates
checklist_questions       -- Questions within checklist profiles
```

### Pipeline Architecture
```
START -> STAGE(WASH_IN) -> STAGE(WASH_OUT) -> CHECKLIST(Post-Wash) -> STAGE(DRY_IN) -> STAGE(DRY_OUT) -> END
```
- Nodes: START, END, STAGE (with stateKey), CHECKLIST (with checklistProfileId)
- Connections: directed edges (fromStageId -> toStageId)
- Flow modes: STRICT (sequential only) or BYPASS_ENABLED (with deviation logging)
- Checklists: automatically triggered when pipeline reaches a CHECKLIST node
- Auto-complete: cycle ends automatically when last STAGE leads to END

### Frontend Pages (14+)
```
/filters                      -- Filter Operations (8 stage blocks + filter status)
/filter-cleaning-profiles     -- Cleaning Profile list
/filter-cleaning-profiles/:id/edit -- Visual pipeline editor
/filter-profiles              -- Filter Profile list
/cleaning-cycles              -- Cycle history with expandable timeline
/cleaning-cycles/:id          -- Cycle detail timeline
/checklists                   -- Checklist Profile list
/checklists/:id               -- Checklist detail with questions
/pm-schedules                 -- PM Schedule list
/pm-schedules/:entityId       -- PM Schedule detail
/ahus/:id                     -- AHU Dashboard
/filters/:id/trace            -- Filter traceability
/config/filter-lifecycle      -- Lifecycle states config
/config/filter-cleaning-reasons -- Cleaning reasons config
```

## Deployment Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    EC2 Instance (t3.large)                    │
│                                                               │
│  ┌─────────┐   ┌──────────┐   ┌──────────────────────────┐  │
│  │  nginx   │──>│ Fastify  │──>│  PostgreSQL 18            │  │
│  │ (port 80)│   │ API      │   │  digilog_db (57 models)   │  │
│  │ React SPA│   │ (3000)   │   │  digilog_tsdb (TimescaleDB)│  │
│  │ /dist    │   │ PM2      │   └──────────────────────────┘  │
│  └─────────┘   └──────────┘                                  │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────────┐  │
│  │  EMQX    │  │ Redis 5  │  │  BullMQ Workers            │  │
│  │  MQTT    │  │ (6379)   │  │  - Ingestion pipeline      │  │
│  │  Broker  │  │          │  │  - Maintenance              │  │
│  └──────────┘  └──────────┘  └────────────────────────────┘  │
│                                                               │
│  Devices ──> MQTT/HTTP ──> Pipeline ──> Rule Engine ──> Alarms│
│  Browser ──> nginx ──> /api/* ──> Fastify ──> Prisma/TSDB    │
└──────────────────────────────────────────────────────────────┘
```

## Permission System Architecture

The permission system is built from five interconnected layers:

```
PERMISSIONS (permissions.ts)
  └─ 95 granular permission strings (e.g. "filter:operations:advance")
      │
FEATURE_PRIVILEGES (feature-privileges.ts)
  └─ 82 feature toggles grouped by module (e.g. "Show PM Schedules Tab")
      │
FEATURE_TO_PERMISSION_MAP (feature-privileges.ts)
  └─ Maps each feature toggle to its required permission(s)
      │
SIDEBAR_PRIVILEGE_MAP (sidebar-privilege-map.ts)
  └─ Controls which sidebar items appear based on feature toggles
      │
REAUTH_ACTIONS (reauth-actions constant in config)
  └─ 69 sensitive actions requiring re-authentication before execution
```

Roles store both `permissions[]` and `featurePrivileges[]`. The frontend checks feature privileges to show/hide UI elements, and the backend checks permissions for API authorization. Re-authentication is enforced by the `reauth` plugin on tagged routes.

## Theme System

```
themes.ts (10 preset color palettes)
  └─ CSS variables (--primary, --accent, --sidebar-bg, etc.)
      └─ use-branding hook (reads org config, applies CSS vars)
          └─ All pages consume via Tailwind classes / CSS var references
```

Theme selection is stored in the `branding` config definition. The `use-branding` hook loads the active theme on mount and injects CSS custom properties into `:root`.

## Report Configuration

```
use-report-config hook (fetches report-settings config)
  └─ ReportPageWrapper component (applies header/footer/layout)
      └─ 3 report pages: Cleaning Cycle, PM Schedule, Filter Traceability
```

Report settings (logo, header text, footer text, page size, orientation) are stored as a config definition and applied at render time by the wrapper component.

## Config Auto-Discovery

```
apps/api/src/modules/config/defs/*.def.ts (24 definition files)
  └─ config-discovery.ts (scans defs/ folder, builds registry)
      └─ GET /api/config/manifest (returns all discovered definitions)
          └─ Frontend config page renders cards from manifest
```

Each `.def.ts` file exports a config definition object (key, label, schema, defaults). The discovery module auto-imports all files in the `defs/` directory at startup, eliminating manual registration.

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
