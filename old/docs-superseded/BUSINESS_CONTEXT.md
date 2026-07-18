# DigiLog — Business Context

**Last updated:** 2026-04-04
**System Health Score:** 87/100 (validated 2026-03-09 via comprehensive QA)

---

## 1. What is DigiLog?

DigiLog is a **21 CFR Part 11 compliant digital logbook** designed for regulated industries — pharmaceutical, biotechnology, food manufacturing, and medical device companies. It replaces paper-based logbooks, equipment records, and manual tracking systems with a secure, auditable, and configurable digital platform.

The name "DigiLog" combines "Digital" and "Logbook" — reflecting its core purpose of digitizing the record-keeping processes that regulated facilities must maintain for compliance.

---

## 2. The Problem

### Paper-Based Record Keeping

Regulated manufacturing facilities are required by law (FDA 21 CFR Part 11, EU Annex 11, GMP) to maintain detailed records of:
- Equipment status, maintenance, and calibration
- Environmental conditions (temperature, humidity, pressure)
- Personnel actions and approvals
- Material tracking and chain of custody
- Process deviations and corrective actions

**Current pain points with paper systems:**

| Problem | Impact |
|---------|--------|
| Paper logbooks are easily lost, damaged, or tampered with | Compliance risk, data integrity failures |
| Manual entries are illegible, inconsistent, or incomplete | Quality issues, audit findings |
| No real-time visibility into equipment or facility status | Delayed response to critical issues |
| Audit preparation requires weeks of manual document gathering | High labor cost, production downtime |
| No automated alerts when parameters go out of range | Product quality and safety risks |
| Difficult to enforce who can do what | Authorization gaps, compliance violations |
| No proof that records haven't been altered after the fact | Data integrity concerns (ALCOA+ principles) |

### Regulatory Pressure

The FDA's 21 CFR Part 11 regulation establishes requirements for electronic records and electronic signatures. Non-compliance can result in:
- **Warning letters** and consent decrees
- **Import alerts** blocking product entry into the US market
- **Product recalls** due to data integrity concerns
- **Criminal prosecution** in severe cases of data fraud

Many companies avoid digital systems because they fear the complexity of achieving Part 11 compliance. DigiLog removes this barrier by building compliance into the architecture.

---

## 3. The Solution

DigiLog provides a **template-driven entity management system** where:

1. **Administrators define templates** — blueprints for equipment types (e.g., "Reactor Vessel", "Clean Room", "HVAC Unit") with:
   - Typed attributes (serial number, capacity, temperature range)
   - Telemetry point definitions (real-time sensor data structure)
   - Inspection checklists (14 question types for structured verification)
   - Alarm rules (out-of-range detection)
   - Status lifecycle (Active → Under Maintenance → Decommissioned)
   - Connection rules (how many parent/child links allowed)

2. **Operators create entities from templates** — individual equipment/room/building instances organized in a hierarchical tree:
   - Enterprise → Site → Building → Floor → Room → Equipment
   - Each entity inherits its template's schema for consistent data capture

3. **Everything is audited** — every create, update, delete, status change, and relationship modification generates a tamper-evident audit record with SHA-256 checksums

4. **Access is controlled** — role-based permissions determine who can view, create, modify, or delete entities, with configurable re-authentication for sensitive operations

---

## 4. Target Industries & Users

### Primary Industries

| Industry | Use Case |
|----------|----------|
| **Pharmaceutical Manufacturing** | Equipment qualification, clean room monitoring, batch record support, calibration tracking |
| **Biotechnology** | Lab equipment management, cold chain monitoring, cell culture environment tracking |
| **Food & Beverage** | HACCP compliance, equipment sanitation records, temperature monitoring, allergen tracking |
| **Medical Devices** | Manufacturing equipment tracking, clean room qualification, component traceability |
| **Contract Manufacturing (CMO/CDMO)** | Multi-client facility management, equipment sharing records, compliance documentation |

### User Roles

