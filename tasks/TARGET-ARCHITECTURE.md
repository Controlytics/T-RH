# compliance-core — Target Architecture & Roadmap

_Post-decision (2026-07-18): **strip cleanroom domain**, **keep React 19 + Tailwind + SWR / Fastify + Prisma stack**, build **all four gap areas**._

This document holds the target-state diagrams and the phased plan. Current-state analysis + gap matrix live in [`COMPLIANCE-CORE-ANALYSIS.md`](./COMPLIANCE-CORE-ANALYSIS.md). The precise delete manifest lives in [`STRIP-MANIFEST.md`](./STRIP-MANIFEST.md) (generated from dependency discovery).

---

## 1. Target System Architecture

```mermaid
flowchart TB
    subgraph Client["Client (browser)"]
        SPA["React 19 SPA<br/>Vite · Tailwind v4 · SWR<br/>react-hook-form + zod"]
    end
    subgraph Edge["Fastify 5 API (:3000, HTTPS)"]
        MW["Middleware chain<br/>helmet · cors · rate-limit<br/>JWT verify · RBAC gate · reauth · audit hook"]
        subgraph Core["Compliance/Admin Core Modules"]
            AUTH["auth"] ; USR["users / user-groups"] ; RBAC["roles"]
            REQ["admin-requests"] ; AUD["audit"] ; NOT["notifications + rules + delivery"]
            CFG["config (defs)"] ; DASH["dashboards"] ; BK["backup"]
            LDAP["ldap"] ; HLT["system-health"] ; DBG["debug-traces"]
        end
    end
    subgraph Async["Async / Jobs"]
        Q["graphile-worker<br/>notification · session_sweep · report_schedule*"]
    end
    subgraph Data["Data"]
        PG[("PostgreSQL 18<br/>digilog_db")]
        FS["File store (uploads, backups)"]
    end
    subgraph Ext["External"]
        SMTP["SMTP"] ; SMS["SMS gateway"] ; WH["Webhook / Teams / Slack*"] ; AD["LDAP / AD"]
    end

    SPA -- "HTTPS/JSON + JWT" --> MW --> Core
    Core --> PG
    Core --> Q
    Q --> PG
    NOT --> SMTP & SMS & WH
    LDAP --> AD
    BK --> FS
    Core -. "hash-chained writes" .-> AUD
    AUD --> PG

    classDef new fill:#dbeafe,stroke:#2563eb;
    class WH,SMS new;
```
_`*` = new/gap work (Phase 2–3)._

## 2. Backend Architecture (clean-architecture layering per module)

```mermaid
flowchart LR
    R["routes.ts<br/>(schema + RBAC gate + reauth)"] --> S["*.service.ts<br/>(business logic)"]
    S --> Rep["*.repository.ts<br/>(Prisma access)"]
    Rep --> DB[("PostgreSQL")]
    S -. "emits" .-> AH["lib/audit.ts<br/>(hash-chain writer)"]
    S -. "enqueues" .-> QUE["@digilog/queue"]
    R -. "validates" .-> Z["zod DTO (packages/shared)"]
    AH --> DB
```

## 3. Frontend Component Flow

```mermaid
flowchart TB
    RT["main.tsx Routes"] --> LAY["AppLayout<br/>(sidebar · breadcrumbs · topbar)"]
    LAY --> GATE["useCan(node-id) gate"]
    GATE --> PG["Route page"]
    PG --> DATA["SWR hook (useX)"]
    DATA --> API["lib/api-base fetch"]
    PG --> UI["Reusable UI:<br/>DataTable · Dialog · Form · Filters · ExportMenu"]
    PG --> FORM["react-hook-form + zod resolver"]
    FORM -. "mutate + reauth dialog" .-> API
```

## 4. Authentication Flow (with target MFA)

```mermaid
sequenceDiagram
    actor U as User
    participant W as SPA
    participant A as auth.routes
    participant S as auth.service
    participant DB as Postgres
    U->>W: username + password (+ captcha*)
    W->>A: POST /api/auth/login
    A->>S: verify(captcha*, password policy, lockout)
    S->>DB: check user, failed-attempts, expiry
    alt MFA enabled*
        S-->>W: 200 {mfaRequired:true}
        U->>W: TOTP code
        W->>A: POST /api/auth/mfa/verify
        A->>S: verify TOTP
    end
    S->>DB: create session, reset failed count
    S-->>W: JWT (access + refresh), scope=GLOBAL
    S-->>DB: audit LOGIN_SUCCESS (hash-chained)
```
_`*` captcha + MFA = Phase 1._

## 5. Authorization / RBAC Flow

```mermaid
flowchart TB
    REQ["Request + JWT"] --> V["verify JWT"] --> EXP["expand role → permissions<br/>(FEATURE_TO_PERMISSION_MAP)"]
    EXP --> GATE{"route gate:<br/>requirePermission / requireAnyPermission"}
    GATE -- deny --> D403["403"]
    GATE -- "reauth action?" --> RA{"reauth required?"}
    RA -- yes --> ESIG["e-signature: re-enter password + reason"]
    ESIG --> H["handler"]
    RA -- no --> H
    GATE -- allow --> H
    H -. "SUPER_ADMIN bypasses gate" .-> H
```

## 6. Audit Trail Flow (tamper-evident hash chain)

```mermaid
sequenceDiagram
    participant H as Handler
    participant AU as lib/audit.ts
    participant DB as audit_trail
    H->>AU: record(action, actor, old, new, reason, ip, ua)
    AU->>DB: SELECT last checksum (chain_position DESC)
    AU->>AU: checksum = hash(prev_checksum + row)
    AU->>DB: INSERT {..., previous_checksum, chain_position}
    Note over DB: immutability trigger blocks UPDATE/DELETE
    par Verify
        H->>DB: GET /api/audit/verify-chain → walks chain
    end
```

