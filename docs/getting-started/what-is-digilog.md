# What is DigiLog?

DigiLog is a **21 CFR Part 11 compliant** IoT data logging platform designed for regulated industries (pharmaceuticals, food & beverage, manufacturing). It replaces paper-based logbooks with a digital system that provides:

## Core Capabilities

### Data Collection
- ~~**Real-time telemetry** from IoT devices via MQTT and HTTP~~ *(removed 2026-06-17 — Phase 7 tore out the data-ingestion pipeline, MQTT broker, and TimescaleDB)*
- **Manual data entry** through mobile-friendly checklists with electronic signatures
- **Binary data** support (images, audio, vibration waveforms)
- **Bulk upload** for importing historical and batch data

### Data Processing
- ~~**77-node visual rule chain engine** for conditional processing, enrichment, and transformation across 8 categories (input, filter, enrichment, transformation, action, analytics, flow, external)~~ *(removed 2026-05-17 — rule-chain subsystem torn out)*
- ~~**Automatic alarm generation** with threshold, rate-of-change, and absence detection~~ *(removed 2026-05-17 — Alarm subsystem torn out)*
- **Multi-channel notifications** (in-app, email, SMS, Telegram, Slack) based on configurable rules

### Compliance
- **Tamper-evident audit trail** with SHA-256 hash-chain integrity
- **Electronic signatures** with re-authentication (21 CFR Part 11 compliant)
- **3-step checklist approval workflow** (Performed -> Checked -> Verified)
- **Role-based access control** with 6 hierarchical roles and 102 permission constants (verified 2026-07-06)

### Organization
- **Entity hierarchy** following ISA-95 standard (Enterprise -> Site -> Area -> Line -> Equipment -> Sensor)
- ~~**Unified Namespace (UNS)** with MQTT wildcard support~~ *(removed 2026-06-17 — Phase 7 tear-out)*
- **12 relationship types** between entities with cycle detection
- **QR/RFID/NFC identifiers** for physical equipment tagging

## Architecture

DigiLog uses a modern tech stack (verified 2026-04-29):
- **Backend:** Fastify 5 (Node.js / TypeScript) with **33 API modules**
- **Frontend:** React 19 + Vite 6 SPA with Tailwind CSS 4
- **Database:** PostgreSQL 18 + Prisma 6 (vanilla PG — TimescaleDB removed 2026-06-17), **61 Prisma models, 23 enums**
- ~~**MQTT:** Mosquitto 2.0 (Phase 1 of windows-friendly-rewrite swapped from EMQX)~~ *(removed 2026-06-17 — Phase 7 tear-out; no MQTT broker)*
- **Queue:** graphile-worker on PostgreSQL (Phase 2 swapped from BullMQ + Redis/Memurai). **No Redis dependency** — Phase 4 (2026-05-01) retired it; pub/sub moved to an in-process EventEmitter bus.
- **PDF export:** client-side via `apps/web` `lib/pdf-report.ts` (jsPDF). *(The server-side `puppeteer-core` + Edge + `@napi-rs/canvas` reports engine was removed 2026-07-04.)*
- **Config:** **35 config definitions** with auto-discovery at startup, **34** corresponding pages

## Digital Filter Management System (Phase 2)

DigiLog includes a comprehensive Digital Filter Management System for pharmaceutical cleanroom HEPA filter cleaning lifecycle management.

### Modules
- **Cleaning Profiles** — Visual pipeline editor for multi-stage cleaning workflows
- **Filter Profiles** — Filter-to-cleaning-profile assignment
- **Filter Operations** — Cycle start, stage advance, bypass (deviation logging), checklist submission
- **PM Schedules** — Preventive maintenance scheduling per AHU with tolerance windows
- **Checklist Profiles** — Reusable question templates (10 types) for pipeline checklist nodes
- **Equipment Groups** — AHU dashboard with dual-set filter management

### Key Features
- Configurable multi-stage cleaning pipeline via visual editor
- CHECKLIST nodes between STAGE nodes trigger automatic question dialogs
- Server-side enforcement: advance() blocks if pending checklist not completed
- Cycle auto-completes when last STAGE leads to END node
- Real-time filter status tracking with QR/barcode scan
- Cleaning cycle history with full audit trail
- PM scheduling per AHU with tolerance windows
- Configurable cleaning reasons with justification support
- Filter retirement and replacement tracking
- Bulk upload for filter data import

### Compliance
All filter operations are recorded as immutable events with SHA-256 checksums, electronic signatures, and deviation tracking per 21 CFR Part 11.

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
