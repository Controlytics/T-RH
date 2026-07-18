# DigiLog — Application Overview & Flow Diagrams

**Audience:** Client business team + IT team
**Version:** Phase 4 (2026-04-20) — **HISTORICAL SNAPSHOT** (paired with `APPLICATION_FLOW.docx` and the Mermaid `diagrams/`)

> **2026-04-29 update — stack swaps in subsequent windows-friendly-rewrite phases not reflected below:**
> - **Mermaid diagram boxes** (Sections 2 + 5) still show **Nginx**, **Memurai/Redis queue**, **EMQX MQTT**, and **TimescaleDB** — these are **all HISTORICAL/removed** and are kept only because the .docx + .png renders match this prose verbatim (they'd have to be regenerated together). Current reality: **Fastify-direct on `:3000` (HTTPS)** (Nginx optional), **graphile-worker on Postgres** for the queue (no Redis/Memurai — removed 2026-05-01), **no MQTT broker** (EMQX/Mosquitto removed 2026-06-17), and **no TimescaleDB** (removed 2026-06-11) — a single vanilla `digilog_db`. Ignore the MQTT/TimescaleDB/Memurai/Nginx boxes in the diagrams below.
> - **Section 18 ("Permissions, 95 / 82 / 69")** is a release-time snapshot of Phase 4. Current totals are **102 permissions / 83 feature toggles / 92 reauth actions** — verified by `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts` etc.
> - **Section 21 (Operations table)** mentions Memurai/EMQX/Nginx/PM2 — **all removed**. Redis/Memurai (2026-05-01), MQTT/EMQX/Mosquitto + TimescaleDB (2026-06), and Nginx + PM2 (Phase 4) are gone; the current stack is PostgreSQL 18 (single `digilog_db`) + one Node process, deployed via the `DigiLog-Setup.exe` installer (registers `DigiLogDB` + `DigiLogAPI` Windows services). See `docs/PHARMA_DEPLOYMENT_21CFR.md`.
>
> For the current architecture refer to root `PROJECT_ARCHITECTURE.md`, `BACKEND_GUIDE.md`, `docs/PHARMA_DEPLOYMENT_21CFR.md`, and `PHASE_5_RECENT_WORK.md` § 12.

---

## 1. What is DigiLog

A 21 CFR Part 11–compliant digital logbook for pharmaceutical / cleanroom environments. It replaces paper logs for:

- Filter **cleaning-cycle tracking** (wash → dry → storage)
- **Preventive-maintenance** scheduling
- **Electronic signatures** and tamper-evident audit trails
- **Offline-capable** tablet operations with automatic sync once connectivity returns

Used on a web browser (admins, supervisors, QA) and on Android tablets (shop-floor operators with RFID scanners).

---

## 2. System at a Glance

```mermaid
flowchart TB
    subgraph Users["End Users"]
        A1[Admin Browser]
        A2[Operator Tablet Browser]
        A3[Android APK Tablet]
    end

    subgraph Server["On-Premises Windows Server"]
        NG[Nginx<br/>Serves web + proxies API]
        API[Fastify API<br/>34 route modules]
        DB[(PostgreSQL<br/>+ TimescaleDB)]
        R[(Memurai<br/>queue)]
        M[(EMQX<br/>MQTT telemetry)]
    end

    A1 --> NG
    A2 --> NG
    A3 --> NG
    NG --> API
    API --> DB
    API --> R
    API -.-> M
```

All DigiLog components run on one on-premises Windows server inside the client network.

---

## 3. Who Uses It

| Role | Does what |
|---|---|
| **Admin** | Sets up the system, creates users, defines cleaning profiles, manages configuration |
| **Supervisor** | Approves deviations (bypass / block-change), reviews reports, signs off cycles |
| **Operator** | Scans filters, performs cleaning steps, records readings |
| **Custom roles** | Any bespoke role created by Admin with a custom permission matrix |

```mermaid
flowchart LR
    A[Admin] -->|creates + grants| S[Supervisor]
    A -->|creates + grants| O[Operator]
    A -->|creates + grants| C[Custom Role]
    A --> V1[Full tenant access]
    S --> V2[Operations · Reports · Approvals]
    O --> V3[Mobile Operations only]
    C --> V4[Custom screen set]
```

---

## 4. Login

```mermaid
sequenceDiagram
    actor U as User
    participant B as Browser / APK
    participant API as API Server
    U->>B: Open /login
    B->>API: POST credentials
    API-->>B: Access token + refresh token
    B-->>U: Dashboard
    Note over B: Single-tab enforcement · 30-min refresh · idle-timeout warning
```

Argon2id password hashing. Optional LDAP. Session tokens in sessionStorage (not localStorage) for shared-workstation safety.

---

## 5. Admin — Initial Setup

```mermaid
flowchart TD
    S([Admin first login]) --> B1[Branding + Datetime]
    B1 --> B2[Roles + Role Access]
    B2 --> B3[Users + Organizations]
    B3 --> B4[Entity hierarchy<br/>Block · Area · AHU · Filter]
    B4 --> B5[Cleaning Profiles<br/>visual pipeline editor]
    B5 --> B6[Filter Profiles + PM Schedules]
    B6 --> B7[Equipment Groups per block]
    B7 --> B8[Notification Settings]
    B8 --> E([System ready])
```

All these are configured through the **Configuration** section of the web UI — no coding needed.

---

## 6. Operator — Day-to-Day Cleaning Cycle

```mermaid
flowchart TD
    L([Operator on tablet]) --> SEL[Select Block / Filter-set]
    SEL --> TAP[Tap stage card<br/>e.g. WASH_IN]
    TAP --> SCAN[Scan filter RFID tag<br/>or type filter name]
    SCAN --> CHK{Active cycle?}

    CHK -->|no| REASON[Pick cleaning reason]
    REASON --> EQUIP{Equipment<br/>readings needed?}
    EQUIP -->|yes| READ[Record pressure / temp<br/>with reauth]
    EQUIP -->|no| ADV
    READ --> ADV

    CHK -->|yes| CLST{Checklist<br/>pending?}
    CLST -->|yes| Q[Answer mandatory questions]
    CLST -->|no| ADV
    Q --> ADV

    ADV[Advance stage] --> DRY{DRY_IN?}
    DRY -->|yes, step 1| SET[Set dryer duration]
    SET --> WAIT[Wait half-time]
    WAIT --> TEMP[Enter temperature]
    TEMP --> NEXT
    DRY -->|no| NEXT{Last stage?}
    NEXT -->|no| TAP
    NEXT -->|yes| DONE([Cycle auto-completes])
```

Every action writes a tamper-evident audit event. Sensitive steps require the operator to re-enter their password.

---

## 7. Offline Mode

```mermaid
sequenceDiagram
    actor O as Operator
    participant T as Tablet
    participant IDB as IndexedDB
    participant API as API Server

    Note over T: WiFi drops
    O->>T: Scan + advance
    T->>API: POST /advance
    API--xT: Network error
    T->>IDB: Queue the operation
    T->>T: Use cached pipeline graph<br/>for next-stage validation
    T-->>O: "(queued)" badge

    Note over T,API: WiFi returns (or periodic /health ping)
    loop for each queued op
        T->>API: Replay with original timestamp
        API-->>T: 200 OK
    end
    T-->>O: "Data Synced" indicator green
```

All cached data (filters, pipeline graphs, checklists, equipment groups, RFID map) is pre-loaded while online so the tablet stays fully functional on the shop floor.

---

## 8. Admin Requests & Approvals

```mermaid
sequenceDiagram
    actor U as Locked-out User
    participant L as Login page
    participant API as API
    actor A as Admin

    U->>L: Click "Contact Admin"
    U->>API: Submit request<br/>(unlock / reset / create / modify)
    API->>A: Notification
    A->>API: Approve with mandatory remarks
    API->>API: Execute action + audit log
    API-->>U: Notification / email
```

---

## 9. Block-Change Approval (cross-block cleaning)

```mermaid
sequenceDiagram
    actor OP as Operator
    participant T as Tablet
    participant API as API
    actor AP as Approver

    OP->>T: Scan filter in Block B (home = A)
    T-->>OP: Block-change required dialog
    OP->>T: State reason (mandatory)
    T->>API: Block-change request
    API->>AP: Push notification
    AP->>API: Approve with remarks
    API-->>T: Approval persisted (one-time use)
    OP->>T: Resume cleaning in Block B
```

---

## 10. Checklist Enforcement (compliance critical)

```mermaid
flowchart TD
    A[Operator advances stage] --> B{Pipeline has<br/>CHECKLIST node?}
    B -->|no| C[Next stage]
    B -->|yes| D[Required questions dialog]
    D --> E{All answered?}
    E -->|no| F[Block submit]
    E -->|yes| G[Submit with signature + reauth]
    G --> H[Audit event with SHA-256 hash]
    H --> C
```

Same enforcement applies offline — required checklists are never skipped.

---

## 11. Reporting

```mermaid
flowchart LR
    S[Supervisor] --> H[Cleaning Cycles · History]
    H --> F[Filter by date / status / filter ID]
    F --> P[Download PDF]
    P --> OUT[(PDF with logo, readings,<br/>hash chain, signatures)]
```

Report layouts (header, footer, records per page) are editable in **Configuration → Report Settings**.

---

## 12. Security & Compliance at a Glance

```mermaid
flowchart LR
    R[Request] --> A[Verify token + session]
    A --> P[Check permission]
    P --> RE{Sensitive<br/>action?}
    RE -->|yes| PW[Reauth dialog]
    RE -->|no| DO
    PW --> DO[Execute]
    DO --> AU[Write audit log<br/>SHA-256 hash-chained]
```

- 95 permissions, 82 feature toggles, 69 reauth actions
- Every mutating action audited — each audit row hashes the previous one, so tampering is detectable end-to-end
- Organization scoping on all queries — tenants cannot see each other's data
- Electronic signatures on checklist submissions

---

## 13. Backup & Restore

```mermaid
flowchart LR
    B1[UI Backup · 64 tables] --> F[(Backup file)]
    B2[pg_dump scheduled] --> F
    F --> R1[Upload to Restore UI]
    R1 --> R2[Two-pass import<br/>handles self-ref FKs]
    R2 --> R3[App online again]
```

One-click dynamic backup covers all 64 database tables. Restore is two-pass to correctly rehydrate self-referential relationships.

---

## 14. Notifications

```mermaid
flowchart LR
    EV[App event] --> R[Notification Rule]
    R --> D[Delivery service]
    D --> E[Email SMTP]
    D --> S[SMS]
    D --> TG[Telegram]
    D --> SL[Slack]
```

Email, SMS, Telegram, and Slack channels are all configurable per rule. OAuth2 supported for Microsoft / Google email.

---

## 15. A Day in the Life of an Operator

```mermaid
flowchart TD
    T0["08:00 — Log in on tablet"] --> T1
    T1["08:07 — Scan F-001 on WASH_IN<br/>Pick reason · record readings · reauth"] --> T2
    T2["08:30 — WiFi drops"] --> T3
    T3["08:31 → 09:14 — Continue offline<br/>Advance · set dryer · submit temp<br/>All queued locally"] --> T4
    T4["09:15 — WiFi returns<br/>Sync engine replays 3 queued ops<br/>Indicator goes green"] --> T5
    T5["09:20 — Cycle auto-completes"] --> T6
    T6["10:00 — Supervisor downloads signed PDF"]

    style T2 fill:#fef3c7,stroke:#d97706
    style T3 fill:#fef3c7,stroke:#d97706
    style T4 fill:#d1fae5,stroke:#059669
```

---

## 16. Key Facts for IT

| Item | Value |
|---|---|
| Server | On-premises Windows Server (2019+) |
| Application runtime | Node.js 20+, PostgreSQL 18 (single `digilog_db`) — no Redis/Memurai (removed 2026-05-01), no EMQX/MQTT (removed 2026-06-17), no TimescaleDB (removed 2026-06-11) |
| Web access | HTTPS via Nginx (port 443) |
| Default URL | `http://<server>/` |
| Default admin login | `admin / Admin@123` (**rotate on first install**) |
| Backup | Daily — scheduled via Windows Task Scheduler or in-app |
| Logs | PM2 logs + Windows Event Viewer |
| Mobile tablets | Signed Android APK distributed by IT |

---

*End of overview. Full technical detail is available in the development team's internal docs.*