| Role | Responsibility | System Access |
|------|---------------|---------------|
| **SUPER_ADMIN** | System owner, full configuration control | All features, all data, all config pages |
| **ADMIN** | Facility manager, user management | User CRUD, role management, most config |
| **SUPERVISOR** | Shift lead, approvals, oversight | Entity management, audit review, team oversight |
| **MAINTENANCE** | Equipment technician | Entity create/edit, status changes, relationship management |
| **OPERATOR** | Production operator, daily logbook entries | Entity view, limited edits, checklist completion |
| **VIEWER** | Auditor, quality reviewer (read-only) | View entities, audit trail, reports |

Custom roles can be created with granular permission combinations for specialized access patterns.

---

## 5. Business Value

### Compliance & Risk Reduction

| Benefit | How DigiLog Delivers |
|---------|---------------------|
| **21 CFR Part 11 compliance** | Built-in audit trail with SHA-256 checksums, electronic signatures via re-authentication, access controls, password policies |
| **Data integrity (ALCOA+)** | Attributable (user tracking), Legible (structured data), Contemporaneous (timestamps), Original (immutable records), Accurate (validation) |
| **Audit readiness** | Searchable audit trail with filters by date, user, action, entity — no manual document gathering |
| **Tamper evidence** | SHA-256 checksum on every audit record; any modification detectable at read time |
| **Access control** | Role-based permissions + action re-authentication ensure only authorized personnel perform sensitive operations |

### Operational Efficiency

| Benefit | How DigiLog Delivers |
|---------|---------------------|
| **Eliminate paper logbooks** | Digital entity records replace physical binders |
| **Standardize data capture** | Templates enforce consistent attribute types, checklist questions, and required fields |
| **Hierarchical organization** | Parent-child tree mirrors physical facility layout (Enterprise → Site → Room → Equipment) |
| **Real-time visibility** | Tree view and list view show all entities with current status |
| **Faster audits** | Filterable audit trail replaces weeks of manual document preparation |
| **Reduced training time** | Configurable UI (field labels, sidebar, permissions) adapts to each role |

### IT & Administration

| Benefit | How DigiLog Delivers |
|---------|---------------------|
| **Single platform** | One application for entity management, user management, configuration, and audit |
| **Dynamic configuration** | All settings (security, branding, datetime, pagination, field labels) configurable without code changes |
| **Backup & restore** | Full database export/import for disaster recovery |
| **Role management** | Create custom roles with granular permissions — no developer needed |
| **Brandable** | Company logo, colors, and name configurable per deployment |

---

## 6. Core Features — Business Perspective

### 6.1 Entity Management

**Business need:** Track every piece of equipment, room, and facility component with structured, validated data.

**What it does:**
- Define entity templates (blueprints) with typed attributes, inspection checklists, alarm thresholds, and status lifecycles
- Create entity instances from templates, organized in a hierarchical tree
- Link entities with 12 relationship types (Contains, Feeds, Monitors, Depends On, etc.)
- Attach physical identifiers (QR codes, barcodes, RFID, NFC tags)
- Track status transitions (Active → Under Maintenance → Decommissioned)
- Enforce connection limits (e.g., a sensor can only have 1 parent equipment)
- Version-controlled templates — every update creates a snapshot for traceability

**14 Checklist Question Types:**
| Type | Use Case |
|------|----------|
| PASS_FAIL | Equipment inspection pass/fail with criteria |
| YES_NO | Binary compliance check |
| YES_NO_NA | Compliance check with "not applicable" option |
| MCQ | Single-choice from predefined options |
| MULTI_SELECT | Multiple-choice selection |
| TEXT | Free-text observation or note |
| NUMERIC | Measured value with unit and min/max range |
| DROPDOWN | Selection from a list |
| PHOTO | Visual evidence capture |
| DATE_TIME | Date/time recording |
| SIGNATURE | Supervisor or operator sign-off |
| YES_NO_COMMENT | Yes/No with mandatory comment |
| CALCULATED | Auto-computed from formula |
| CONDITIONAL | Shows only when a condition is met |

### 6.2 User Management

**Business need:** Control who can access the system and what they can do, with full accountability.

