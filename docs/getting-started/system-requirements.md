# System Requirements

> **DigiLog runs on local Windows only as of Phase 5 (2026-04-29).** EC2 / Linux / PM2 production paths were retired in commit `251be95`. The historical production stack table is preserved below for archival reference; the canonical install path is the `DigiLog-Setup.exe` installer — see `docs/PHARMA_DEPLOYMENT_21CFR.md` (root `DEPLOY-WINDOWS.md` is a pointer to it).

## Server (current — Windows local)
- **OS:** Windows Server 2019 / 2022 or Windows 10 / 11 Pro
- **CPU:** 2+ cores
- **RAM:** 4GB minimum, 8GB recommended
- **Disk:** 20GB+ (depends on data volume)

## Software Dependencies (current)
| Component | Version | Purpose |
|-----------|---------|---------|
| Node.js | 20.x or 22.x | Application runtime |
| PostgreSQL | 18 | Primary database (Prisma ORM, **61 models, 23 enums**) — also hosts the graphile-worker queue schema. Vanilla PG 18, no extensions required. |
| ~~TimescaleDB~~ | REMOVED | ~~Time-series extension (database: digilog_tsdb, 7 hypertables)~~ *(removed 2026-06-17 — Phase 7 data-ingestion tear-out dropped `digilog_tsdb` + all hypertables; no TimescaleDB dependency)* |
| ~~Mosquitto~~ | REMOVED | ~~MQTT broker~~ *(removed 2026-06-17 — Phase 7 tear-out removed the MQTT broker + data-ingestion pipeline; no MQTT dependency, `install-mosquitto.ps1` deleted)* |
| ~~Microsoft Edge~~ | not needed | The server-side `puppeteer-core` + Edge reports PDF engine was removed 2026-07-04; PDF export is now client-side (jsPDF). No Edge/Chromium dependency. |
| ~~Memurai (Redis)~~ | RETIRED | Phase 4 (2026-05-01): pub/sub moved in-process. Do NOT install. |
| Reverse proxy (Nginx / IIS) | optional | Customer-choice; not bundled after Phase 4 of the windows-friendly-rewrite. Default is Fastify-direct on `:3000`. |
| Prisma | 6.x | ORM for PostgreSQL |

## Local Development (Windows)
| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | 20.x or 22.x | Application runtime |
| PostgreSQL | 18 | Primary database (vanilla PG 18 — TimescaleDB extension removed 2026-06-17, Phase 7) |
| ~~Mosquitto~~ | REMOVED | ~~Optional unless testing MQTT ingest~~ *(removed 2026-06-17 — MQTT broker + ingestion gone)* |
| ~~Memurai (Redis)~~ | RETIRED | Phase 4: not used by DigiLog anymore |
| tsx | latest | API dev server (auto-reload) |
| Vite | latest | Frontend dev server |

## Monorepo Structure
```
apps/api/     — Fastify backend (TypeScript, port 3000)
apps/web/     — React frontend (Vite SPA, Tailwind CSS)
packages/shared/ — Shared types, schemas, constants
# packages/db/ — REMOVED 2026-06-17 (Phase 7): was Prisma client + TimescaleDB pool + telemetry batcher
packages/queue/  — graphile-worker job queue (Postgres-backed)
```

## Ports (current)
| Port | Service | Required |
|------|---------|----------|
| 3000 | Fastify API + SPA (HTTPS via mkcert) | Yes |
| 5432 | PostgreSQL (app + queue schema) | Internal |
| ~~6379~~ | ~~Redis~~ | RETIRED (Phase 4 — 2026-05-01) |
| ~~1883~~ | ~~MQTT (Mosquitto, TCP)~~ | REMOVED (Phase 7 — 2026-06-17; no MQTT broker) |

> Legacy ports — 80/443 (Nginx), 18083 (EMQX dashboard), 8883/8083/8084 (EMQX TLS / WS / WSS) — are no longer part of the standard install. Customers who add a reverse proxy in front of Fastify will reintroduce 80/443.

## Browser Support
- Chrome 90+, Firefox 90+, Safari 15+, Edge 90+
- Mobile: iOS Safari 15+, Android Chrome 90+
- Light theme only (bg-white, text-slate-800) across all pages

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
