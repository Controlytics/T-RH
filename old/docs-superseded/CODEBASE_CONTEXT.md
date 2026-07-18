# DigiLog Codebase Context & Reference

> Comprehensive reference for working on the DigiLog 21 CFR Part 11 Compliant Digital Logbook.
> Updated: 2026-04-04 (All Phases A-K Complete + Phase 2 Digital FMS + Phase 3 enhancements — 34 API modules, 57 Prisma models, 77 rule chain node types, 52+ permissions)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Tech Stack & Dependencies](#3-tech-stack--dependencies)
4. [Backend (apps/api)](#4-backend-appsapi)
5. [Frontend (apps/web)](#5-frontend-appsweb)
6. [Shared Package (packages/shared)](#6-shared-package-packagesshared)
7. [Database Schema (Prisma)](#7-database-schema-prisma)
8. [Authentication & Authorization](#8-authentication--authorization)
9. [API Route Inventory](#9-api-route-inventory)
10. [Frontend Routes & Pages](#10-frontend-routes--pages)
11. [Key Architectural Patterns](#11-key-architectural-patterns)
12. [Entity Management System](#12-entity-management-system)
13. [Configuration System](#13-configuration-system)
14. [Production Deployment](#14-production-deployment)
15. [Git & Development Workflow](#15-git--development-workflow)
16. [Test Suite](#16-test-suite)

---

## 1. Project Overview

DigiLog is a regulatory-compliant digital logbook for pharma/biotech/food manufacturing. Core features:

- **User Management** with role-based access, password policies, account lockout
- **Entity Management** (template-based) with hierarchical parent-child trees, relationships, identifiers
- **Audit Trail** with SHA-256 checksum integrity verification (21 CFR Part 11)
- **System Configuration** for branding, security, datetime, pagination, field labels
- **Notification System** with role-based delivery
- **Backup/Restore** with 4 export formats (JSON, BAK, SQL, CSV) — all restorable via UI
- **Data Ingestion & Integration** with MQTT transport, WebSocket real-time streaming, rule chain engine (77 node types, sandboxed VM execution, sub-chain delegation), telemetry queries, alarm management (with MANUALLY_CLEARED status), Unified Namespace (ISA-95), entity connectivity tracking, QR code generation, and alarm column visibility configuration
- **Digital Filter Management System** with cleaning profiles (visual pipeline editor), filter profiles, filter operations (cycle start/advance/bypass/checklist), PM schedules, checklist profiles, equipment groups, bulk upload, retirement/replacement

**Default Login:** `superadmin` / `Admin@123`

---

## 2. Monorepo Structure

```
21cfrlogbook/
├── apps/
│   ├── api/                    # Fastify 5 backend (port 3000)
│   │   ├── src/
│   │   │   ├── app.ts          # Entry point, middleware stack
│   │   │   ├── lib/            # Utilities (jwt, password, prisma, reauth, hash-chain, sanitize, etc.)
│   │   │   ├── plugins/        # Fastify plugins (auth, rbac, audit-logger)
│   │   │   ├── modules/        # 34 feature modules
│   │   │   │   ├── data-ingestion/   # HTTP ingestion, entity resolver, normalizer, pipeline, DLQ, connectivity tracker
│   │   │   │   ├── rule-chain/       # Rule chain engine, 77 node types, sandboxed VM execution, sub-chain delegation, debug recorder
│   │   │   │   ├── uns/              # Unified Namespace (ISA-95)
│   │   │   │   ├── queries/          # Telemetry, alarms, export, retention
│   │   │   │   ├── connectivity/     # Entity connectivity status & code snippets
│   │   │   │   ├── notification-rules/  # Notification rules CRUD, multi-select event types
│   │   │   │   ├── notification-delivery/ # Email/SMS/Telegram/Slack dispatch, dynamic templates, retry logic
│   │   │   │   ├── user-groups/          # User group management for notifications
│   │   │   │   ├── qr-code/          # QR code generation
│   │   │   │   ├── help/             # Help articles with versioning
│   │   │   │   ├── cleaning-profiles/    # Pipeline profile CRUD (Phase 2)
│   │   │   │   ├── filter-profiles/      # Filter-to-profile assignment (Phase 2)
│   │   │   │   ├── filter-operations/    # Cycle lifecycle, advance, bypass, checklist, events (Phase 2)
│   │   │   │   ├── pm-schedules/         # PM schedule CRUD, execution tracking (Phase 2)
│   │   │   │   ├── checklist-profiles/   # Checklist template CRUD (Phase 2)
│   │   │   │   └── equipment-groups/     # Equipment group management (Phase 2)
│   │   │   ├── transport/      # MQTT auth, MQTT client, WebSocket handler
│   │   │   └── workers/        # BullMQ ingestion & maintenance workers
│   │   ├── prisma/
│   │   │   ├── schema.prisma   # Database schema (57 models, 17 enums)
│   │   │   ├── seed.ts         # Default data seeding
│   │   │   └── sql/            # PostgreSQL extensions
│   │   └── uploads/            # Uploaded files directory
│   │
│   └── web/                    # React 19 frontend (Vite, port 5175 dev / port 80 prod)
│       ├── src/
│       │   ├── main.tsx        # Entry point with router + providers
│       │   ├── app.css         # Global Tailwind styles
│       │   ├── components/     # Layout + UI components + specialized
│       │   ├── hooks/          # 9 custom hooks
│       │   ├── lib/            # api-client, cn utility, swr-config
│       │   └── routes/         # Page components (auth, users, assets, config, audit, etc.)
│       └── public/             # Static assets
│
├── packages/
│   ├── shared/                 # Zod schemas + TypeScript types (consumed by both apps)
│   │   └── src/
│   │       ├── schemas/        # auth, users, config, audit, action-reauth, assets
│   │       ├── types/          # roles, permissions, sidebar-items, audit-actions, reauth-actions, etc.
│   │       └── index.ts        # Re-exports everything
│   ├── db/                     # Prisma singleton + TimescaleDB pg Pool (Phase A)
│   └── queue/                  # BullMQ queue definitions + Redis connection (Phase A)
│
├── documentation/               # Centralized documentation
│   ├── Bug_Resolution_Log.md   # Structured bug tracking
│   ├── Project_Summary.md      # Comprehensive project summary
│   └── testing/                # All testing documentation
│       ├── manual/             # TEST.md, TEST_CASES.md, TEST_SUMMARY.md
│       ├── reports/            # TEST_REPORT.md, TREE_DIAGRAM_TEST_REPORT.md, RBAC_TEST_RESULTS.md
│       ├── automation/         # rbac-test.sh
│       ├── validation/         # 21CFR_PART11_VERIFICATION.md
│       └── regression/         # Regression test results
│
├── .github/
│   └── ISSUE_TEMPLATE/
│       └── bug_report.md       # Structured bug report template
│
├── turbo.json                  # Turborepo pipeline: shared -> api -> web
├── package.json                # Root scripts
├── init-tsdb.sql               # TimescaleDB initialization (7 hypertables)
├── docker-compose.yml          # PostgreSQL 16 + TimescaleDB + EMQX + Redis
├── .env                        # Environment variables
└── CLAUDE.md                   # Project instructions
```

---

## 3. Tech Stack & Dependencies

| Layer | Technology | Version |
|-------|-----------|---------|
| **Monorepo** | Turborepo | Latest |
| **Backend** | Fastify | 5.2.0 |
| **Frontend** | React | 19.0.0 |
| **Build** | Vite | 6.1.0 |
| **Styling** | Tailwind CSS | 4.0.0 |
| **ORM** | Prisma | 6.3.0 |
| **Database** | PostgreSQL | 18 (pgcrypto) |
| **Auth** | jose (JWT) | 6.0.0 |
| **Password** | bcrypt | 5.1.1 |
| **Validation** | Zod | 3.24.0 |
| **Data Fetching** | SWR | 2.3.0 |
| **Forms** | React Hook Form | 7.54.0 |
| **Icons** | Lucide React | 0.474.0 |
| **Process Manager** | PM2 | Production |
| **Time-Series DB** | TimescaleDB | latest-pg16 |
| **MQTT Broker** | EMQX | 5-elixir |
| **Queue** | BullMQ | 5.x |
| **Redis** | Redis | 5 |
| **MQTT Client** | mqtt.js | 5.x |

**Key Backend Plugins:** @fastify/cors, @fastify/helmet, @fastify/rate-limit, @fastify/multipart, @fastify/static, @fastify/swagger, @fastify/swagger-ui

---

## 4. Backend (apps/api)

### Directory Structure

```
apps/api/src/
├── app.ts                          # Entry point + middleware registration
├── lib/
│   ├── prisma.ts                   # Prisma client singleton
│   ├── jwt.ts                      # Token sign/verify (HS256, jose)
│   ├── password.ts                 # bcrypt hash/verify (cost 12)
│   ├── hash-chain.ts               # SHA-256 checksum for audit integrity
│   ├── reauth-check.ts             # Re-auth validation (10s cache)
│   ├── user-id-validator.ts        # User ID format validation
│   ├── swagger.ts                  # Swagger UI at /docs
│   └── error-schemas.ts            # Standard error response schemas (400-500)
├── plugins/
│   ├── auth.ts                     # JWT validation, session checks, public path exclusions
│   ├── rbac.ts                     # requirePermission() + requireRole() decorators
│   └── audit-logger.ts             # Audit trail with SHA-256 checksums
├── modules/
│   ├── auth/routes.ts              # Login, logout, password, reauth (8 endpoints)
│   ├── users/routes.ts             # User CRUD, unlock, reset (11 endpoints)
│   ├── roles/routes.ts             # Role management (8 endpoints)
│   ├── config/routes.ts            # System configuration (15+ endpoints)
│   ├── assets/routes.ts            # Entity templates/instances/relationships/identifiers (21 endpoints)
│   ├── audit/routes.ts             # Audit trail query + integrity (4 endpoints)
│   ├── notifications/routes.ts     # Notification delivery (4 endpoints)
│   ├── uploads/routes.ts           # File upload (2 endpoints)
│   ├── backup/routes.ts            # Backup/restore (3 endpoints)
│   ├── data-ingestion/             # HTTP data ingestion, pipeline, DLQ (8 endpoints)
│   ├── rule-chain/routes.ts        # Rule chain engine (14 endpoints)
│   ├── uns/routes.ts               # Unified Namespace ISA-95 (6 endpoints)
│   ├── queries/                    # Telemetry (7), alarms (4), export (5), retention (4)
│   ├── connectivity/routes.ts      # Entity connectivity (6 endpoints)
│   ├── qr-code/routes.ts           # QR code generation (4 endpoints)
│   └── help/routes.ts              # Help articles (6 endpoints)
├── transport/
│   ├── mqtt-auth.ts                # MQTT broker authentication (3 endpoints)
│   ├── mqtt-client.ts              # MQTT client connection
│   └── ws-handler.ts               # WebSocket handler
└── workers/
    ├── ingestion.worker.ts         # BullMQ ingestion worker
    └── maintenance.worker.ts       # DLQ + connectivity maintenance
```

### Middleware Stack (in order)

1. **CORS** - configurable origins via `ALLOWED_ORIGINS` env
2. **Helmet** - security headers (HSTS 1-year, preload)
3. **Rate Limiting** - 100 req/min global; 10/min login; 5/5min forgot-password
4. **Multipart** - 5MB max, 1 file per request
5. **Static Files** - serves `/uploads/` directory
6. **Audit Logger Plugin** - `app.auditLog()` method
7. **Auth Plugin** - JWT validation + session tracking
8. **RBAC Plugin** - `requirePermission()` + `requireRole()` decorators

### Public Endpoints (No Auth)

- `GET /api/health`
- `POST /api/auth/login`, `/api/auth/forgot-password`, `/api/auth/beacon-logout`
- `GET /api/config/branding`, `/api/config/datetime/current`
- `GET /uploads/*`
- `GET /docs` (Swagger)

---

## 5. Frontend (apps/web)

### Directory Structure

```
apps/web/src/
├── main.tsx                           # Router + ErrorBoundary + ToastProvider + SWRConfig
├── app.css                            # Tailwind imports + custom styles
├── components/
│   ├── layout/
│   │   ├── app-layout.tsx             # Main wrapper (sidebar + header + outlet)
│   │   ├── header.tsx                 # Top bar with notifications + user menu
│   │   └── sidebar.tsx                # Left nav (dynamic items from config API)
│   ├── ui/
│   │   ├── button.tsx                 # Variants: default, destructive, outline, secondary, ghost, link, success
│   │   ├── input.tsx                  # secureField prop (disables copy/paste for 21 CFR)
│   │   ├── dialog.tsx                 # Modal with Escape key support
│   │   ├── card.tsx                   # Container components
│   │   ├── table.tsx                  # Table components
│   │   ├── badge.tsx                  # Inline badges
│   │   ├── select.tsx                 # Dropdown
│   │   └── toast.tsx                  # Toast notification component
│   ├── error-boundary.tsx             # Error catch + reload
│   ├── reauth-dialog.tsx              # Re-authentication password modal
│   ├── require-role.tsx               # Role-based route guard
│   └── toast-provider.tsx             # Toast context provider
├── hooks/
│   ├── use-auth.ts                    # Login/logout, user state, token management
│   ├── use-reauth.ts                  # Re-auth dialog flow + action checking
│   ├── use-session.ts                 # Idle timeout + warning countdown
│   ├── use-single-tab.ts             # Enforce single active tab per user
│   ├── use-toast.ts                   # Access global toast notifications
│   ├── use-branding.ts               # Fetch & cache branding config
│   ├── use-datetime-format.ts         # DateTime formatting with timezone
│   ├── use-field-labels.ts            # Dynamic field label config from API
│   └── use-pagination-config.ts       # Pagination options [10, 25, 50]
├── lib/
│   ├── api-client.ts                  # HTTP client with auth headers + error handling
│   ├── cn.ts                          # clsx + tailwind-merge utility
│   └── swr-config.ts                  # SWR fetcher + global config
└── routes/                            # Page components (see section 10)
```

### Custom Hooks Summary

| Hook | Purpose | Key Detail |
|------|---------|------------|
| `useAuth()` | Auth state + login/logout | Token in `sessionStorage`, SWR-based `/api/auth/me` |
| `useReauth()` | Sensitive action gating | Checks `/api/config/action-reauth/my-actions`, shows dialog if needed |
| `useSession()` | Idle timeout | Activity tracking (click/key/scroll), warning countdown, auto-logout |
| `useSingleTab()` | Multi-tab prevention | localStorage heartbeat, cross-tab coordination |
| `useToast()` | Toast notifications | 4 variants: success/error/warning/info, auto-dismiss 5s |
| `useBranding()` | App branding | Colors, logos, app name from `/api/config/branding` |
| `useDatetimeFormat()` | Date/time formatting | Configurable format + timezone from `/api/config/datetime/current` |
| `useFieldLabels()` | Dynamic field names | Customizable labels from `/api/config/field-ids` |
| `usePaginationConfig()` | Table page sizes | Options tuple from `/api/config/pagination/current` |

### API Client Pattern

```typescript
// lib/api-client.ts
class ApiClient {
  get<T>(url), post<T>(url, body), put<T>(url, body), patch<T>(url, body), delete<T>(url)
  // Re-auth variants (password in body + x-reauth-password header)
  deleteWithReauth<T>(url, password), postWithReauth<T>(url, body, password),
  putWithReauth<T>(url, body, password)
}
// Token from sessionStorage, 401 → redirect /login, special error handling
```

### SWR Configuration

```typescript
// lib/swr-config.ts
{ fetcher: apiClient.get, revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 5000 }

// Paginated responses: { data: T[], total, page, limit, totalPages }
const { data: res } = useSWR<{ data: Item[] }>('/api/items?page=1&limit=10');
const items = res?.data ?? [];

// Tree endpoints return plain arrays
const { data: tree } = useSWR<TreeNode[]>('/api/assets/instances/tree');
```

---

## 6. Shared Package (packages/shared)

### Schemas (`src/schemas/`)

| File | Schemas | Used By |
|------|---------|---------|
| `auth.ts` | `loginSchema`, `passwordChangeSchema`, `reAuthSchema` | Login, password change, reauth |
| `users.ts` | `createUserSchema`, `updateUserSchema`, `resetPasswordSchema`, `userQuerySchema`, `bulkDeleteUsersSchema` | User CRUD |
| `config.ts` | `brandingConfigSchema`, `passwordPolicySchema`, `loginSecuritySchema`, `sessionConfigSchema`, `datetimeConfigSchema`, `userIdConfigSchema`, `auditTemplatesSchema`, `paginationConfigSchema` | All config pages |
| `audit.ts` | `auditQuerySchema` | Audit trail |
| `action-reauth.ts` | `actionReauthConfigSchema` | Action reauth config |
| `assets.ts` | `createAssetTemplateSchema`, `updateAssetTemplateSchema`, `createAssetInstanceSchema`, `updateAssetInstanceSchema`, `createAssetRelationshipSchema`, `createAssetIdentifierSchema`, `assetQuerySchema`, `templateQuerySchema` | Entity management |

### Constants (`src/schemas/assets.ts`)

| Constant | Values |
|----------|--------|
| `ATTRIBUTE_DATA_TYPES` | TEXT, INTEGER, FLOAT, DATE, DATETIME, BOOLEAN, DROPDOWN, URL, FILE |
| `TELEMETRY_DATA_TYPES` | INTEGER, FLOAT, BOOLEAN, STRING, ENUM |
| `RELATIONSHIP_TYPES` | CONTAINS, CONTAINED_IN, CONNECTED_TO, FEEDS, FED_BY, DEPENDS_ON, DEPENDED_ON_BY, BACKS_UP, BACKED_UP_BY, MONITORS, MONITORED_BY, CUSTOM |
| `IDENTIFIER_TYPES` | QR, BARCODE, RFID, NFC, MANUAL |
| `ASSET_STATUSES` | Active, Inactive, Under Maintenance, Commissioning, Decommissioned |
| `ALARM_RULE_TYPES` | HIGH, LOW, HIGH_HIGH, LOW_LOW, RATE_OF_CHANGE, BOOLEAN_STATE, CUSTOM |
| `ALARM_SEVERITIES` | WARNING, ALARM, CRITICAL |
| `INVERSE_RELATIONSHIP_MAP` | CONTAINS<>CONTAINED_IN, FEEDS<>FED_BY, DEPENDS_ON<>DEPENDED_ON_BY, BACKS_UP<>BACKED_UP_BY, MONITORS<>MONITORED_BY, CONNECTED_TO<>CONNECTED_TO (symmetric) |

### Types (`src/types/`)

| File | Exports | Purpose |
|------|---------|---------|
| `roles.ts` | `DEFAULT_ROLES`, `USER_STATUS`, `RoleData` interface | Role hierarchy, user status enum |
| `permissions.ts` | `PERMISSIONS` (52+ keys), `Permission` type | All permission constants |
| `permission-categories.ts` | `PERMISSION_CATEGORIES` (10 categories) | Grouped permissions for role editor UI (User Management, System, Entity Management, Audit & Approvals, Notifications, Data & Ingestion, Rule Chains, Alarms, Checklists, Advanced) |
| `alarm-columns.ts` | `ALARM_COLUMN_DEFINITIONS`, `ALL_ALARM_COLUMN_IDS` | Alarm table column visibility definitions (11 columns) |
| `feature-privileges.ts` | `FEATURE_PRIVILEGES`, `FEATURE_PRIVILEGE_CATEGORIES` | Config page privilege management |
| `sidebar-items.ts` | `SIDEBAR_ITEMS` | Sidebar navigation config |
| `audit-actions.ts` | `AUDIT_ACTIONS` (60+ actions) | All audit log action types |
| `reauth-actions.ts` | `REAUTH_ACTIONS` (42+ actions), `REAUTH_ACTION_CATEGORIES` (13 categories) | Actions requiring re-auth |
| `audit-templates.ts` | `AUDIT_TEMPLATE_DEFAULTS`, `AUDIT_TEMPLATE_CATEGORIES` | Customizable audit messages |

---

## 7. Database Schema (Prisma)

### 57 Models (including Phase 2 FMS)

#### User & Auth (5 models)
- **User** — username, fullName, email, passwordHash, role (string), status (ENABLED/DISABLED/LOCKED/EXPIRED), forcePasswordChange, failedLoginAttempts, lockoutUntil, passwordExpiresAt
- **Role** — name (unique), displayName, hierarchyLevel, permissions (JSON array), color, isSystem, isActive
- **PasswordHistory** — userId (FK), passwordHash (prevents reuse)
- **Session** — userId (FK), tokenHash (SHA-256), ipAddress, userAgent, isActive, expiresAt, terminationReason
- **PasswordResetRequest** — userId, status (PENDING), requestedAt, processedAt, processedBy

#### Configuration (3 models)
- **SystemConfig** — configKey (unique), configValue (JSON), configType, requiresReauth
  - Keys: `password-policy`, `login-security`, `session`, `datetime`, `pagination`, `user-id`, `branding`, `action-reauth`, `audit-templates`, `alarm-columns`
- **UserConfig** — userId (unique), sidebarItems (JSON), homeWidgets (JSON), permissions (JSON)
- **RoleConfig** — role (unique), sidebarItems (JSON), homeWidgets (JSON), permissions (JSON)
- **FieldIdConfig** — fieldId, defaultName, displayName, module, description

#### Audit & Notifications (2 models)
- **AuditTrail** — timestamp, userId, userName, userRole, action, targetType, targetId, beforeValue, afterValue, reason, ipAddress, checksum (SHA-256), signatureMeaning
- **Notification** — type, title, message, targetUserId, forUserId, forRole, isRead, metadata (JSON)

#### Entity Management (5 models)
- **AssetTemplate** — name (unique), description, category, icon, version, attributeSchema (JSON), telemetrySchema (JSON), expectedIdentifiers (JSON), expectedRelationships (JSON), statusLifecycle (JSON), alarmRules (JSON), maxParentConnections, maxConnections, isActive, dataIngestionEnabled, transportType, credentialType, inactivityTimeout, defaultMaxDataRate, autoProvision, defaultRuleChainId
- **AssetTemplateVersion** — templateId (FK), versionNumber, snapshot (full JSON), changeNotes
- **AssetInstance** — name, templateId (FK), templateVersion, status, attributes (JSON), telemetryConfig (JSON), customAttributes (JSON), parentId (self-FK for tree), unsPath, isActive
- **AssetRelationship** — sourceAssetId, targetAssetId, relationshipType (enum), customLabel, notes
- **AssetIdentifier** — assetId (FK), identifierType (enum), identifierValue (globally unique), label, isPrimary

#### Data Ingestion & Integration (15 models — Phase A)
- **DeviceCredential** — entityId (unique), accessToken (unique), credentialData (JSON), status (INACTIVE/ACTIVE), allowedIps, maxDataRatePerMin, connection timestamps
- **RuleChain** — name, isRoot, isSystem, firstRuleNodeId, configuration (JSON), currentVersion, isActive
- **RuleChainVersion** — ruleChainId (FK), version, snapshot (JSON), status (ACTIVE/SUPERSEDED), createdBy
- **RuleNode** — ruleChainId (FK), type, name, configuration (JSON), debugEnabled, positionX/Y
- **RuleNodeConnection** — ruleChainId (FK), fromNodeId (FK), toNodeId (FK), label
- **Alarm** — entityId, alarmType, severity, status (ACTIVE/ACKNOWLEDGED/CLEARED/MANUALLY_CLEARED), unsPath, trigger details, clearDetails (JSON, telemetry at clear time), ack/clear tracking with e-signatures
- **ChecklistReview** — checklistId (unique), entityId, templateId, 3-step workflow (performed→checked→verified), rejection tracking
- **ElectronicSignature** — recordType, recordId, signer info, signedAt, meaning, recordHash (SHA-256), signatureHash (SHA-256), reAuthVerified
- **LatestTelemetry** — entityId + key (unique), valueNum/valueStr/valueBool/valueJson, lastUpdated
- **UnsMapping** — entityId (unique), unsPath (unique), pathSegments (JSON), isOverridden
- **ConnectivityStatus** — entityId (unique), status (ONLINE/OFFLINE/UNKNOWN), last activity/connection timestamps, protocol, sourceIp
- **QrCode** — entityId (unique), qrData, imagePath, svgData, size, includeLabel
- **HelpArticle** — key (unique), title, content, category, sortOrder, currentVersion, versions relation
- **HelpArticleVersion** — helpArticleId (FK), version, content, changedBy, changeNotes
- **DataStream** — entityId + key (unique), dataType, unit, unsPath, source
- **IngestionSystemConfig** — key (unique), value, dataType, category, label, description, defaultValue, min/maxValue, unit, requiresRestart, isSecret

### Default Seed Data

**Roles (6):** SUPER_ADMIN (level 6), ADMIN (5), SUPERVISOR (4), MAINTENANCE (3), OPERATOR (2), VIEWER (1)

**Default User:** admin / Admin@123 (SUPER_ADMIN, forcePasswordChange: true)

**Config Defaults:** password-policy (minLength=8, reuseCount=12, expiryDays=90), login-security (maxFailed=5, lockout=30min), session (8h duration, 15min idle), datetime (DD/MM/YYYY, 24h, UTC), pagination (recordsPerPage=20)

**Ingestion Config (33):** Hot-reload settings across categories: rule_engine, device, pipeline, rpc, export, websocket, retention, mqtt, binary, ingestion

**Help Articles (28):** Getting Started, User Management, Entity Management, Data & Telemetry, Alarms, Rule Chains, Checklists, UNS, Connectivity, QR Codes, Compliance, System Administration

---

## 8. Authentication & Authorization

### JWT

- **Algorithm:** HS256 (jose library)
- **Payload:** `{ sub, username, role, sessionId }`
- **Duration:** 8 hours (configurable via session config)
- **Storage:** `sessionStorage.setItem('access_token', token)`
- **Secrets:** `JWT_SECRET`, `VERIFICATION_TOKEN_SECRET` (env vars)

### Sessions

- Stored in `Session` table with tokenHash (SHA-256, not plaintext)
- **Single active session per user** — new login terminates previous
- Tracked: userId, tokenHash, ipAddress, userAgent, isActive, expiresAt, terminationReason

### Authorization: Two Systems

| System | Method | Used By | How It Works |
|--------|--------|---------|-------------|
| `requirePermission(perm)` | Checks role.permissions JSON array in DB | Entity/Asset routes | Dynamic, based on configured role permissions |
| `requireRole(...names)` | Checks role name string | User, Role, Config routes | Static role name matching |

### Permission Constants (39+ total, 10 categories)

```
User Management: USER_CREATE, USER_READ, USER_UPDATE, USER_DELETE, USER_ENABLE_DISABLE, USER_UNLOCK, USER_RESET_PASSWORD
System: CONFIG_READ, CONFIG_UPDATE, FIELD_ID_UPDATE, ROLE_MANAGE
Entity Management: ASSET_TEMPLATE_MANAGE, ASSET_CREATE, ASSET_UPDATE, ASSET_DELETE, ASSET_VIEW, ASSET_RELATIONSHIP_MANAGE, ASSET_IDENTIFIER_MANAGE
Audit & Approvals: AUDIT_READ, AUDIT_EXPORT, APPROVAL_REVIEW, APPROVAL_REQUEST
Notifications: NOTIFICATION_MANAGE
Data & Ingestion: DATA_INGEST, DATA_VIEW, DATA_MANAGE, DATA_EXPORT
Rule Chains: RULE_CHAIN_VIEW, RULE_CHAIN_MANAGE
Alarms: ALARM_VIEW, ALARM_MANAGE
Checklists: CHECKLIST_SUBMIT, CHECKLIST_REVIEW, CHECKLIST_APPROVE
Advanced: UNS_VIEW, UNS_MANAGE, QR_CODE_GENERATE, HELP_MANAGE, READ_DEBUG_TRACE, MANAGE_DEBUG_TRACE, RETENTION_MANAGE, SYSTEM_CONFIG_MANAGE
```

### Re-Authentication (enforceReauth)

- Dynamic: reads from DB `SystemConfig.action-reauth` (cached 10 seconds)
- Per-action, per-role configuration
- Password sent via `_currentPassword` body field or `x-reauth-password` header
- Frontend: `useReauth()` hook checks `/api/config/action-reauth/my-actions` before executing
- **All `reauth.execute()` calls must be `await`-ed** (prevents race conditions)

### Audit Trail

- **SUPER_ADMIN actions are NOT logged** (21 CFR Part 11 exemption)
- SHA-256 checksum on: timestamp, userId, action, targetType, targetId, afterValue
- Read-time verification: recompute checksum, return `integrityValid: boolean`

---

## 9. API Route Inventory

### Auth (`/api/auth`) — 8 endpoints
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /login | No | Login with username/password |
| POST | /logout | Yes | Terminate session |
| POST | /beacon-logout | No | Logout via sendBeacon (tab close) |
| GET | /me | Yes | Get current user profile |
| PUT | /profile | Yes | Update own profile |
| POST | /change-password | Yes | Change password |
| POST | /verify | Yes | Re-authenticate for sensitive ops |
| POST | /forgot-password | No | Password reset request |

### Users (`/api/users`) — 11 endpoints
| Method | Path | Reauth Action | Purpose |
|--------|------|--------------|---------|
| GET | / | — | List users (paginated, searchable) |
| GET | /stats | — | User count stats by status |
| POST | / | CREATE_USER | Create new user |
| GET | /:id | — | Get user details |
| PUT | /:id | UPDATE_USER | Update user |
| DELETE | /:id | DELETE_USER | Delete user |
| POST | /:id/enable | UPDATE_USER | Enable account |
| POST | /:id/disable | UPDATE_USER | Disable account |
| POST | /:id/unlock | UPDATE_USER | Unlock locked account |
| POST | /:id/password-reset | RESET_USER_PASSWORD | Admin password reset |
| POST | /bulk/delete | DELETE_USER | Bulk delete users |

### Roles (`/api/roles`) — 8 endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | / | List all roles (SUPER_ADMIN/ADMIN) |
| GET | /active | List active roles (all users, for dropdowns) |
| GET | /:name | Get role by name |
| GET | /permissions/all | List all available permissions (SUPER_ADMIN) |
| GET | /:name/creatable | Get roles this role can create |
| POST | / | Create custom role (SUPER_ADMIN) |
| PUT | /:name | Update role (SUPER_ADMIN) |
| DELETE | /:name | Delete role (SUPER_ADMIN) |

### Entity Management (`/api/assets`) — 21 endpoints

**Templates (6):**
| Method | Path | Permission | Reauth |
|--------|------|-----------|--------|
| GET | /templates | ASSET_VIEW | — |
| GET | /templates/:id | ASSET_VIEW | — |
| POST | /templates | ASSET_TEMPLATE_MANAGE | CREATE_ASSET_TEMPLATE |
| PUT | /templates/:id | ASSET_TEMPLATE_MANAGE | UPDATE_ASSET_TEMPLATE |
| DELETE | /templates/:id | ASSET_TEMPLATE_MANAGE | DELETE_ASSET_TEMPLATE |
| GET | /templates/:id/versions | ASSET_VIEW | — |

**Instances (8):**
| Method | Path | Permission | Reauth |
|--------|------|-----------|--------|
| GET | /instances | ASSET_VIEW | — |
| GET | /instances/tree | ASSET_VIEW | — |
| GET | /instances/:id | ASSET_VIEW | — |
| POST | /instances | ASSET_CREATE | CREATE_ASSET |
| PUT | /instances/:id | ASSET_UPDATE | UPDATE_ASSET |
| PATCH | /instances/:id/status | ASSET_UPDATE | UPDATE_ASSET |
| DELETE | /instances/:id | ASSET_DELETE | DELETE_ASSET |
| GET | /instances/:id/children | ASSET_VIEW | — |

**Relationships (3):**
| Method | Path | Permission | Notes |
|--------|------|-----------|-------|
| GET | /relationships | ASSET_VIEW | — |
| POST | /relationships | ASSET_RELATIONSHIP_MANAGE | Auto-creates inverse; enforces maxConnections |
| DELETE | /relationships/:id | ASSET_RELATIONSHIP_MANAGE | Deletes both sides |

**Identifiers (4):**
| Method | Path | Permission | Reauth |
|--------|------|-----------|--------|
| GET | /identifiers | ASSET_VIEW | — |
| GET | /identifiers/lookup/:value | ASSET_VIEW | — |
| POST | /identifiers | ASSET_IDENTIFIER_MANAGE | CREATE_ASSET_IDENTIFIER |
| DELETE | /identifiers/:id | ASSET_IDENTIFIER_MANAGE | DELETE_ASSET_IDENTIFIER |

### Config (`/api/config`) — 36+ endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET/PUT | /password-policy | Password policy config |
| GET/PUT | /login-security | Login security config |
| GET/PUT | /session | Session config |
| GET | /datetime/current | Get datetime format (public) |
| GET/PUT | /datetime | DateTime config |
| GET | /pagination/current | Get pagination settings (public) |
| GET/PUT | /pagination | Pagination config |
| GET/PUT | /user-id | User ID format config |
| GET | /user-id/next | Get next auto-generated User ID |
| POST | /user-id/validate | Validate user ID format |
| GET | /branding | Get branding config (public, no auth) |
| PUT | /branding | Update branding (SUPER_ADMIN) |
| GET/PUT | /roles, /roles/:role | Role config |
| GET/PUT | /users/:userId | User config |
| GET | /my-config | Current user's config |
| GET | /field-ids | Field ID config |
| PUT | /field-ids/:fieldId | Update field label |
| GET/PUT | /action-reauth | Reauth config (SUPER_ADMIN) |
| GET | /action-reauth/check | Check specific action |
| GET | /action-reauth/my-actions | Get user's reauth actions |
| GET/PUT | /audit-templates | Audit template config (SUPER_ADMIN) |
| GET | /audit-templates/current | Current audit templates |
| GET | /alarm-columns | All alarm column configs (SUPER_ADMIN) |
| PUT | /alarm-columns | Update alarm column visibility per role |
| GET | /alarm-columns/current | Current user's visible alarm columns |

### Audit (`/api/audit`) — 4 endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | / | Query audit trail (paginated, filterable) |
| GET | /:id | Get detail + checksum verification |
| DELETE | /:id | Delete single record (SUPER_ADMIN) |
| DELETE | / | Bulk delete records (SUPER_ADMIN) |

### Notifications (`/api/notifications`) — 4 endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | / | List for current user (role-based filtering) |
| GET | /unread-count | Quick count for badge |
| POST | / | Create notification |
| PATCH | /:id/read | Mark as read |

### Uploads (`/api/uploads`) — 2 endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | / | Upload file (5MB max, auth required) |
| GET | /:filename | Serve file (public) |

### Backup (`/api/backup`) — 3 endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | /create | Create backup (SUPER_ADMIN) |
| GET | / | List backups (SUPER_ADMIN) |
| POST | /restore | Restore from backup (SUPER_ADMIN) |

### Data Ingestion (`/api/data`) — 8 endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | / | Ingest telemetry data (HTTP transport) |
| POST | /batch | Batch telemetry ingestion |
| GET | /streams | List data streams for entity |
| POST | /streams | Create/update data stream config |
| GET | /credentials | Get device credentials |
| POST | /credentials | Create device credentials |
| PUT | /credentials/:id | Update device credentials |
| DELETE | /credentials/:id | Delete device credentials |

### MQTT Auth (`/api/internal/mqtt`) — 3 endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | /auth | MQTT client authentication |
| POST | /acl | MQTT topic ACL check |
| POST | /superuser | MQTT superuser check |

### Rule Chains (`/api/rule-chains`) — 14 endpoints
| Method | Path | Permission | Reauth | Purpose |
|--------|------|-----------|--------|---------|
| GET | / | RULE_CHAIN_MANAGE | — | List rule chains (with configSchema) |
| GET | /:id | RULE_CHAIN_MANAGE | — | Get rule chain details |
| POST | / | RULE_CHAIN_MANAGE | CREATE_RULE_CHAIN | Create rule chain (audit logged) |
| PUT | /:id | RULE_CHAIN_MANAGE | UPDATE_RULE_CHAIN | Update rule chain (audit logged) |
| DELETE | /:id | RULE_CHAIN_MANAGE | — | Delete rule chain |
| GET | /:id/versions | RULE_CHAIN_MANAGE | — | List versions |
| POST | /:id/nodes | RULE_CHAIN_MANAGE | — | Add node |
| PUT | /:id/nodes/:nodeId | RULE_CHAIN_MANAGE | — | Update node |
| DELETE | /:id/nodes/:nodeId | RULE_CHAIN_MANAGE | — | Delete node |
| POST | /:id/connections | RULE_CHAIN_MANAGE | — | Add connection |
| DELETE | /:id/connections/:connId | RULE_CHAIN_MANAGE | — | Delete connection |
| POST | /:id/debug | MANAGE_DEBUG_TRACE | — | Start debug session |
| GET | /:id/debug | READ_DEBUG_TRACE | — | Get debug trace |
| DELETE | /:id/debug | MANAGE_DEBUG_TRACE | — | Clear debug trace |

**Node Types:** GET `/api/rule-chains/node-types` now includes `configSchema` field for dynamic config UI generation.
**Engine Features:** Sandboxed VM execution (1s timeout), sub-chain delegation with depth tracking, dual create-alarm/clear-alarm paths per alarm rule.

### UNS (`/api/uns`) — 6 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | /tree | SUPER_ADMIN/ADMIN/SUPERVISOR | Get UNS hierarchy tree |
| GET | /entity/:entityId | ASSET_VIEW | Get entity UNS mapping |
| PUT | /entity/:entityId | SUPER_ADMIN (reauth OVERRIDE_UNS_PATH) | Override entity UNS path |
| POST | /entity/:entityId/move | SUPER_ADMIN/ADMIN | Generate move impact report |
| POST | /entity/:entityId/move/confirm | SUPER_ADMIN/ADMIN (reauth UPDATE_UNS_CONFIG) | Execute cascade move |
| GET | /search?path=<pattern> | ASSET_VIEW | Wildcard search |

### Telemetry Queries (`/api/queries/telemetry`) — 7 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | /latest | DATA_VIEW | Latest telemetry values |
| GET | /history | DATA_VIEW | Historical time-series data |
| GET | /keys | DATA_VIEW | Available telemetry keys |
| GET | /aggregated | DATA_VIEW | Aggregated telemetry (avg, min, max, sum) |
| GET | /compare | DATA_VIEW | Cross-entity comparison |
| GET | /delta | DATA_VIEW | Value deltas over time |
| GET | /stats | DATA_VIEW | Statistical summary |

### Alarms (`/api/queries/alarms`) — 5 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | / | ALARM_VIEW | List alarms (filterable, includes entityName enrichment) |
| GET | /stats | ALARM_VIEW | Alarm statistics (counts by status/severity) |
| GET | /:id | ALARM_VIEW | Get alarm details |
| POST | /:id/acknowledge | ALARM_MANAGE | Acknowledge alarm (reauth: ACKNOWLEDGE_ALARM, audit logged) |
| POST | /:id/clear | ALARM_MANAGE | Clear alarm (reauth: CLEAR_ALARM, stores clearDetails) |

**Alarm Statuses:** ACTIVE, ACKNOWLEDGED, CLEARED, MANUALLY_CLEARED

### Export (`/api/queries/export`) — 5 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | /telemetry | DATA_EXPORT | Export telemetry data |
| POST | /alarms | DATA_EXPORT | Export alarm data |
| POST | /audit | DATA_EXPORT | Export audit trail |
| GET | /jobs | DATA_EXPORT | List export jobs |
| GET | /jobs/:id/download | DATA_EXPORT | Download export file |

### Retention (`/api/queries`) — 4 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | /retention | RETENTION_MANAGE | Get retention policies |
| POST | /retention | RETENTION_MANAGE | Create retention policy |
| PUT | /retention/:id | RETENTION_MANAGE | Update retention policy |
| DELETE | /retention/:id | RETENTION_MANAGE | Delete retention policy |

### Connectivity (`/api/connectivity`) — 6 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | / | DATA_VIEW | List connectivity statuses |
| GET | /:entityId | DATA_VIEW | Get entity connectivity |
| GET | /:entityId/history | DATA_VIEW | Connectivity history |
| GET | /:entityId/snippet | DATA_VIEW | Code snippet for integration |
| POST | /check | DATA_MANAGE | Trigger connectivity check |
| GET | /stats | DATA_VIEW | Connectivity statistics |

### QR Codes (`/api/qr`) — 4 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | /generate | QR_CODE_GENERATE | Generate QR code for entity |
| GET | /:entityId | DATA_VIEW | Get entity QR code |
| DELETE | /:entityId | QR_CODE_GENERATE | Delete QR code |
| GET | /scan/:data | DATA_VIEW | Lookup entity by QR data |

### Debug Traces (`/api/debug/traces`) — 4 endpoints
| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | / | READ_DEBUG_TRACE | List traces (paginated, filterable by status/transport/entity/time) |
| GET | /stats | READ_DEBUG_TRACE | Trace stats (success rate, avg duration, top errors) |
| GET | /:id | READ_DEBUG_TRACE | Get trace detail |
| PUT | /entity/:entityId/toggle | MANAGE_DEBUG_TRACE | Toggle per-entity tracing (audit logged) |

### Help Articles (`/api/help`) — 6 endpoints
| Method | Path | Permission | Reauth | Purpose |
|--------|------|-----------|--------|---------|
| GET | / | Any | — | List help articles |
| GET | /:key | Any | — | Get article by key |
| POST | / | HELP_MANAGE | CREATE_HELP_ARTICLE | Create help article (audit logged) |
| PUT | /:key | HELP_MANAGE | UPDATE_HELP_ARTICLE | Update help article (audit logged) |
| DELETE | /:key | HELP_MANAGE | DELETE_HELP_ARTICLE | Delete help article (audit logged) |
| GET | /:key/versions | HELP_MANAGE | — | Get article version history |

---

## 10. Frontend Routes & Pages

| Path | Component | Access | Purpose |
|------|-----------|--------|---------|
| `/login` | LoginPage | Public | Authentication |
| `/forgot-password` | ForgotPasswordPage | Public | Password reset request |
| `/change-password` | ChangePasswordPage | Public | Force/voluntary password change |
| `/` | DashboardPage | Protected | Home dashboard with stats |
| `/profile` | ProfilePage | Protected | User profile |
| `/users` | UserListPage | SUPER_ADMIN, ADMIN | User list |
| `/users/create` | CreateUserPage | SUPER_ADMIN, ADMIN | Create user |
| `/users/:id` | EditUserPage | SUPER_ADMIN, ADMIN | Edit user |
| `/users/reset-requests` | ResetRequestsPage | SUPER_ADMIN, ADMIN | Password reset requests |
| `/assets` | AssetExplorerPage | Protected | Entity Explorer (tree + list) |
| `/assets/templates` | AssetTemplatesPage | SUPER_ADMIN, ADMIN | Entity Template Manager |
| `/audit` | AuditTrailPage | Protected | Audit trail viewing |
| `/notifications` | NotificationsPage | Protected | Notification center |
| `/config` | ConfigIndexPage | SUPER_ADMIN, ADMIN | Config landing |
| `/config/password-policy` | PasswordPolicyPage | SUPER_ADMIN, ADMIN | Password rules |
| `/config/login-security` | LoginSecurityPage | SUPER_ADMIN, ADMIN | Login security |
| `/config/session` | SessionConfigPage | SUPER_ADMIN, ADMIN | Session config |
| `/config/datetime` | DatetimeConfigPage | SUPER_ADMIN, ADMIN | DateTime format |
| `/config/branding` | BrandingConfigPage | SUPER_ADMIN, ADMIN | App branding |
| `/config/role-privileges` | RolePrivilegesPage | SUPER_ADMIN, ADMIN | Role permissions |
| `/config/roles` | RolesManagementPage | SUPER_ADMIN, ADMIN | Role CRUD |
| `/config/sidebar` | SidebarConfigPage | SUPER_ADMIN, ADMIN | Sidebar visibility |
| `/config/field-ids` | FieldIdsPage | SUPER_ADMIN, ADMIN | Field label config |
| `/config/user-id` | UserIdConfigPage | SUPER_ADMIN, ADMIN | User ID format |
| `/config/backup` | BackupRestorePage | SUPER_ADMIN, ADMIN | Backup/restore |
| `/config/action-reauth` | ActionReauthPage | SUPER_ADMIN | Reauth config |
| `/config/audit-templates` | AuditTemplatesConfigPage | SUPER_ADMIN | Audit templates |
| `/config/pagination` | PaginationConfigPage | SUPER_ADMIN | Pagination options |
| `/rule-chains` | RuleChainsPage | RULE_CHAIN_VIEW | Rule chain management |
| `/rule-chains/:id` | RuleChainEditorPage | RULE_CHAIN_MANAGE | Visual rule chain editor (React Flow) |
| `/alarms` | AlarmDashboardPage | ALARM_VIEW | Alarm monitoring (role-based column visibility) |
| `/config/uns` | UnsConfigPage | SUPER_ADMIN, ADMIN | UNS configuration |
| `/config/alarm-columns` | AlarmColumnsPage | SUPER_ADMIN | Alarm column visibility per role |
| `/debug` | DebugTracesPage | READ_DEBUG_TRACE | Pipeline debug traces |
| `/checklist/:entityId` | ChecklistPage | Protected | Checklist submission for entity |

---

## 11. Key Architectural Patterns

### Reauth Flow
```
Frontend: useReauth() → checks /api/config/action-reauth/my-actions (cached 30s)
  → If action requires reauth: shows ReauthDialog → user enters password
  → Password sent via _currentPassword body + x-reauth-password header
Backend: enforceReauth() → reads SystemConfig.action-reauth (cached 10s)
  → Validates password via bcrypt → strips password before schema validation
CRITICAL: Always await reauth.execute() to prevent race conditions
```

### SWR Data Fetching
```typescript
// Paginated: API returns { data: T[], total, page, limit, totalPages }
const { data: res } = useSWR<{ data: T[] }>('/api/items');
const items = res?.data ?? [];

// Tree: returns plain array
const { data: tree } = useSWR<TreeNode[]>('/api/assets/instances/tree');

// Conditional: only fetch if condition met
const { data } = useSWR(token ? '/api/auth/me' : null);
```

### Permission vs Role Check
```
Entity routes → requirePermission('ASSET_VIEW') → checks role.permissions JSON array
Non-entity routes → requireRole('SUPER_ADMIN', 'ADMIN') → checks role name string
```

### Audit Integrity
```
Write: SHA-256 of sorted JSON {timestamp, userId, action, targetType, targetId, afterValue}
Read: Recompute checksum → return integrityValid: boolean
SUPER_ADMIN actions are NOT audited (21 CFR Part 11 exemption)
```

### Sandboxed Script Execution (Rule Chain)
```
User scripts (script-filter, transform-msg, unit-converter) run in Node.js VM contexts:
- 1-second timeout
- No access to process, require, global
- Sandboxed context: { msg, metadata, msgType }
```

### Sub-Chain Delegation
```
Rule chains can call other chains via delegate-chain node:
- _delegateChain marker triggers sub-chain execution
- Depth counter prevents infinite loops
- Results (alarms, notifications, errors) merged into parent chain
```

### Atomic Ingestion Operations
```
- Telemetry upsert: INSERT ... ON CONFLICT ... DO UPDATE WHERE (single SQL, no race conditions)
- Alarm deduplication: Only create if no ACTIVE alarm of same type exists
- Entity CRUD: All operations wrapped in Prisma transactions
```

### Absolute Session Timeout
```
- 24-hour hard limit regardless of activity
- Session sliding window extends expiresAt on each request
- terminateOtherSessions() on password change
```

### Soft Delete Pattern
- Templates: `isActive: false` (soft delete)
- Instances: cascade `isActive: false` to all descendants (atomic transaction)
- Identifiers: hard delete
- Relationships: hard delete (both sides)

### Pagination Response Format
```json
{ "data": [...], "total": N, "page": 1, "limit": 50, "totalPages": M }
```

---

## 12. Entity Management System

### Hierarchy

```
AssetTemplate (blueprint) → defines attribute schema, telemetry, identifiers, relationships, alarms
  └── AssetInstance (created from template) → stores actual values, parent-child tree via parentId
        ├── AssetRelationship → bidirectional with auto-inverse
        └── AssetIdentifier → globally unique identifier values
```

### Template Features

- **Attribute Schema** — typed fields: TEXT, INTEGER, FLOAT, DATE, DATETIME, BOOLEAN, DROPDOWN, URL, FILE
- **Telemetry Schema** — INTEGER, FLOAT, BOOLEAN, STRING, ENUM
- **Expected Identifiers** — QR, BARCODE, RFID, NFC, MANUAL
- **Expected Relationships** — relationship type suggestions
- **Status Lifecycle** — configurable statuses with transitions and colors
- **Alarm Rules** — HIGH, LOW, HIGH_HIGH, LOW_LOW, RATE_OF_CHANGE, BOOLEAN_STATE, CUSTOM (severities: WARNING/ALARM/CRITICAL)
- **Connection Limits** — `maxParentConnections` (CONTAINS parents), `maxConnections` (total)
- **Versioning** — auto-creates AssetTemplateVersion snapshot on each update

### Relationship System

| Type | Inverse | Auto-Created |
|------|---------|-------------|
| CONTAINS | CONTAINED_IN | Yes |
| FEEDS | FED_BY | Yes |
| DEPENDS_ON | DEPENDED_ON_BY | Yes |
| BACKS_UP | BACKED_UP_BY | Yes |
| MONITORS | MONITORED_BY | Yes |
| CONNECTED_TO | CONNECTED_TO | Yes (symmetric) |
| CUSTOM | CUSTOM | No |

- Cycle detection via iterative ancestor walk for CONTAINS
- Connection limits enforced on both source and target
- Success/error responses include `connectionInfo: { used, allowed, remaining }`

### Tree Diagram (Entity Explorer)

- Interactive tree in Relationships tab
- **Create New Child** — green "+" button, opens Add Entity wizard with parent pre-set
- **Attach Existing** — blue link button, search/select entity, create CONTAINS relationship
- **Remove from Tree** — red "x" button, deletes CONTAINS relationship (not entity)
- **Unlink from Parent** — sidebar tree, removes parentId reference

---

## 13. Configuration System

### SystemConfig Keys

| Key | Purpose | Schema |
|-----|---------|--------|
| `password-policy` | Password requirements | minLength, maxLength, requireUppercase/Lowercase/Numbers/Special, reuseCount, expiryDays |
| `login-security` | Login protection | maxFailedAttempts, lockoutType, lockoutDuration |
| `session` | Session management | sessionDurationHours, idleTimeoutMinutes, warningMinutes |
| `datetime` | Date/time display | dateFormat, timeFormat, timezone |
| `pagination` | Table pagination | options tuple [10, 25, 50] |
| `user-id` | User ID generation | format, length, prefix, autoGenerate, startNumber |
| `branding` | App appearance | appName, colors, logos |
| `action-reauth` | Reauth requirements | `Record<action, role[]>` |
| `audit-templates` | Audit messages | `Record<action, template_string>` |

---

## 14. Production Deployment

| Component | Detail |
|-----------|--------|
| **App URL** | http://3.108.185.106 (port 80 via nginx) |
| **API** | PM2 process `digilog-api` on port 3000 (cluster mode) |
| **Swagger** | http://3.108.185.106/docs |
| **Database** | `digilog_db` on PostgreSQL 16 (port 5432) |
| **TimescaleDB** | `digilog_tsdb` on PostgreSQL 16 (port 5432) — 7 hypertables |
| **Redis** | localhost:6379 (BullMQ queue backend) |
| **EMQX** | MQTT broker on ports 1883/8883(TLS)/8083(WS)/8084(WSS) |
| **nginx config** | `/etc/nginx/sites-available/digilog` (`server_tokens off` + security headers) |
| **nginx root** | `/home/ubuntu/21cfrlogbook/apps/web/dist` |
| **PM2 config** | `/home/ubuntu/ecosystem.config.cjs` |

### Build & Deploy

```bash
npm run build                 # Builds shared -> api -> web via Turborepo
pm2 restart digilog-api       # Restart API
# Web is served directly from apps/web/dist — no copy needed
```

**Important:** Clean old modules before rebuilding:
```bash
rm -rf apps/api/dist && cd apps/api && npm run build
```

### CI/CD

- **GitHub Actions** — `.github/workflows/ci.yml`
  - Triggers: push (main, DataIngestion), pull requests (main)
  - Services: PostgreSQL 15 + Redis 7
  - Pipeline: checkout → Node 20 setup → npm ci → prisma generate → migrate → build shared → test

---

## 15. Git & Development Workflow

**Current Branch:** `DataIngestion`
**Main Branch:** `main`

### Recent Commit History
```
76625e1 fix: checklist MCQ/MULTI_SELECT click handlers + schema normalization (FIX-024)
aa9ca2b refactor: extract 6 dialog components from assets/index.tsx (2081→386 lines)
a38493a feat: TimescaleDB hypertables + entity-detail-panel refactoring
6563a10 ci: add GitHub Actions CI workflow with postgres + redis
7e4ff84 test: fix 26 failing tests, add turbo test task + testing skills
4012261 fix: RBAC button guards + sidebar visibility for Entity Explorer
76e4d02 feat: data ingestion pipeline, connectivity, checklist photos, config improvements
c415e50 security: fix 8 production bugs (trustProxy, user enum, session, orphans, RBAC, nginx)
```

### Quick Start (Development)
```bash
docker compose up -d          # Start PostgreSQL
npm install                   # Install all deps
npm run db:migrate            # Run Prisma migrations
npm run db:seed               # Seed default data
npm run dev                   # Start API + Web
```

### Key Commands
| Command | Purpose |
|---------|---------|
| `npm run dev` | Start all apps in dev mode |
| `npm run build` | Build all packages (Turborepo) |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed default data |
| `npm run db:studio` | Open Prisma Studio |
| `pm2 restart digilog-api` | Restart production API |
| `sudo systemctl restart nginx` | Restart nginx |

---

## File Path Quick Reference

### Backend
| File | Purpose |
|------|---------|
| `apps/api/src/app.ts` | Entry point + middleware |
| `apps/api/src/plugins/auth.ts` | JWT validation + session |
| `apps/api/src/plugins/rbac.ts` | requirePermission + requireRole |
| `apps/api/src/plugins/audit-logger.ts` | Audit trail + checksums |
| `apps/api/src/lib/jwt.ts` | Token sign/verify |
| `apps/api/src/lib/password.ts` | bcrypt hash/verify |
| `apps/api/src/lib/reauth-check.ts` | Re-auth enforcement |
| `apps/api/src/lib/hash-chain.ts` | SHA-256 audit checksums |
| `apps/api/src/lib/user-id-validator.ts` | User ID format validation |
| `apps/api/src/modules/auth/routes.ts` | Auth endpoints |
| `apps/api/src/modules/users/routes.ts` | User endpoints |
| `apps/api/src/modules/roles/routes.ts` | Role endpoints |
| `apps/api/src/modules/config/routes.ts` | Config endpoints |
| `apps/api/src/modules/assets/routes.ts` | Entity endpoints (21) |
| `apps/api/src/modules/audit/routes.ts` | Audit endpoints |
| `apps/api/src/modules/notifications/routes.ts` | Notification endpoints |
| `apps/api/src/modules/uploads/routes.ts` | Upload endpoints |
| `apps/api/src/modules/backup/routes.ts` | Backup endpoints |
| `apps/api/src/modules/data-ingestion/` | Data ingestion pipeline, DLQ, normalizer |
| `apps/api/src/modules/rule-chain/routes.ts` | Rule chain endpoints (14) |
| `apps/api/src/modules/uns/routes.ts` | UNS endpoints (6) |
| `apps/api/src/modules/queries/index.ts` | Query module aggregator |
| `apps/api/src/modules/connectivity/routes.ts` | Connectivity endpoints (6) |
| `apps/api/src/modules/qr-code/routes.ts` | QR code endpoints (4) |
| `apps/api/src/modules/help/routes.ts` | Help article endpoints (6) |
| `apps/api/src/transport/mqtt-client.ts` | MQTT client |
| `apps/api/src/transport/ws-handler.ts` | WebSocket handler |
| `apps/api/src/workers/ingestion.worker.ts` | BullMQ ingestion worker |
| `apps/api/prisma/schema.prisma` | Database schema |
| `apps/api/prisma/seed.ts` | Seed data |

### Frontend
| File | Purpose |
|------|---------|
| `apps/web/src/main.tsx` | Entry point + router |
| `apps/web/src/components/layout/app-layout.tsx` | Main layout wrapper |
| `apps/web/src/components/layout/sidebar.tsx` | Navigation sidebar |
| `apps/web/src/components/layout/header.tsx` | Top header bar |
| `apps/web/src/components/reauth-dialog.tsx` | Re-auth modal |
| `apps/web/src/components/toast-provider.tsx` | Toast context |
| `apps/web/src/hooks/use-auth.ts` | Auth state management |
| `apps/web/src/hooks/use-reauth.ts` | Re-auth flow |
| `apps/web/src/hooks/use-session.ts` | Session timeout |
| `apps/web/src/hooks/use-single-tab.ts` | Single-tab enforcement |
| `apps/web/src/hooks/use-toast.ts` | Toast notifications |
| `apps/web/src/lib/api-client.ts` | HTTP client |
| `apps/web/src/lib/swr-config.ts` | SWR configuration |
| `apps/web/src/routes/assets/index.tsx` | Entity Explorer (386 lines — dialogs extracted) |
| `apps/web/src/routes/assets/components/dialogs/` | 6 extracted dialog components (wizard, edit, delete, link, identifier, attach) |
| `apps/web/src/routes/assets/components/tabs/` | 6 extracted tab components (attributes, telemetry, connectivity, alarms, checklist-history, qr-code) |
| `apps/web/src/routes/assets/hooks/` | use-asset-mutations.ts (10 CRUD handlers), use-asset-tree-logic.ts (tree filtering) |
| `apps/web/src/routes/assets/components/entity-detail-panel.tsx` | Entity detail panel (763 lines — tabs extracted) |
| `apps/web/src/routes/assets/templates.tsx` | Entity Template Manager |
| `apps/web/src/routes/config/role-privileges.tsx` | Role Privileges |
| `apps/web/src/routes/config/roles.tsx` | Role Management |
| `apps/web/src/routes/audit/index.tsx` | Audit Trail |
| `apps/web/src/routes/rule-chains/index.tsx` | Rule Chain management |
| `apps/web/src/routes/alarms/index.tsx` | Alarm Dashboard |
| `apps/web/src/routes/config/uns.tsx` | UNS Configuration |

### Shared
| File | Purpose |
|------|---------|
| `packages/shared/src/index.ts` | Main entry (re-exports all) |
| `packages/shared/src/schemas/assets.ts` | Entity schemas + constants |
| `packages/shared/src/schemas/auth.ts` | Auth schemas |
| `packages/shared/src/schemas/users.ts` | User schemas |
| `packages/shared/src/schemas/config.ts` | Config schemas |
| `packages/shared/src/types/permissions.ts` | Permission constants |
| `packages/shared/src/types/roles.ts` | Role definitions |
| `packages/shared/src/types/reauth-actions.ts` | Reauth action constants |
| `packages/shared/src/types/audit-actions.ts` | Audit action constants |
| `packages/db/src/prisma.ts` | PrismaClient singleton |
| `packages/db/src/tsdb.ts` | TimescaleDB pg Pool |
| `packages/queue/src/queues.ts` | BullMQ queue definitions |
| `packages/queue/src/connection.ts` | Redis connection factory |
| `init-tsdb.sql` | TimescaleDB hypertable initialization |

### Documentation & Governance
| File | Purpose |
|------|---------|
| `CHANGELOG.md` | Semantic versioned change history |
| `API_GUIDE.md` | Complete API endpoint reference |
| `task_status.md` | Development task tracking with governance checklist |
| `BUSINESS_CONTEXT.md` | Business context and regulatory compliance |
| `CODEBASE_CONTEXT.md` | This file — technical architecture reference |
| `PLAN.md` | Master development plan and roadmap |
| `documentation/Project_Summary.md` | Comprehensive project summary with metrics |
| `documentation/Bug_Resolution_Log.md` | Structured bug lifecycle tracking |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Standardized bug report template |

---

## 16. Test Suite

**Phase K (Testing & Documentation) — COMPLETE + Post-Phase Additions**
1344 total tests, 0 failures across 83+ test files in 3 packages (`packages/shared`, `packages/db`, `apps/api`).

### New Test Files (13 added in Phase K)

| # | File | Type | Package |
|---|------|------|---------|
| 1 | `apps/api/src/e2e/auth.test.ts` | E2E | apps/api |
| 2 | `apps/api/src/e2e/users.test.ts` | E2E | apps/api |
| 3 | `apps/api/src/e2e/roles.test.ts` | E2E | apps/api |
| 4 | `apps/api/src/e2e/config.test.ts` | E2E | apps/api |
| 5 | `apps/api/src/e2e/audit.test.ts` | E2E | apps/api |
| 6 | `apps/api/src/e2e/notifications.test.ts` | E2E | apps/api |
| 7 | `apps/api/src/e2e/health.test.ts` | E2E | apps/api |
| 8 | `apps/api/src/modules/data-ingestion/__tests__/ingestion.service.test.ts` | Unit | apps/api |
| 9 | `apps/api/src/modules/data-ingestion/__tests__/ingestion-config.service.test.ts` | Unit | apps/api |
| 10 | `apps/api/src/modules/data-ingestion/__tests__/connectivity-tracker.test.ts` | Unit | apps/api |
| 11 | `apps/api/src/modules/data-ingestion/__tests__/dlq-manager.test.ts` | Unit | apps/api |
| 12 | `apps/api/src/modules/data-ingestion/__tests__/pipeline-tracer.test.ts` | Unit | apps/api |
| 13 | `packages/db/src/__tests__/telemetry-batcher.test.ts` | Unit | packages/db |

### Post-Phase K Test Files (3 added in v3.0)

| # | File | Type | Package |
|---|------|------|---------|
| 1 | `apps/api/src/e2e/checklist-submission.test.ts` | E2E | apps/api |
| 2 | `packages/shared/src/__tests__/checklist-answers.test.ts` | Unit | packages/shared |
| 3 | `packages/shared/src/__tests__/checklist-normalizer.test.ts` | Unit | packages/shared |

### Pre-existing Test Files (5)

| File | Type | Package |
|------|------|---------|
| `packages/shared/src/schemas/assets.test.ts` | Unit | packages/shared |
| `packages/shared/src/schemas/auth.test.ts` | Unit | packages/shared |
| `packages/shared/src/schemas/config.test.ts` | Unit | packages/shared |
| `packages/shared/src/schemas/users.test.ts` | Unit | packages/shared |
| `packages/shared/src/types/audit-templates.test.ts` | Unit | packages/shared |

### Vitest Testing Patterns

- **`vi.hoisted()`**: Used to hoist mock variables above imports so they are available when `vi.mock()` factory functions execute. Required because ES module mocking occurs before module evaluation.
- **Class-based mocks for ioredis/bullmq**: Redis (`ioredis`) and BullMQ (`Queue`, `Worker`) are mocked using class constructors that return mock instances with spied methods. This avoids connecting to real Redis during tests.
- **Mock path conventions**: Module mocks use relative paths matching the import paths in source code. `__tests__/` directories are co-located with the modules they test (e.g., `modules/data-ingestion/__tests__/`).
- **Test runner**: Vitest with `globals: true`, `environment: 'node'`.
- **E2E pattern**: `buildApp()` + `app.inject()` (no HTTP server needed).
- **Assertion style**: Vitest `expect()` with Jest-compatible matchers.

---

## 17. Documentation Governance

**Version:** 3.0.0 | **Activated:** 2026-02-25 | **Last Updated:** 2026-03-07

### Mandatory Update Rule

Every code change, bug fix, feature addition, or structural modification triggers mandatory updates to all 7 governance files:

1. `CHANGELOG.md` — Semantic versioned entry
2. `API_GUIDE.md` — API impact or explicit "No API changes" notation
3. `task_status.md` — Task entry with documentation compliance checklist
4. `BUSINESS_CONTEXT.md` — Business/operational impact
5. `CODEBASE_CONTEXT.md` — Architecture/technical impact
6. `PLAN.md` — Roadmap/status updates
7. `documentation/Project_Summary.md` — Current state reflection

### Bug Lifecycle

1. Create Git issue (`.github/ISSUE_TEMPLATE/bug_report.md`)
2. Implement fix with validation
3. Add entry to `documentation/Bug_Resolution_Log.md`
4. Close issue with commit reference
5. Update all 7 governance files

### Git Issue Tracking

All bugs tracked via GitHub Issues with structured templates:
- **Repository:** `pankajexa/21cfrlogbook`
- **Issue template:** `.github/ISSUE_TEMPLATE/bug_report.md`
- **Total issues created:** 12 (#2–#13)
- **Closed:** 11 | **Open:** 1 (#13)
- **Labels:** `bug`, `severity:<level>`, `module:<name>`
- **Traceability chain:** Bug_Resolution_Log.md → GitHub Issue → Commit

### Testing Documentation

Centralized at `documentation/testing/`:
- `manual/` — Test plans, cases, summaries
- `reports/` — Execution reports
- `automation/` — Test scripts
- `validation/` — Compliance verification
- `regression/` — Regression results

## Phase 2 Modules

### Backend (`apps/api/src/modules/`)
- `cleaning-profiles/` — FilterCleaningProfile CRUD with visual pipeline (stages + connections), versioning
- `filter-profiles/` — FilterProfile CRUD, links cleaning profiles to filter instances
- `filter-operations/` — Core cycle lifecycle: start, advance, bypass, submit-checklist, events, cycles
- `pm-schedules/` — PM schedule CRUD with monthly entries and execution tracking
- `checklist-profiles/` — ChecklistProfile and ChecklistQuestion CRUD

### Frontend (`apps/web/src/routes/`)
- `filter-management/filter-operations.tsx` — 8-stage cleaning operations with scan/submit
- `filter-management/cleaning-profile-editor.tsx` — Visual pipeline editor (canvas, nodes, wires)
- `filter-management/cleaning-profile-list.tsx` — Profile listing with archive/activate
- `filter-management/filter-profile-list.tsx` — Filter profile management
- `filter-management/ahu-dashboard.tsx` — AHU filter set visualization
- `filter-management/filter-traceability.tsx` — Per-filter event/cycle history
- `cleaning-cycles/history.tsx` — Expandable cycle history with stage timeline
- `cleaning-cycles/timeline.tsx` — Detailed cycle event timeline
- `checklists/list.tsx` — Checklist profile list
- `checklists/detail.tsx` — Checklist detail with question management
- `pm-schedules/index.tsx` — PM schedule list
- `config/filter-lifecycle.tsx` — Lifecycle state configuration
- `config/filter-cleaning-reasons.tsx` — Cleaning reasons configuration


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