**What it does:**
- Create/edit/delete user accounts with role assignment
- 6 default roles with configurable permissions (21 permissions across 7 categories)
- Create custom roles for specialized access patterns
- Enforce password policies (complexity, history, expiry)
- Account lockout after failed login attempts
- Forced password change on first login (temporary passwords)
- Admin-initiated password reset workflow
- Bulk user operations for large deployments

### 6.3 Audit Trail

**Business need:** Prove that records are authentic, unmodified, and attributable — the foundation of 21 CFR Part 11.

**What it does:**
- Every mutation (create, update, delete, status change) generates an audit record
- Records include: who (user), what (action), when (timestamp), before/after values, IP address
- SHA-256 checksum on each record — any modification is detectable
- Integrity verification on every read (recomputes checksum)
- Searchable and filterable by date range, user, action type, target entity
- Customizable audit message templates per action type
- SUPER_ADMIN actions exempt from logging (21 CFR Part 11 provision)

### 6.4 Configuration

**Business need:** Adapt the system to each facility's policies without developer involvement.

**33 configuration endpoints** covering:

| Category | Settings |
|----------|----------|
| **Security** | Password policy (length, complexity, history, expiry), login security (lockout rules), session management (duration, idle timeout) |
| **Display** | DateTime format, pagination options, field labels, branding (logo, colors, company name) |
| **Access** | Role privileges, sidebar visibility per role/user, action re-authentication matrix |
| **Audit** | Customizable audit message templates with placeholder system |
| **User ID** | Auto-generation format (prefix, separator, sequence) |

### 6.5 Notifications

**Business need:** Keep users informed of relevant events without information overload.

**What it does:**
- Role-based notification delivery (supervisors see team events, admins see system events)
- Unread count badge in header
- Mark read/unread, bulk operations
- In-app toast notifications for real-time feedback (relationship created, entity deleted, etc.)

### 6.6 Backup & Restore

**Business need:** Protect against data loss and support disaster recovery plans.

**What it does:**
- Full database export as downloadable ZIP
- Restore from backup with validation
- Backup integrity verification before restore

### 6.7 Data Ingestion & IoT Integration

**Business need:** Capture real-time sensor data from equipment automatically, replacing manual readings and enabling continuous monitoring.

**What it does:**
- **MQTT transport** — devices publish telemetry via standard MQTT protocol (EMQX broker)
- **HTTP transport** — REST API for telemetry data submission
- **WebSocket** — Real-time bidirectional streaming for dashboards
- **Processing pipeline** — 11-stage BullMQ pipeline: validation, enrichment, transformation, persistence, rule evaluation, alarm check, notification dispatch, aggregation, forwarding, DLQ, tracing
- **TimescaleDB** — Time-series database with 7 hypertables for efficient telemetry storage and queries
- **Dead Letter Queue** — Failed messages captured for analysis and replay

### 6.8 Rule Chain Engine

**Business need:** Automate decision-making based on incoming data — trigger alarms, transform values, route data, without custom code.

**What it does:**
- **77 node types** — filter, transform, switch, delay, aggregate, enrichment, action, external integration across 8 categories
- **Visual editor** — React Flow-based drag-and-drop rule chain builder
- **Sandboxed execution** — User scripts run in secure VM contexts (no access to system resources)
- **Sub-chain delegation** — Rule chains can call other chains for modular automation
- **Automatic alarm management** — Each alarm rule creates both create-alarm and clear-alarm paths

### 6.9 Alarm Management

**Business need:** Detect and alert when equipment parameters go out of range, with auditable acknowledgment and clearance workflows.

**What it does:**
- **4 alarm statuses** — ACTIVE, ACKNOWLEDGED, CLEARED, MANUALLY_CLEARED
- **3 severity levels** — WARNING, ALARM, CRITICAL
- **Role-based column visibility** — Admins control which alarm columns each role can see
- **Reauth-protected actions** — Alarm acknowledgment and clearance require re-authentication
- **Audit logged** — All alarm actions generate audit trail entries
- **Enriched display** — Alarm list includes entity names, threshold values, and generated/cleared values

