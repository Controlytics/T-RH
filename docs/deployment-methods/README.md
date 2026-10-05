# DigiLog — Deployment Methods Guide

This folder is the **decision record** for how DigiLog is deployed on a client Windows Server — the analysis of every method evaluated (native Windows, Docker, hybrid, IIS, cloud) and *why native Windows won* for a 21 CFR Part 11 pharma client. It is kept for that rationale; it is **not** the install runbook.

> **What actually ships (2026-07):** DigiLog installs via a single **`DigiLog-Setup-<ver>.exe`** (Inno Setup) — this is **Method A (Native Windows), productized**. The installer bundles its own portable PostgreSQL and registers Windows services (`DigiLogDB` + `DigiLogAPI`), so the manual multi-installer process the method files below describe no longer applies. **For the deployment runbook, read [`docs/PHARMA_DEPLOYMENT_21CFR.md`](../PHARMA_DEPLOYMENT_21CFR.md)** (and [`tasks/EXE-PACKAGING-PLAN.md`](../../tasks/EXE-PACKAGING-PLAN.md) for installer internals).
>
> **The stack has also shrunk — and one piece came back.** Removed since these docs were written: TimescaleDB (2026-06-11), Redis/Memurai (2026-05-01), Nginx + PM2 (Phase 4), and the server-side PDF/Chromium engine (2026-07-04). **The MQTT broker is NOT removed** — this line said "EMQX / Mosquitto (2026-06-17)" until 2026-10-05 and was stale: the instrument-ingest MQTT bridge returned in 2026-08, and since 2026-09-08 the `Setup.exe` installer **bundles EMQX 5.3.2** as a third service (`scripts/build-installer.ps1 -EmqxZip`, `scripts/provision-emqx.ps1`; the `.deb` bundles the same version). The **current** stack is **PostgreSQL 18 (one database, `digilog_db` as the installer names it) + one Node process** (Fastify serving the SPA + `/api/*` on `:3000` HTTPS; graphile-worker queue lives inside Postgres) **+ EMQX 5.3.2** (1883 / 8883, dashboard loopback-only). The canonical stack description lives in `PHARMA_DEPLOYMENT_21CFR.md` — not duplicated here to avoid drift. **Every table, diagram, and per-method write-up below describes the ORIGINAL multi-service stack and is retained as historical evaluation.**

## Application Stack (original evaluation — historical)

| Component | Technology | Port |
|---|---|---|
| Backend API | Node.js / Fastify (TypeScript) | 3000 |
| Frontend SPA | React (Vite build, static files) | 80/443 via Nginx |
| Primary Database | PostgreSQL 18 | 5432 |
| Time-Series Database | TimescaleDB (PostgreSQL extension) | 5432 |
| Job Queue / Cache | Redis (Memurai on Windows) | 6379 |
| MQTT Broker | EMQX 5.x | 1883 / 18083 |
| Reverse Proxy | Nginx | 80 / 443 |
| Process Manager | PM2 | — |

## Methods Evaluated

| File | Method | Recommendation |
|---|---|---|
| [method-a-native-windows.md](method-a-native-windows.md) | Native Windows Install | **RECOMMENDED** |
| [method-b-docker-compose.md](method-b-docker-compose.md) | Docker Compose on Windows | Good alternative |
| [method-c-ubuntu-deb.md](method-c-ubuntu-deb.md) | **Ubuntu / Debian `.deb` package** (2026-09-09) | **SHIPPED — the Linux installer** |
| [method-d-hybrid.md](method-d-hybrid.md) | Hybrid (Docker Infra + Native App) | Niche use case |
| [method-e-iis.md](method-e-iis.md) | IIS Instead of Nginx | Only if mandated |
| [comparison.md](comparison.md) | Side-by-Side Comparison & Final Verdict | — |

> **Note:** Method C was "WSL2" in the original matrix and was never written up; the
> letter now names the **Ubuntu `.deb` installer** (2026-09-09), which is a shipped
> method, not an evaluation. Method F (Cloud) was evaluated but never written up. See the status banner at the top of
> this file for how the stack has since changed; TimescaleDB in the tables below is historical
> (removed 2026-06, Phase 7); EMQX is live again and bundled (see the banner).

## Quick Decision Tree (original evaluation — the shipped path is the Setup.exe installer = Method A)

```
Is the client a factory with on-premises server?
├── YES → Does their IT team know Docker?
│         ├── YES → Method B (Docker Compose)
│         └── NO  → Method A (Native Windows) ← MOST CLIENTS
└── NO  → Is cloud hosting allowed?
          ├── YES → Method F (Cloud)
          └── NO  → Method A (Native Windows)

Does the client mandate IIS?
├── YES → Method E (IIS)
└── NO  → Stick with Nginx (Methods A/B)
```

## Architecture Diagram — current (2026-10-05)

```
+--------------- Client server (Windows Setup.exe or Ubuntu .deb) -----------------+
|                                                                                  |
|  +----------------------+   +--------------+   +----------------------------+    |
|  | Node 24 API (Fastify)|-->| PostgreSQL 18|   | EMQX 5.3.2 (bundled)       |    |
|  | :3000 HTTPS          |   | :5432        |   | :1883 / :8883              |    |
|  | serves the SPA,      |   | app data +   |<--| device telemetry -> the    |    |
|  | /api/*, /uploads/*   |   | graphile-    |   | API's MQTT bridge          |    |
|  | + the MQTT bridge    |   | worker queue |   | (auth hook -> the API)     |    |
|  +----------------------+   +--------------+   +----------------------------+    |
|  Windows: DigiLogDB / DigiLogAPI / emqx services . Linux: digilog-* units        |
+----------------------------------------------------------------------------------+
           ^ https (LAN, internal-CA cert)              ^ mqtt(s) (LAN)
     Browsers on domain machines                  Gateways / loggers
```

No reverse proxy, no Redis, no TimescaleDB, no tablets or APK (none exist in this fork).

## Architecture Diagram (original multi-service stack — HISTORICAL, as evaluated in 2026-04)

```
┌─────────────── Client Windows Server ───────────────┐
│                                                       │
│  ┌─────────┐   ┌────────┐   ┌────────┐   ┌────────┐  │
│  │ Node 20+│   │Postgres│   │Memurai │   │ EMQX   │  │
│  │ API     │←──│ +Timsc │   │(Redis) │   │ MQTT   │  │
│  │ :3000   │   │:5432   │   │:6379   │   │:1883   │  │
│  └────┬────┘   └────────┘   └────────┘   └────────┘  │
│       │                                               │
│  ┌────┴────────────────────┐                          │
│  │  PM2 keeps API alive    │                          │
│  └─────────────────────────┘                          │
│                                                       │
│  ┌────────────────────────┐                           │
│  │  Nginx :80 :443        │  ← serves the SPA         │
│  │  static files + proxy  │    and proxies /api/* →   │
│  │                        │    https://localhost:3000  │
│  └────────────────────────┘                           │
└───────────────────────────────────────────────────────┘
                    ▲
                    │ https (LAN)
    ┌───────────────┴───────────────┐
    │ Tablets with DigiLog APK      │
    │ (rootCA.pem installed in      │
    │  system cert store)           │
    └───────────────────────────────┘
```
