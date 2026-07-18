# DigiLog — Local Windows Setup Guide

**Purpose:** This file contains everything Claude (or a developer) needs to clone, set up, and run the DigiLog application locally on a Windows machine. Follow every step exactly.

> ⚠️ **2026-06-17 — TimescaleDB + Mosquitto no longer required.** The data-ingestion subsystem was removed in Phase 7 of the cleanup. You only need vanilla PostgreSQL 18 (no TimescaleDB extension), no MQTT broker, and no telemetry-related `.env` keys (`TSDB_*` / `MQTT_*` / `EMQX_*` / `UNS_ROOT_PREFIX` are all gone). This guide has been updated accordingly. See `CHANGELOG.md` Phase 7 entry + root `CLAUDE.md` System Stats for what's current.

---

## 1. Prerequisites — Install These First

### 1.1 Node.js v20 (LTS)
- Download: https://nodejs.org/en/download — select **v20.x LTS** (NOT v22)
- Verify: `node -v` should show `v20.x.x`
- npm comes bundled: `npm -v` should show `10.x.x`

### 1.2 PostgreSQL 18
- Download PostgreSQL 18: https://www.postgresql.org/download/windows/
- During install: remember the superuser password (e.g. `postgres`)
- Port: **5432** (default)
- No TimescaleDB extension is needed — the time-series subsystem was removed in Phase 7 (2026-06-17). Vanilla PostgreSQL 18 is all DigiLog requires.

### 1.3 Redis — RETIRED (Phase 4, 2026-05-01)
DigiLog no longer uses Redis. **Do not install Memurai or Redis.** Phase 2
moved the job queue to Postgres (graphile-worker); Phase 4 moved pub/sub
and RPC correlation in-process (EventEmitter bus + Map TTL cache). Skip
this section entirely — there is nothing to install for the pub/sub layer.

### 1.4 Git
- Download: https://git-scm.com/download/win
- Verify: `git --version`

> **No MQTT broker required.** The data-ingestion subsystem (Mosquitto/MQTT,
> TimescaleDB) was removed wholesale in Phase 7 (2026-06). There is no broker
> to install for local dev.

---

## 2. Clone the Repository

```bash
git clone https://github.com/pankajexa/21cfrlogbook.git
cd 21cfrlogbook
git checkout DigitalFMS
```

---

## 3. Create Databases

Open **pgAdmin** or **psql** and run:

```sql
-- Create the application user
CREATE USER digilog WITH PASSWORD 'digilog123';

-- Create the main database (Prisma)
CREATE DATABASE digilog_db OWNER digilog;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE digilog_db TO digilog;

-- Connect to digilog_db and enable pgcrypto (used for UUID / hashing)
\c digilog_db
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO digilog;
```

> **Note:** There is only one application database now — `digilog_db` (Prisma).
> The former `digilog_tsdb` TimescaleDB database was dropped in Phase 7
> (2026-06-17) along with the data-ingestion subsystem.

---

## 4. Create Environment Files

### 4.1 Root `.env` (copy to project root AND `apps/api/.env`)

Create the file `21cfrlogbook/.env` with this content:

```env
# --- PostgreSQL (Prisma) ---
DATABASE_URL=postgresql://digilog:digilog123@localhost:5432/digilog_db?schema=public

# --- Redis — RETIRED (Phase 4, 2026-05-01) ---
# Pub/sub moved in-process via EventEmitter bus. RPC correlation moved to
# Map TTL cache. REDIS_* env vars are no longer read by anything.
# (TimescaleDB / MQTT env keys were removed in Phase 7 — none are read anymore.)

# --- SMTP (optional) ---
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=

# --- JWT Configuration ---
JWT_SECRET=LOCAL_DEV_SECRET_CHANGE_IN_PRODUCTION_1234567890abcdefghijklmnopqrstuvwxyz
VERIFICATION_TOKEN_SECRET=LOCAL_DEV_VERIFY_SECRET_CHANGE_IN_PRODUCTION_1234567890abcdefghijklmn
JWT_EXPIRES_IN=8h

# --- Server Configuration ---
NODE_ENV=development
API_PORT=3000

# --- CORS Configuration ---
CORS_ORIGIN=http://localhost:5175
ALLOWED_ORIGINS=http://localhost:5175,http://localhost:3000

# --- Upload Configuration ---
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880
```

