# DigiLog — Project Summary

## What is DigiLog?

DigiLog is a **21 CFR Part 11 compliant Digital Filter Management System** designed for pharmaceutical and manufacturing facilities. It tracks filter cleaning cycles, preventive maintenance, equipment status, and provides complete audit trails with electronic signatures.

## Business Purpose

Pharmaceutical factories use air handling units (AHUs) with filters that must be cleaned on a strict schedule. Every cleaning cycle, stage transition, and checklist completion must be recorded with tamper-proof audit trails to comply with FDA regulations (21 CFR Part 11). DigiLog digitizes this entire process — replacing paper logbooks with a validated electronic system.

## Technology Stack

| Layer | Technology | Details |
|---|---|---|
| **Frontend** | React 19 + TypeScript | Vite SPA, Tailwind CSS, SWR |
| **Backend** | Node.js + Fastify 5 | TypeScript, 33 API modules, 200+ endpoints (org-admin + tenant-admin removed in MT removal 2026-04-30; reports + report-templates removed 2026-07-04) |
| **Primary DB** | PostgreSQL 18 | 61 Prisma models, 23 enums (single DB `digilog_db`; TemplateKind lookup; MT removal dropped Organization; Step 6 added FilterDetails 1:1 sidecar; Step 5b A.1 added ChecklistProfileVersion immutable-history table; Phase A.2 added `FilterCleaningProfile.lineageId` for rowful version-history tracking — no new model; Phase A.3 added `FilterProfileVersion` sidecar; Phase A.4 added `EquipmentGroupVersion` sidecar — group + 3 instruments composite snapshot per version; **Step 4 (2026-05-02)** replaced `FilterProfile.applicableTemplates` JSONB array with `FilterProfileApplicableTemplate` join table — cascade FKs to AssetTemplate kill the dangling-reference foot-gun, and AssetTemplate delete is guarded with 409 IN_USE) |
| **Job Queue** | graphile-worker on PostgreSQL | LISTEN/NOTIFY + SKIP LOCKED + advisory locks; no separate Redis service |
| **Mobile** | Capacitor (Android APK) | Wraps web app for tablet use |
| **RFID** | Kotlin Android app | KC-series UHF reader integration |

## Monorepo Structure

```
21cfrlogbook-DigitalFMS/
├── apps/
│   ├── api/            — Fastify backend (33 modules, TypeScript)
│   ├── web/            — React SPA (77 routes, Vite + Tailwind)
│   └── android/        — Capacitor wrapper for Android APK (incl. RfidPlugin.java for SDK-mode RFID)
├── packages/
│   ├── shared/         — Zod schemas, permissions, types (102 permissions, 83 privileges, 92 reauth actions, 26 sidebar items)
│   └── queue/          — graphile-worker job queue (Postgres-backed; Phase 2 of windows-friendly-rewrite swapped from BullMQ + ioredis)
├── rfid_scan_app/      — Native Kotlin Android RFID scanner (predates RfidPlugin in DigiLog APK)
├── scripts/            — Windows PowerShell deployment scripts (package + install)
├── certs/              — mkcert TLS infrastructure (server.crt, server.key, rootCA.pem)
└── docs/               — Full documentation site
```

## Key Features

### Phase 1: Core Platform
- Single-tenant deployment (multi-tenancy removed 2026-04-30)
- Role-based access control (RBAC) with 102 permissions
- JWT authentication with session management
- Asset template and instance management (hierarchical)
- Notifications (email, SMS, Telegram, Slack)
- Audit trail with SHA-256 hash-chain integrity
- Help article system with versioning
- Backup/restore with integrity verification
- System health monitoring

### Phase 2: Digital Filter Management
- Visual cleaning profile pipeline editor (custom hand-rolled canvas)
- Filter cleaning cycle management (start, advance, bypass, complete)
- Server-side checklist enforcement between pipeline stages
- Preventive maintenance (PM) scheduling with monthly entries
- Equipment group management (AHU dashboard)
- Cleaning cycle history and timeline views
- Filter traceability with full event log
- Immutable events with SHA-256 checksums (21 CFR Part 11)

