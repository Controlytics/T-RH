# DigiLog — Session Resume Point

**Last Updated:** 2026-04-14
**Branch:** `RFID`
**Status:** Phase 3 active development. Permissions overhaul, color themes, report settings, PM redesign, reauth fixes completed this session.

### Current Session Changes (2026-04-14)
- **Permissions overhaul** — Expanded from 52 to 95 granular permissions, 82 feature toggles, 69 re-authentication actions
- **Color themes** — 10 preset color palettes via themes.ts + CSS variables + use-branding hook
- **Report settings** — Configurable header/footer/layout stored in config, applied via ReportPageWrapper
- **PM Schedule redesign** — QA approval workflow, filter-set selection modes, CSV upload with past-date validation
- **Reauth fixes** — 69 sensitive actions now enforce re-authentication
- **Config discovery** — 24 auto-discovered config definitions (up from 23)
- **Block change approval** — Cross-block approval with desktop+mobile popup, single-use consumption, mandatory remarks

### Pending Work
- Theme colors not yet applied to all pages (mobile, alarms, rule chains, etc.)
- `config/index.tsx` cards still use hardcoded gradients instead of theme colors
- APK needs rebuild after RFID branch changes

### Application State
- **Backend:** Fastify + TypeScript, 34 API modules, port 3000
- **Frontend:** React + Vite SPA + Tailwind CSS, port 5175 (dev)
- **Database:** PostgreSQL 18 + Prisma ORM (57 models, 17 enums) + TimescaleDB (7 hypertables)
- **Queue:** BullMQ + Redis 5
- **MQTT:** EMQX broker (port 1883/18083)
- **Monorepo:** apps/api, apps/web, apps/android, packages/shared, packages/db, packages/queue

### EC2 Instance
- **IP:** 34.232.224.0
- **SSH:** `ssh -i ~/Downloads/21cfrbook.pem ubuntu@34.232.224.0`
- **Login:** superadmin / Admin@123

### Windows Local Development
- Redis 5: `C:\Users\hello\redis5\redis-server.exe`
- EMQX: `C:\Users\hello\emqx\bin\emqx.cmd`
- PostgreSQL 18: auto-starts as service
- API: `cd apps/api && npx tsx watch src/app.ts`
- Frontend: `cd apps/web && npx vite --host`
- Start script: `start-digilog.bat`