### 6.10 Unified Namespace (UNS)

**Business need:** Organize all data sources in a standardized ISA-95 hierarchy for consistent cross-system data access.

**What it does:**
- **ISA-95 paths** — Enterprise/Site/Area/Line/Cell path structure
- **Auto-mapping** — Automatically generates UNS paths from entity hierarchy
- **Wildcard search** — Path-based queries for namespace traversal
- **Cascade moves** — Moving a node cascades to all descendants

---

## 7. Regulatory Compliance Map

### 21 CFR Part 11 — Electronic Records & Signatures

| Regulation | Requirement | DigiLog Implementation |
|------------|------------|----------------------|
| **11.10(a)** | System access limited to authorized individuals | JWT + sessions, RBAC, account lockout |
| **11.10(b)** | Audit trail — record creating, modifying, deleting | SHA-256 checksummed audit records for all mutations |
| **11.10(c)** | Audit trail — independent of operator | Server-side audit logging, operators cannot disable |
| **11.10(d)** | Limit system access to authorized individuals | Role-based permissions (52+ granular permissions) |
| **11.10(e)** | Audit trails for operator actions | Before/after values captured for every change |
| **11.10(g)** | Authority checks | `requirePermission()` + `requireRole()` on every endpoint |
| **11.10(h)** | Device checks | Session management, idle timeout, single-tab enforcement |
| **11.10(k)** | Controls for system documentation | Template versioning with full JSON snapshots |
| **11.50** | Signature includes name, date/time, meaning | Audit records contain username, timestamp, action type |
| **11.70** | Signatures linked to records | Audit entries contain userId, sessionId, IP address |
| **11.100** | Each signature unique to one individual | Unique username + password per user |
| **11.200** | Two-component signatures | Username (identification) + password (authentication) |
| **11.300(a)** | Unique identification codes | Unique username enforced at DB level |
| **11.300(b)** | Password aging | Configurable expiry via password policy |
| **11.300(c)** | Loss management | Account lockout + admin unlock workflow |
| **11.300(d)** | Transaction safeguards | Action re-authentication for sensitive operations |
| **11.300(e)** | Temporary passwords | Forced password change on first login |

### ALCOA+ Data Integrity Principles

| Principle | How DigiLog Ensures It |
|-----------|----------------------|
| **Attributable** | Every record linked to a specific user via userId, username, role, IP address |
| **Legible** | Structured data with typed attributes, not free-text; configurable display formats |
| **Contemporaneous** | Server-side timestamps on all records; cannot be backdated |
| **Original** | Immutable audit trail with SHA-256 checksums; originals preserved |
| **Accurate** | Zod schema validation on all inputs; numeric constraints on attributes |
| **Complete** | Before/after values in audit trail; required fields enforced; checklist required flag |
| **Consistent** | Templates enforce data structure; validation rules shared between client and server |
| **Enduring** | PostgreSQL database with backup/restore; records persist indefinitely |
| **Available** | Web-based access from any authorized device; searchable audit trail |

---

## 8. Deployment Model

