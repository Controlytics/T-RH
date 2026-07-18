# DigiLog — Master Development Plan

**Last updated:** 2026-04-04
**Status:** ALL PHASES COMPLETE (A through K) + Phase 2: Digital FMS + Phase 3 enhancements. 34 API modules, 57 Prisma models, 17 enums, 52+ permissions, 77 rule chain node types.

---

## Timeline

| Date | Milestone | Status |
|------|-----------|--------|
| 2026-02-17 | **v1.0.0** — Initial release (User Mgmt, Entity Mgmt, Config, Audit) | Done |
| 2026-02-17 | Action reauth, audit templates, pagination config | Done |
| 2026-02-19 | Dynamic tree diagram, telemetry schema, attach existing, multi-select linking | Done |
| 2026-02-20 | Connection limits, toast system, Asset->Entity rename, bug fixes | Done |
| 2026-02-20 | API refactoring Phase 0-4 (infrastructure + entity + auth + config + users) | Done |
| 2026-02-21 | Checklist feature, audit descriptions, privileges, reauth, tests | Done |
| 2026-02-25 | **v2.1.1** — Documentation governance, testing centralization | Done |
| 2026-02-25 | **Phases A-J** — Data Ingestion Infrastructure through Integration | Done |
| 2026-02-26 | **Phase K** — Testing & Documentation (~1344 tests) | Done |
| 2026-03-01 | **v3.0** — Security, CI/CD, refactoring, TimescaleDB, documentation | Done |
| 2026-03-07 | Bug fixes — LatestTelemetry UUID, device credentials, auto-refresh | Done |
| 2026-03-09 | **v3.1 System Validation** — 87/100 health score, 48 node types, 30+ APIs tested | Done |
| 2026-03-12 | **v1.0.0 Config** — 23 config definitions, field IDs, SWR, role management | Done |
| 2026-03-16 | Input sanitization, data retention config, help articles | Done |
| 2026-03-26 | **Phase 2: Digital FMS** — 6 backend modules, 11+ tables, 14+ pages | Done |
| 2026-03-27 | Quality audit: 43 issues found, 35 fixed, 30 GitHub issues closed | Done |
| 2026-04-02 | Phase 3 enhancements: bulk upload, retirement, mobile PWA, Android APK | Done |

---

## Current Architecture

### Backend (34 API Modules)
admin-requests, assets (templates, instances, identifiers, relationships), audit, auth, backup, checklist-profiles, cleaning-profiles, config, connectivity, dashboards, data-ingestion, deployment-check, entity-assignments, equipment-groups, filter-operations, filter-profiles, help, ldap, notification-delivery, notification-rules, notifications, org-admin, pm-schedules, qr-code, queries (telemetry/alarm/retention/export), roles, rule-chain, super-admin, system-health, tenant-admin, uns, uploads, user-groups, users

### Database (57 Prisma Models, 17 Enums)
Organization, TemplateAssignment, EntityAssignment, Dashboard, DashboardWidget, DashboardAssignment, Role, User, PasswordHistory, Session, SystemConfig, FieldIdConfig, PasswordResetRequest, AdminRequest, AuditTrail, Notification, UserConfig, RoleConfig, AssetTemplate, AssetTemplateVersion, AssetInstance, AssetRelationship, AssetIdentifier, DeviceCredential, RuleChain, RuleChainVersion, RuleNode, RuleNodeConnection, Alarm, ChecklistReview, ElectronicSignature, LatestTelemetry, UnsMapping, ConnectivityStatus, QrCode, HelpArticle, HelpArticleVersion, DataStream, DeadLetterQueue, IngestionSystemConfig, NotificationLog, NotificationTemplate, UserGroup, UserGroupMember, NotificationRule, NotificationRuleRecipient, PmSchedule, PmScheduleEntry, PmExecution, FilterCleaningProfile, FilterPipelineStage, FilterPipelineConnection, FilterProfile, CleaningCycle, FilterEvent, EquipmentGroup, EquipmentGroupInstrument, ChecklistProfile, ChecklistQuestion

### Frontend
20+ route groups covering all modules with light theme (bg-white, text-slate-800)

---

## Completed Work

### Phase 1 — Core Application (v1.0.0)

Full-stack 21 CFR Part 11 compliant digital logbook with:
- 27+ API modules, 28 frontend pages
- 30 Prisma models, 9 custom hooks
- Shared package with Zod schemas, TypeScript types, and constants
- SHA-256 audit trail, electronic signatures, RBAC

### Phase 2 — Entity Management Enhancements
- Connection limits, toast system, dynamic tree diagram
- Checklist schema (14 question types), audit log descriptions
- Entity feature privileges and reauth actions