### Phase 3: RFID & Offline Operations
- Native Kotlin RFID scanner app for KC-series UHF readers
- Web-side RFID keyboard guard (blocks tag input in non-RFID fields)
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier-to-filter map for offline RFID lookup
- Responsive layout with collapsible sidebar
- Mobile-optimized operations page
- Capacitor Android APK for tablets

### Phase 4: Permissions, Themes & Reports
- 18 granular feature toggles (Filters, Checklists, Cleaning Profiles, Equipment, PM pages)
- 10 configurable color themes (Ocean, Sapphire, Emerald, etc.)
- Report settings configuration (page titles, labels, signatories) + report-review workflow
- Dynamic bulk upload (CSV columns from template attributeSchema)
- 92 re-authentication actions across 16 categories
- Block change request/approval workflow

## Database Statistics

| Metric | Count |
|---|---|
| Prisma models | 61 |
| Database enums | 23 |
| Permission constants | 102 |
| Feature privileges | 83 |
| Re-auth actions | 92 |
| Sidebar items | 26 |
| API modules | 33 |
| API endpoints | 200+ |
| Config definitions | 35 |
| Config pages | 34 |
| Frontend routes | 77 |
| Custom React hooks | 26 |
| Frontend lib modules | 30 |
| graphile-worker tasks | 3 (`notification`, `pm_overdue_check`, `session_sweep`) |

## Security & Compliance

### 21 CFR Part 11 Compliance
- **Electronic signatures**: Password re-authentication for sensitive operations
- **Audit trail**: Every mutation logged with SHA-256 hash-chain verification
- **Immutable records**: Filter events stored with checksums, cannot be modified
- **Access control**: Role-based permissions with 102 granular controls (verified by `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts`)
- **Session management**: Auto-logout on inactivity, single-tab enforcement
- **Password policies**: Configurable complexity, expiry, and history requirements

### Security Features
- JWT tokens with 8-hour expiry and 30-minute refresh
- Input sanitization (HTML stripping on all text fields)
- CORS configuration with explicit allowed origins
- Rate limiting (global, configurable)
- HTTPS everywhere (API, web, tablet connections)

## Deployment

### Production Deployment (Windows Server)
- Packaged `DigiLog-Setup-<ver>.exe` installer (bundles portable PostgreSQL) built via `scripts/build-installer.ps1`
- On run it provisions the DB + registers the `DigiLogDB` / `DigiLogAPI` Windows services (`install.ps1` → `provision-db.ps1` + `register-services.ps1`). *(Old `package-for-production.ps1` / `install-on-target.ps1` removed 2026-07-04; see `docs/PHARMA_DEPLOYMENT_21CFR.md`.)*
- API serves SPA + `/api/*` directly on `:3000` over HTTPS (mkcert)
- Reverse proxy (Nginx / IIS) is optional / customer-choice — not bundled after Phase 4 of the windows-friendly-rewrite
- The `DigiLog-Setup.exe` installer registers `DigiLogDB` + `DigiLogAPI` as auto-start Windows services (WinSW, via `scripts/register-services.ps1`); see `docs/PHARMA_DEPLOYMENT_21CFR.md`
- Firewall rules auto-configured (80, 443, 3000)

### Prerequisites
- Node.js 20+, PostgreSQL 18. **No Redis dependency** — Phase 2 moved the queue to graphile-worker on Postgres; Phase 4 retired Redis pub/sub.

### Default Login
- Username: `superadmin`
- Password: `Admin@123` (must change on first login)

## Team & Development

- **Repository**: github.com/pankajexa/21cfrlogbook.git
- **Active Branch**: RFID (development), main (stable)
- **Build System**: Turborepo monorepo with Vite (frontend) + tsc (backend)
- **Testing**: Vitest unit tests, manual E2E test cases (25 test suites)
- **Code Reviews**: 3 full audits completed, 114 issues resolved