**IMPORTANT:** Copy the same file to `apps/api/.env`:
```bash
cp .env apps/api/.env
```

---

## 5. Install Dependencies

```bash
npm install
```

This installs all dependencies for the monorepo (root + apps/api + apps/web + packages/*).

---

## 6. Set Up the Database

### 6.1 Generate Prisma Client
```bash
cd apps/api
npx prisma generate
```

### 6.2 Run Migrations
```bash
npx prisma migrate deploy
```

> This creates all 61 model tables including the Phase 2 filter management tables, equipment groups, and checklist profiles.

### 6.3 Seed the Database
```bash
npx prisma db seed
```

> This creates: 6 default roles (SUPER_ADMIN through VIEWER), superadmin user (username: `superadmin`, password: `Admin@123`), system config entries (auto-discovered), permission constants, and the system template kinds (DigiLog is single-tenant, no organizations created).

```bash
cd ../..
```

---

## 7. Build the Project

```bash
npm run build
```

This runs `turbo build` which builds all packages in dependency order:
1. `@digilog/shared` (shared types)
2. `@digilog/queue` (graphile-worker wrapper)
3. `@digilog/api` (Fastify backend — TypeScript -> JavaScript)
4. `@digilog/web` (React frontend — Vite build)

---

## 8. Run the Application

### 8.1 Development Mode (with hot reload)

Open **two terminals**:

**Terminal 1 — Backend API:**
```bash
cd apps/api
npx tsx watch src/app.ts
```
API runs on http://localhost:3000

**Terminal 2 — Frontend:**
```bash
cd apps/web
npx vite --host
```
Frontend runs on http://localhost:5175

### 8.2 Using Batch Scripts
```bash
start-digilog.bat    # Starts API and Frontend (no Redis, no MQTT broker)
stop-digilog.bat     # Stops all services
```

### 8.3 Production Mode

```bash
# Build first
npm run build

# Start API
cd apps/api
node dist/app.js

# Serve frontend (use any static server)
cd ../web
npx vite preview
```

---

## 9. Verify It Works

1. Open http://localhost:5175 in your browser
2. Login: **superadmin** / **Admin@123**
3. You should see the dashboard
4. Check the sidebar for:
   - Filter Operations
   - Cleaning Cycles
   - Checklists
   - Cleaning Profiles
   - Filter Profiles
   - PM Schedules
   - Equipment Groups

### API Health Check
```bash
curl http://localhost:3000/api/health
# or in browser: http://localhost:3000/docs (Swagger UI)
```

---

## 10. Project Structure

```
21cfrlogbook/
├── apps/
│   ├── api/                    # Fastify backend (TypeScript)
│   │   ├── prisma/
│   │   │   ├── schema.prisma   # Database schema (61 models, 23 enums)
│   │   │   ├── seed.ts         # Database seeder
│   │   │   └── migrations/     # SQL migrations
│   │   └── src/
│   │       ├── app.ts          # Entry point
│   │       ├── modules/        # 33 API modules
│   │       ├── plugins/        # Auth, CORS, etc.
│   │       └── lib/            # Shared utilities
│   ├── web/                    # React frontend (Vite + Tailwind)
│   │   └── src/
│   │       ├── main.tsx        # Router + routes
│   │       ├── routes/         # 20+ route groups
│   │       ├── components/     # Shared components
│   │       └── lib/            # API client, hooks
│   └── android/                # Capacitor Android app
├── packages/
│   ├── shared/                 # Shared types & Zod schemas
│   └── queue/                  # graphile-worker wrapper (Postgres-backed)
├── turbo.json                  # Turborepo build config
├── start-digilog.bat           # Windows start script
├── stop-digilog.bat            # Windows stop script
└── package.json                # Root workspace config
```

---

## 11. Key Configuration

| Config | Value | Notes |
|--------|-------|-------|
| API Port | 3000 | Fastify backend |
| Web Dev Port | 5175 | Vite dev server |
| PostgreSQL | localhost:5432 | User: digilog, DB: digilog_db (PG 18) |
| ~~Redis~~ | ~~localhost:6379~~ | RETIRED (Phase 4) — pub/sub now in-process |
| Default Login | superadmin / Admin@123 | Created by seed |

---

## 12. Common Commands

```bash
# Install dependencies
npm install

# Build everything
npm run build

# Run dev mode (both API + Web)
npm run dev

# Database commands
cd apps/api
npx prisma generate          # Regenerate Prisma client
npx prisma migrate dev       # Create + apply new migration
npx prisma migrate deploy    # Apply pending migrations
npx prisma db seed           # Seed default data
npx prisma studio            # Visual DB browser on localhost:5555

# Run tests
npx turbo run test

# Build only API
npx turbo build --filter=@digilog/api

# Build only Web
npx turbo build --filter=@digilog/web
```

---

## 13. Troubleshooting

### "Module not found" errors
```bash
npm install
npx turbo build --force
```

### Prisma client errors
```bash
cd apps/api
npx prisma generate
cd ../..
npm run build
```

### Database connection errors
- Check PostgreSQL is running: `pg_isready`
- (Phase 4: Redis is no longer used; this step is no longer needed.)
- Verify .env DATABASE_URL matches your PostgreSQL credentials
- Ensure the `digilog_db` database exists (there is no longer a separate TimescaleDB database)

### Port conflicts
- API (3000): `netstat -ano | findstr :3000`
- Web (5175): `netstat -ano | findstr :5175`
- PostgreSQL (5432): `netstat -ano | findstr :5432`
- (Phase 4: Redis port 6379 is no longer used by DigiLog.)

### Windows-specific issues
- Use **Git Bash** or **WSL2** for running commands (not CMD)
- If `bcrypt` fails to install, run: `npm install --build-from-source bcrypt`
- If `sharp` errors occur: `npm install --platform=win32 --arch=x64 sharp`

---

## 14. Git Information

| Field | Value |
|-------|-------|
| Repository | https://github.com/pankajexa/21cfrlogbook.git |
| Branch | DigitalFMS |

---

## 15. Architecture Summary

- **Backend:** Fastify 5 + TypeScript + Prisma ORM + graphile-worker job queue
- **Frontend:** React 19 + Vite 6 + Tailwind CSS 4 + SWR + React Router 7
- **Database:** PostgreSQL 18 + Prisma migrations (single `digilog_db` database)
- **Queue:** PostgreSQL + graphile-worker (notification, PM-overdue, session-sweep tasks + cron)
- **Auth:** JWT tokens with bcrypt password hashing, session management

### Phase 2: Digital Filter Management System
- 6 backend modules: cleaning-profiles, filter-profiles, filter-operations, pm-schedules, checklist-profiles, equipment-groups
- 14+ frontend pages: operations, profiles, cycles, checklists, PM, AHU dashboard, traceability, equipment, bulk-upload, retirement
- 11+ database tables: filter_cleaning_profiles, filter_pipeline_stages, filter_pipeline_connections, filter_profiles, cleaning_cycles, filter_events, pm_schedules, pm_schedule_entries, pm_executions, equipment_groups, equipment_group_instruments, checklist_profiles, checklist_questions
- Visual pipeline editor with STAGE, CHECKLIST, START, END nodes
- Server-side checklist enforcement, race condition protection, input sanitization

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