## 7. Notification Flow (with target channels)

```mermaid
flowchart LR
    EV["Domain event"] --> RULES["notification-rules<br/>(triggers · conditions · escalation)"]
    RULES --> DISP["notification-dispatcher"]
    DISP --> Q["graphile-worker job"]
    Q --> DEL["delivery.service"]
    DEL --> EM["email-channel"] & SMSc["sms-channel"] & WHc["webhook-channel*"] & SLK["teams/slack*"] & INAPP["in-app"]
    DEL --> LOG["delivery logs + retry"]
    classDef new fill:#dbeafe,stroke:#2563eb;
    class WHc,SLK new;
```

## 8. Target Core ER (high level)

```mermaid
erDiagram
    User ||--o{ Session : has
    User }o--o{ Role : "via role assignment"
    Role ||--o{ RoleConfig : configures
    User ||--o{ AuditTrail : "actor"
    User ||--o{ AdminRequest : raises
    AdminRequest ||--o{ AuditTrail : audited
    User ||--o{ Notification : receives
    NotificationRule ||--o{ Notification : generates
    User }o--|| UserGroup : "member"
    SystemConfig ||--o{ ConfigDef : "keyed"
    AuditTrail ||--|| AuditTrail : "previous_checksum chain"
```
_(Domain models removed; core keeps User, Role, Session, AuditTrail, AdminRequest, Notification*, SystemConfig, UserGroup, Backup, help, etc. Final list confirmed post-strip.)_

## 9. Request Lifecycle

```mermaid
flowchart LR
    IN["HTTP in"] --> HELM["helmet/cors"] --> RL["rate-limit"] --> JWT["JWT verify"]
    JWT --> SCHEMA["zod schema validate"] --> GATE["RBAC gate"] --> REAUTH["reauth (if e-sig action)"]
    REAUTH --> HDL["handler → service → repo"] --> AUDIT["audit hook (hash chain)"]
    AUDIT --> RESP["response + status code"]
    HDL -. error .-> EXC["exception handler → problem+json → audit ERROR"]
```

## 10. Deployment (current: local Windows; microservice-ready)

```mermaid
flowchart TB
    subgraph Now["Current — single-host Windows"]
        VITE["Vite dev / static build"] --- API1["Fastify (tsx/tsc)"] --- PG1[("Postgres 18")]
        API1 --- GW["graphile-worker (in-proc/worker)"]
    end
    subgraph Future["Microservice-ready evolution"]
        GWs["Gateway"] --> AUTHs["auth-svc"] & AUDs["audit-svc"] & NOTs["notify-svc"] & CFGs["config-svc"]
        NOTs --> BUS["job queue (graphile-worker/Postgres)"]
    end
    Now -. "seams already exist: module boundaries, queue, JWT" .-> Future
```

---

## 11. Roadmap

### Phase 0 — Domain strip (foundation) ✅ DONE (2026-07-18)
Executed and verified: models 61→23, enums 23→6, perms 102→31, reauth 92→39, sidebar 27→10, config defs 36→21, api modules 33→18. All compile gates + runtime gate (boot/login/audit verify-chain/web build) green. DB re-baselined fresh; audit hash chain `intact:true`. Restored generic `report-page-titles` config. Remaining: vitest runtime test rework; DigiLog-era doc rewrite.

Execute per `STRIP-MANIFEST.md`. Order: cut core→domain couplings → remove domain routes from `app.ts` → delete domain modules/models/config-defs/frontend routes → drop domain perms/reauth/sidebar/schema nodes → prune seed → `prisma migrate` → build + test green. Git tag `pre-domain-strip` before starting. **Verify:** API boots, `/api/health` 200, login works, audit chain verifies, no dangling imports (`tsc` clean), web builds.

### Phase 1 — Auth hardening
- **MFA/TOTP**: `otplib`-style secret + QR enrollment, `POST /api/auth/mfa/{enroll,verify,disable}`, per-user `mfaEnabled`/`mfaSecret`, config toggle, reauth-gated disable, audit events. UI: enroll dialog, login MFA step.
- **CAPTCHA**: configurable provider (turnstile/hcaptcha/off) wired into existing `login-security.def.ts`; backend verify before password check.
- **Concurrent-login control**: max-sessions config, evict-oldest or block, session list UI.

### Phase 2 — Notification channels
Extend `notification-delivery/channels/` (email, sms → **webhook, teams, slack, push**). New channel classes implementing the existing channel interface; config defs for endpoints/tokens; per-rule channel selection; delivery logs + retry reuse. UI: channel config pages.

### Phase 3 — Audit reporting
Scheduled canned Daily/Monthly/Yearly + user/module-wise audit reports. New graphile-worker `report_schedule` task; jspdf/exceljs render reusing existing export; schedule config; report history. UI: report builder + schedule + download.

### Phase 4 — User-management completeness
Clone user, copy permissions, bulk import/export/enable/disable, profile images (uploads module), role hierarchy/inheritance. UI: bulk toolbar, clone dialog, import wizard.

### Cross-cutting (every phase)
New permissions + reauth actions + sidebar/tree nodes in `packages/shared`; audit events for each new action; Swagger for each endpoint; config-def 12-touchpoint rule; doc-sync (CHANGELOG + counts). Each phase ships **complete** (no stubs) and is verified end-to-end before the next.