### Current Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    EC2 Instance (t3.large)                     │
│                                                                │
│  ┌─────────┐   ┌──────────┐   ┌──────────────────────────┐  │
│  │  nginx   │──▶│ Fastify  │──▶│  PostgreSQL 16            │  │
│  │ (port 80)│   │ API      │   │  digilog_db (30 tables)   │  │
│  │ React SPA│   │ (3000)   │   │  digilog_tsdb (TimescaleDB)│  │
│  │ /dist    │   │ PM2      │   └──────────────────────────┘  │
│  └─────────┘   └──────────┘                                   │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────────┐  │
│  │  EMQX    │  │ Redis 7  │  │  BullMQ Workers            │  │
│  │  MQTT    │  │ (6379)   │  │  - Ingestion pipeline      │  │
│  │  Broker  │  │          │  │  - Maintenance              │  │
│  └──────────┘  └──────────┘  └────────────────────────────┘  │
│                                                                │
│  Devices ──▶ MQTT/HTTP ──▶ Pipeline ──▶ Rule Engine ──▶ Alarms│
│  Browser ──▶ nginx ──▶ /api/* ──▶ Fastify ──▶ Prisma/TSDB    │
└──────────────────────────────────────────────────────────────┘
```

### Scalability Considerations

| Aspect | Current | Future |
|--------|---------|--------|
| **Users** | Single facility, ~50 concurrent users | Multi-facility with site-level isolation |
| **Entities** | Thousands of entities per facility | Tens of thousands with pagination optimization |
| **Database** | Single PostgreSQL instance | Read replicas, connection pooling |
| **Application** | Single EC2 instance, PM2 cluster | Container orchestration (ECS/EKS) |
| **Storage** | Local file uploads | S3 for photos and documents |
| **SSL** | HTTP (internal network) | HTTPS with TLS certificates |

---

## 9. Data Model — Business View

### Entity Hierarchy Example

```
Acme Pharma (Enterprise)
├── Site Alpha (Site)
│   ├── Building A (Building)
│   │   ├── Floor 1 (Floor)
│   │   │   ├── Clean Room 101 (Room)
│   │   │   │   ├── Reactor Vessel RV-001 (Equipment)
│   │   │   │   │   ├── Temperature Sensor TS-001 (Sensor) [MONITORS → RV-001]
│   │   │   │   │   ├── Pressure Gauge PG-001 (Instrument) [MONITORS → RV-001]
│   │   │   │   │   └── QR Code: "RV-001-QR" (Identifier)
│   │   │   │   ├── Mixing Tank MT-001 (Equipment) [FEEDS → RV-001]
│   │   │   │   └── HVAC Unit HV-001 (Equipment)
│   │   │   └── Storage Room 102 (Room)
│   │   └── Floor 2 (Floor)
│   └── Building B (Building)
└── Site Beta (Site)
```

### Template → Instance Flow

```
[Template: "Reactor Vessel"]                [Instance: "RV-001"]
┌──────────────────────────┐               ┌──────────────────────────┐
│ Attributes:              │               │ Attributes:              │
│  - serialNumber (TEXT)   │  ──creates──▶ │  - serialNumber: "ABC123"│
│  - capacity (FLOAT)     │               │  - capacity: 500.5       │
│  - material (DROPDOWN)  │               │  - material: "316L SS"   │
│                          │               │                          │
│ Checklist:               │               │ Status: Active           │
│  - "Is vessel clean?"   │               │ Template Version: 3      │
│  - "Check pressure"     │               │ Parent: Clean Room 101   │
│  - "Supervisor sign-off" │               │                          │
│                          │               │ Identifiers:             │
│ Alarm Rules:             │               │  - QR: "RV-001-QR"      │
│  - Temp > 80°C → ALARM  │               │  - RFID: "TAG-4521"     │
│                          │               │                          │
│ Status Lifecycle:        │               │ Relationships:           │
│  Active → Maintenance   │               │  - FEEDS ← MT-001       │
│  Maintenance → Active   │               │  - MONITORED_BY → TS-001 │
│  Any → Decommissioned   │               │                          │
└──────────────────────────┘               └──────────────────────────┘
```

---

## 10. Competitive Positioning

### How DigiLog Compares

| Feature | DigiLog | Paper Logbooks | Generic CMMS | Enterprise MES |
|---------|---------|----------------|-------------|----------------|
| **21 CFR Part 11 compliance** | Built-in | Not applicable | Partial | Full |
| **Cost** | Low (open-source, self-hosted) | Low (paper) | Medium | Very High |
| **Implementation time** | Days | N/A | Weeks | Months to years |
| **Customization** | Template-driven, no-code config | N/A | Limited | Requires consultants |
| **Audit trail** | SHA-256 checksummed, tamper-evident | Manual review | Basic logging | Full |
| **Hierarchical entity management** | 12 relationship types, tree view | N/A | Basic | Full |
| **Checklist/inspection support** | 14 question types | Paper forms | Basic | Full |
| **User management** | Dynamic roles, 21 permissions | N/A | Basic | Full |
| **Self-hosted** | Yes | N/A | Varies | Usually cloud/on-prem |

### Target Segment

DigiLog is positioned for **small-to-medium regulated manufacturers** (50-500 employees) who need:
- 21 CFR Part 11 compliance without enterprise software budgets
- Quick deployment without lengthy implementation projects
- Customizable entity tracking without developer resources
- Audit-ready records that survive FDA inspections

---

## 11. Roadmap — Business Capabilities

### Completed Phases

| Phase | Capability | Status |
|-------|-----------|--------|
| **Phase 1** | Core Application (User Management, Entity Management, Config, Audit) | Done (v1.0.0) |
| **Phase 2** | Entity Enhancements (Connection limits, tree diagram, checklists, toast system) | Done |
| **Phase A** | Data Ingestion Infrastructure (Docker, TimescaleDB, Prisma models, shared types, seed data) | Done |
| **Phase B** | Transport Layer (MQTT auth, HTTP ingestion, WebSocket, entity resolver) | Done |
| **Phase C** | Ingestion Pipeline (BullMQ worker, 11 pipeline stages, DLQ, connectivity tracker) | Done |
| **Phase D** | Rule Chain Engine (77 node types, BFS execution, debug recorder, sandboxed scripts) | Done |
| **Phase E** | Unified Namespace (ISA-95 paths, wildcard search, cascade moves) | Done |
| **Phase F** | Queries & Export (telemetry, alarms, export, retention routes) | Done |
| **Phase G-J** | Connectivity, QR Codes, Help Articles, Rule Chain Editor, Alarm Dashboard, UNS Config | Done |
| **Phase K** | Testing & Documentation (1344 tests, 36-page docs, CI/CD pipeline) | Done |
| **Phase 2 FMS** | Digital Filter Management System (6 modules, 11+ tables, 14+ pages) | Done |
| **Phase 3** | Bulk upload, retirement/replacement, mobile PWA, Android APK, unified theme | Done |

### Upcoming Phases

| Phase | Capability | Business Value |
|-------|-----------|----------------|
| **v3.2** | Reports & Dashboards | PDF/Excel audit reports, entity status reports, compliance dashboards |
| **v4.0** | HTTPS/TLS + Multi-tenant | Secure communications + single deployment serving multiple facilities |

---

## 12. Key Metrics

### System Capacity (Current — v3.0)

| Metric | Value |
|--------|-------|
| API endpoints | ~200+ |
| Database models | 57 Prisma models + 17 enums |
| Frontend route groups | 20+ |
| Custom hooks | 9 |
| Permission types | 52+ (across 10+ categories) |
| Entity relationship types | 12 |
| Checklist question types | 14 |
| Attribute data types | 9 |
| Alarm rule types | 7 |
| Rule chain node types | 77 |
| Configuration definitions | 23 |
| Automated tests | 1,344 (0 failures, 83 test files) |
| Default roles | 6 |
| TimescaleDB hypertables | 7 |
| Help articles | 40+ |
| API modules | 34 |

### Documentation & Governance

| Metric | Value |
|--------|-------|
| Documented bugs | 25 (24 resolved, 1 open low-priority) |
| Test documentation files | 8 (centralized in `/documentation/testing/`) |
| Governance documents | 15+ (plans, summaries, bug logs, compliance, API reference) |

### Compliance Coverage

| Standard | Coverage |
|----------|----------|
| 21 CFR Part 11 — Subpart B (Electronic Records) | 14/14 controls implemented |
| 21 CFR Part 11 — Subpart C (Electronic Signatures) | 8/8 controls implemented |
| ALCOA+ Data Integrity | 9/9 principles addressed |

---

## 13. Glossary

| Term | Definition |
|------|-----------|
| **21 CFR Part 11** | US FDA regulation governing electronic records and electronic signatures in regulated industries |
| **ALCOA+** | Data integrity framework: Attributable, Legible, Contemporaneous, Original, Accurate + Complete, Consistent, Enduring, Available |
| **Entity** | A tracked object in the system (equipment, room, building, sensor, etc.) — created from a template |
| **Template** | A blueprint defining the structure (attributes, checklists, alarm rules) for a type of entity |
| **Instance** | A specific entity created from a template (e.g., "Reactor Vessel RV-001") |
| **Relationship** | A bidirectional link between two entities (e.g., CONTAINS, FEEDS, MONITORS) |
| **Identifier** | A physical tag attached to an entity (QR code, barcode, RFID, NFC) |
| **Reauth** | Re-authentication — requiring password confirmation before sensitive operations |
| **Audit Trail** | Immutable, checksummed log of all system actions for compliance verification |
| **GMP** | Good Manufacturing Practice — regulations for pharmaceutical/food manufacturing quality |
| **CMMS** | Computerized Maintenance Management System |
| **MES** | Manufacturing Execution System |
| **OPC-UA** | Open Platform Communications Unified Architecture — industrial communication protocol |
| **MQTT** | Message Queuing Telemetry Transport — lightweight IoT messaging protocol |
| **HACCP** | Hazard Analysis Critical Control Points — food safety management system |

---

## 14. Documentation Governance — Business Impact

**Effective:** 2026-02-25 (v2.1.1) | **Updated:** 2026-04-04 (v2.1.0)

### Why This Matters for Regulated Industries

In 21 CFR Part 11 environments, **documentation integrity is as critical as system integrity**. Regulatory audits assess not just whether systems work correctly, but whether changes are properly documented, traceable, and governed.

### Governance Controls Activated

| Control | Business Benefit |
|---------|-----------------|
| Auto-synchronized documentation (7 files) | Audit readiness — documentation always matches system state |
| Structured bug lifecycle (Git issues + Bug_Resolution_Log) | Traceability — every defect has root cause analysis and resolution record |
| Centralized testing documentation | Organized evidence for validation audits (IQ/OQ/PQ) |
| Version-tracked governance documents | Change control compliance — every modification is logged |
| Mandatory documentation update on every change | Eliminates documentation drift — a common FDA audit finding |

### Git Issue Lifecycle (v2.1.2)

All 12 historical bugs have been converted to structured GitHub issues (#2–#13) with full traceability:
- **11 issues closed** with linked commit references
- **1 issue open** (#13 — low priority test expectation mismatch)
- Each issue includes: module, severity, root cause analysis, impact, resolution
- Bug_Resolution_Log.md links each bug entry to its GitHub issue

### Risk Reduction

- **Eliminates documentation lag** — the #1 cause of 483 observations related to electronic records
- **Ensures traceability** — every code change maps to documentation changes
- **Full bug traceability** — Bug_Resolution_Log → Git Issue → Commit → Documentation
- **Supports audit preparation** — structured documents reduce audit preparation from weeks to hours
- **Maintains system validated state** — documentation always reflects current validated configuration

## Phase 2: Digital Filter Management System

### Business Need
Pharmaceutical cleanrooms use HEPA filters that require periodic cleaning following strict GMP protocols. Manual paper-based tracking is error-prone, non-traceable, and fails 21 CFR Part 11 compliance.

### Solution
Digital FMS provides:
- **Configurable cleaning pipelines** — Each facility defines its own cleaning stages (wash, dry, storage) with optional quality checklists between stages
- **Real-time tracking** — Operators scan filters at each stage, system enforces sequence and records timestamps
- **Dual filter sets** — AHUs maintain Set A (in-use) and Set B (spare), enabling rotation during cleaning
- **PM scheduling** — Annual preventive maintenance calendar per AHU with tolerance windows
- **Complete traceability** — Every state transition, checklist answer, and deviation is immutably recorded
- **Configurable reasons** — 8 cleaning reasons (PM, Type A/B/C, On Request, Contamination, Failure, Custom) with optional justification

### Compliance
- All events stored with SHA-256 checksums (tamper detection)
- Electronic signatures via user authentication
- Deviation tracking for bypass/out-of-sequence operations
- Immutable audit trail for all filter operations


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