### Phases A-K — Data Ingestion & Integration
- **A:** Docker Compose, TimescaleDB, 15 new Prisma models, packages/db + packages/queue
- **B:** MQTT auth, MQTT client, WebSocket, HTTP ingestion, entity resolver
- **C:** BullMQ worker, 11 pipeline stages, telemetry batcher, DLQ, connectivity tracker
- **D:** Rule Chain Engine (77 node types, BFS execution, sandboxed VM)
- **E:** Unified Namespace (ISA-95 paths, wildcard search, cascade moves)
- **F:** Telemetry queries, alarm management, data export, retention
- **G-J:** Connectivity, QR codes, help articles, rule chain editor, alarm dashboard
- **K:** 1,344 tests across 83+ test files

### Phase 2: Digital Filter Management System — COMPLETE

| Date | Milestone | Status |
|------|-----------|--------|
| 2026-03-26 | Database: 11+ tables, 17 enums, 52+ permissions | Done |
| 2026-03-26 | Backend: 6 modules (cleaning-profiles, filter-profiles, filter-operations, pm-schedules, checklist-profiles, equipment-groups) | Done |
| 2026-03-26 | Frontend: 14+ pages (operations, profiles, cycles, checklists, PM, AHU, traceability, equipment, config) | Done |
| 2026-03-27 | Checklist gates in pipeline with auto-trigger and server-side enforcement | Done |
| 2026-03-27 | Cleaning reason selection, auto-close popups, proper navigation flow | Done |
| 2026-03-27 | Comprehensive quality audit: 43 issues found, 35 fixed | Done |
| 2026-03-27 | All fixes pushed to git, 30 GitHub issues created and closed | Done |

### Phase 3: Enhancements — COMPLETE

| Date | Milestone | Status |
|------|-----------|--------|
| 2026-04-02 | Bulk filter upload via CSV | Done |
| 2026-04-02 | Filter retirement and replacement | Done |
| 2026-04-02 | Mobile PWA and Android APK (Capacitor) | Done |
| 2026-04-02 | Unified light theme across all pages | Done |
| 2026-04-02 | 3 full quality audits completed | Done |

---

## Pending — API Refactoring (Phases 5-7)

### Phase 5: Backup Module (600 lines -> 4 files)
### Phase 6: Roles Module (541 lines -> 3 files)
### Phase 7: Notifications Module (469 lines -> 3 files)

---

## Future Features

| Feature | Description | Priority | Status |
|---------|-------------|----------|--------|
| HTTPS/TLS Certificates | SSL for production deployment | Medium | Pending |
| Multi-tenant | Single deployment serving multiple facilities | Medium | Pending |
| Reports & Dashboards | PDF/Excel audit reports, compliance dashboards | Medium | Pending |
| Frontend Component Tests | Vitest + React Testing Library for UI components | Low | Pending |
| Offline Sync | Full offline capability for mobile | Low | In Progress |

---

## Verification Checklist

Run after every change:

```bash
# 1. TypeScript compilation
cd apps/api && npm run build
cd apps/web && npm run build

# 2. Tests (1344 total, 0 failures)
npx turbo run test

# 3. Full Turborepo build (5 packages: shared, db, queue, api, web)
npm run build

# 4. Production deploy
pm2 restart digilog-api
```

---

## Architecture Principles

1. **Routes -> Services -> Repositories** — Thin route handlers, business logic in services, DB queries in repositories
2. **RequestContext** — Services receive `{ userId, userSub, userRole, ipAddress, userAgent, sessionId }` instead of Fastify request
3. **AppError hierarchy** — `NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError` caught by global error handler
4. **Reauth in routes** — `enforceReauth()` needs `req`/`reply`, called before service layer
5. **Swagger schemas in routes** — Define the HTTP contract at the route level
6. **Audit logging in services** — Services call standalone `auditLog()` with `RequestContext`
7. **Shared package as source of truth** — All Zod schemas, types, constants live in `@digilog/shared`
8. **Light theme only** — bg-white, text-slate-800, bg-slate-50 sections, no dark mode

---

## Documentation Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` (root) | Full codebase overview, endpoints, architecture |
| `README.md` | Project overview and quick start |
| `API_GUIDE.md` | Complete API endpoint reference |
| `ARCHITECTURE.md` | System architecture diagrams |
| `BUSINESS_CONTEXT.md` | Business context, regulatory compliance |
| `CHANGELOG.md` | Version history and change details |
| `CODEBASE_CONTEXT.md` | Codebase context and architecture overview |
| `DEPLOYMENT.md` | Production deployment guide |
| `LOCAL_SETUP_WINDOWS.md` | Windows local development setup |
| `PLAN.md` | This file — master development plan |
| `SESSION_RESUME.md` | Session resume context |
| `DEPENDENCIES.md` | Full dependency list with versions |
| `AGENTS.md` | Codex review instructions |
| `task_status.md` | Development status tracking |

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
