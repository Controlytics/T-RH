# DigiLog — Data Ingestion & Integration Layer

## Complete Requirements & Development Plan

**Version:** 3.5.0
**Date:** 2026-02-25 (requirements) | Updated: 2026-04-04 (status)
**Status:** IMPLEMENTED — All phases (A through K) complete. 34 API modules, 57 Prisma models, 77 rule chain node types.
**Depends on:** DigiLog v2.1.2 (original baseline). Current: v2.1.0 with Phase 2 Digital FMS.
**Changelog:**
- v1.0.0 → v2.0.0: 14 compliance deviations identified and resolved
- v2.0.0 → v3.0.0: Architecture simplification — removed event-sourcing, merged DeviceProfile into AssetTemplate, external MQTT broker, dropped CoAP, corrected audit scope, simplified alarm/checklist lifecycle
- v3.0.0 → v3.1.0: Replaced Mosquitto with EMQX, added device subscribe topics + ACL, added alarm deduplication, added separation of duties enforcement, added pipeline error handling/DLQ, added alarm clear signature, added TLS specification, added MQTT QoS policy, added rule chain recursion limit, added binary upload limits, added WebSocket authentication, added TimescaleDB continuous aggregate refresh policy, added export safeguards
- v3.1.0 → v3.2.0: Deep critical review — 25 gaps identified (Appendix E), added MQTT LWT for connectivity, added graceful shutdown, added EMQX persistent sessions, resolved orphaned DataStream model, added pagination specs, added client timestamp validation, added RPC timeout, added MQTT max payload, clarified EMQX degradation mode, added export permission fix, resolved FK gaps
- v3.2.0 → v3.3.0: SUPER_ADMIN System Configuration UI (Section 20) — all operational limits stored in DB with hot-reload, configurable from UI with reauth + audit. Separated TimescaleDB as dedicated instance (Scale 2). Worker architecture finalized: Redis + BullMQ from Day 1, in-process initially, ingestion worker structured for split. Reports Worker queue defined for future scope. Environment variables reduced to cold infrastructure settings only.
- v3.3.0 → v3.4.0: Pipeline Debug Trace (Section 6.3) — per-message ingestion tracing with 11-stage progress tracking, standardized error codes per stage, visual progress bar UI, per-entity/per-template/global trace toggle, real-time WebSocket streaming, `ts_pipeline_traces` TimescaleDB table with auto-purge, trace stats dashboard. Fixed duplicate subsection numbering in Section 6.
- v3.4.0 → v3.5.0: Critical review — 18 issues identified and resolved. Fixed: ConfigService null pointer crash and missing oldValue (#1/#2), Section 3.2 TSDB location contradiction (#6), init-tsdb.sql CREATE DATABASE error (#14), stale env var references (#5), duplicate EMQX Docker Compose (#13). Architecture: added SUCCESS_WITH_WARNINGS trace status for non-fatal issues (#4/#7), single JSONB stages array replacing 11 columns (#18), moved worker concurrency + rate limit + trace TTL to cold/restart-required settings (#8/#15), kept BullMQ priorities for compliance (#16), batch flush before job ack (#17). Documented: Redis as hard dependency with degradation mode (#11), pre-auth trace limitation (#10), cross-process cache invalidation (#9), MQTT dashboard port clarification (#12).

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Dual Database Architecture](#3-dual-database-architecture)
4. [Unified Namespace (UNS) Integration](#4-unified-namespace-uns-integration)
5. [Transport & Protocol Layer](#5-transport--protocol-layer)
6. [Data Ingestion Pipeline](#6-data-ingestion-pipeline)
7. [Rule Chain Engine](#7-rule-chain-engine)
8. [Connectivity Testing & Diagnostics](#8-connectivity-testing--diagnostics)
9. [QR Code Generation & Checklist Submission](#9-qr-code-generation--checklist-submission)
10. [Help System](#10-help-system)
11. [API Endpoint Specification](#11-api-endpoint-specification)
12. [Database Schema](#12-database-schema)
13. [Frontend Pages & Components](#13-frontend-pages--components)
14. [File Structure & Module Layout](#14-file-structure--module-layout)
15. [Development Phases](#15-development-phases)
16. [Testing Strategy](#16-testing-strategy)
17. [Configuration & Environment](#17-configuration--environment)
18. [Mobile App Integration Points](#18-mobile-app-integration-points)
19. [Future Scope: Dashboards & Widgets](#19-future-scope-dashboards--widgets)
20. [System Configuration (SUPER_ADMIN)](#20-system-configuration-super_admin)
21. [Scaling Architecture & Worker Processes](#21-scaling-architecture--worker-processes)
22. [Appendix A: Rule Node Type Registry](#appendix-a-rule-node-type-registry)
23. [Appendix B: Default Help Articles](#appendix-b-default-help-articles-seed-data)
24. [Appendix C: 21 CFR Part 11 Compliance Matrix](#appendix-c-21-cfr-part-11-compliance-matrix)
25. [Appendix D: Design Decision Register](#appendix-d-design-decision-register)
26. [Appendix E: Critical Review — Gaps, Risks & Resolutions](#appendix-e-critical-review--gaps-risks--resolutions-v320)

---

## 1. Executive Summary

This document specifies the Data Ingestion & Integration Layer for DigiLog — a real-time data processing pipeline that receives telemetry, attributes, images, audio, vibration data, and checklist responses from IoT devices and external systems, processes them through a configurable rule chain engine, and stores them in a dual-database architecture (PostgreSQL for relational data and lifecycle objects, TimescaleDB for append-only time-series data).

**Key capabilities:**

- Multi-protocol ingestion: MQTT (external EMQX broker), HTTP, WebSocket
- Rule chain engine with visual editor, JavaScript scripting, debug mode on every node, version-controlled snapshots
- Dual database: PostgreSQL (entities, relationships, config, alarms, checklist reviews, signatures, audit trail) + TimescaleDB (telemetry, attributes, device events, binary metadata, checklist responses)
- Clear data tier separation: TimescaleDB for immutable machine-generated data, PostgreSQL for lifecycle objects with audit trail
- UNS (Unified Namespace) path standard with ISA-95 hierarchy and MQTT wildcards
- Connectivity testing UI with per-protocol test tools and live status indicators
- QR code generation per entity for mobile checklist filling (full user authentication enforced)
- Electronic signatures compliant with §11.50 and §11.200
- Contextual help buttons throughout the UI with version-controlled content
- Default rule chain auto-provisioned for every new entity template
- Three-tier approval workflow for checklists (Performed By / Checked By / Verified By)
- PWA/native mobile app for offline checklist access with server-side sync
- Audit trail on all compliance-critical actions (attributes, alarms, checklists, deviations — NOT raw telemetry)

**Inspiration sources:** ThingsBoard (rule chain, debug mode, connectivity testing, device API), OpenRemote (asset-centric data model, protocol agents), United Manufacturing Hub (UNS topic structure).

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          TRANSPORT LAYER                                     │
│  ┌──────────────┐  ┌──────────┐  ┌──────────┐                              │
│  │    EMQX     │  │  HTTP    │  │WebSocket │                              │
│  │  MQTT Broker │  │  API     │  │  Server  │                              │
│  │  (external)  │  │(Fastify) │  │(Fastify) │                              │
│  └──────┬───────┘  └────┬─────┘  └────┬─────┘                              │
│         │                │              │                                    │
│         └────────────────┴──────────────┘                                   │
│                          │                                                   │
│               ┌──────────▼──────────┐                                       │
│               │  INGESTION GATEWAY  │                                       │
│               │  (Unified Message   │                                       │
│               │   Envelope)         │                                       │
│               └──────────┬──────────┘                                       │
└──────────────────────────┼──────────────────────────────────────────────────┘
                           │
                ┌──────────▼──────────┐
                │   UNS PATH RESOLVER │
                │  (Entity Lookup +   │
                │   Topic Validation  │
                │   + Device Check)   │
                └──────────┬──────────┘
                           │
                ┌──────────▼──────────┐
                │   RULE CHAIN ENGINE │
                │  ┌───────────────┐  │
                │  │ Input Node    │  │
                │  └──────┬────────┘  │
                │  ┌──────▼────────┐  │
                │  │ Processing    │  │
                │  │ Nodes         │  │
                │  └──────┬────────┘  │
                │  ┌──────▼────────┐  │
                │  │ Action Nodes  │  │
                │  │ (Save + Audit)│  │
                │  └───────────────┘  │
                └──────────┬──────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
┌─────────▼─────┐  ┌──────▼──────┐  ┌──────▼──────┐
│  PostgreSQL   │  │ TimescaleDB │  │ File Store  │
│  (Lifecycle)  │  │ (Immutable  │  │ (Blobs)     │
│               │  │  Streams)   │  │             │
│ - Audit Trail │  │             │  │ - Images    │
│ - Alarms      │  │ - Telemetry │  │ - Audio     │
│ - Checklist   │  │ - Attribs   │  │ - Vibration │
│   Reviews     │  │ - Device    │  │   raw data  │
│ - E-Signatures│  │   Events    │  │             │
│ - Entities    │  │ - Binary    │  │             │
│ - Templates   │  │   Metadata  │  │             │
│ - Rule Chains │  │ - Checklist │  │             │
│ - UNS Map     │  │   Responses │  │             │
│ - Latest      │  │             │  │             │
│   Telemetry   │  │             │  │             │
│ - Connectivity│  │             │  │             │
└───────────────┘  └─────────────┘  └─────────────┘
```

### Data Tier Principle

> **TimescaleDB** stores immutable, machine-generated, append-only time-series data. No UPDATE or DELETE ever.
> **PostgreSQL** stores everything with a lifecycle — entities, alarms, checklist reviews, signatures, rule chains, users, configuration. Mutable, with every compliance-critical change captured in the existing SHA-256 chained audit trail.
> **Audit trail** covers attribute changes, alarm state transitions, checklist workflow steps, deviations, rule chain changes, and configuration changes. Raw telemetry is NOT audited (machine-generated, immutable in TimescaleDB).

---

## 3. Dual Database Architecture

### 3.1 PostgreSQL (via Prisma) — Relational + Lifecycle Data

The existing PostgreSQL database retains all current models and adds:

| New Model | Purpose | Mutable? | Audited? |
|-----------|---------|----------|----------|
| `DeviceCredential` | Access tokens, IP allowlist, rate limits per entity instance | Yes | Yes |
| `RuleChain` | Rule chain definition (name, root flag, JSON graph) | Yes | Yes |
| `RuleChainVersion` | Immutable version snapshots for rollback | No (append-only) | Yes |
| `RuleNode` | Individual nodes within a rule chain | Yes (via chain update) | Via chain audit |
| `RuleNodeConnection` | Edges between rule nodes | Yes (via chain update) | Via chain audit |
| `Alarm` | Full alarm lifecycle in one row | Yes | Yes (every transition) |
| `ChecklistReview` | Approval workflow status (Performed/Checked/Verified) | Yes | Yes (every step) |
| `ElectronicSignature` | §11.50/§11.70 compliant signatures with FK to records | No (append-only) | Yes |
| `DataStream` | Registered data streams per entity | Yes | No |
| `UnsMapping` | Maps entity IDs to UNS topic paths | Yes | Yes |
| `ConnectivityStatus` | Last known connectivity state per entity | Yes | No |
| `LatestTelemetry` | Cache of most recent value per entity+key | Yes (UPSERT cache) | No |
| `QrCode` | Generated QR codes linked to entity instances | Yes | No |
| `HelpArticle` | Contextual help content | Yes | Yes |
| `HelpArticleVersion` | Immutable version snapshots of help content | No (append-only) | Yes |
| `SystemConfig` | SUPER_ADMIN configurable system settings | Yes | Yes |

### 3.2 TimescaleDB — Immutable Append-Only Streams

TimescaleDB runs as a **dedicated Docker container** (`tsdb` service) separate from the PostgreSQL instance used by Prisma. See Section 21.1 for Docker Compose configuration.

**CRITICAL RULE: No UPDATE or DELETE operations are ever performed on compliance hypertables** (`ts_telemetry`, `ts_attributes`, `ts_checklist_responses`, `ts_device_events`, `ts_binary_data`). Debug/operational tables (`ts_pipeline_traces`) are exempt — they are auto-purged by TimescaleDB retention policy and are not compliance records.

**Multi-tenant isolation:** All hypertables include `entity_id` which is tenant-scoped (entities belong to tenants via the existing PostgreSQL hierarchy). Queries MUST always filter by `entity_id` or by `uns_path` (which includes the enterprise/tenant prefix). There is no separate `tenant_id` column in TimescaleDB tables — tenant isolation is enforced at the application layer through entity ownership. This is acceptable because:
1. All TSDB queries originate from the API layer which already validates tenant access via RBAC
2. Device credentials are entity-scoped, so devices can only write to their own entity's data
3. UNS paths include the enterprise prefix, providing natural tenant segmentation
4. If row-level security is needed in future, a `tenant_id` column can be added via TimescaleDB migration without data loss

Enforced by:
1. Database-level `REVOKE UPDATE, DELETE` on all compliance hypertables for the application user
2. Application-level enforcement in the repository layer
3. Compliance tests that verify no UPDATE/DELETE queries exist in the codebase for compliance TSDB tables

**Connection:** A dedicated `pg` Pool pointing to `TSDB_HOST:TSDB_PORT/digilog_tsdb` (separate from Prisma's `DATABASE_URL`).

#### Hypertables

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ═══════════════════════════════════════════════════════════
-- 1. TELEMETRY (append-only sensor data)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE ts_telemetry (
    time        TIMESTAMPTZ      NOT NULL,
    entity_id   UUID             NOT NULL,
    key         TEXT             NOT NULL,
    value_num   DOUBLE PRECISION,
    value_str   TEXT,
    value_bool  BOOLEAN,
    value_json  JSONB,
    uns_path    TEXT             NOT NULL,
    source      TEXT             DEFAULT 'device',   -- device | manual | rule_engine | api
    source_ip   TEXT,
    trace_id    TEXT
);
SELECT create_hypertable('ts_telemetry', 'time');
CREATE INDEX idx_ts_telemetry_entity ON ts_telemetry (entity_id, time DESC);
CREATE INDEX idx_ts_telemetry_uns ON ts_telemetry (uns_path, time DESC);
CREATE INDEX idx_ts_telemetry_key ON ts_telemetry (entity_id, key, time DESC);

-- ═══════════════════════════════════════════════════════════
-- 2. ATTRIBUTES (append-only attribute change history)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE ts_attributes (
    time        TIMESTAMPTZ      NOT NULL,
    entity_id   UUID             NOT NULL,
    scope       TEXT             NOT NULL,    -- client | server | shared
    key         TEXT             NOT NULL,
    value_num   DOUBLE PRECISION,
    value_str   TEXT,
    value_bool  BOOLEAN,
    value_json  JSONB,
    updated_by  TEXT             NOT NULL,    -- userId or deviceCredentialId
    uns_path    TEXT             NOT NULL,
    source_ip   TEXT
);
SELECT create_hypertable('ts_attributes', 'time');

-- ═══════════════════════════════════════════════════════════
-- 3. CHECKLIST RESPONSES (immutable on submit, never modified)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE ts_checklist_responses (
    time          TIMESTAMPTZ    NOT NULL,
    entity_id     UUID           NOT NULL,
    template_id   UUID           NOT NULL,
    checklist_id  TEXT           NOT NULL,    -- UUID, used to link to ChecklistReview in PG
    submitted_by  TEXT           NOT NULL,    -- userId (NEVER device token)
    answers       JSONB          NOT NULL,
    answers_hash  TEXT           NOT NULL,    -- SHA-256 of answers JSON for signature binding
    uns_path      TEXT           NOT NULL,
    source_ip     TEXT
);
SELECT create_hypertable('ts_checklist_responses', 'time');

-- ═══════════════════════════════════════════════════════════
-- 4. DEVICE EVENTS (append-only connection history)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE ts_device_events (
    time          TIMESTAMPTZ    NOT NULL,
    entity_id     UUID           NOT NULL,
    event_type    TEXT           NOT NULL,    -- CONNECTED | DISCONNECTED | ACTIVITY | ERROR | INACTIVITY | IP_MISMATCH | RATE_LIMITED
    details       JSONB,
    source_ip     TEXT,
    uns_path      TEXT           NOT NULL
);
SELECT create_hypertable('ts_device_events', 'time');

-- ═══════════════════════════════════════════════════════════
-- 5. BINARY DATA REFERENCES (append-only file metadata)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE ts_binary_data (
    time          TIMESTAMPTZ    NOT NULL,
    entity_id     UUID           NOT NULL,
    data_type     TEXT           NOT NULL,    -- image | audio | vibration_raw | document
    file_path     TEXT           NOT NULL,
    file_hash     TEXT           NOT NULL,    -- SHA-256 of file content
    file_size     BIGINT,
    mime_type     TEXT,
    metadata      JSONB,
    uploaded_by   TEXT           NOT NULL,
    uns_path      TEXT           NOT NULL
);
SELECT create_hypertable('ts_binary_data', 'time');

-- ═══════════════════════════════════════════════════════════
-- PIPELINE DEBUG TRACES
-- ═══════════════════════════════════════════════════════════
CREATE TABLE ts_pipeline_traces (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    time            TIMESTAMPTZ NOT NULL,
    message_id      TEXT NOT NULL,
    entity_id       UUID,
    entity_name     TEXT,
    transport       TEXT NOT NULL,
    message_type    TEXT NOT NULL,
    payload_size    INTEGER,
    stages          JSONB NOT NULL,
    final_status    TEXT NOT NULL,
    failed_stage    TEXT,
    error_code      TEXT,
    error_message   TEXT,
    warnings        JSONB,
    total_duration_ms INTEGER NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT create_hypertable('ts_pipeline_traces', 'time');
CREATE INDEX idx_pipeline_traces_entity ON ts_pipeline_traces (entity_id, time DESC);
CREATE INDEX idx_pipeline_traces_status ON ts_pipeline_traces (final_status, time DESC);

-- ═══════════════════════════════════════════════════════════
-- CONTINUOUS AGGREGATES
-- ═══════════════════════════════════════════════════════════
CREATE MATERIALIZED VIEW telemetry_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    entity_id,
    key,
    AVG(value_num) AS avg_val,
    MIN(value_num) AS min_val,
    MAX(value_num) AS max_val,
    COUNT(*) AS sample_count
FROM ts_telemetry
WHERE value_num IS NOT NULL
GROUP BY bucket, entity_id, key;

-- Refresh policy: auto-refresh the last 2 hours of data every 30 minutes
SELECT add_continuous_aggregate_policy('telemetry_hourly',
  start_offset => INTERVAL '2 hours',
  end_offset   => INTERVAL '30 minutes',
  schedule_interval => INTERVAL '30 minutes');

-- Daily aggregate (for long-term trending)
CREATE MATERIALIZED VIEW telemetry_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS bucket,
    entity_id,
    key,
    AVG(value_num) AS avg_val,
    MIN(value_num) AS min_val,
    MAX(value_num) AS max_val,
    COUNT(*) AS sample_count
FROM ts_telemetry
WHERE value_num IS NOT NULL
GROUP BY bucket, entity_id, key;

SELECT add_continuous_aggregate_policy('telemetry_daily',
  start_offset => INTERVAL '2 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- ═══════════════════════════════════════════════════════════
-- COMPRESSION (data stays, just compressed — NOT deleted)
-- ═══════════════════════════════════════════════════════════
SELECT add_compression_policy('ts_telemetry', INTERVAL '7 days');
SELECT add_compression_policy('ts_attributes', INTERVAL '30 days');
SELECT add_compression_policy('ts_device_events', INTERVAL '7 days');
SELECT add_compression_policy('ts_binary_data', INTERVAL '30 days');
SELECT add_compression_policy('ts_checklist_responses', INTERVAL '30 days');
SELECT add_compression_policy('ts_pipeline_traces', INTERVAL '1 day');

-- ═══════════════════════════════════════════════════════════
-- RETENTION: DISABLED BY DEFAULT (except debug traces)
-- Data is NEVER auto-deleted. Enabling retention requires:
--   1. SUPER_ADMIN configuration
--   2. Verified archive/export of affected date range
--   3. Configurable per-table through System Config UI
-- Pipeline traces are debug data (NOT compliance) — auto-purged
-- ═══════════════════════════════════════════════════════════
SELECT add_retention_policy('ts_pipeline_traces', INTERVAL '48 hours');

-- ═══════════════════════════════════════════════════════════
-- SECURITY: REVOKE UPDATE/DELETE on compliance hypertables
-- NOTE: ts_pipeline_traces is intentionally excluded (debug data, auto-purged by retention policy)
-- ═══════════════════════════════════════════════════════════
REVOKE UPDATE, DELETE ON ts_telemetry FROM digilog_app;
REVOKE UPDATE, DELETE ON ts_attributes FROM digilog_app;
REVOKE UPDATE, DELETE ON ts_checklist_responses FROM digilog_app;
REVOKE UPDATE, DELETE ON ts_device_events FROM digilog_app;
REVOKE UPDATE, DELETE ON ts_binary_data FROM digilog_app;
```

### 3.3 Electronic Signature Schema

All electronic signatures conform to §11.50 and §11.200:

```typescript
interface ElectronicSignature {
  signatureId: string;
  signerUserId: string;
  signerFullName: string;       // §11.50(a): Printed name
  signerRole: string;
  signedAt: string;             // §11.50(b): ISO 8601 timestamp
  meaning: string;              // §11.50(c): "Performed By" | "Checked By" | "Verified By" | "Acknowledged By" | "Cleared By"
  recordType: string;           // 'alarm' | 'checklist'
  recordId: string;             // FK to Alarm.id or ChecklistReview.id
  recordHash: string;           // §11.70: SHA-256 of record content at signing time
  signatureHash: string;        // §11.70: SHA-256(recordHash + signerUserId + signedAt)
  reAuthVerified: boolean;
  reAuthMethod: 'password';     // §11.200: Two-component auth
  signatureImage?: string;      // Optional canvas signature
}
```

### 3.4 Data Routing Rules

| Data Type | Storage | Why |
|-----------|---------|-----|
| Telemetry (sensor readings) | TimescaleDB `ts_telemetry` + PG `LatestTelemetry` cache | High-volume, time-series, machine-generated |
| Attribute history | TimescaleDB `ts_attributes` | Time-series change log |
| Checklist submitted answers | TimescaleDB `ts_checklist_responses` | Immutable submission record |
| Checklist review workflow | PostgreSQL `ChecklistReview` | Lifecycle object, audited |
| Alarms | PostgreSQL `Alarm` | Lifecycle object, audited |
| Electronic signatures | PostgreSQL `ElectronicSignature` | FK to alarm/checklist records |
| Device events | TimescaleDB `ts_device_events` | Time-series, machine-generated |
| Binary metadata | TimescaleDB `ts_binary_data` | Time-series, machine-generated |
| Pipeline debug traces | TimescaleDB `ts_pipeline_traces` | Debug, auto-purge after TTL |
| Binary blobs | File store `uploads/data/{entity_id}/` | Large files |
| Audit trail | PostgreSQL `AuditTrail` (existing) | SHA-256 chained compliance log |
| Rule chains | PostgreSQL `RuleChain` + `RuleChainVersion` | Config with version history |
| Everything else | PostgreSQL (existing models) | Relational data |

### 3.5 Audit Scope

| Action | Audited? | Reason |
|--------|----------|--------|
| Attribute changes | **Yes** | Human or system-initiated config change |
| Alarm created | **Yes** | Compliance-critical event |
| Alarm acknowledged | **Yes** | Human action on compliance record |
| Alarm cleared | **Yes** | State transition on compliance record |
| Checklist submitted | **Yes** | Human action on compliance record |
| Checklist reviewed/approved/rejected | **Yes** | Workflow step on compliance record |
| Deviation created/resolved | **Yes** | Already in existing system |
| Report generated | **Yes** | Already in existing system |
| Rule chain created/updated/deleted | **Yes** | Configuration change affecting data processing |
| UNS path overridden | **Yes** | Configuration change |
| Help article edited | **Yes** | Documentation change |
| Device credential regenerated | **Yes** | Security action |
| Telemetry received | **No** | Machine-generated, immutable in TimescaleDB |
| Device connect/disconnect | **No** | Operational, not compliance |
| Binary uploads | **No** | Machine-generated data |

---

## 4. Unified Namespace (UNS) Integration

### 4.1 Topic Structure (ISA-95 Aligned)

**Format:**
```
digilog/v1/{enterprise}/{site}/{area}/{line}/{cell}/{entity_name}/{data_category}
```

**Data categories — Device PUBLISH (device → server):**
```
/telemetry        — Real-time sensor data
/attributes       — Client-side attribute updates
/events           — Device lifecycle events
/rpc/response     — RPC responses FROM the device
/binary/image     — Image data references
/binary/audio     — Audio data references
/binary/vibration — Vibration raw data references
```

**Data categories — Device SUBSCRIBE (server → device):**
```
/rpc/request         — RPC commands FROM the server TO the device
/attributes/shared   — Shared attribute updates pushed by server
/config              — Configuration updates pushed by server
/ota                 — OTA firmware update notifications
```

**Data categories — Server-only (internal events):**
```
/alarms           — Alarm state changes (published by rule engine)
/checklist        — Checklist submission confirmations
```

### 4.2a MQTT ACL (Access Control)

Enforced via EMQX HTTP ACL callback (`/api/internal/mqtt/acl`):

**Device ACL (per entity credential):**

| Direction | Topic Pattern | Allowed? |
|-----------|--------------|----------|
| PUBLISH | `digilog/v1/.../OwnEntityName/telemetry` | ✅ |
| PUBLISH | `digilog/v1/.../OwnEntityName/attributes` | ✅ |
| PUBLISH | `digilog/v1/.../OwnEntityName/events` | ✅ |
| PUBLISH | `digilog/v1/.../OwnEntityName/rpc/response` | ✅ |
| PUBLISH | `digilog/v1/.../OwnEntityName/binary/#` | ✅ |
| SUBSCRIBE | `digilog/v1/.../OwnEntityName/rpc/request` | ✅ |
| SUBSCRIBE | `digilog/v1/.../OwnEntityName/attributes/shared` | ✅ |
| SUBSCRIBE | `digilog/v1/.../OwnEntityName/config` | ✅ |
| SUBSCRIBE | `digilog/v1/.../OwnEntityName/ota` | ✅ |
| ANY | `digilog/v1/.../OtherEntity/#` | ❌ DENIED |
| ANY | `$SYS/#` | ❌ DENIED |

**Server/API ACL (internal MQTT client):**

| Direction | Topic Pattern | Purpose |
|-----------|--------------|---------|
| SUBSCRIBE | `digilog/v1/#` | Receive all device data for rule chain processing |
| PUBLISH | `digilog/v1/.../AnyEntity/rpc/request` | Send RPC commands to devices |
| PUBLISH | `digilog/v1/.../AnyEntity/attributes/shared` | Push shared attribute updates |
| PUBLISH | `digilog/v1/.../AnyEntity/config` | Push configuration changes |
| PUBLISH | `digilog/v1/.../AnyEntity/ota` | Push OTA notifications |
| PUBLISH | `digilog/v1/.../AnyEntity/alarms` | Publish alarm state for subscribers |

**ACL validation logic:**
```
1. Extract entity_id from DeviceCredential (via access token)
2. Look up entity's UNS path from UnsMapping
3. Verify requested topic starts with entity's UNS path
4. Verify data_category suffix matches allowed PUBLISH or SUBSCRIBE set
5. Deny all cross-entity access
```

### 4.2b Server → Device Communication

**RPC (Remote Procedure Call):**
```
User/API → POST /api/data/rpc {entityId, method, params}
  → Server publishes to: digilog/v1/.../EntityName/rpc/request
  → Message: {"requestId": "uuid", "method": "setConfig", "params": {...}}
  → Device (subscribed) receives command
  → Device executes, publishes to: digilog/v1/.../EntityName/rpc/response
  → Message: {"requestId": "uuid", "result": {...}}
  → Server receives, stores in RPC response cache, notifies caller
```

**Shared Attribute Push:**
```
Admin updates shared attribute via UI/API
  → Server publishes to: digilog/v1/.../EntityName/attributes/shared
  → Message: {"firmware_version": "2.1.0", "config_interval": 30}
  → Device (subscribed) receives and applies
```

**Configuration Push:**
```
Template config change or entity-specific override
  → Server publishes to: digilog/v1/.../EntityName/config
  → Message: {"reportingInterval": 10, "thresholds": {"temp": 80}}
  → Device applies new configuration
```

### 4.2c MQTT QoS Policy

| Topic Category | QoS Level | Rationale |
|---------------|-----------|-----------|
| `/telemetry` | QoS 0 (at most once) | High volume, occasional loss acceptable, TimescaleDB aggregates compensate |
| `/attributes` | QoS 1 (at least once) | Must not lose attribute changes, dedup by key+timestamp |
| `/events` | QoS 1 (at least once) | Connection events important for diagnostics |
| `/rpc/request` | QoS 1 (at least once) | Commands must reach device |
| `/rpc/response` | QoS 1 (at least once) | Responses must reach server |
| `/attributes/shared` | QoS 1 (at least once) | Config changes must reach device |
| `/config` | QoS 1 (at least once) | Config changes must reach device |
| `/ota` | QoS 1 (at least once) | OTA notifications must reach device |
| `/alarms` | QoS 1 (at least once) | Alarm state changes must not be lost |
| `/binary/*` | QoS 1 (at least once) | Binary metadata must not be lost |

### 4.2 UNS Path Auto-Generation

When an entity instance is created or moved:
1. Walks parent chain to build path segments
2. Maps template category to ISA-95 level (configurable in System Config)
3. Creates/updates `UnsMapping` record
4. Subscribes MQTT broker to entity topic pattern
5. Updates child entity paths recursively

**Category → ISA-95 Level Mapping:**

| Template Category | ISA-95 Level |
|-------------------|-------------|
| Enterprise | `{enterprise}` |
| Site / Plant / Factory | `{site}` |
| Building / Area / Department | `{area}` |
| Production Line / Assembly Line | `{line}` |
| Work Cell / Station / Room | `{cell}` |
| Equipment / Sensor / Device | `{entity_name}` |

### 4.3 Entity Move — Cascade Handling

When an entity with children is moved to a different parent:

1. **Impact analysis** — system calculates affected entity count, affected device count (entities with active `DeviceCredential`), and affected UNS paths
2. **Confirmation prompt** — UI displays: number of entities affected, number of connected devices that will need reconfiguration, list of topic path changes (old → new)
3. **Before/after report** — system generates a downloadable CSV/PDF mapping old UNS paths to new UNS paths, so operators can reconfigure device firmware
4. **Execution** — on confirmation, cascade runs as a background job with progress indicator
5. **Notification** — affected device owners notified of topic path changes

### 4.4 Wildcard Subscriptions

| Pattern | Meaning |
|---------|---------|
| `+` (single level) | Any one level |
| `#` (multi level) | All remaining levels |

### 4.5 UNS Configuration UI

Config → UNS Mapping page for admins. UNS path overrides require reauth and generate audit trail entries.

---

## 5. Transport & Protocol Layer

### 5.1 MQTT Broker (Primary Protocol)

**Technology:** EMQX — external broker running as a separate Docker container.

**Why EMQX over Mosquitto:** EMQX is built in Erlang/OTP with native clustering, high availability, and horizontal scalability. Mosquitto is single-threaded with no built-in clustering — if the node dies, every device disconnects. EMQX supports 100M+ concurrent connections, has a built-in management dashboard, native HTTP auth/ACL callbacks, Prometheus/Grafana integration, and PostgreSQL auth backend support. BSL license permits all uses except offering competing MQTT-as-a-service (DigiLog is a logbook, not an MQTT service).

**Why external:** Decoupled from the API process. If the API restarts, devices stay connected and messages queue. Supports clustering for future multi-site scaling. Battle-tested in production IIoT deployments.

**Docker Compose:** See Section 21.2 for the complete EMQX service definition with HTTP auth/ACL backend configuration pointing to DigiLog's API callbacks.

**Authentication:** EMQX HTTP auth backend that validates tokens against DigiLog's `DeviceCredential` table via HTTP callback to the API:
```
POST /api/internal/mqtt/auth     — Validate username (access token) → 200 allow / 401 deny
POST /api/internal/mqtt/acl      — Validate topic + action against UnsMapping + ACL rules → 200 allow / 403 deny
POST /api/internal/mqtt/superuser — Always returns 403 (no superuser access)
```

**Topic ACL:** Devices can only publish to their own UNS path publish topics and subscribe to their own UNS path subscribe topics. Cross-entity access is denied. See Section 4.2a for full ACL specification.

**TLS Configuration:**
```
Port 1883: Plain MQTT (internal network / development only)
Port 8883: MQTT over TLS (production — devices MUST use this)
Port 8083: MQTT over WebSocket (internal network / development only)
Port 8084: MQTT over WSS (production — browser dashboards MUST use this)
```

TLS certificates managed via EMQX configuration volume. In production, all device connections MUST use TLS (port 8883). Plain MQTT (1883) should be disabled or firewalled in production deployments.

**MQTT Last Will and Testament (LWT):**

Devices SHOULD set an LWT when connecting to EMQX for accurate offline detection:
```
Will Topic:  digilog/v1/.../EntityName/events
Will Payload: {"event": "DISCONNECTED", "reason": "unexpected", "ts": "<broker_timestamp>"}
Will QoS:   1
Will Retain: false
```

On unexpected disconnect, EMQX publishes the LWT message automatically. The server's MQTT handler processes it as a `DEVICE_EVENT` → inserts into `ts_device_events` → updates `ConnectivityStatus` to OFFLINE immediately. Without LWT, offline detection relies solely on inactivity timeout (could be 60+ seconds of stale "Online" status).

**EMQX Persistent Sessions:**

| Client Type | Clean Session | Rationale |
|------------|---------------|-----------|
| Devices (sensors) | `true` (clean) | Devices send data, they don't need missed messages queued. Stale queued data on reconnect causes burst processing. |
| Devices (actuators receiving RPC) | `false` (persistent) | Commands sent while offline MUST be delivered on reconnect. Session expiry: 1 hour (configurable via `EMQX_SESSION__EXPIRY_INTERVAL`). |
| Server MQTT client | `false` (persistent) | If API restarts, EMQX queues device messages. On reconnect, queued messages are delivered. Prevents data loss during deploys. Session expiry: 5 minutes. |

**MQTT Max Payload Size:**
```
EMQX_MQTT__MAX_PACKET_SIZE: 1048576   # 1 MB (default). Rejects messages exceeding this.
```

For binary data, devices use the HTTP multipart endpoint (POST `/api/data/binary`) which has type-specific limits (images: 10MB, audio: 50MB, vibration: 100MB). MQTT is NOT used for large binary transfers.

**EMQX Degradation Mode:**

If EMQX is unavailable (broker down, network partition):
- HTTP data endpoints continue to function normally (devices can POST telemetry via REST)
- WebSocket subscriptions for dashboards fail with reconnect retry
- Readiness check (`/api/health/ready`) returns 503 (signals load balancer to stop routing until recovery)
- MQTT-connected devices buffer locally (device firmware responsibility) and resend on reconnect
- No data is lost from HTTP-connected devices; MQTT device data loss depends on device-side buffering

**Configuration:**
```env
MQTT_ENABLED=true
MQTT_BROKER_HOST=emqx
MQTT_BROKER_PORT=1883
MQTT_BROKER_TLS_PORT=8883
MQTT_BROKER_WS_PORT=8083
MQTT_BROKER_WSS_PORT=8084
MQTT_AUTH_CALLBACK_URL=http://api:3000/api/internal/mqtt
EMQX_ADMIN_PASSWORD=<secret>
```

EMQX Dashboard is exposed on port 18083 (mapped in Docker Compose) but not configurable via env var — it's an EMQX-internal default.

**Redis Degradation Mode (HARD DEPENDENCY):**

Redis is a harder dependency than EMQX. If Redis goes down:
- All BullMQ workers stop processing (ingestion, notification, export, maintenance)
- No new ingestion jobs can be enqueued — telemetry from MQTT and HTTP is rejected with 503
- WebSocket event broadcasting stops (Redis pub/sub is the broadcast channel)
- The API itself stays alive (HTTP health check returns 503 for readiness, 200 for liveness)
- MQTT-connected devices stay connected to EMQX but their messages cannot be processed

**Mitigation:** Redis must be monitored with the same priority as the database. Use `redis-server --appendonly yes` for persistence across restarts. In production, consider Redis Sentinel or Redis Cluster for high availability. The readiness check (`/api/health/ready`) verifies Redis connectivity and returns 503 if unreachable.

### 5.2 HTTP API (REST Ingestion)

Extends the existing Fastify API with data ingestion endpoints. Devices POST data with the entity access token in the Authorization header.

### 5.3 WebSocket (Real-time Bidirectional)

**Technology:** Fastify WebSocket plugin (`@fastify/websocket`).

For browser dashboards and applications needing live data streams:
```javascript
ws.send(JSON.stringify({
  type: 'SUBSCRIBE',
  entityId: 'uuid-of-entity',
  keys: ['temperature', 'humidity'],
  unsPath: 'digilog/v1/Acme/PlantA/+/+/+/telemetry'
}));
```

### 5.4 Message Envelope (Unified Format)

All protocols normalize incoming data into a common envelope:

```typescript
interface IngestionMessage {
  messageId: string;                // UUID v7 (time-sortable)
  timestamp: string;                // ISO 8601
  protocol: 'mqtt' | 'http' | 'websocket' | 'internal';
  entityId: string;
  entityName: string;
  templateId: string;
  unsPath: string;
  credentialId: string;             // DeviceCredential ID (not raw token)
  sourceIp: string;
  messageType: 'POST_TELEMETRY' | 'POST_ATTRIBUTES' | 'POST_CHECKLIST'
             | 'POST_BINARY' | 'DEVICE_EVENT' | 'RPC_REQUEST' | 'RPC_RESPONSE'
             | 'ALARM' | 'CONNECTIVITY_EVENT';
  data: Record<string, unknown>;
  metadata: Record<string, string>;
  ruleChainId: string;
  traceId: string;
}
```

---

## 6. Data Ingestion Pipeline

### 6.1 Pipeline Stages

```
Device/Gateway → Protocol Adapter → Authentication → Device Validation
     → Entity Resolution → UNS Path Validation → Message Normalization
     → Rule Chain Router → Rule Chain Execution → Data Persistence
     → Audit Trail (if applicable) → Event Emission
```

**Stage 1: Protocol Adapter**
- Receives raw bytes from MQTT/HTTP/WebSocket
- Validates protocol-specific headers and payload format
- Extracts access token

**Stage 2: Authentication**
- Looks up access token in `DeviceCredential` table
- Validates token is active
- Validates token has been activated (first-use activation check)
- Returns associated entity ID

**Stage 3: Device Validation**
- Validates source IP against `DeviceCredential.allowedIps` (if configured)
- Checks per-device rate limit against `DeviceCredential.maxDataRatePerMin`
- Logs IP_MISMATCH or RATE_LIMITED events to `ts_device_events` on violation
- Updates `ConnectivityStatus` (last seen, protocol, IP)

**Stage 4: Entity Resolution**
- Fetches entity instance, template, and UNS mapping
- Validates entity is active
- Reads `transportConfig` from template

**Stage 5: UNS Path Validation**
- Validates published topic matches entity's UNS path
- For HTTP, auto-constructs UNS path from entity lookup

**Stage 6: Message Normalization**
- Transforms raw payload into unified `IngestionMessage` envelope
- Validates data types against template's `telemetrySchema` / `attributeSchema`
- **Client timestamp validation:** If device provides `ts` field, server validates it falls within ±24 hours of server time. Timestamps outside this window are replaced with server time and a `TIMESTAMP_CORRECTED` event is logged to `ts_device_events`. This prevents devices with misconfigured clocks from inserting data with wildly incorrect timestamps while still allowing reasonable clock drift and batch uploads.

**Stage 7: Rule Chain Router**
- Priority: Entity-specific override > Template `defaultRuleChainId` > System default

**Stage 8: Rule Chain Execution**
- Processes through assigned rule chain nodes
- Debug events recorded per node when debug mode enabled

**Stage 9: Data Persistence**
- Save Telemetry → `ts_telemetry` (TimescaleDB) + conditional UPSERT `LatestTelemetry` (PostgreSQL cache — only if incoming timestamp > existing `lastUpdated`, prevents stale overwrites from out-of-order or batch messages)
- Save Attributes → `ts_attributes` (TimescaleDB) + update entity attributes (PostgreSQL)
- Save Checklist → `ts_checklist_responses` (TimescaleDB) + INSERT `ChecklistReview` (PostgreSQL)
- Create Alarm → INSERT `Alarm` (PostgreSQL)
- Save Binary → file store + `ts_binary_data` (TimescaleDB)

**Stage 10: Audit Trail (compliance-critical actions only)**

| Action | Audit Entry |
|--------|-------------|
| Save Attributes | `DATA_ATTRIBUTES_UPDATED`: `"Updated {count} attributes for {entityName}: {keys}"` |
| Create Alarm | `ALARM_CREATED`: `"Alarm {alarmType} ({severity}) for {entityName}"` |
| Save Checklist | `DATA_CHECKLIST_SUBMITTED`: `"Checklist submitted for {entityName} by {submittedBy}"` |
| Save Telemetry | **Not audited** — immutable in TimescaleDB |
| Save Binary | **Not audited** — immutable in TimescaleDB |
| Device Events | **Not audited** — operational |

**Stage 11: Event Emission**
- Publishes to WebSocket subscribers
- Emits MQTT retained messages for latest values
- Triggers notification system for alarms
- Updates continuous aggregates

### 6.2 Pipeline Error Handling

**Every pipeline stage can fail.** Error handling is critical — lost or corrupt data in a regulated environment creates compliance risk.

**Error routing per stage:**

| Stage | Error Type | Action |
|-------|-----------|--------|
| Protocol Adapter | Malformed payload | Reject with 400. Log to `ts_device_events` (EVENT_TYPE: `PARSE_ERROR`). |
| Authentication | Invalid/expired token | Reject with 401. Log to `ts_device_events` (EVENT_TYPE: `AUTH_FAILED`). |
| Device Validation | IP mismatch, rate limit | Reject with 403/429. Log warning event. Continue for IP warnings if `device.ip_validation_enabled` is set to warn mode. |
| Entity Resolution | Entity not found/inactive | Reject with 404. Log error event. |
| UNS Path Validation | Topic mismatch | Reject with 403. Log error event. |
| Message Normalization | Schema validation failure | Reject with 422. Log to `ts_device_events` (EVENT_TYPE: `VALIDATION_ERROR`, details include failing keys). |
| Rule Chain Execution | Script timeout/error | Route to **Failure** output. If no Failure handler: log error, persist raw data via default Save node (data is never silently dropped). |
| Data Persistence | TSDB write failure | **Retry** 3 times with exponential backoff (100ms, 500ms, 2s). On final failure: write to **Dead Letter Queue**. |
| Audit Trail | Audit write failure | **CRITICAL** — halt the transaction. Compliance data without audit trail is non-compliant. Retry 3 times, then fail the entire operation and return 500. |

**Dead Letter Queue (DLQ):**

```sql
-- PostgreSQL table for failed messages
CREATE TABLE dead_letter_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      TEXT NOT NULL,
    entity_id       UUID,
    message_type    TEXT NOT NULL,
    payload         JSONB NOT NULL,
    error_message   TEXT NOT NULL,
    error_stage     TEXT NOT NULL,      -- Which pipeline stage failed
    retry_count     INT DEFAULT 0,
    max_retries     INT DEFAULT 3,
    status          TEXT DEFAULT 'PENDING',  -- PENDING | RETRYING | RESOLVED | DEAD
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_retry_at   TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT
);
```

**DLQ Management:**
- SUPER_ADMIN can view DLQ via System Config → Dead Letter Queue
- Actions: Retry (reprocesses through pipeline), Resolve (marks as handled with reason), Purge (remove resolved items older than 30 days)
- Alarm: If DLQ depth exceeds configurable threshold (default: 100), system creates CRITICAL alarm
- DLQ is NOT audited (operational, not compliance)

### 6.3 Pipeline Debug Trace

A per-message trace that tracks every ingestion message through all pipeline stages, showing a visual progress bar in the UI. This allows SUPER_ADMIN and ADMIN users to diagnose whether a problem is on the IoT device side (authentication, payload format, schema mismatch) or in the rule chain (script error, timeout, incorrect wiring).

#### Enabling Trace Mode

Trace mode is configurable at three levels:

| Level | Setting | Effect |
|-------|---------|--------|
| **Global** | System Config: `pipeline.trace_enabled` (default: `false`) | Traces ALL messages from ALL entities. High overhead — use only for system-wide debugging. |
| **Per-Entity** | Entity detail page → Debug tab → "Enable Pipeline Trace" toggle | Traces messages from one specific entity. Recommended for targeted debugging. |
| **Per-Template** | Template detail page → Debug tab → "Enable Pipeline Trace" toggle | Traces messages from ALL entities of this template type. Useful when debugging a device model. |

When trace is enabled, every message passing through the pipeline creates a `PipelineTrace` record.

#### PipelineTrace Schema

```sql
-- TimescaleDB: auto-purged, append-only
CREATE TABLE ts_pipeline_traces (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    time            TIMESTAMPTZ NOT NULL,
    message_id      TEXT NOT NULL,           -- Unique ID assigned at Stage 1
    entity_id       UUID,                    -- NULL if auth fails before entity resolution
    entity_name     TEXT,
    transport       TEXT NOT NULL,            -- MQTT | HTTP | WebSocket
    message_type    TEXT NOT NULL,            -- TELEMETRY | ATTRIBUTES | RPC | CHECKLIST | BINARY | EVENT
    payload_size    INTEGER,                  -- Bytes
    
    -- All stages in a single JSONB array (compact, good compression)
    stages          JSONB NOT NULL,          -- Array of StageResult objects, indexed 0-10 for stages 1-11
    
    -- Summary
    final_status    TEXT NOT NULL,            -- SUCCESS | SUCCESS_WITH_WARNINGS | FAILED | DLQ
    failed_stage    TEXT,                     -- e.g., "STAGE_6_NORMALIZE" (only if FAILED)
    error_code      TEXT,                     -- Standardized error code (only if FAILED)
    error_message   TEXT,                     -- Human-readable error (only if FAILED)
    warnings        JSONB,                   -- Array of warning strings (only if SUCCESS_WITH_WARNINGS)
    total_duration_ms INTEGER NOT NULL,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

SELECT create_hypertable('ts_pipeline_traces', 'time');
```

**Why single JSONB array instead of 11 columns:** Traces are short-lived debug data (auto-purged after TTL). A single `stages` array compresses better, produces narrower rows, and simplifies schema evolution if stages are added/removed. Querying a specific stage uses `stages->6->>'status'` (zero-indexed) which is fast enough for debug queries that always filter by entity_id + time range first.

**Each stage object in the array:**
```typescript
interface StageResult {
  stage: number;               // 1-11
  name: string;                // "Protocol Adapter", "Authentication", etc.
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  errorCode?: string;          // Only if FAILED
  errorMessage?: string;       // Only if FAILED
  warnings?: string[];         // Non-fatal issues (e.g., timestamp corrected, emit partial failure)
  details?: Record<string, any>;  // Stage-specific debug info
}
```

**Final status logic:**
- All stages SUCCESS, no warnings → `SUCCESS`
- All stages SUCCESS, but one or more stages have warnings → `SUCCESS_WITH_WARNINGS`
- Any stage FAILED → `FAILED` (pipeline stops, remaining stages are `SKIPPED`)
- FAILED and routed to DLQ → `DLQ`

**What produces warnings (not failures):**
- Stage 6: Client timestamp corrected (data still saved with server time) — `WARN_TIMESTAMP_CORRECTED`
- Stage 11: WebSocket broadcast failed but data is already persisted — `WARN_EMIT_WS_FAILED`
- Stage 11: MQTT retained publish failed but data is already persisted — `WARN_EMIT_MQTT_FAILED`

#### Stage-Specific Details & Error Codes

| Stage | On Success `details` | Error Code | Error Description |
|-------|---------------------|-----------|-------------------|
| 1. Protocol Adapter | `{protocol: "MQTT", topic: "digilog/v1/...", payloadBytes: 245}` | `ERR_PROTO_MALFORMED` | Cannot parse payload (invalid JSON, corrupt binary) |
| | | `ERR_PROTO_EMPTY` | Empty payload body |
| | | `ERR_PROTO_ENCODING` | Unsupported content encoding |
| 2. Authentication | `{credentialType: "ACCESS_TOKEN", entityId: "..."}` | `ERR_AUTH_TOKEN_MISSING` | No access token provided |
| | | `ERR_AUTH_TOKEN_INVALID` | Token not found in database |
| | | `ERR_AUTH_TOKEN_EXPIRED` | Token has been revoked |
| | | `ERR_AUTH_NOT_ACTIVATED` | Token exists but never activated |
| 3. Device Validation | `{ip: "192.168.1.50", rateUsed: 42, rateLimit: 600}` | `ERR_VAL_IP_DENIED` | Source IP not in allowlist |
| | | `ERR_VAL_RATE_LIMITED` | Rate limit exceeded (shows current/max) |
| 4. Entity Resolution | `{entityName: "Reactor-001", templateName: "BioReactor-v2"}` | `ERR_ENTITY_NOT_FOUND` | Entity ID doesn't exist |
| | | `ERR_ENTITY_INACTIVE` | Entity is deactivated |
| | | `ERR_ENTITY_NO_TEMPLATE` | Entity has no template assigned |
| 5. UNS Path | `{expectedPath: "digilog/v1/.../Reactor-001", actualTopic: "..."}` | `ERR_UNS_MISMATCH` | Published topic doesn't match entity's UNS path |
| 6. Normalization | `{keysProcessed: 3, timestampSource: "client", corrected: false}` | `ERR_NORM_SCHEMA` | Payload keys don't match template schema (details list failing keys) |
| | | `ERR_NORM_TYPE` | Value type mismatch (e.g., string sent for numeric key) |
| | | `ERR_NORM_RANGE` | Value outside min/max bounds |
| | | `ERR_NORM_RESOLUTION` | Float value exceeds resolution constraint |
| | | ⚠️ `WARN_TIMESTAMP_CORRECTED` | Client timestamp outside ±drift tolerance (corrected to server time, stage still SUCCESS) |
| 7. Rule Chain Router | `{ruleChainId: "...", ruleChainName: "BioReactor Processing", source: "template"}` | `ERR_CHAIN_NOT_FOUND` | No rule chain assigned (entity, template, or system default) |
| | | `ERR_CHAIN_INACTIVE` | Assigned rule chain is disabled |
| 8. Rule Chain Exec | `{nodesExecuted: 5, path: ["Filter→Transform→Save"], alarmsCreated: 0}` | `ERR_CHAIN_TIMEOUT` | Script execution exceeded timeout |
| | | `ERR_CHAIN_SCRIPT` | JavaScript runtime error (includes line number + message) |
| | | `ERR_CHAIN_MEMORY` | Script exceeded memory limit |
| | | `ERR_CHAIN_DEPTH` | Recursive rule chain depth exceeded |
| | | `ERR_CHAIN_NODE` | Node-level failure (details include nodeId + nodeType) |
| 9. Data Persistence | `{table: "ts_telemetry", rowsWritten: 3, batchId: "..."}` | `ERR_PERSIST_TSDB` | TimescaleDB write failed after retries |
| | | `ERR_PERSIST_PG` | PostgreSQL write failed (LatestTelemetry, Alarm, etc.) |
| | | `ERR_PERSIST_FILE` | File store write failed (binary upload) |
| 10. Audit Trail | `{action: "ALARM_CREATED", auditId: "..."}` | `ERR_AUDIT_WRITE` | Audit trail write failed (CRITICAL — entire operation fails) |
| | (or `{skipped: true, reason: "telemetry — not auditable"}`) | | |
| 11. Event Emission | `{wsSubscribers: 3, mqttRetained: true, notificationsQueued: 1}` | ⚠️ `WARN_EMIT_WS_FAILED` | WebSocket broadcast failed (data already persisted — non-fatal) |
| | | ⚠️ `WARN_EMIT_MQTT_FAILED` | MQTT retained message publish failed (data already persisted — non-fatal) |

**Warning vs Error:** Codes prefixed with `ERR_` cause the pipeline to halt and mark the trace as `FAILED`. Codes prefixed with `WARN_` are recorded in the stage's `warnings[]` array but the stage still shows `SUCCESS`. If any stage has warnings, `final_status` is `SUCCESS_WITH_WARNINGS` instead of `SUCCESS`. Data integrity is never compromised by warnings — they only indicate degraded real-time delivery.

#### Trace Lifecycle

```
Message arrives
  │
  ├── traceId generated (UUID)
  ├── startTime recorded
  │
  ├── Stage 1: Protocol ──→ {status: SUCCESS, durationMs: 1}
  ├── Stage 2: Auth ──→ {status: SUCCESS, durationMs: 3}
  ├── Stage 3: Validation ──→ {status: SUCCESS, durationMs: 2, details: {rateUsed: 42}}
  ├── Stage 4: Entity ──→ {status: SUCCESS, durationMs: 5}
  ├── Stage 5: UNS ──→ {status: SUCCESS, durationMs: 1}
  ├── Stage 6: Normalize ──→ {status: FAILED, durationMs: 4,
  │                            errorCode: "ERR_NORM_RANGE",
  │                            errorMessage: "Key 'temperature': value 999.9 exceeds max 150.0"}
  │
  ├── Stages 7-11: not reached (NULL)
  │
  └── Final: {status: FAILED, failedStage: "STAGE_6_NORMALIZE",
              errorCode: "ERR_NORM_RANGE", totalDurationMs: 16}
```

#### API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/debug/traces` | JWT (ADMIN+) | List traces with filters |
| GET | `/api/debug/traces/:traceId` | JWT (ADMIN+) | Single trace with all stage details |
| GET | `/api/debug/traces/entity/:entityId` | JWT (ADMIN+) | Traces for specific entity |
| PUT | `/api/debug/traces/entity/:entityId/toggle` | JWT (ADMIN+) | Enable/disable per-entity tracing |
| PUT | `/api/debug/traces/template/:templateId/toggle` | JWT (ADMIN+) | Enable/disable per-template tracing |
| GET | `/api/debug/traces/stats` | JWT (ADMIN+) | Aggregate stats: success rate, avg duration, top error codes |

**Query parameters for list endpoint:**
- `entityId` — filter by entity
- `status` — `SUCCESS`, `SUCCESS_WITH_WARNINGS`, `FAILED`, `DLQ`
- `errorCode` — filter by specific error code (e.g., `ERR_NORM_RANGE`)
- `failedStage` — filter by failed stage (e.g., `STAGE_8_RULECHAIN`)
- `from` / `to` — time range
- `transport` — `MQTT`, `HTTP`, `WebSocket`
- `page`, `pageSize` (default 50, max 200)

#### UI: Pipeline Trace View

**Location:** Entity Detail → Debug tab → "Pipeline Traces" panel. Also accessible from `/debug/traces` (ADMIN+ global view).

**Trace List View:**

Each row shows:
```
[●] 2026-02-25 14:23:01.456 | Reactor-001 | TELEMETRY | MQTT | ████████████░░░░ 9/11 | FAILED | ERR_CHAIN_TIMEOUT | 5,012ms
[✓] 2026-02-25 14:23:00.123 | Reactor-001 | TELEMETRY | MQTT | ████████████████ 11/11 | SUCCESS | — | 47ms
[✓] 2026-02-25 14:22:59.789 | Reactor-001 | ATTRIBUTES | HTTP | ████████████████ 11/11 | SUCCESS | — | 62ms
```

- `●` red dot = FAILED, `✓` green check = SUCCESS, `⚠` amber = SUCCESS_WITH_WARNINGS, `◌` yellow = DLQ
- Progress bar: filled segments = completed stages, color = green (success) / red (failed at that stage) / grey (not reached)
- Click row to expand full trace detail

**Trace Detail View (expanded row or dedicated page):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Message: abc-123-def    Entity: Reactor-001    Type: TELEMETRY │
│  Transport: MQTT         Payload: 245 bytes     Total: 5,012ms │
│                                                                  │
│  ██ 1. Protocol     ✓  1ms   MQTT topic parsed                  │
│  ██ 2. Auth         ✓  3ms   Token valid → entity e7f2...       │
│  ██ 3. Validation   ✓  2ms   IP OK, rate 42/600                 │
│  ██ 4. Entity       ✓  5ms   Reactor-001 (BioReactor-v2)        │
│  ██ 5. UNS Path     ✓  1ms   Path matched                       │
│  ██ 6. Normalize    ✓  4ms   3 keys, client timestamp OK        │
│  ██ 7. Router       ✓  2ms   → "BioReactor Processing" (template)│
│  ██ 8. Rule Chain   ✗  5,012ms  ERR_CHAIN_TIMEOUT               │
│  │   └─ Script execution exceeded timeout (5000ms)              │
│  │   └─ Last node: "Transform Script" (node_4f2a)               │
│  │   └─ [View Rule Chain Debug Events →]                        │
│  ░░ 9. Persist      —  not reached                               │
│  ░░ 10. Audit       —  not reached                               │
│  ░░ 11. Emit        —  not reached                               │
│                                                                  │
│  [View Raw Payload]  [View Normalized Message]  [Retry]          │
└─────────────────────────────────────────────────────────────────┘
```

- Green `██` = SUCCESS, Red `██` = FAILED, Grey `░░` = not reached
- Each completed stage shows duration and key detail
- Failed stage expands to show error code, message, and contextual link (e.g., link to rule chain debug events for Stage 8 failures)
- "View Raw Payload" shows the exact bytes received from the device
- "View Normalized Message" shows the `IngestionMessage` envelope after Stage 6
- "Retry" button (for DLQ items) resubmits the message through the pipeline

**Real-time streaming:** When viewing traces for an entity with tracing enabled, the UI subscribes via WebSocket to `ws:trace:{entityId}`. New traces appear at the top of the list in real time — useful for watching a device send data and immediately seeing if it passes or fails.

#### Trace Retention & Performance

- **Storage:** `ts_pipeline_traces` in TimescaleDB. Auto-compressed after 1 day. Auto-purged after configurable TTL (default 48h, requires restart to change — see Section 20.3).
- **System Config:** `pipeline.trace_ttl_hours` (default: 48, min: 1, max: 168, requires restart)
- **Performance impact:** When trace is enabled for an entity, each message has ~2-5ms additional overhead (JSON serialization of stage results + one TSDB INSERT). Negligible for per-entity debugging. Global trace mode on a high-volume system should only be used temporarily.
- **Ring buffer behavior:** If an entity generates more than 10,000 traces within the TTL window, the oldest traces are auto-purged to keep the per-entity trace count manageable.

**Known limitation — pre-authentication traces:** Per-entity and per-template trace cannot capture failures at Stage 1 (Protocol) or Stage 2 (Authentication), because the entity ID is not known until after authentication succeeds. A message that fails auth is associated with a raw access token, not an entity. Only **global trace** captures pre-auth failures. If a device's messages are failing at auth and per-entity trace is enabled, the user will see no traces for that entity. The UI should display a note: *"Per-entity trace does not capture authentication failures. Enable global trace to see all failures."*

#### Trace Stats Dashboard

The `/debug/traces/stats` endpoint and the top of the Debug page show aggregate metrics:

- **Success rate** (last 1h / 24h): percentage of messages that completed all 11 stages
- **Avg pipeline duration** (last 1h): total end-to-end time
- **Top 5 error codes** (last 24h): which errors are most frequent, with count
- **Failure heatmap by stage**: which stages fail most often (helps identify systemic issues — e.g., if Stage 6 fails frequently, the template schemas might be wrong; if Stage 8 fails frequently, rule chains need debugging)
- **Per-transport breakdown**: success/failure rate by MQTT vs HTTP vs WebSocket

### 6.4 WebSocket Authentication

WebSocket connections for real-time dashboard subscriptions require authentication:

```
1. Client connects: ws://host/api/ws
2. First message MUST be: {"type": "AUTH", "token": "<JWT>"}
3. Server validates JWT within 5 seconds
4. If valid: sends {"type": "AUTH_OK"}, connection proceeds
5. If invalid or timeout: server closes connection with code 4001
6. Subsequent messages: SUBSCRIBE, UNSUBSCRIBE
7. JWT expiry: server checks token expiry on each subscription. On expiry, sends {"type": "AUTH_EXPIRED"} and closes.
```

Token refresh: Client must reconnect with new JWT after expiry. No in-flight token refresh (WebSocket is short-lived for dashboard sessions).

### 6.5 Data Types Supported

| Data Type | Ingestion Format | Storage | Processing |
|-----------|-----------------|---------|------------|
| Numeric telemetry | `{"temperature": 72.5}` | `ts_telemetry.value_num` | Aggregation, alarms, FFT, trend |
| String telemetry | `{"status": "running"}` | `ts_telemetry.value_str` | Pattern matching, state machine |
| Boolean telemetry | `{"doorOpen": true}` | `ts_telemetry.value_bool` | State change detection |
| JSON telemetry | `{"gps": {"lat": 1, "lng": 2}}` | `ts_telemetry.value_json` | JSON path extraction |
| Vibration raw | Binary (multipart) | File store + `ts_binary_data` | FFT, RMS, peak analysis |
| Images | Binary (JPEG/PNG) | File store + `ts_binary_data` | Thumbnail gen, metadata |
| Audio | Binary (WAV/MP3) | File store + `ts_binary_data` | Duration, spectrum |

**Binary Upload Limits:**
| Type | Max File Size | Allowed MIME Types |
|------|--------------|-------------------|
| Image | 10 MB | image/jpeg, image/png, image/webp |
| Audio | 50 MB | audio/wav, audio/mpeg, audio/mp3 |
| Vibration raw | 100 MB | application/octet-stream, application/x-vibration |
| Document | 25 MB | application/pdf |

Configurable via System Config (`binary.max_image_size_mb`, `binary.max_audio_size_mb`, `binary.max_vibration_size_mb`). Rejections return 413 with descriptive error.
| Checklist answers | JSON array | `ts_checklist_responses` | Pass/fail scoring, approval |
| Attributes | `{"firmware": "2.1.0"}` | `ts_attributes` | Change detection |

### 6.6 Telemetry Payload Formats

**Simple key-value:**
```json
POST /api/data/telemetry
Authorization: Bearer <entity_access_token>

{"temperature": 72.5, "humidity": 45.2, "pressure": 1013.25}
```

**With client-side timestamp:**
```json
{"ts": 1709049600000, "values": {"temperature": 72.5, "humidity": 45.2}}
```

**Batch (multiple timestamps):**
```json
[
  {"ts": 1709049600000, "values": {"temperature": 72.5}},
  {"ts": 1709049601000, "values": {"temperature": 72.6}}
]
```

---

## 7. Rule Chain Engine

### 7.1 Access Control

Rule chain management is restricted to **SUPER_ADMIN only**. Rule chain pages are hidden from ADMIN and all roles below via RBAC. This is because rule chains are configured during factory setup or development, not during daily operations.

### 7.2 Core Concepts

| Concept | Description |
|---------|-------------|
| **Rule Chain** | A directed graph of rule nodes that processes messages |
| **Rule Node** | A single processing unit (filter, transform, action, etc.) |
| **Connection** | A labeled edge between two nodes (Success, Failure, True, False, custom) |
| **Message** | The `IngestionMessage` envelope flowing through the chain |
| **Debug Event** | A recorded snapshot of message state at a node (when debug enabled) |

### 7.3 Rule Node Types

#### 7.3.1 Input Nodes (3)

| Node | Description | Configuration |
|------|-------------|---------------|
| Message Type Switch | Routes messages by type | Output: one per message type |
| Entity Type Switch | Routes by template category | Output: one per category |
| Entity Type Filter | Passes only messages from specific templates | `templateIds: string[]` |

#### 7.3.2 Filter Nodes (4)

| Node | Description | Configuration |
|------|-------------|---------------|
| Script Filter | JavaScript returns true/false | `function filter(msg, metadata) { return msg.temperature > 80; }` |
| Check Key Exists | Passes if keys exist in payload | `keys: ['temperature', 'humidity']` |
| Check Relation | Passes if entity has relationship | `direction, relationType` |
| Time Window | Passes during time range | `from, to, timezone` |

#### 7.3.3 Enrichment Nodes (4)

| Node | Description | Configuration |
|------|-------------|---------------|
| Entity Attributes | Fetches entity attributes to metadata | `scope, keys` |
| Related Entity Data | Fetches data from related entities | `direction, relationType, scope, keys` |
| Originator Telemetry | Fetches recent telemetry | `keys, limit, orderBy` |
| Calculate Delta | Computes difference from previous value | `keys, addPeriod` |

#### 7.3.4 Transformation Nodes (4)

| Node | Description | Configuration |
|------|-------------|---------------|
| Script Transform | JavaScript transforms message | `function transform(msg, metadata) { ... }` |
| Rename Keys | Renames payload keys | `mappings: { oldKey: newKey }` |
| FFT Processor | FFT on vibration data | `sampleRate, windowSize, windowType` |
| Data Aggregator | Aggregates over time window | `keys, interval, function` |

#### 7.3.5 Action Nodes (9)

| Node | Description | Audit? |
|------|-------------|--------|
| Save Telemetry | Persists to `ts_telemetry` + `LatestTelemetry` | No |
| Save Attributes | Persists to `ts_attributes` + entity attributes | **Yes** |
| Save Checklist | Persists to `ts_checklist_responses` + `ChecklistReview` | **Yes** |
| Create Alarm | Creates `Alarm` in PostgreSQL | **Yes** |
| Clear Alarm | Updates `Alarm.cleared` in PostgreSQL | **Yes** |

**Alarm Deduplication:**
The Create Alarm node checks for existing active (non-cleared) alarms of the same `alarmType` for the same `entityId` before creating a new one:
- If active alarm exists with same type + entity: **suppress** (do not create duplicate). Optionally update `triggerDetails` with latest values and log a debug event.
- If no active alarm of that type: create new alarm.
- Configuration per Create Alarm node: `deduplication: true` (default), `updateOnDuplicate: true` (updates triggerDetails on suppress).
- This prevents alarm storms when a sensor continuously reports values above threshold.

**Alarm Severity Escalation:**
If an active alarm exists but incoming severity is higher (e.g., existing WARNING, incoming CRITICAL), the existing alarm is escalated:
- Update severity to higher level
- Log `ALARM_ESCALATED` audit entry
- Re-trigger notification with new severity
| Create Notification | Sends via notification system | No |
| Log | Writes to system log | No |
| RPC Call Request | Sends RPC to device | No |
| Delay | Delays message processing | No |

#### 7.3.6 External Nodes (3)

| Node | Description |
|------|-------------|
| REST API Call | Calls external HTTP endpoint |
| Send Email | Sends email via SMTP |
| MQTT Publish | Publishes to external MQTT topic |

#### 7.3.7 Flow Nodes (3)

| Node | Description |
|------|-------------|
| Rule Chain Switch | Forwards to another rule chain |
| Checkpoint | Marks successful processing point |
| Acknowledge | Acknowledges message for QoS |

**Rule Chain Recursion Limit:** Rule Chain Switch can forward messages to other chains, which could forward back creating infinite loops. The engine enforces a maximum chain depth (default: 10, configurable via System Config `rule_engine.max_chain_depth`). If depth is exceeded, message is routed to Failure output with error `"Maximum rule chain depth exceeded"` and logged as a debug event.

### 7.4 Debug Mode

Per-node debug toggle — each node has a "Debug" checkbox:

```typescript
interface DebugEvent {
  id: string;
  ruleChainId: string;
  ruleNodeId: string;
  timestamp: string;
  messageType: string;
  entityId: string;
  dataIn: object;
  dataOut: object;
  metadataIn: object;
  metadataOut: object;
  relation: string;
  error?: string;
  processingTimeMs: number;
}
```

- Ring buffer: last 100 events per node (configurable)
- Auto-purge after 24h TTL
- Debug button (bug icon) on every node in visual editor, glows orange when active

### 7.5 Script Sandbox

JavaScript scripts execute in isolated environment (`isolated-vm`):

**Available:**
```javascript
msg, metadata, msgType
JSON.parse(), JSON.stringify(), Math.*, Date, Date.now()
parseInt(), parseFloat(), String(), Number(), Boolean()
Array.isArray(), Object.keys(), Object.values(), Object.entries()

// Read-only DigiLog API (async)
await fetchEntityAttributes(entityId, scope, keys)
await fetchRelatedEntities(entityId, direction, relationType)
await fetchLatestTelemetry(entityId, keys)
await getEntityDetails(entityId)
```

**NOT available:**
```
require(), import, fetch, process, fs, child_process, eval
createAlarm(), clearAlarm(), sendNotification() — use dedicated action nodes
```

**Limits:** 5s timeout, 16MB memory, single-threaded.

Cross-entity data access in scripts is intentional and acceptable since only SUPER_ADMIN writes scripts.

### 7.6 Default Rule Chain

Auto-provisioned for every new entity template:

```
┌─────────────────┐
│   Input Node    │
│ (Message Type   │
│   Switch)       │
└──┬──┬──┬──┬──┬──┘
   │  │  │  │  │
   │  │  │  │  └── Device Event ──→ [Save Device Event] ──→ [Update Connectivity]
   │  │  │  │
   │  │  │  └───── Alarm ──→ [Create Notification] ──→ [Save Alarm]
   │  │  │
   │  │  └──────── Post Attributes ──→ [Save Attributes]
   │  │
   │  └─────────── Post Checklist ──→ [Validate Required Fields] ──→ [Save Checklist]
   │
   └────────────── Post Telemetry ──→ [Check Alarm Rules] ──┬── True ──→ [Create Alarm]
                                                             │
                                                             └── False ─→ [Save Telemetry]
```

### 7.7 Rule Chain Version Control

Every save creates an immutable version snapshot for rollback:

- `RuleChainVersion` stores: version number, complete JSON snapshot, who saved, change notes
- Versions transition: `ACTIVE` → `SUPERSEDED` on new save
- SUPER_ADMIN can roll back to any previous version
- Audit trail captures every change with before/after diff

### 7.8 Visual Editor

**Technology:** React Flow (`reactflow` npm package, pinned to v11.x).

**Features:**
- Drag nodes from categorized sidebar palette
- Connect nodes by dragging from output to input port
- Double-click node to open configuration panel
- Connection labels on edges
- Debug button per node
- Events panel slides open on debug click
- Save/load/import/export rule chain JSON
- Undo/redo
- Minimap, zoom/pan, node search/filter
- Test message input dialog

---

## 8. Connectivity Testing & Diagnostics

### 8.1 Connectivity Status Display

| Status | Icon | Color | Meaning |
|--------|------|-------|---------|
| Online | ● | Green | Last message within inactivity threshold |
| Offline | ○ | Red | No message beyond inactivity threshold |
| Unknown | ◌ | Gray | Never connected or no data ingestion enabled |

Indicator appears: entity tree, detail panel header, list view column.

### 8.2 Device Identity Validation

| Field | Purpose |
|-------|---------|
| `allowedIps` | IP allowlist (empty = any IP). Rejects from unlisted IPs |
| `deviceFingerprint` | Optional hardware identifier |
| `maxDataRatePerMin` | Per-device rate limit (default 600). Returns 429 on excess |

Warning events written to `ts_device_events` on IP mismatch or rate limit.

### 8.3 Token Lifecycle

Tokens created via auto-provisioning are **inactive until first use**:

```
Template: autoProvision = true
  → Entity created → DeviceCredential created (status: INACTIVE)
  → First valid data arrives → DeviceCredential activated (status: ACTIVE)
  → Token is now fully functional
```

Inactive tokens reject data with a specific error: `"Token not yet activated. Send any valid message to activate."`

On first-use activation, system logs a `DEVICE_FIRST_CONNECTED` event to `ts_device_events`.

### 8.4 Connectivity Test Page

Entity Detail → Connectivity tab:

**A. Connection Info Panel:**
- Entity access token (copy + regenerate with reauth)
- UNS path (copy)
- Protocol type (from template)
- Last activity timestamp
- Current status
- Token status (INACTIVE/ACTIVE)

**B. Quick Test Tools (per protocol):**

MQTT test (mosquitto_pub command, auto-populated), HTTP test (curl command, auto-populated), WebSocket test (in-browser form).

**C. In-Browser Test Tool:**
- Select message type
- JSON editor with schema validation from template
- Send button, response inline

**D. Connection History:**
Time-series graph from `ts_device_events`.

### 8.5 Code Snippets

| Language/Tool | MQTT | HTTP | WebSocket |
|---------------|------|------|-----------|
| curl | — | ✅ | — |
| mosquitto_pub | ✅ | — | — |
| Python (paho-mqtt) | ✅ | ✅ (requests) | ✅ |
| Node.js (mqtt.js) | ✅ | ✅ (fetch) | ✅ |
| Arduino/ESP32 | ✅ | ✅ | — |
| Postman collection | — | ✅ | — |

Snippets auto-populated with entity's actual token, UNS path, and server address.

---

## 9. QR Code Generation & Checklist Submission

### 9.1 QR Code Generation

**QR Code Content — URL only, NO embedded tokens:**
```
https://host/checklist/{entityId}
```

The QR code identifies which entity's checklist to show. It does NOT bypass authentication.

**UI Integration:**
- "Generate QR Code" button in entity detail panel header
- Modal with: preview, download PNG (print-ready), download SVG, print button, size selector, optional entity name label
- QR code saved as entity identifier (type: `QR_GENERATED`)

**Technology:** `qrcode` (server) + `qrcode.react` (client preview).

### 9.2 Mobile Checklist Flow

```
Operator scans QR → Opens checklist URL → Login (if no active session)
  → Session managed by existing user settings (timeout on inactivity, explicit logout)
  → RBAC check (CHECKLIST_SUBMIT permission)
  → Entity info + checklist questions rendered
  → Fills answers → Required field validation
  → For SIGNATURE questions: RE-AUTH REQUIRED
  → Submit → Pipeline → TimescaleDB + PostgreSQL
  → Audit trail entry
```

**Authentication:** Full user login (username + password = two identification components per §11.200). Session management follows existing user settings configured by SUPER_ADMIN (session timeout on inactivity, single login, explicit logout).

### 9.3 Checklist Approval Workflow

Entity templates define `checklistApprovalWorkflow`:

```typescript
interface ChecklistApprovalWorkflow {
  enabled: boolean;
  steps: Array<{
    stepName: string;           // "Performed By" | "Checked By" | "Verified By"
    stepSequence: number;       // 1, 2, 3 — enforced ordering
    requiredRole: string;       // Minimum role required
    requiresSignature: boolean;
    requiresReauth: boolean;
  }>;
}
```

**Sequencing enforcement (§11.10(f)):**
- Step N cannot be completed before step N-1
- Each step creates audit trail entry + electronic signature (if required)
- `ChecklistReview` in PostgreSQL tracks current step
- Rejection resets to step 1 with REOPENED audit entry

**Separation of Duties enforcement (§11.10(d)):**
- The same user CANNOT perform consecutive steps. The person who "Performed By" CANNOT also be "Checked By". The person who "Checked By" CAN be "Verified By" (different function), but the person who "Performed By" CANNOT be "Verified By".
- Enforced at API level: `ChecklistReview.checkedBy !== ChecklistReview.performedBy` and `ChecklistReview.verifiedBy !== ChecklistReview.performedBy`
- Attempting to complete a step when you performed a prior step returns `403 Forbidden` with message: `"Separation of duties: you cannot review your own submission"`
- This is configurable per template: `separationOfDuties: boolean` (default: `true`). When false, same user CAN perform multiple steps (for low-risk checklists or small teams). Disabling creates an audit entry: `SEPARATION_OF_DUTIES_DISABLED`.

**Default workflow:**
```
Step 1: "Performed By" — OPERATOR, signature required, reauth required
Step 2: "Checked By" — SUPERVISOR, signature required, reauth required
Step 3: "Verified By" — ADMIN/QA, signature required, reauth required
```

### 9.4 Checklist Data Flow

```
Submit → POST /api/data/checklist (User JWT required)
  → User authentication (two-factor: username + password)
  → RBAC check (CHECKLIST_SUBMIT)
  → Validate answers against template checklistSchema
  → Compute answers_hash = SHA-256(JSON.stringify(answers))
  → INSERT ts_checklist_responses (immutable in TimescaleDB)
  → INSERT ChecklistReview (PostgreSQL, step 1: "Performed By")
  → If SIGNATURE question: reauth → INSERT ElectronicSignature
  → INSERT AuditTrail (DATA_CHECKLIST_SUBMITTED)
  → If approval workflow enabled: notify next step's role
  → If any FAIL/NO on required questions: notify supervisors
```

All PostgreSQL writes (ChecklistReview + ElectronicSignature + AuditTrail) happen in a single transaction.

---

## 10. Help System

### 10.1 Contextual Help Buttons

`?` icon (CircleHelp from Lucide) at strategic locations:

| Location | Help Content |
|----------|-------------|
| Entity Explorer page header | Entity management overview |
| Entity Template form sections | Attributes, telemetry schema, checklist types, alarm rules |
| Rule Chain editor (SUPER_ADMIN only) | How rule chains work, node types, best practices |
| Connectivity tab | Protocol setup, troubleshooting |
| UNS Mapping config | UNS concepts, ISA-95, wildcards |
| QR Code dialog | QR usage, scanning tips |
| Checklist mobile page | How to fill checklists, photo/signature tips |
| Audit Trail page | Understanding audit records, compliance |
| User Management — role permissions | Permission descriptions |
| Alarm panel | Severity levels, acknowledgment workflow |

### 10.2 Help Button Component

```tsx
<HelpButton articleKey="rule-chain.overview" position="top-right" variant="icon" />
```

Click opens slide-over panel (right side, 400px) with markdown-rendered content. Panel has: title, content, "Was this helpful?" feedback, close button. Keyboard shortcut: `F1`.

### 10.3 Help Content Management

SUPER_ADMIN manages via Config → Help Articles:
- List, create, edit articles (markdown editor with preview)
- Each article: `key`, `title`, `content`, `category`, `sortOrder`
- Seeded on first deploy
- **Version controlled:** every save creates `HelpArticleVersion` snapshot
- Editing requires reauth
- All changes generate audit trail entries

---

## 11. API Endpoint Specification

### 11.1 Data Ingestion Endpoints

| Method | Endpoint | Auth | Reauth | Description |
|--------|----------|------|--------|-------------|
| POST | `/api/data/telemetry` | Device Token | — | Push telemetry |
| POST | `/api/data/attributes` | Device Token | — | Push attributes |
| GET | `/api/data/attributes` | Device Token | — | Get shared attributes |
| POST | `/api/data/checklist` | **User JWT only** | If SIGNATURE | Submit checklist |
| POST | `/api/data/binary` | Device Token | — | Upload binary (multipart) |
| POST | `/api/data/event` | Device Token | — | Push device event |
| POST | `/api/data/rpc` | User JWT | — | Send RPC to device |
| GET | `/api/data/rpc/response/:requestId` | User JWT | — | Get RPC response |

**RPC timeout:** Default 30 seconds (configurable via System Config `rpc.timeout_ms`). If device does not respond within timeout, API returns `408 Request Timeout` with body `{"error": "Device did not respond", "requestId": "..."}`. Caller can poll `GET /api/data/rpc/response/:requestId` for late responses (responses cached per `rpc.response_cache_ttl_ms`, default 5 minutes).

### 11.2 Telemetry Query Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/telemetry/:entityId/latest` | JWT | Latest values |
| GET | `/api/telemetry/:entityId/timeseries` | JWT | Time-range with aggregation |
| GET | `/api/telemetry/:entityId/keys` | JWT | List available keys |
| GET | `/api/attributes/:entityId/:scope` | JWT | Current attributes by scope |
| GET | `/api/attributes/:entityId/history` | JWT | Attribute change history |
| GET | `/api/checklist/:entityId/responses` | JWT | List responses (paginated) |
| GET | `/api/checklist/:entityId/responses/:id` | JWT | Single response with review status |

### 11.3 Data Export Endpoints

| Method | Endpoint | Auth | Permission | Description |
|--------|----------|------|-----------|-------------|
| GET | `/api/export/telemetry/:entityId` | JWT | DATA_EXPORT | Export as CSV/JSON/PDF |
| GET | `/api/export/checklist/:entityId` | JWT | DATA_EXPORT | Export responses + reviews |
| GET | `/api/export/alarms` | JWT | DATA_EXPORT | Export alarms |
| GET | `/api/export/attributes/:entityId` | JWT | DATA_EXPORT | Export attribute history |

Query params: `from`, `to` (ISO dates), `format` (csv|json|pdf), `keys` (optional filter).

**Export Safeguards:**
- Maximum date range: 90 days per request (configurable via `EXPORT_MAX_RANGE_DAYS=90`). Requests exceeding this return 400 with message and guidance to narrow the range.
- Maximum row count: 1,000,000 rows per export (configurable). If exceeded, response is truncated with a warning header `X-DigiLog-Truncated: true`.
- Streaming: CSV and JSON exports use streaming responses to avoid memory exhaustion. PDF exports are limited to 10,000 rows (generates in-memory).
- Rate limit: 5 export requests per user per minute (prevents abuse).

### 11.4 Rule Chain Endpoints (SUPER_ADMIN Only)

| Method | Endpoint | Reauth | Description |
|--------|----------|--------|-------------|
| GET | `/api/rule-chains` | — | List |
| GET | `/api/rule-chains/:id` | — | Get with nodes |
| POST | `/api/rule-chains` | CREATE_RULE_CHAIN | Create |
| PUT | `/api/rule-chains/:id` | UPDATE_RULE_CHAIN | Update (creates version) |
| DELETE | `/api/rule-chains/:id` | DELETE_RULE_CHAIN | Delete |
| POST | `/api/rule-chains/:id/set-root` | SET_ROOT_RULE_CHAIN | Set as root |
| GET | `/api/rule-chains/:id/versions` | — | Version history |
| GET | `/api/rule-chains/:id/debug-events` | — | Debug events |
| GET | `/api/rule-chains/:id/nodes/:nodeId/debug-events` | — | Node debug events |
| DELETE | `/api/rule-chains/:id/debug-events` | — | Clear debug events |

**Pipeline Debug Traces**

| Method | Endpoint | Permission | Description |
|--------|----------|-----------|-------------|
| GET | `/api/debug/traces` | READ_DEBUG_TRACE | List traces (paginated, filtered) |
| GET | `/api/debug/traces/:traceId` | READ_DEBUG_TRACE | Single trace with all stage details |
| GET | `/api/debug/traces/entity/:entityId` | READ_DEBUG_TRACE | Traces for specific entity |
| PUT | `/api/debug/traces/entity/:entityId/toggle` | MANAGE_DEBUG_TRACE | Enable/disable per-entity tracing |
| PUT | `/api/debug/traces/template/:templateId/toggle` | MANAGE_DEBUG_TRACE | Enable/disable per-template tracing |
| GET | `/api/debug/traces/stats` | READ_DEBUG_TRACE | Aggregate success rate, duration, top errors |
| POST | `/api/rule-chains/:id/test` | — | Send test message |
| POST | `/api/rule-chains/import` | IMPORT_RULE_CHAIN | Import JSON |
| GET | `/api/rule-chains/:id/export` | — | Export JSON |

### 11.5 Connectivity Endpoints

| Method | Endpoint | Auth | Reauth | Description |
|--------|----------|------|--------|-------------|
| GET | `/api/connectivity/:entityId/status` | JWT | — | Status |
| GET | `/api/connectivity/:entityId/history` | JWT | — | History |
| POST | `/api/connectivity/:entityId/test` | JWT | — | Test |
| GET | `/api/connectivity/:entityId/snippets/:protocol` | JWT | — | Code snippets |
| GET | `/api/connectivity/:entityId/credentials` | JWT | — | Credentials (masked) |
| POST | `/api/connectivity/:entityId/credentials/regenerate` | JWT | REGENERATE_CREDENTIALS | Regenerate token |

### 11.6 Alarm Endpoints

| Method | Endpoint | Auth | Permission | Reauth | Description |
|--------|----------|------|-----------|--------|-------------|
| GET | `/api/alarms` | JWT | ALARM_VIEW | — | List alarms |
| GET | `/api/alarms/:entityId` | JWT | ALARM_VIEW | — | Entity alarms |

**Alarm query parameters:** `status` (ACTIVE|ACKNOWLEDGED|CLEARED), `severity` (CRITICAL|MAJOR|MINOR|WARNING|INFO), `from`/`to` (ISO dates), `entityId`, `alarmType`, `page` (default 1), `pageSize` (default 50, max 200), `sortBy` (createdAt|severity|status), `sortDir` (asc|desc).

**Telemetry timeseries query parameters:** `from`/`to` (ISO dates, required), `keys` (comma-separated), `aggregation` (none|avg|min|max|sum|count), `interval` (auto|1m|5m|15m|1h|1d), `limit` (default 10000, max 50000). If raw data exceeds `limit`, server auto-applies aggregation and returns `X-DigiLog-Aggregated: true` header.
| POST | `/api/alarms/:id/acknowledge` | JWT | ALARM_MANAGE | ACKNOWLEDGE_ALARM | Acknowledge |
| POST | `/api/alarms/:id/clear` | JWT | ALARM_MANAGE | CLEAR_ALARM | Clear |

### 11.7 QR Code Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/qr/:entityId/generate` | JWT | Generate QR |
| GET | `/api/qr/:entityId` | JWT | Get existing QR |
| GET | `/api/qr/:entityId/image` | Public | Serve PNG |
| GET | `/api/qr/:entityId/svg` | Public | Serve SVG |

### 11.8 UNS Mapping Endpoints

| Method | Endpoint | Auth | Permission | Reauth | Description |
|--------|----------|------|-----------|--------|-------------|
| GET | `/api/uns/tree` | JWT | UNS_VIEW | — | Topic tree |
| GET | `/api/uns/entity/:entityId` | JWT | UNS_VIEW | — | Entity path |
| PUT | `/api/uns/entity/:entityId` | JWT | UNS_MANAGE | OVERRIDE_UNS_PATH | Override path |
| GET | `/api/uns/config` | JWT | CONFIG_READ | — | UNS config |
| PUT | `/api/uns/config` | JWT | CONFIG_UPDATE | UPDATE_UNS_CONFIG | Update config |
| POST | `/api/uns/test-wildcard` | JWT | UNS_VIEW | — | Test wildcard |

### 11.9 Help Article Endpoints (SUPER_ADMIN)

| Method | Endpoint | Reauth | Description |
|--------|----------|--------|-------------|
| GET | `/api/help/:key` | — | Get by key (all users) |
| GET | `/api/help` | — | List all |
| POST | `/api/help` | CREATE_HELP_ARTICLE | Create |
| PUT | `/api/help/:key` | UPDATE_HELP_ARTICLE | Update (creates version) |
| DELETE | `/api/help/:key` | DELETE_HELP_ARTICLE | Delete |
| GET | `/api/help/:key/versions` | — | Version history |

### 11.10 Retention Management Endpoints (SUPER_ADMIN)

| Method | Endpoint | Reauth | Description |
|--------|----------|--------|-------------|
| GET | `/api/config/retention` | — | Get policies |
| PUT | `/api/config/retention` | UPDATE_RETENTION_POLICY | Update config |
| POST | `/api/retention/archive` | ARCHIVE_DATA | Archive before delete |
| POST | `/api/retention/execute` | EXECUTE_RETENTION | Execute after archive |

### 11.11 MQTT Auth Callbacks (Internal)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/internal/mqtt/auth` | Internal | Validate device token → 200 allow / 401 deny |
| POST | `/api/internal/mqtt/acl` | Internal | Validate topic + action per ACL rules → 200 allow / 403 deny |
| POST | `/api/internal/mqtt/superuser` | Internal | Always returns 403 |

### 11.12 Health Check Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | None | Liveness: API is running |
| GET | `/api/health/ready` | None | Readiness: PostgreSQL + TimescaleDB + EMQX all connected |
| GET | `/api/health/detailed` | JWT (ADMIN+) | Detailed status of each subsystem with latency |

Readiness check verifies: PostgreSQL `SELECT 1`, TimescaleDB `SELECT 1`, EMQX MQTT client connected, Redis `PING`, file store writable. Returns 200 if all pass, 503 if any fail. Used by Docker healthcheck and load balancers.

**New endpoint total: ~60 endpoints**
**Updated system total: ~142 endpoints** (82 existing + 60 new)

---

## 12. Database Schema

### 12.1 Template Enhancement (Merged DeviceProfile)

```prisma
// Added fields to existing AssetTemplate model
model AssetTemplate {
  // ... all existing fields preserved ...

  // ─── Data Ingestion Blueprint (NEW) ────────────────
  dataIngestionEnabled  Boolean   @default(false)
  transportType         String?                         // MQTT | HTTP | WEBSOCKET
  credentialType        String?   @default("TOKEN")     // TOKEN | BASIC | X509
  inactivityTimeout     Int       @default(60)          // seconds
  defaultMaxDataRate    Int       @default(600)          // default rate limit for instances
  autoProvision         Boolean   @default(true)         // auto-create credentials on instance creation
  defaultRuleChainId    String?

  defaultRuleChain      RuleChain? @relation(fields: [defaultRuleChainId], references: [id])
}
```

### 12.2 New Prisma Models (PostgreSQL)

```prisma
// ─── Device Credentials (per entity instance) ─────────────
model DeviceCredential {
  id                    String    @id @default(uuid())
  entityId              String    @unique
  accessToken           String    @unique
  credentialData        Json?
  status                String    @default("INACTIVE")   // INACTIVE | ACTIVE
  allowedIps            String[]  @default([])
  deviceFingerprint     String?
  maxDataRatePerMin     Int       @default(600)
  isActive              Boolean   @default(true)
  firstConnectedAt      DateTime?                        // Set on first-use activation
  lastConnectedAt       DateTime?
  lastDisconnectedAt    DateTime?
  lastSourceIp          String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
}

// ─── Rule Chains (SUPER_ADMIN only) ───────────────────────
model RuleChain {
  id                    String    @id @default(uuid())
  name                  String
  description           String?
  isRoot                Boolean   @default(false)
  isSystem              Boolean   @default(false)
  firstRuleNodeId       String?
  configuration         Json?
  currentVersion        Int       @default(1)
  isActive              Boolean   @default(true)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  nodes                 RuleNode[]
  connections           RuleNodeConnection[]
  versions              RuleChainVersion[]
  templates             AssetTemplate[]
}

// ─── Rule Chain Versions (append-only snapshots) ──────────
model RuleChainVersion {
  id              String    @id @default(uuid())
  ruleChainId     String
  version         Int
  snapshot        Json
  status          String    @default("ACTIVE")      // ACTIVE | SUPERSEDED
  createdBy       String
  changeNotes     String?
  createdAt       DateTime  @default(now())

  ruleChain       RuleChain @relation(fields: [ruleChainId], references: [id], onDelete: Cascade)

  @@unique([ruleChainId, version])
}

// ─── Rule Nodes ────────────────────────────────────────────
model RuleNode {
  id                    String    @id @default(uuid())
  ruleChainId           String
  type                  String
  name                  String
  configuration         Json      @default("{}")
  debugEnabled          Boolean   @default(false)
  positionX             Float     @default(0)
  positionY             Float     @default(0)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  ruleChain             RuleChain @relation(fields: [ruleChainId], references: [id], onDelete: Cascade)
  fromConnections       RuleNodeConnection[] @relation("FromNode")
  toConnections         RuleNodeConnection[] @relation("ToNode")
}

// ─── Rule Node Connections ─────────────────────────────────
model RuleNodeConnection {
  id                    String    @id @default(uuid())
  ruleChainId           String
  fromNodeId            String
  toNodeId              String
  label                 String

  ruleChain             RuleChain @relation(fields: [ruleChainId], references: [id], onDelete: Cascade)
  fromNode              RuleNode  @relation("FromNode", fields: [fromNodeId], references: [id], onDelete: Cascade)
  toNode                RuleNode  @relation("ToNode", fields: [toNodeId], references: [id], onDelete: Cascade)
}

// ─── Alarm (single row lifecycle, audited) ─────────────────
model Alarm {
  id                    String    @id @default(uuid())
  entityId              String
  alarmType             String
  severity              String                          // CRITICAL | MAJOR | MINOR | WARNING | INFO
  status                String    @default("ACTIVE")    // ACTIVE | ACKNOWLEDGED | CLEARED
  unsPath               String

  // Creation
  createdAt             DateTime  @default(now())
  createdByRuleChain    String?
  triggerDetails        Json?

  // Acknowledgment
  acknowledged          Boolean   @default(false)
  acknowledgedBy        String?
  acknowledgedAt        DateTime?
  ackRemarks            String?
  ackSignatureId        String?

  // Clearance
  cleared               Boolean   @default(false)
  clearedAt             DateTime?
  clearedBy             String?
  clearRemarks          String?
  clearSignatureId      String?                         // §11.50: Clearing a compliance record requires signature

  updatedAt             DateTime  @updatedAt

  @@index([entityId, status])
  @@index([severity, status])
  @@index([createdAt])
}

// ─── Checklist Review (approval workflow, audited) ─────────
model ChecklistReview {
  id                    String    @id @default(uuid())
  checklistId           String    @unique               // Links to ts_checklist_responses
  entityId              String
  templateId            String

  // Current state
  currentStep           String    @default("SUBMITTED")
  currentSequence       Int       @default(1)

  // Step 1: Performed By
  performedBy           String
  performedAt           DateTime
  performedSignatureId  String?

  // Step 2: Checked By
  checkedBy             String?
  checkedAt             DateTime?
  checkedRemarks        String?
  checkedSignatureId    String?

  // Step 3: Verified By
  verifiedBy            String?
  verifiedAt            DateTime?
  verifiedRemarks       String?
  verifiedSignatureId   String?

  // Rejection
  rejectedBy            String?
  rejectedAt            DateTime?
  rejectionReason       String?

  updatedAt             DateTime  @updatedAt

  @@index([entityId])
  @@index([currentStep])
}

// ─── Electronic Signature (§11.50 + §11.70) ───────────────
model ElectronicSignature {
  id                    String    @id @default(uuid())
  recordType            String                          // 'alarm' | 'checklist'
  recordId              String                          // Alarm.id or ChecklistReview.id
  signerUserId          String
  signerFullName        String                          // §11.50(a)
  signerRole            String
  signedAt              DateTime  @default(now())       // §11.50(b)
  meaning               String                          // §11.50(c)
  recordHash            String                          // §11.70
  signatureHash         String                          // §11.70: SHA-256(recordHash + signerUserId + signedAt)
  reAuthVerified        Boolean   @default(true)
  reAuthMethod          String    @default("password")
  signatureImage        String?   @db.Text
  createdAt             DateTime  @default(now())

  @@index([recordType, recordId])
}

// ─── Latest Telemetry (cache) ──────────────────────────────
model LatestTelemetry {
  id              String    @id @default(uuid())
  entityId        String
  key             String
  valueNum        Float?
  valueStr        String?
  valueBool       Boolean?
  valueJson       Json?
  lastUpdated     DateTime

  @@unique([entityId, key])
}

// ─── UNS Mapping ───────────────────────────────────────────
model UnsMapping {
  id                    String    @id @default(uuid())
  entityId              String    @unique
  unsPath               String    @unique
  pathSegments          Json
  isOverridden          Boolean   @default(false)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
}

// ─── Connectivity Status ───────────────────────────────────
model ConnectivityStatus {
  id                    String    @id @default(uuid())
  entityId              String    @unique
  status                String    @default("UNKNOWN")
  lastActivityAt        DateTime?
  lastConnectedAt       DateTime?
  lastDisconnectedAt    DateTime?
  protocol              String?
  sourceIp              String?
  updatedAt             DateTime  @updatedAt
}

// ─── QR Codes ──────────────────────────────────────────────
model QrCode {
  id                    String    @id @default(uuid())
  entityId              String    @unique
  qrData                String                          // URL only — NO tokens
  imagePath             String
  svgData               String?   @db.Text
  size                  String    @default("MEDIUM")
  includeLabel          Boolean   @default(true)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
}

// ─── Help Articles (version-controlled) ────────────────────
model HelpArticle {
  id                    String    @id @default(uuid())
  key                   String    @unique
  title                 String
  content               String    @db.Text
  category              String
  sortOrder             Int       @default(0)
  currentVersion        Int       @default(1)
  isActive              Boolean   @default(true)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  versions              HelpArticleVersion[]
}

// ─── Help Article Versions ─────────────────────────────────
model HelpArticleVersion {
  id              String    @id @default(uuid())
  helpArticleId   String
  version         Int
  content         String    @db.Text
  changedBy       String
  changeNotes     String?
  createdAt       DateTime  @default(now())

  helpArticle     HelpArticle @relation(fields: [helpArticleId], references: [id], onDelete: Cascade)

  @@unique([helpArticleId, version])
}

// ─── Data Stream Registration ──────────────────────────────
// DataStream registers known telemetry keys per entity for UI discovery.
// Auto-created when first telemetry arrives with a new key.
// Used by: telemetry chart key selector, dashboard widget config,
// export key filter, alarm rule key picker.
// NOT part of ingestion pipeline — it's a metadata registry.
model DataStream {
  id                    String    @id @default(uuid())
  entityId              String
  key                   String
  dataType              String
  unit                  String?
  unsPath               String
  source                String    @default("device")
  isActive              Boolean   @default(true)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@unique([entityId, key])
}
```

### 12.3 Permissions

```typescript
// Data
'DATA_INGEST', 'DATA_VIEW', 'DATA_MANAGE', 'DATA_EXPORT',

// Rule Chain (SUPER_ADMIN only — hidden from other roles)
'RULE_CHAIN_VIEW', 'RULE_CHAIN_MANAGE',

// Alarm
'ALARM_VIEW', 'ALARM_MANAGE',

// UNS
'UNS_VIEW', 'UNS_MANAGE',

// QR Code
'QR_CODE_GENERATE',

// Help (SUPER_ADMIN only)
'HELP_MANAGE',

// Checklist
'CHECKLIST_SUBMIT', 'CHECKLIST_REVIEW', 'CHECKLIST_APPROVE',

// Retention (SUPER_ADMIN only)
'RETENTION_MANAGE',

// System Config (SUPER_ADMIN only)
'SYSTEM_CONFIG_MANAGE',

// Debug Trace (ADMIN+)
'READ_DEBUG_TRACE',
'MANAGE_DEBUG_TRACE',
```

### 12.4 Reauth Actions

```typescript
// Alarms
'ACKNOWLEDGE_ALARM', 'CLEAR_ALARM',

// Checklist
'SUBMIT_CHECKLIST_WITH_SIGNATURE', 'REVIEW_CHECKLIST', 'APPROVE_CHECKLIST',

// Rule Chain (SUPER_ADMIN)
'CREATE_RULE_CHAIN', 'UPDATE_RULE_CHAIN', 'DELETE_RULE_CHAIN',
'SET_ROOT_RULE_CHAIN', 'IMPORT_RULE_CHAIN',

// Credentials
'REGENERATE_CREDENTIALS',

// UNS
'OVERRIDE_UNS_PATH', 'UPDATE_UNS_CONFIG',

// Help (SUPER_ADMIN)
'CREATE_HELP_ARTICLE', 'UPDATE_HELP_ARTICLE', 'DELETE_HELP_ARTICLE',

// Retention (SUPER_ADMIN)
'UPDATE_RETENTION_POLICY', 'ARCHIVE_DATA', 'EXECUTE_RETENTION',

// System Config (SUPER_ADMIN)
'UPDATE_SYSTEM_CONFIG', 'RESTART_SERVER',
```

### 12.5 Audit Actions

```typescript
// Data ingestion (compliance-critical only)
'DATA_ATTRIBUTES_UPDATED',
'DATA_CHECKLIST_SUBMITTED',

// Alarms
'ALARM_CREATED', 'ALARM_ACKNOWLEDGED', 'ALARM_CLEARED', 'ALARM_ESCALATED',

// Checklist workflow
'CHECKLIST_REVIEWED', 'CHECKLIST_APPROVED', 'CHECKLIST_REJECTED', 'CHECKLIST_REOPENED',
'SEPARATION_OF_DUTIES_DISABLED',

// Rule chain (SUPER_ADMIN — captured even though SUPER_ADMIN is not auditable for other actions)
'RULE_CHAIN_CREATED', 'RULE_CHAIN_UPDATED', 'RULE_CHAIN_DELETED',
'RULE_CHAIN_SET_ROOT', 'RULE_CHAIN_IMPORTED',

// Credentials
'DEVICE_CREDENTIAL_REGENERATED',

// UNS
'UNS_PATH_OVERRIDDEN', 'UNS_CONFIG_UPDATED',

// Help
'HELP_ARTICLE_CREATED', 'HELP_ARTICLE_UPDATED', 'HELP_ARTICLE_DELETED',

// Retention
'RETENTION_POLICY_UPDATED', 'DATA_ARCHIVED', 'RETENTION_EXECUTED',

// System Config
'SYSTEM_CONFIG_UPDATED', 'SERVER_RESTART_TRIGGERED',
```

---

## 13. Frontend Pages & Components

### 13.1 New Pages

| Route | Page | Access | Description |
|-------|------|--------|-------------|
| `/rule-chains` | Rule Chain List | SUPER_ADMIN | List all rule chains |
| `/rule-chains/:id` | Rule Chain Editor | SUPER_ADMIN | Visual editor (React Flow) |
| `/config/uns` | UNS Configuration | ADMIN+ | UNS tree, category mapping |
| `/config/help` | Help Article Manager | SUPER_ADMIN | CRUD for help articles |
| `/config/retention` | Retention Management | SUPER_ADMIN | Retention policies |
| `/config/system` | System Configuration | SUPER_ADMIN | All operational settings with hot-reload |
| `/debug/traces` | Pipeline Debug Traces | ADMIN+ | Global trace list, stats dashboard, entity/template trace toggle |
| `/checklist/:entityId` | Mobile Checklist | Authenticated | Checklist filling page |
| `/alarms` | Alarm Dashboard | ALARM_VIEW | Active alarms, history |

### 13.2 Entity Detail Enhancements

New tabs added to entity detail:

| Tab | Content |
|-----|---------|
| **Telemetry** | Live chart, key selector, aggregation |
| **Connectivity** | Status, test tools, snippets, message log |
| **Alarms** | Active + history for this entity |
| **Checklist History** | Submitted checklists with review status |
| **QR Code** | Generate/view/download QR |

### 13.3 New Components

| Component | Description |
|-----------|-------------|
| `HelpButton` / `HelpPanel` | Contextual help |
| `ConnectivityIndicator` | Online/offline dot |
| `QrCodeGenerator` | QR generation dialog |
| `RuleChainCanvas` | React Flow editor |
| `RuleNodePalette` | Draggable node sidebar |
| `RuleNodeConfig` | Node configuration panel |
| `DebugEventPanel` | Debug events viewer |
| `ScriptEditor` | Monaco editor for JS |
| `TelemetryChart` | Time-series chart (Recharts) |
| `AlarmBadge` | Alarm count in header |
| `CodeSnippet` | Syntax-highlighted copyable block |
| `ChecklistForm` | Mobile checklist renderer (all 14 types) |
| `SignaturePad` | Canvas signature input |
| `MessageLog` | Live message stream |
| `UnsTreeView` | UNS topic hierarchy |
| `ApprovalWorkflowStepper` | Checklist approval step indicator |
| `ElectronicSignatureDialog` | Signature capture with reauth + meaning |
| `VersionHistoryPanel` | Version diff viewer for rule chains + help |
| `DataExportDialog` | Export config (format, date range, keys) |
| `EntityMoveImpactReport` | Before/after UNS mapping preview |

---

## 14. File Structure & Module Layout

### 14.1 Backend

```
apps/api/src/
├── modules/
│   ├── data-ingestion/
│   │   ├── routes.ts                    # HTTP data endpoints (8)
│   │   ├── ingestion.service.ts         # Pipeline orchestration
│   │   ├── ingestion.repository.ts      # TimescaleDB writes
│   │   ├── message-normalizer.ts        # Protocol → unified envelope
│   │   ├── entity-resolver.ts           # Token → entity lookup
│   │   └── data-validators.ts           # Schema validation
│   │
│   ├── telemetry/
│   │   ├── routes.ts                    # Query endpoints (7)
│   │   ├── telemetry.service.ts
│   │   └── telemetry.repository.ts
│   │
│   ├── rule-chain/
│   │   ├── routes.ts                    # CRUD endpoints (13)
│   │   ├── rule-chain.service.ts
│   │   ├── rule-chain.repository.ts
│   │   ├── rule-engine.ts               # Core execution
│   │   ├── script-sandbox.ts            # isolated-vm
│   │   ├── debug-recorder.ts            # Ring buffer
│   │   ├── default-chain-builder.ts
│   │   └── nodes/                       # 30+ node implementations
│   │       ├── index.ts
│   │       ├── input/
│   │       ├── filter/
│   │       ├── enrichment/
│   │       ├── transform/
│   │       ├── action/
│   │       ├── external/
│   │       └── flow/
│   │
│   ├── connectivity/
│   │   ├── routes.ts                    # 6 endpoints
│   │   ├── connectivity.service.ts
│   │   ├── connectivity.repository.ts
│   │   └── snippet-generator.ts
│   │
│   ├── qr-code/
│   │   ├── routes.ts                    # 4 endpoints
│   │   ├── qr-code.service.ts
│   │   └── qr-code.repository.ts
│   │
│   ├── alarms/
│   │   ├── routes.ts                    # 4 endpoints
│   │   ├── alarm.service.ts
│   │   └── alarm.repository.ts
│   │
│   ├── uns/
│   │   ├── routes.ts                    # 6 endpoints
│   │   ├── uns.service.ts
│   │   ├── uns.repository.ts
│   │   └── uns-path-builder.ts
│   │
│   ├── help/
│   │   ├── routes.ts                    # 6 endpoints
│   │   ├── help.service.ts
│   │   └── help.repository.ts
│   │
│   ├── checklist/
│   │   ├── routes.ts
│   │   ├── checklist.service.ts
│   │   └── checklist.repository.ts
│   │
│   └── export/
│       ├── routes.ts                    # 4 endpoints
│       ├── export.service.ts
│       └── formatters/
│           ├── csv-formatter.ts
│           ├── json-formatter.ts
│           └── pdf-formatter.ts
│
├── transport/
│   ├── mqtt-client.ts                   # Connects to external EMQX
│   ├── mqtt-handler.ts                  # MQTT message → pipeline (publish + subscribe handling)
│   ├── mqtt-auth-routes.ts              # Internal auth + ACL callback endpoints for EMQX
│   └── ws-handler.ts                    # WebSocket subscriptions (JWT authenticated)
│
├── lib/
│   ├── tsdb.ts                          # TimescaleDB pg Pool
│   ├── tsdb-migrations.ts              # Schema migrations
│   └── ... (existing)
│
└── ... (existing structure)
```

### 14.2 Frontend

```
apps/web/src/
├── routes/
│   ├── rule-chains/
│   │   ├── index.tsx                    # List (SUPER_ADMIN only)
│   │   └── editor.tsx                   # Visual editor
│   ├── alarms/
│   │   └── index.tsx                    # Dashboard
│   ├── checklist/
│   │   └── [entityId].tsx               # Mobile checklist
│   └── config/
│       ├── uns.tsx                       # UNS config
│       ├── help.tsx                      # Help manager
│       └── retention.tsx                # Retention config
│
├── components/
│   ├── rule-chain/
│   │   ├── canvas.tsx, node-palette.tsx, node-config.tsx
│   │   ├── debug-panel.tsx, script-editor.tsx
│   │   ├── version-history.tsx
│   │   └── node-types/                  # Per-type config panels
│   ├── data/
│   │   ├── telemetry-chart.tsx, telemetry-table.tsx
│   │   └── attribute-history.tsx
│   ├── connectivity/
│   │   ├── connectivity-indicator.tsx, connectivity-tab.tsx
│   │   ├── message-log.tsx, code-snippet.tsx
│   │   └── token-status-badge.tsx
│   ├── checklist/
│   │   ├── checklist-form.tsx, signature-pad.tsx
│   │   ├── photo-capture.tsx, approval-stepper.tsx
│   │   └── checklist-response-viewer.tsx
│   ├── entity/
│   │   ├── qr-code-generator.tsx
│   │   └── move-impact-report.tsx
│   ├── uns/
│   │   └── uns-tree.tsx
│   ├── export/
│   │   └── data-export-dialog.tsx
│   └── ui/
│       ├── help-button.tsx, help-panel.tsx
│       ├── alarm-badge.tsx
│       └── electronic-signature-dialog.tsx
│
└── hooks/
    ├── use-telemetry.ts, use-connectivity.ts
    ├── use-alarms.ts, use-websocket.ts
    └── use-checklist.ts
```

---

## 15. Development Phases

| Phase | Duration | Scope |
|-------|----------|-------|
| **A: Infrastructure** | 3-4 days | TimescaleDB setup, Redis + BullMQ setup, Prisma schema (Alarm, ChecklistReview, ElectronicSignature, DeviceCredential, RuleChain*, UnsMapping, DeadLetterQueue, etc.), queue job schemas (`packages/queue`), new permissions, reauth actions, audit actions, shared Zod schemas, env config, help article seed data, EMQX Docker config |
| **B: Transport** | 3-4 days | EMQX HTTP auth/ACL callbacks, MQTT client connecting to external broker, MQTT message handler (publish + subscribe topics), HTTP ingestion endpoints, WebSocket subscription manager with JWT auth, message normalization |
| **C: Pipeline** | 2-3 days | Entity resolver, device validation (IP, rate limit, first-use activation), data validators, TimescaleDB write layer, binary data handler, connectivity tracker, audit trail integration for compliance actions |
| **D: Rule Chain** | 5-7 days | Core engine, script sandbox, 30+ node implementations, debug recorder, default chain builder, rule chain CRUD API, version snapshot system |
| **E: UNS** | 2-3 days | Path builder, auto-generation on entity CRUD, wildcard matching, UNS config API, cascade move with impact report |
| **F: Queries & Export** | 3-4 days | Telemetry/attribute/checklist query endpoints, alarm CRUD, export endpoints (CSV/JSON/PDF), retention management |
| **G: Rule Chain Editor** | 5-7 days | React Flow canvas, node palette, node config, script editor (Monaco), debug panel, version history, save/load/import/export, test message |
| **H: Connectivity & QR** | 3-4 days | Connectivity indicator, connectivity tab, code snippets, in-browser test, live message log, token status badge, QR generation, connection history graph |
| **I: Checklist & Mobile** | 3-4 days | Mobile checklist page (all 14 types), signature pad, photo capture, approval workflow stepper, electronic signature dialog, checklist response viewer |
| **J: Help, UNS UI, Alarms** | 2-3 days | HelpButton + HelpPanel, help article manager + version history, UNS config page, alarm dashboard + alarm badge |
| **K: Testing & Docs** | 3-4 days | All test suites, update governance documents |

**Total: 35-47 development days**

---

## 16. Testing Strategy

### 16.1 Unit Tests (~120 tests)

| Suite | Count | Coverage |
|-------|-------|----------|
| Rule node types | ~45 | All 30+ node implementations |
| Script sandbox | ~15 | Isolation, limits, API access |
| Message normalizer | ~15 | All protocols, all payload formats |
| UNS path builder | ~15 | Generation, wildcards, cascade |
| Data validators | ~15 | Schema validation, type coercion |
| Pipeline stages | ~15 | Auth, resolution, routing |

### 16.2 E2E Tests (~80 tests)

| Suite | Count | Coverage |
|-------|-------|----------|
| HTTP data endpoints | ~20 | Telemetry, attributes, checklist, binary |
| Rule chain CRUD | ~12 | Create, update, delete, version history |
| Telemetry queries | ~12 | Latest, timeseries, aggregation, export |
| Checklist workflow | ~10 | Submit, review, approve, reject, reopen |
| Alarm lifecycle | ~10 | Create, acknowledge, clear, audit trail |
| Connectivity | ~8 | Status, test, snippets, token activation |
| QR code | ~4 | Generate, get, image, SVG |
| UNS mapping | ~8 | Tree, override, cascade, wildcard |

### 16.3 Compliance Tests (~50 tests)

| Suite | Count | Coverage |
|-------|-------|----------|
| TimescaleDB immutability | ~8 | Verify no UPDATE/DELETE possible on any hypertable |
| Audit trail completeness | ~12 | Every auditable action produces entry with correct action type |
| Electronic signatures | ~10 | §11.50 fields, §11.70 binding, reauth enforced |
| Checklist sequencing | ~8 | Step order enforced, rejection resets, signatures per step |
| Reauth enforcement | ~12 | All reauth actions reject without valid reauth |

### 16.4 Integration Tests (~5)

| Test | Flow |
|------|------|
| MQTT → Pipeline → TimescaleDB | Publish via EMQX → auth callback → normalize → rule chain → stored |
| HTTP → Rule Chain → Alarm → Audit | Post telemetry → threshold breach → alarm created → audit entry |
| QR → Checklist → Approval → Signatures | Scan → login → fill → submit → review → approve → signatures valid |
| Entity create → UNS → MQTT subscribe | New entity → auto-provision credential → UNS path → EMQX subscription |
| Entity move → Cascade → Impact report | Move parent → calculate impact → confirm → cascade → before/after report |

---

## 17. Configuration & Environment

### 17.1 Configuration Strategy

DigiLog uses a two-tier configuration approach:

- **Hot-reload settings** (30+ operational limits): Stored in `SystemConfig` table. Configurable by SUPER_ADMIN via UI. Takes effect within 10 seconds. See Section 20.3 for complete list.
- **Cold settings** (infrastructure connections): Stored in `.env` file. Require server restart. Cannot be changed from UI.

### 17.2 Environment Variables (Cold — Infrastructure Only)

```env
# ─── PostgreSQL (Prisma) ──────────────────────────────────
DATABASE_URL=postgresql://digilog_app:<secret>@db:5432/digilog

# ─── TimescaleDB (Separate Instance) ─────────────────────
TSDB_HOST=tsdb
TSDB_PORT=5432
TSDB_DATABASE=digilog_tsdb
TSDB_USER=digilog_app
TSDB_PASSWORD=<secret>
TSDB_POOL_MAX=20

# ─── MQTT (External EMQX) ────────────────────────────────
MQTT_ENABLED=true
MQTT_BROKER_HOST=emqx
MQTT_BROKER_PORT=1883
MQTT_BROKER_TLS_PORT=8883
MQTT_BROKER_WS_PORT=8083
MQTT_BROKER_WSS_PORT=8084
MQTT_AUTH_CALLBACK_URL=http://api:3000/api/internal/mqtt
EMQX_ADMIN_PASSWORD=<secret>

# ─── Redis (BullMQ + Pub/Sub) ────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=<secret>

# ─── SMTP (connection only) ──────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=<secret>
SMTP_PASSWORD=<secret>

# ─── UNS (topic prefix — changing affects all paths) ─────
UNS_ROOT_PREFIX=digilog/v1
UNS_VERSION=v1
```

**Note:** All operational limits (script timeout, rate limits, export limits, batch sizes, etc.) have been moved to `SystemConfig` (Section 20). SUPER_ADMIN configures them from the UI without server restarts.

### 17.3 Docker Compose

See Section 21.2 for the complete Docker Compose configuration with all 5 services (API, PostgreSQL, TimescaleDB, EMQX, Redis).

The `init-tsdb.sql` script initializes the TimescaleDB extensions and tables. The database itself (`digilog_tsdb`) is created automatically by the Docker image via `POSTGRES_DB` environment variable. Scripts in `/docker-entrypoint-initdb.d/` run against this database after creation.
```sql
-- init-tsdb.sql (runs automatically on first container start)
CREATE EXTENSION IF NOT EXISTS timescaledb;
-- Hypertable definitions follow (see Section 3.2)
```

### 17.4 npm Dependencies

**Backend (`apps/api`):**
```json
{
  "mqtt": "^5.5.0",              // MQTT client (connects to external EMQX)
  "isolated-vm": "^5.0.0",       // Script sandbox
  "qrcode": "^1.5.4",            // QR code generation
  "fft-js": "^0.0.12",           // FFT for vibration data
  "@fastify/websocket": "^10.0.0", // WebSocket support
  "bullmq": "^5.0.0",            // Job queue (Redis-backed)
  "ioredis": "^5.4.0"            // Redis client (required by BullMQ)
}
```

**Frontend (`apps/web`):**
```json
{
  "reactflow": "^11.11.0",        // Rule chain editor (pinned v11.x)
  "@monaco-editor/react": "^4.6.0", // Script editor
  "qrcode.react": "^4.0.1",      // QR display
  "signature_pad": "^5.0.0",     // Signature canvas
  "recharts": "^2.13.0"          // Telemetry charts
}
```

---

## 18. Mobile App Integration Points

The mobile app (PWA, Android, iOS) is specified in a **separate requirements document**. This section defines the integration contracts between the mobile app and the DigiLog backend.

### 18.1 Authentication

- Mobile app uses the same `/api/auth/login` endpoint (username + password)
- JWT token stored securely in app sandbox (Keychain/Keystore)
- Session timeout and logout behavior follows existing user settings from SUPER_ADMIN config
- Reauth for signature actions uses the same `/api/auth/reauth` endpoint

### 18.2 Offline Data Sync

**Sync-down (server → app):**
- Entity list, template schemas, checklist schemas for assigned entities
- Sync endpoint: `GET /api/sync/entities?since={lastSyncTimestamp}`
- App caches locally for offline viewing

**Sync-up (app → server):**
- Checklist submissions queued locally when offline
- App timestamps submissions using device clock
- On reconnect: `POST /api/data/checklist` for each queued submission
- Server accepts with app-provided timestamp (trusted app environment)
- Conflict resolution: submissions accepted with original template version, flagged for supervisor review if template changed since submission

### 18.3 Push Notifications

- Alarm notifications for entities assigned to user
- Checklist review notifications (next step in approval workflow)
- Integration via existing notification system + FCM (Android) / APNs (iOS)

### 18.4 QR Code Scanning

- Native camera access for QR scanning
- Scanned QR decodes to `https://host/checklist/{entityId}`
- App intercepts URL and opens checklist form natively (no browser redirect)
- If offline: loads cached entity + template data, queues submission for sync

---

## 19. Future Scope: Dashboards & Widgets

**NOT in this development phase.**

### 19.1 Widget-Based Dashboard Builder

Drag-and-drop canvas, widget library (line chart, bar chart, gauge, map, table, heatmap, alarm list, entity tree, custom HTML), real-time via WebSocket, dashboard templates, per-role assignments.

### 19.2 Entity Grouping via UNS

Virtual groups by UNS wildcard patterns. Groups usable in dashboards, alarms, reports, rule chains.

### 19.3 Advanced Analytics

Anomaly detection, predictive maintenance scoring, OEE calculation, SPC charts.

---

## 20. System Configuration (SUPER_ADMIN)

### 20.1 Design Principle

All operational limits, thresholds, and tuneable parameters are stored in the database (`SystemConfig` table) and configurable by SUPER_ADMIN through the UI. Environment variables are reserved exclusively for infrastructure connection strings and secrets that cannot be changed at runtime.

**Two categories:**

| Category | Storage | Change Mechanism | Takes Effect |
|----------|---------|-----------------|--------------|
| **Hot-reload** (operational) | `SystemConfig` table (PostgreSQL) | UI → API → database | Immediately (next request reads new value) |
| **Cold** (infrastructure) | `.env` file / environment variables | Server restart required | After container restart |

### 20.2 SystemConfig Schema

```prisma
model SystemConfig {
  id            String    @id @default(uuid())
  key           String    @unique          // e.g., "rule_engine.script_timeout_ms"
  value         String                     // JSON-encoded value
  dataType      String                     // STRING | INTEGER | FLOAT | BOOLEAN | JSON
  category      String                     // rule_engine | device | mqtt | export | pipeline | retention | websocket | rpc
  label         String                     // Human-readable: "Script Execution Timeout"
  description   String?                    // Help text shown in UI
  defaultValue  String                     // JSON-encoded factory default
  minValue      String?                    // For numeric types: minimum allowed
  maxValue      String?                    // For numeric types: maximum allowed
  unit          String?                    // "ms" | "seconds" | "minutes" | "MB" | "rows" | null
  requiresRestart Boolean @default(false)  // If true, UI shows restart warning
  isSecret      Boolean   @default(false)  // If true, value masked in UI (e.g., SMTP password)
  updatedBy     String?
  updatedAt     DateTime  @updatedAt
  createdAt     DateTime  @default(now())
}
```

**Reading pattern:** API reads config values via a `ConfigService` that caches values in memory with a 10-second TTL. On cache miss, reads from database. This means hot-reload changes take effect within 10 seconds without any restart.

```typescript
class ConfigService {
  private cache = new Map<string, { value: any; expiresAt: number }>();
  private TTL_MS = 10_000;

  async get<T>(key: string): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    
    const config = await prisma.systemConfig.findUnique({ where: { key } });
    if (!config) throw new Error(`SystemConfig key not found: ${key}`);
    const value = JSON.parse(config.value);
    this.cache.set(key, { value, expiresAt: Date.now() + this.TTL_MS });
    return value;
  }

  async set(key: string, newValue: any, userId: string): Promise<void> {
    const existing = await prisma.systemConfig.findUnique({ where: { key } });
    if (!existing) throw new Error(`SystemConfig key not found: ${key}`);
    const oldValue = JSON.parse(existing.value);
    // Validate against min/max/dataType before saving
    await prisma.systemConfig.update({ where: { key }, data: { value: JSON.stringify(newValue), updatedBy: userId } });
    this.cache.delete(key); // Invalidate immediately on this process
    // Audit trail
    await auditTrail.log('SYSTEM_CONFIG_UPDATED', userId, { key, oldValue, newValue });
  }
}
```

**Cache invalidation in multi-process deployments:** The in-memory cache is per-process. When the ingestion worker is split into a separate container, changing a config value in the API process invalidates only the API's cache. The worker's cache expires naturally within 10 seconds (TTL). For most settings this delay is acceptable. If sub-second propagation is needed in future, add Redis pub/sub cache invalidation (broadcast `config:invalidate:{key}` on set, all processes subscribe and evict).

### 20.3 Hot-Reload Settings (Configurable from UI)

| Key | Label | Default | Min | Max | Unit | Category |
|-----|-------|---------|-----|-----|------|----------|
| `rule_engine.script_timeout_ms` | Script Execution Timeout | 5000 | 1000 | 30000 | ms | rule_engine |
| `rule_engine.script_memory_mb` | Script Memory Limit | 16 | 4 | 64 | MB | rule_engine |
| `rule_engine.debug_buffer_size` | Debug Events Per Node | 100 | 10 | 1000 | events | rule_engine |
| `rule_engine.debug_ttl_hours` | Debug Event Retention | 24 | 1 | 168 | hours | rule_engine |
| `rule_engine.max_chain_depth` | Max Rule Chain Depth | 10 | 3 | 50 | chains | rule_engine |
| `device.default_inactivity_timeout_sec` | Default Inactivity Timeout | 60 | 10 | 3600 | seconds | device |
| `device.ip_validation_enabled` | IP Allowlist Enforcement | true | — | — | — | device |
| `device.rate_limit_enabled` | Per-Device Rate Limiting | true | — | — | — | device |
| `device.default_max_data_rate_per_min` | Default Rate Limit | 600 | 10 | 10000 | msg/min | device |
| `pipeline.timestamp_max_drift_hours` | Max Clock Drift Tolerance | 24 | 1 | 168 | hours | pipeline |
| `pipeline.dlq_alarm_threshold` | DLQ Depth Alert Threshold | 100 | 10 | 10000 | messages | pipeline |
| `pipeline.telemetry_batch_size` | Telemetry Write Batch Size | 100 | 1 | 1000 | rows | pipeline |
| `pipeline.telemetry_batch_flush_ms` | Telemetry Batch Flush Interval | 500 | 100 | 5000 | ms | pipeline |
| `rpc.timeout_ms` | RPC Response Timeout | 30000 | 5000 | 120000 | ms | rpc |
| `rpc.response_cache_ttl_ms` | RPC Response Cache TTL | 300000 | 60000 | 900000 | ms | rpc |
| `export.max_range_days` | Max Export Date Range | 90 | 7 | 365 | days | export |
| `export.max_rows` | Max Export Row Count | 1000000 | 10000 | 10000000 | rows | export |
| `export.pdf_max_rows` | Max PDF Export Rows | 10000 | 1000 | 100000 | rows | export |
| `export.rate_limit_per_min` | Export Requests Per Minute | 5 | 1 | 20 | requests | export |
| `export.async_threshold_rows` | Async Export Threshold | 10000 | 1000 | 100000 | rows | export |
| `websocket.max_connections_per_user` | Max WebSocket Connections | 10 | 1 | 50 | connections | websocket |
| `retention.auto_enabled` | Auto-Retention Enabled | false | — | — | — | retention |
| `retention.requires_archive` | Require Archive Before Delete | true | — | — | — | retention |
| `retention.compression_after_days` | Compress Data After | 7 | 1 | 90 | days | retention |
| `mqtt.max_payload_bytes` | MQTT Max Payload Size | 1048576 | 1024 | 10485760 | bytes | mqtt |
| `binary.max_image_size_mb` | Max Image Upload Size | 10 | 1 | 50 | MB | binary |
| `binary.max_audio_size_mb` | Max Audio Upload Size | 50 | 5 | 200 | MB | binary |
| `binary.max_vibration_size_mb` | Max Vibration Upload Size | 100 | 10 | 500 | MB | binary |
| `pipeline.trace_enabled` | Global Pipeline Trace | false | — | — | — | pipeline |
| `pipeline.trace_max_per_entity` | Max Traces Per Entity | 10000 | 1000 | 100000 | traces | pipeline |

**Settings that require restart (in System Config UI with ⚠️ badge):**

These are stored in SystemConfig for UI visibility and audit trail, but require a process restart to take effect (BullMQ worker options and TimescaleDB retention policies cannot be changed at runtime).

| Key | Label | Default | Min | Max | Unit | Category |
|-----|-------|---------|-----|-----|------|----------|
| `ingestion.worker_concurrency` | Ingestion Worker Concurrency | 10 | 1 | 50 | jobs | ingestion |
| `ingestion.worker_rate_limit` | Ingestion Worker Rate Limit | 1000 | 100 | 10000 | jobs/sec | ingestion |
| `pipeline.trace_ttl_hours` | Trace Retention Period | 48 | 1 | 168 | hours | pipeline |

These settings have `requiresRestart: true` in SystemConfig. When SUPER_ADMIN changes them, the UI shows: *"This change requires a restart. [Save & Restart]"*. On restart, the BullMQ worker re-reads concurrency/rate-limit from SystemConfig, and a startup script updates the TimescaleDB retention policy via `SELECT remove_retention_policy('ts_pipeline_traces'); SELECT add_retention_policy('ts_pipeline_traces', INTERVAL '<trace_ttl_hours> hours');`.

### 20.4 Cold Settings (Env Vars — Restart Required)

These remain in `.env` because they configure infrastructure connections:

```env
# Database
DATABASE_URL=postgresql://...        # Prisma connection
TSDB_HOST=tsdb                       # TimescaleDB host (separate from PG)
TSDB_PORT=5432
TSDB_DATABASE=digilog_tsdb
TSDB_USER=digilog_app
TSDB_PASSWORD=<secret>
TSDB_POOL_MAX=20

# MQTT Broker
MQTT_ENABLED=true
MQTT_BROKER_HOST=emqx
MQTT_BROKER_PORT=1883
MQTT_BROKER_TLS_PORT=8883
MQTT_BROKER_WS_PORT=8083
MQTT_BROKER_WSS_PORT=8084
MQTT_AUTH_CALLBACK_URL=http://api:3000/api/internal/mqtt
EMQX_ADMIN_PASSWORD=<secret>

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=<secret>

# SMTP (connection only — notification templates are hot-configurable)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=<secret>
SMTP_PASSWORD=<secret>

# UNS (changing version prefix affects all topics — requires EMQX reconfiguration)
UNS_ROOT_PREFIX=digilog/v1
UNS_VERSION=v1
```

### 20.5 Configuration API Endpoints

| Method | Endpoint | Auth | Reauth | Description |
|--------|----------|------|--------|-------------|
| GET | `/api/config/system` | JWT (SUPER_ADMIN) | — | List all settings grouped by category |
| GET | `/api/config/system/:key` | JWT (SUPER_ADMIN) | — | Get single setting with metadata |
| PUT | `/api/config/system/:key` | JWT (SUPER_ADMIN) | UPDATE_SYSTEM_CONFIG | Update setting value |
| POST | `/api/config/system/:key/reset` | JWT (SUPER_ADMIN) | UPDATE_SYSTEM_CONFIG | Reset to factory default |
| POST | `/api/config/system/restart` | JWT (SUPER_ADMIN) | RESTART_SERVER | Trigger graceful server restart |

**Reauth action:** `UPDATE_SYSTEM_CONFIG`, `RESTART_SERVER`
**Audit action:** `SYSTEM_CONFIG_UPDATED` (captures key, old value, new value, who changed it)

### 20.6 Configuration UI Page

**Route:** `/config/system` (SUPER_ADMIN only)

**Layout:** Settings grouped by category tabs (Rule Engine, Device, Pipeline, Export, MQTT, WebSocket, RPC, Retention, Binary Uploads, Ingestion Worker).

Each setting displays:
- Label + description
- Current value with appropriate input control (number input with min/max for integers, toggle for booleans, text input for strings)
- Unit label (ms, seconds, MB, etc.)
- Default value indicator (shows "Modified" badge if different from default)
- Reset to default button
- ⚠️ Restart required badge (for `requiresRestart: true` settings — though currently only cold settings need restart, and those aren't in this UI)

**Save flow:**
1. SUPER_ADMIN changes value(s)
2. Clicks "Save Changes"
3. Reauth dialog appears (password confirmation)
4. On success: values saved, audit trail created
5. If any changed setting has `requiresRestart: true`: banner appears: "Some changes require a server restart to take effect. [Restart Now]"
6. "Restart Now" triggers `POST /api/config/system/restart` with reauth → graceful shutdown → container orchestrator restarts the process

**Seed data:** All settings are seeded on first deploy with their default values. The seed script creates all rows in `SystemConfig` using the table above.

---

## 21. Scaling Architecture & Worker Processes

### 21.1 Chosen Strategy: Scale 2 — Separate TimescaleDB Host

DigiLog uses a dedicated TimescaleDB instance from Day 1, separate from the PostgreSQL instance that Prisma uses.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  PostgreSQL   │    │  TimescaleDB │    │    EMQX      │
│  (Prisma)     │    │  (Dedicated) │    │  (MQTT)      │
│  Lifecycle    │    │  Time-series │    │              │
│  objects      │    │  immutable   │    │              │
└──────────────┘    └──────────────┘    └──────────────┘
```

**Docker Compose:**
```yaml
services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: digilog
      POSTGRES_USER: digilog_app
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  tsdb:
    image: timescale/timescaledb:latest-pg16
    ports:
      - "5433:5432"
    volumes:
      - tsdb_data:/var/lib/postgresql/data
      - ./init-tsdb.sql:/docker-entrypoint-initdb.d/init-tsdb.sql
    environment:
      POSTGRES_DB: digilog_tsdb
      POSTGRES_USER: digilog_app
      POSTGRES_PASSWORD: ${TSDB_PASSWORD}
```

**Why separate from Day 1:**
- TimescaleDB write volume (telemetry) competes with Prisma read/write I/O (CRUD, queries, audit trail) on shared disk and connection pool
- Separate instance means independent connection pools, independent I/O, independent memory
- Zero code change to move later if starting combined — but starting separate avoids the migration pain
- TimescaleDB Docker image is purpose-built with optimized PostgreSQL settings (shared_buffers, work_mem, maintenance_work_mem tuned for time-series workloads)

**Future scaling path (no code changes required):**
1. Write batching (configurable via `pipeline.telemetry_batch_size` in System Config) — already built in, SUPER_ADMIN can tune
2. Read replica — add `TSDB_READ_HOST` env var, route query endpoints to replica
3. Timescale Cloud — change `TSDB_HOST` to managed endpoint

### 21.2 Worker Architecture (Option A: Build In-Process, Structure for Split)

#### Principle

Redis + BullMQ are added from Day 1. Queue schemas and interfaces are defined. All heavy processing goes through queue interfaces. But everything runs **in the same API process** initially. When scaling demands it, splitting the ingestion worker is a deployment change (add a Dockerfile), not a code rewrite.

```
DAY 1 (in-process):                         FUTURE (split):
┌──────────────────────┐                     ┌──────────────┐  ┌──────────────────┐
│        API           │                     │     API      │  │ Ingestion Worker │
│  ┌─────────────────┐ │                     │              │  │                  │
│  │ Fastify HTTP/WS │ │                     │ HTTP/WS      │  │ Rule Engine      │
│  └────────┬────────┘ │      →              │ Enqueue jobs │  │ Persist data     │
│  ┌────────▼────────┐ │                     └──────┬───────┘  └────────┬─────────┘
│  │ BullMQ Worker   │ │                            │  Redis/BullMQ  │
│  │ (in-process)    │ │                            └────────────────┘
│  │ Rule Engine     │ │
│  │ Persist data    │ │
│  └─────────────────┘ │
└──────────────────────┘
```

**How in-process works:** BullMQ supports running workers in the same Node.js process as producers. The API enqueues jobs to Redis, and a BullMQ worker in the same process picks them up. Redis acts as a buffer — if the API is busy handling HTTP requests, ingestion jobs wait in the queue rather than blocking the event loop directly. Even in-process, this provides:
- Backpressure control (queue depth = natural throttle)
- Job retry on failure
- Job priority (checklist > alarm > telemetry)
- DLQ for permanently failed jobs
- Metrics (jobs/sec, queue depth, processing time)

#### Queue Definitions

```typescript
// packages/queue/src/queues.ts
export const QUEUES = {
  INGESTION: {
    name: 'ingestion',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 500 },
      removeOnComplete: 100,    // Keep last 100 completed jobs for monitoring
      removeOnFail: 1000,       // Keep last 1000 failed jobs for debugging
    }
  },
  NOTIFICATION: {
    name: 'notification',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 }, // 1min, 2min, 4min
      removeOnComplete: 50,
    }
  },
  EXPORT: {
    name: 'export',
    defaultJobOptions: {
      attempts: 2,
      timeout: 300000,          // 5 minute timeout for large exports
      removeOnComplete: 20,
    }
  },
  REPORTS: {                    // FUTURE SCOPE — queue defined now, worker built later
    name: 'reports',
    defaultJobOptions: {
      attempts: 2,
      timeout: 600000,          // 10 minute timeout for complex reports
      removeOnComplete: 20,
    }
  },
  MAINTENANCE: {
    name: 'maintenance',
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 10,
    }
  }
} as const;
```

#### Job Priority

```typescript
// packages/queue/src/priorities.ts
export const JOB_PRIORITY = {
  CHECKLIST_SUBMISSION: 1,      // Highest — human waiting for response
  ALARM_PROCESSING: 2,          // Critical — safety/compliance
  ATTRIBUTE_UPDATE: 3,          // Important — config changes
  TELEMETRY: 5,                 // Normal — sensor data (bulk)
  DEVICE_EVENT: 7,              // Low — connection status
  BINARY_METADATA: 8,           // Lowest — file metadata
} as const;
```

#### Ingestion Worker (Built Now)

The ingestion worker handles pipeline Stages 7-11. Runs in-process initially, structured to split into its own container.

```typescript
// packages/rule-engine/src/ingestion-processor.ts
export async function processIngestionJob(job: Job<IngestionMessage>) {
  const message = job.data;
  const config = container.get(ConfigService);
  
  // Stage 7: Rule Chain Router
  const ruleChain = await resolveRuleChain(message);
  
  // Stage 8: Rule Chain Execution
  const scriptTimeout = await config.get<number>('rule_engine.script_timeout_ms');
  const result = await executeRuleChain(ruleChain, message, { scriptTimeout });
  
  // Stage 9: Data Persistence
  await persistResults(result);
  // CRITICAL: If write batching is enabled, flush the batch BEFORE this job
  // is acknowledged as complete. If the process crashes after job ack but
  // before batch flush, buffered rows are lost permanently (BullMQ won't retry).
  await telemetryBatcher.flush();
  
  // Stage 10: Audit Trail (compliance-critical only)
  if (result.auditRequired) {
    await writeAuditTrail(result.auditEntries);
    // If audit write fails, the ENTIRE job fails → goes to DLQ
    // Compliance data without audit trail is worthless
  }
  
  // Stage 11: Event Emission
  // Publish via Redis pub/sub → API picks up and broadcasts to WebSocket clients
  await redis.publish('ws:events', JSON.stringify({
    type: result.eventType,
    entityId: message.entityId,
    data: result.emitData
  }));
  
  // Enqueue notifications if needed
  if (result.alarm) {
    await notificationQueue.add('alarm', result.alarm, { priority: JOB_PRIORITY.ALARM_PROCESSING });
  }
  if (result.checklistNotify) {
    await notificationQueue.add('checklist-review', result.checklistNotify);
  }
}
```

**Concurrency and rate limit:** Controlled via System Config (`ingestion.worker_concurrency`, `ingestion.worker_rate_limit`). These are cold settings — SUPER_ADMIN saves the new value and restarts the process for it to take effect.

**Notification handling:** Built in-process alongside ingestion. Notifications are enqueued to the `notification` queue and processed by a BullMQ worker in the same process. When scaling demands it, split into its own container.

**Maintenance tasks (DLQ, cleanup, connectivity checks):** Implemented as BullMQ repeatable jobs in the `maintenance` queue. Run in-process. Split when needed.

#### Reports Worker (Future Scope — Queue Defined, Worker NOT Built)

The `reports` queue is defined now so that when the Reports module is built, the infrastructure is ready.

**Planned scope for Reports Worker:**
- Scheduled report generation (daily/weekly/monthly compliance reports)
- Batch PDF generation for multi-entity reports
- Report template rendering (combining telemetry data + checklist results + alarm history)
- Report distribution (email attachments, shared drive upload)
- Regulatory submission package assembly (compile all records for an audit period)

**Why defer:** Reports are fundamentally different from data export. Export dumps raw data. Reports interpret data — they need templates, formatting rules, cross-entity aggregation, and potentially complex business logic (e.g., "show all entities that had >3 alarms last month with checklist failure rate >10%"). This is a full feature module, not a simple worker.

**Architecture readiness:**
```typescript
// This queue definition exists from Day 1
// The worker that processes it will be built when Reports module is developed

// Future: packages/reports/src/report-processor.ts
export async function processReportJob(job: Job<ReportRequest>) {
  const { reportTemplateId, dateRange, entities, format, scheduledBy } = job.data;
  
  // 1. Load report template
  // 2. Query data across entities and time range
  // 3. Apply template transformations
  // 4. Render to PDF/XLSX
  // 5. Store generated report
  // 6. Notify requestor
  // 7. Audit trail: REPORT_GENERATED
}
```

#### File Structure (What Gets Built Now)

```
packages/
├── shared/                  # Already exists
│   ├── types/               # IngestionMessage, Alarm, etc.
│   ├── validation/          # Zod schemas
│   └── constants/           # Permissions, audit actions
│
├── db/                      # NEW: Shared database access
│   ├── prisma.ts            # Prisma client
│   ├── tsdb.ts              # TimescaleDB pool
│   └── repositories/        # Shared repositories
│
├── rule-engine/             # NEW: Rule chain execution (importable by API and future worker)
│   ├── engine.ts            # Core execution loop
│   ├── sandbox.ts           # isolated-vm
│   ├── ingestion-processor.ts  # BullMQ job processor
│   └── nodes/               # All node implementations
│
└── queue/                   # NEW: BullMQ definitions
    ├── queues.ts            # Queue names + options (including future REPORTS queue)
    ├── priorities.ts        # Job priority constants
    ├── schemas.ts           # Job payload Zod schemas
    └── connection.ts        # Redis connection factory

apps/
├── api/                     # HTTP + WebSocket + in-process workers
│   └── src/
│       ├── transport/
│       │   ├── mqtt-handler.ts     # Normalize → enqueue to BullMQ
│       │   └── ws-handler.ts       # Subscribe to Redis pub/sub for events
│       ├── workers/                # In-process BullMQ workers (Phase 1)
│       │   ├── ingestion.worker.ts # Imports from packages/rule-engine
│       │   ├── notification.worker.ts
│       │   └── maintenance.worker.ts
│       └── modules/
│           └── config/
│               ├── routes.ts       # System Config endpoints
│               ├── config.service.ts  # Cached config reader
│               └── config.repository.ts
│
└── web/
    └── src/
        └── routes/
            └── config/
                └── system.tsx      # System Configuration page
```

#### Docker Compose (Day 1)

```yaml
services:
  api:
    build: ./apps/api
    ports:
      - "3000:3000"
    depends_on: [db, tsdb, redis, emqx]
    environment:
      DATABASE_URL: postgresql://digilog_app:${DB_PASSWORD}@db:5432/digilog
      TSDB_HOST: tsdb
      TSDB_PORT: 5432
      TSDB_DATABASE: digilog_tsdb
      TSDB_USER: digilog_app
      TSDB_PASSWORD: ${TSDB_PASSWORD}
      REDIS_HOST: redis
      REDIS_PORT: 6379
      MQTT_BROKER_HOST: emqx
      MQTT_BROKER_PORT: 1883

  db:
    image: postgres:16
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: digilog
      POSTGRES_USER: digilog_app
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  tsdb:
    image: timescale/timescaledb:latest-pg16
    ports:
      - "5433:5432"
    volumes:
      - tsdb_data:/var/lib/postgresql/data
      - ./init-tsdb.sql:/docker-entrypoint-initdb.d/init-tsdb.sql
    environment:
      POSTGRES_DB: digilog_tsdb
      POSTGRES_USER: digilog_app
      POSTGRES_PASSWORD: ${TSDB_PASSWORD}

  emqx:
    image: emqx/emqx:5-elixir
    ports:
      - "1883:1883"
      - "8883:8883"
      - "8083:8083"
      - "8084:8084"
      - "18083:18083"
    environment:
      EMQX_DASHBOARD__DEFAULT_USERNAME: admin
      EMQX_DASHBOARD__DEFAULT_PASSWORD: ${EMQX_ADMIN_PASSWORD}
      EMQX_AUTHENTICATION__1__MECHANISM: password_based
      EMQX_AUTHENTICATION__1__BACKEND: http
      EMQX_AUTHENTICATION__1__METHOD: post
      EMQX_AUTHENTICATION__1__URL: "http://api:3000/api/internal/mqtt/auth"
      EMQX_AUTHENTICATION__1__BODY: '{"username":"${username}","password":"${password}"}'
      EMQX_AUTHENTICATION__1__HEADERS__CONTENT-TYPE: application/json
      EMQX_AUTHORIZATION__SOURCES__1__TYPE: http
      EMQX_AUTHORIZATION__SOURCES__1__METHOD: post
      EMQX_AUTHORIZATION__SOURCES__1__URL: "http://api:3000/api/internal/mqtt/acl"
      EMQX_AUTHORIZATION__SOURCES__1__BODY: '{"username":"${username}","topic":"${topic}","action":"${action}"}'
      EMQX_AUTHORIZATION__SOURCES__1__HEADERS__CONTENT-TYPE: application/json
    volumes:
      - emqx_data:/opt/emqx/data
      - emqx_log:/opt/emqx/log
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    restart: unless-stopped

volumes:
  pg_data:
  tsdb_data:
  emqx_data:
  emqx_log:
  redis_data:
```

**Container count: 5** (API, PostgreSQL, TimescaleDB, EMQX, Redis)

#### Splitting the Ingestion Worker (When Needed)

When SUPER_ADMIN observes via EMQX dashboard or API metrics that rule chain execution is affecting API response times:

**Step 1:** Create `apps/worker-ingestion/`:
```typescript
// apps/worker-ingestion/src/index.ts
import { Worker } from 'bullmq';
import { processIngestionJob } from '@digilog/rule-engine';
import { redisConnection } from '@digilog/queue';
import { ConfigService } from '@digilog/db';

const config = new ConfigService();

const worker = new Worker('ingestion', processIngestionJob, {
  connection: redisConnection,
  concurrency: await config.get<number>('ingestion.worker_concurrency'),
  limiter: {
    max: await config.get<number>('ingestion.worker_rate_limit'),
    duration: 1000
  }
});
```

**Step 2:** Add to Docker Compose:
```yaml
  worker-ingestion:
    build: ./apps/worker-ingestion
    deploy:
      replicas: 2
    depends_on: [db, tsdb, redis]
```

**Step 3:** Remove in-process ingestion worker from API startup.

Zero changes to queue schemas, rule engine code, or job processors. The `processIngestionJob` function is the same — it just runs in a different container.

#### Development Phase Impact

| Phase | Additions |
|-------|-----------|
| **A: Infrastructure** | Redis in Docker Compose. `packages/queue` (queue definitions, schemas, priorities). `SystemConfig` Prisma model + seed data. Config routes + service. |
| **B: Transport** | MQTT handler: normalize → enqueue to BullMQ `ingestion` queue. In-process ingestion worker starts alongside API. |
| **C: Pipeline** | Build pipeline stages in `packages/rule-engine`. Write batching for telemetry (configurable via System Config). |
| **D: Rule Chain** | Build in `packages/rule-engine`. Import from API's in-process worker. |
| **F: Queries & Export** | Export enqueued to BullMQ `export` queue. Processed in-process. Async threshold configurable via System Config. |
| **J: Help, UNS UI, Alarms** | Add System Configuration page (`/config/system`). |

---

## Appendix A: Rule Node Type Registry

```typescript
enum RuleNodeType {
  // Input (3)
  INPUT_MESSAGE_TYPE_SWITCH = 'INPUT_MESSAGE_TYPE_SWITCH',
  INPUT_ENTITY_TYPE_SWITCH = 'INPUT_ENTITY_TYPE_SWITCH',
  INPUT_ENTITY_TYPE_FILTER = 'INPUT_ENTITY_TYPE_FILTER',

  // Filter (4)
  FILTER_SCRIPT = 'FILTER_SCRIPT',
  FILTER_CHECK_KEY_EXISTS = 'FILTER_CHECK_KEY_EXISTS',
  FILTER_CHECK_RELATION = 'FILTER_CHECK_RELATION',
  FILTER_TIME_WINDOW = 'FILTER_TIME_WINDOW',

  // Enrichment (4)
  ENRICHMENT_ENTITY_ATTRIBUTES = 'ENRICHMENT_ENTITY_ATTRIBUTES',
  ENRICHMENT_RELATED_ENTITY = 'ENRICHMENT_RELATED_ENTITY',
  ENRICHMENT_ORIGINATOR_TELEMETRY = 'ENRICHMENT_ORIGINATOR_TELEMETRY',
  ENRICHMENT_CALCULATE_DELTA = 'ENRICHMENT_CALCULATE_DELTA',

  // Transform (4)
  TRANSFORM_SCRIPT = 'TRANSFORM_SCRIPT',
  TRANSFORM_RENAME_KEYS = 'TRANSFORM_RENAME_KEYS',
  TRANSFORM_FFT = 'TRANSFORM_FFT',
  TRANSFORM_AGGREGATOR = 'TRANSFORM_AGGREGATOR',

  // Action (9)
  ACTION_SAVE_TELEMETRY = 'ACTION_SAVE_TELEMETRY',
  ACTION_SAVE_ATTRIBUTES = 'ACTION_SAVE_ATTRIBUTES',
  ACTION_SAVE_CHECKLIST = 'ACTION_SAVE_CHECKLIST',
  ACTION_CREATE_ALARM = 'ACTION_CREATE_ALARM',
  ACTION_CLEAR_ALARM = 'ACTION_CLEAR_ALARM',
  ACTION_CREATE_NOTIFICATION = 'ACTION_CREATE_NOTIFICATION',
  ACTION_LOG = 'ACTION_LOG',
  ACTION_RPC_CALL = 'ACTION_RPC_CALL',
  ACTION_DELAY = 'ACTION_DELAY',

  // External (3)
  EXTERNAL_REST_API_CALL = 'EXTERNAL_REST_API_CALL',
  EXTERNAL_SEND_EMAIL = 'EXTERNAL_SEND_EMAIL',
  EXTERNAL_MQTT_PUBLISH = 'EXTERNAL_MQTT_PUBLISH',

  // Flow (3)
  FLOW_RULE_CHAIN_SWITCH = 'FLOW_RULE_CHAIN_SWITCH',
  FLOW_CHECKPOINT = 'FLOW_CHECKPOINT',
  FLOW_ACKNOWLEDGE = 'FLOW_ACKNOWLEDGE',
}
```

## Appendix B: Default Help Articles (Seed Data)

| Key | Title | Category |
|-----|-------|----------|
| `entity.overview` | Entity Management Overview | entity |
| `entity.templates` | Working with Entity Templates | entity |
| `entity.tree` | Navigating the Entity Tree | entity |
| `entity.relationships` | Entity Relationships Guide | entity |
| `entity.identifiers` | Entity Identifiers (QR, RFID, NFC) | entity |
| `rule-chain.overview` | Rule Chain Engine Overview | rule-chain |
| `rule-chain.nodes` | Rule Node Types Reference | rule-chain |
| `rule-chain.scripting` | Writing Rule Chain Scripts | rule-chain |
| `rule-chain.debug` | Debugging Rule Chains | rule-chain |
| `rule-chain.default` | Understanding the Default Rule Chain | rule-chain |
| `connectivity.overview` | Device Connectivity Guide | connectivity |
| `connectivity.mqtt` | MQTT Protocol Setup | connectivity |
| `connectivity.http` | HTTP API Integration | connectivity |
| `connectivity.testing` | Testing Device Connectivity | connectivity |
| `data.telemetry` | Telemetry Data Guide | data |
| `data.attributes` | Entity Attributes (Client/Server/Shared) | data |
| `data.binary` | Binary Data (Images, Audio, Vibration) | data |
| `checklist.overview` | Checklist System Overview | checklist |
| `checklist.mobile` | Filling Checklists on Mobile | checklist |
| `checklist.qr-code` | QR Code Scanning Guide | checklist |
| `checklist.approval` | Checklist Approval Workflow | checklist |
| `uns.overview` | Unified Namespace (UNS) Concepts | uns |
| `uns.isa95` | ISA-95 Hierarchy Mapping | uns |
| `uns.wildcards` | UNS Wildcard Patterns | uns |
| `alarms.overview` | Alarm System Overview | alarms |
| `alarms.management` | Managing and Acknowledging Alarms | alarms |
| `audit.overview` | Audit Trail & Compliance | audit |
| `users.roles` | User Roles & Permissions | users |

## Appendix C: 21 CFR Part 11 Compliance Matrix

| CFR Section | Requirement | Implementation |
|-------------|-------------|---------------|
| §11.10(a) | System validation | Rule chain version control. Immutable TimescaleDB. Compliance test suites. |
| §11.10(b) | Accurate record copies | Export endpoints (CSV/JSON/PDF) for all data. |
| §11.10(c) | Record protection/retention | No auto-deletion. Compression only. Archive-before-delete. |
| §11.10(d) | System access controls | RBAC + permissions. Rule chains SUPER_ADMIN only. |
| §11.10(e) | Audit trail | All compliance-critical actions audited with SHA-256 chain. Telemetry exempt (machine-generated, immutable in TSDB). |
| §11.10(f) | Operational sequencing | Checklist approval workflow: Performed → Checked → Verified. |
| §11.10(g) | Authority checks | Reauth on 19 sensitive actions. Alarm acknowledgment AND clearance require e-signature. |
| §11.10(h) | Device checks | IP allowlisting, per-device rate limits, device fingerprint, source IP logging. |
| §11.10(k) | Documentation controls | Help articles version-controlled, reauth on edits, audited. |
| §11.50(a) | Signature — printed name | `ElectronicSignature.signerFullName` required. |
| §11.50(b) | Signature — date/time | `ElectronicSignature.signedAt` required. |
| §11.50(c) | Signature — meaning | `ElectronicSignature.meaning` required. |
| §11.70 | Signature-record linking | SHA-256 cryptographic binding. FK to source record. |
| §11.200(a) | Two-component signatures | Checklist requires User JWT (username + password). QR codes URL-only. |

## Appendix D: Design Decision Register

| Decision | Chosen | Alternative Considered | Rationale |
|----------|--------|----------------------|-----------|
| MQTT broker | External EMQX | Mosquitto (single-threaded, no clustering), Aedes (in-process) | EMQX: native clustering for HA, HTTP auth/ACL callbacks, management dashboard, 100M+ connections, Prometheus integration. Mosquitto single-threaded = single point of failure. BSL license permits all non-competing-MQTT-service uses. |
| Alarm storage | PostgreSQL (single row, mutable, audited) | TimescaleDB event-sourced + PG mirror | Alarms are lifecycle objects, not time-series. Eliminates dual-write and mirror drift. Audit trail captures all transitions. |
| Checklist workflow storage | PostgreSQL (ChecklistReview, mutable, audited) | TimescaleDB event-sourced + PG mirror | Same rationale as alarms. Single transaction for workflow + audit. |
| DeviceProfile | Merged into AssetTemplate | Separate model (ThingsBoard pattern) | Template-defines-capability, instance-gets-specifics. Consistent with existing DigiLog patterns. Eliminates redundant config. |
| Telemetry audit | Not audited | Batched audit entries | Machine-generated, immutable in TSDB. Auditing would create massive overhead with no compliance value. |
| Rule chain access | SUPER_ADMIN only | All roles with approval workflow | Setup-only configuration. Simplifies security model. Eliminates need for approval workflow. |
| Token lifecycle | Inactive until first use | Active on creation | Prevents unused tokens from being exploitable. |
| CoAP protocol | Dropped | Included (disabled by default) | No current use case. Simplifies transport layer. Can add later. |
| Offline checklist | PWA/native app with sync | Browser localStorage | App sandbox is tamper-resistant. Secure credential storage. Server-side sync with conflict resolution. |
| Data retention | Disabled by default, compression only | Auto-delete after 365 days | Regulated industries need long retention. SUPER_ADMIN controls archival. |
| QR code content | URL only, no tokens | URL + embedded short-lived token | Two-factor auth enforced. Session management via existing user settings. |
| Device subscribe topics | ACL-enforced per-entity subscribe | ThingsBoard's opaque `v1/devices/me/` pattern | UNS-consistent, human-readable, hierarchical. ACL enforces device isolation while enabling server→device communication (RPC, config, shared attributes, OTA). |
| Alarm deduplication | Suppress if active alarm of same type exists | Create new alarm every time | Prevents alarm storms from continuous threshold breaches. Severity escalation handles worsening conditions. |
| Separation of duties | Enforced by default, configurable per template | No enforcement | Critical for CFR Part 11 compliance. Performer cannot review their own work. Configurable for small teams. |
| Pipeline error handling | DLQ with retry, audit failures halt transaction | Silent drop / log only | Lost data in regulated environment is non-compliant. DLQ ensures nothing is silently dropped. Audit failure halts because compliance data without audit trail is worthless. |
| Alarm clear signature | Required (same as acknowledgment) | Not required | Clearing is closing a compliance record. FDA expects same level of accountability as acknowledgment. |
| TLS in production | Required for all device MQTT connections | Optional | Device access tokens transmitted in cleartext over unencrypted MQTT is a security vulnerability. |
| Worker architecture | BullMQ job queues with dedicated worker processes | Kafka (ThingsBoard pattern), RabbitMQ, in-process threading | BullMQ is Node.js native, Redis-backed (already needed for caching), supports priorities/retries/concurrency. Kafka is overkill for DigiLog's scale and adds Zookeeper dependency. In-process threading doesn't scale horizontally. |
| TSDB scaling strategy | Incremental: batching → separate host → read replicas | Distributed hypertables from Day 1, Timescale Cloud only | Start simple, scale when needed. Distributed hypertables add operational complexity that's unjustified at <10K devices. Env var separation means zero code change for host split. |
| Monolith-first development | Build in single process, structure for splitting | Microservices from Day 1 | Splitting too early slows development and adds deployment complexity. Clean module boundaries and queue-ready interfaces allow splitting as a deployment change, not a rewrite. |
| System configuration | Database-stored with hot-reload + SUPER_ADMIN UI | Environment variables only | Env vars require SSH access and server restart. SUPER_ADMIN needs to tune limits (script timeout, rate limits, export limits) without developer intervention. 10-second cache TTL means changes take effect almost immediately. Audit trail captures who changed what. |
| TimescaleDB deployment | Separate Docker container from Day 1 | Shared PostgreSQL instance with TimescaleDB extension | Eliminates I/O contention between Prisma CRUD and TSDB writes. Independent connection pools. TimescaleDB Docker image has optimized PostgreSQL settings for time-series. Zero code change if starting combined, but avoids migration pain. |
| Reports worker | Queue defined now, worker built later | Build with data ingestion module | Reports require templates, cross-entity aggregation, and business logic that isn't defined yet. Defining the queue now means the infrastructure is ready when the Reports module is developed. |
| Pipeline debug trace | Per-message trace in TimescaleDB with auto-purge | Application logs only | Logs are unstructured and hard to correlate. Structured traces with standardized error codes per stage enable visual progress bar, targeted filtering (by entity, stage, error code), and real-time WebSocket streaming. TimescaleDB auto-purge prevents debug data from growing indefinitely. Trace is opt-in (per-entity toggle) so zero overhead in production. |
| Trace stages storage | Single JSONB array column | 11 separate JSONB columns | Traces are short-lived debug data. Single array compresses better, produces narrower rows, and simplifies schema evolution. Query pattern is always by entity_id + time first, then expand stages — array access (`stages->6`) is fast enough for filtered results. |
| Trace non-fatal handling | SUCCESS_WITH_WARNINGS status | Binary SUCCESS/FAILED only | Timestamp corrections and Stage 11 emit failures are not data-loss events — the data is persisted. Treating them as FAILED misleads operators into thinking data was lost. Warnings preserve signal without false alarms. |
| BullMQ job priorities | Keep priorities (compliance > telemetry) | FIFO (simpler) | In a regulated environment, a checklist submission from a human operator must never wait behind 10,000 queued telemetry messages. The ~1-2ms overhead per enqueue is acceptable given compliance requirements. |
| Worker concurrency config | Cold setting (restart required) | Hot-reload | BullMQ Worker constructor reads concurrency once at startup. Changing it requires destroying and recreating the worker. Claiming hot-reload is dishonest. Cold setting with restart prompt is simple and correct. |

---

## Appendix E: Critical Review — Gaps, Risks & Resolutions (v3.2.0)

This appendix documents 25 gaps identified during a deep review of the v3.1.0 specification. Each gap is classified by severity and resolution status.

**Severity levels:** 🔴 CRITICAL (blocks compliance or causes data loss), 🟡 HIGH (production risk), 🟢 MEDIUM (quality/UX), ⚪ LOW (nice-to-have)

### E.1 Resolved in v3.2.0 (Inline Fixes Applied)

| # | Severity | Gap | Resolution |
|---|----------|-----|------------|
| 1 | 🔴 | **No MQTT LWT (Last Will and Testament)** — without LWT, a crashed device stays "Online" until the inactivity timeout expires (could be 60+ seconds). Operators see stale green dots. | Added LWT spec in Section 5.1. Devices set will message on connect. EMQX publishes disconnect event immediately on unexpected drop. ConnectivityStatus updates instantly. |
| 2 | 🟡 | **No EMQX persistent session spec** — if API restarts, do queued MQTT messages get lost? If a device reconnects, do missed RPC commands get delivered? | Added persistent session table in Section 5.1. Server client uses persistent session (5-min expiry) to survive restarts. Actuator devices use persistent for RPC delivery. Sensor devices use clean session (no stale queue buildup). |
| 3 | 🟡 | **No MQTT max payload size** — a device could send a 100MB telemetry message via MQTT, exhausting broker memory. | Added 1MB limit in Section 5.1 via `EMQX_MQTT__MAX_PACKET_SIZE`. Binary data uses HTTP multipart with type-specific limits. |
| 4 | 🟡 | **No EMQX degradation handling** — if EMQX is down, does the entire system fail? | Added degradation mode in Section 5.1. HTTP endpoints continue working. Readiness check returns 503. MQTT devices buffer locally. No HTTP data loss. |
| 5 | 🔴 | **Client timestamps not validated** — a device with a bad clock could insert telemetry with year 2095 timestamps, corrupting aggregates and charts. | Added ±24h validation in Section 6.1 Stage 6. Out-of-range timestamps replaced with server time, `TIMESTAMP_CORRECTED` event logged. |
| 6 | 🟡 | **No RPC timeout** — `POST /api/data/rpc` could hang forever waiting for device response. | Added 30s default timeout in Section 11.1. Returns 408 on timeout. Late responses cached 5 minutes for polling. |
| 7 | 🟡 | **No alarm endpoint pagination** — `GET /api/alarms` could return 50,000 rows. | Added pagination and filtering parameters in Section 11.6. Default page size 50, max 200. Filter by status, severity, date, entity. |
| 8 | 🟡 | **No telemetry query safeguard** — time-range query for a month of 1-second data = 2.6M rows. | Added auto-aggregation in Section 11.6. If raw data exceeds limit, server auto-aggregates and signals via header. |
| 9 | 🟢 | **Export permission inconsistency** — endpoints used `DATA_VIEW` but schema defined `DATA_EXPORT`. | Fixed endpoints in Section 11.3 to use `DATA_EXPORT` permission. |
| 10 | 🟢 | **DataStream model orphaned** — defined but never referenced in pipeline or endpoints. | Added purpose documentation in Section 12.2. DataStream is a metadata registry for UI key discovery, auto-created on first telemetry with new key. |

### E.2 Acknowledged Risks — Deferred to Implementation

| # | Severity | Gap | Decision |
|---|----------|-----|----------|
| 11 | 🟡 | **No graceful shutdown / drain period** — when API restarts, in-flight rule chain executions may be lost. | **Deferred.** Node.js `SIGTERM` handler should: (a) stop accepting new MQTT messages, (b) wait up to 10s for in-flight rule chains to complete, (c) disconnect MQTT client cleanly. Implementation detail, not requirements. Add to Phase B (Transport) implementation notes. |
| 12 | 🟡 | **No EMQX cluster configuration** — Docker Compose shows single node. Production needs HA. | **Deferred to deployment guide.** EMQX supports auto-clustering via Docker environment variables (`EMQX_CLUSTER__DISCOVERY_STRATEGY=static`, `EMQX_CLUSTER__STATIC__SEEDS`). Single node is correct for development. Production deployment guide should specify 3-node minimum. |
| 13 | 🟡 | **No monitoring / observability specification** — no Prometheus metrics, no Grafana dashboards, no alerting rules defined. | **Deferred to operations guide.** EMQX exposes Prometheus metrics natively on port 18083. API should expose `/api/metrics` (Prometheus format) covering: messages/sec, rule chain execution time, DLQ depth, TSDB write latency, active WebSocket connections. Specific dashboard layouts are operational, not requirements. |
| 14 | 🟢 | **No backup/DR spec for TimescaleDB** — critical for regulated environment. How is immutable data backed up? | **Deferred to operations guide.** TimescaleDB supports `pg_dump`, continuous archiving (WAL), and point-in-time recovery. Backup strategy is infrastructure-level, not application requirements. Recommend: daily `pg_dump` + WAL archiving to S3 with 30-day retention for development; production requires customer-specific DR plan. |
| 15 | 🟢 | **No data migration strategy for existing entities** — when this module is deployed, existing entities don't have UNS mappings, DeviceCredentials, or data ingestion template fields. | **Deferred to Phase A (Infrastructure).** Migration script should: (a) add default values to existing templates (`dataIngestionEnabled: false`), (b) generate UNS mappings for all existing entities from their parent chain, (c) NOT auto-provision credentials (opt-in per template). |
| 16 | 🟢 | **No WebSocket connection limit** — a user could open 100 tabs, each creating a WebSocket connection. | **Deferred.** Default limit: 10 WebSocket connections per user. Exceeding the limit closes the oldest connection with code 4002 and message `"Connection limit exceeded"`. |
| 17 | 🟢 | **No specification for concurrent checklist submissions** — two operators scan the same QR, submit simultaneously. | **Deferred.** The `ChecklistReview.checklistId` has a `@unique` constraint. Both submissions insert into `ts_checklist_responses` (immutable, both preserved). Only one `ChecklistReview` can be created per `checklistId`. Database uniqueness constraint handles this — second INSERT fails with 409 Conflict. |

### E.3 Accepted Design Limitations

| # | Severity | Gap | Acceptance Rationale |
|---|----------|-----|---------------------|
| 18 | 🟢 | **ElectronicSignature has no FK constraint to source records** — `recordId` is a string, not a database foreign key. If alarm/review is deleted, signature is orphaned. | **Accepted.** Alarms and ChecklistReviews are NEVER deleted in a regulated system. Soft-delete at most. FK would create cross-table coupling that complicates the separate lifecycle management. The string-based `recordType + recordId` pattern is intentional for polymorphic references. |
| 19 | 🟢 | **Alarm model doesn't track escalation history** — on escalation, severity is overwritten. Previous severity only exists in audit trail. | **Accepted.** Audit trail IS the history. Adding a `previousSeverity` field duplicates data. Alarm detail UI should display audit trail entries inline (already planned for entity detail → Alarms tab). |
| 20 | 🟢 | **No OTA management endpoints** — the `/ota` subscribe topic exists but there's no firmware management system. | **Accepted.** OTA management is explicitly out of scope for this phase. The subscribe topic is defined so that when OTA is implemented later, the topic structure and ACL already exist. For now, SUPER_ADMIN can publish OTA notifications via rule chain (External → MQTT Publish node) or direct EMQX dashboard. |
| 21 | ⚪ | **Help articles have no rollback endpoint** — rule chains have explicit rollback, but help articles only have "view versions". | **Accepted.** Help articles are low-risk content. Viewing a previous version + copy-paste into editor achieves the same result. Adding a rollback endpoint is gold-plating. Can add later if users request it. |
| 22 | ⚪ | **UNS path length limit not specified** — deeply nested hierarchies could create very long MQTT topic strings. | **Accepted.** MQTT spec allows 65,535 bytes for topics. EMQX default is 65,535. A realistic UNS path like `digilog/v1/AcmePharma/PlantA/Building3/Line7/Cell2/Reactor001/telemetry` is ~80 characters. Even extreme nesting won't approach the limit. No action needed. |
| 23 | ⚪ | **No offline-to-online sync priority** — when a device reconnects after being offline with 1000s of buffered messages, is there priority for live vs queued data? | **Accepted.** EMQX delivers queued messages in order (FIFO). The rule chain processes them sequentially. No special prioritization needed — the pipeline handles bursts via rate limiting (DeviceCredential.maxDataRatePerMin). If burst exceeds rate limit, excess messages are rejected with 429 and the device retries. |
| 24 | ⚪ | **`SEPARATION_OF_DUTIES_DISABLED` audit trigger not specified** — when does this fire? | **Clarification:** This fires when a SUPER_ADMIN changes a template's checklist approval workflow to disable separation of duties (allows same person to perform and review). The trigger is in the existing template update audit logic. The audit entry records: template ID, who disabled it, reason (from confirmation dialog). |
| 25 | ⚪ | **HTTP rate limiting matches MQTT** — per-device rate limit is defined for MQTT via `DeviceCredential.maxDataRatePerMin` but should also apply to HTTP data endpoints. | **Clarification:** Rate limiting is per credential, not per protocol. Stage 3 (Device Validation) checks `maxDataRatePerMin` regardless of whether the message came via MQTT or HTTP. The rate counter is shared. This is already implied by the pipeline architecture (all protocols normalize to the same envelope and go through the same stages) but worth stating explicitly. |

### E.4 Summary

| Category | Count |
|----------|-------|
| Resolved inline in v3.2.0 | 10 |
| Deferred to implementation/deployment | 7 |
| Accepted design limitations | 8 |
| **Total gaps identified** | **25** |

**Assessment:** No 🔴 CRITICAL gaps remain unresolved. All critical items (LWT, timestamp validation) have been addressed inline. The 🟡 HIGH deferred items are implementation/operational concerns that don't affect the requirements specification. The document is ready for development.

---

*End of Requirements Document v3.2.0*


> **Note:** Phase 2 added auth preHandlers and path traversal prevention to binary file endpoints in the data ingestion module. See quality audit commit 429538f.


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
