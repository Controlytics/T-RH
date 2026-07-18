# Method B: Docker Compose on Windows

**Status: Good alternative if client knows Docker — HISTORICAL EVALUATION DOC**

> **2026-04-29 update:** the bundled `docker-compose.yml` was updated to `eclipse-mosquitto:2.0` (replacing the EMQX image) in Phase 1 of the windows-friendly-rewrite. BullMQ + Memurai are no longer required — the queue runs inside Postgres via graphile-worker. Reports use Edge headless via `puppeteer-core` (Phase 3). DigiLog now ships as the native-Windows `DigiLog-Setup-<ver>.exe` installer (not Docker); for the deployment runbook see [`docs/PHARMA_DEPLOYMENT_21CFR.md`](../PHARMA_DEPLOYMENT_21CFR.md). This page is the original Docker-Compose evaluation.
>
> **2026-06 update (Phase 7):** the entire data-ingestion subsystem — MQTT (Mosquitto), TimescaleDB, and Redis — was removed. The MQTT-broker, TimescaleDB, and Redis containers shown in the diagrams below **no longer apply**; DigiLog now runs on a single vanilla PostgreSQL 18 database with no broker or cache service. This page is retained as a historical evaluation only.

All services run as Docker containers. One `docker-compose up -d` starts everything.

---

## How It Works

```
Docker Desktop / Docker Engine (Hyper-V / WSL2)
├── postgres:18-timescaledb    (database)
├── redis:7-alpine             (job queue + cache)
├── emqx/emqx:5               (MQTT broker)
├── nginx:stable-alpine        (reverse proxy + SPA)
└── digilog-api:latest         (custom Dockerfile — your API)
```

All services defined in a single `docker-compose.yml`. Volumes for persistent data. Networks for inter-container communication.

## Pros

### 1. One Command to Start/Stop Everything
```powershell
docker-compose up -d      # start all
docker-compose down       # stop all
docker-compose ps         # check status
docker-compose logs -f    # stream all logs
```

### 2. Real Redis 7, Not Memurai Clone
Official Redis 7 Docker image. Fully tested, fully compatible with BullMQ and all Node.js libraries. No Memurai license concerns.

### 3. Identical Containers Everywhere
Same container runs on your dev machine, staging, and production. No "works on my machine" problems.

### 4. Easy Rollback
```powershell
# Rollback API to previous version
docker tag digilog-api:latest digilog-api:broken
docker tag digilog-api:previous digilog-api:latest
docker-compose up -d api
```
30 seconds, done. No reinstalling dependencies.

### 5. Volume Mounts for Data Persistence
Database data survives container rebuilds. Defined clearly in `docker-compose.yml`.

### 6. Auto-Restart on Boot
```yaml
services:
  api:
    restart: always
```
Docker Desktop auto-starts on Windows boot. Containers with `restart: always` come back automatically.

---

## Cons

### 1. Docker Desktop License Cost

Docker Desktop is **not free for business use** (companies with 250+ employees OR $10M+ revenue).

| Tier | Cost |
|---|---|
| Personal (small companies) | Free |
| Pro | $5/user/month |
| Team | $9/user/month |
| Business | $24/user/month |

**Impact:** Enterprise clients may need legal/procurement approval before installing Docker Desktop. This can delay deployment by weeks or months.

**Alternative:** Docker Engine (CLI only) can run on Windows Server via Hyper-V without Docker Desktop license. But setup is significantly harder with no GUI.

---

### 2. ~2GB RAM Overhead for Docker Engine

Docker on Windows runs Linux containers inside a WSL2 or Hyper-V virtual machine. This VM consumes memory before containers even start.

| Component | RAM Usage |
|---|---|
| WSL2/Hyper-V VM (base) | 1-2 GB |
| PostgreSQL container | ~200 MB |
| Redis container | ~50 MB |
| EMQX container | ~300 MB |
| Nginx container | ~20 MB |
| API container | ~200 MB |
| **Total** | **~2.5-3.5 GB** |

Compare to native install: ~770 MB total (no VM layer).

**Impact:** On servers with 8 GB RAM or less, Docker takes a significant portion. 16+ GB servers won't notice.

---

### 3. Windows Docker = Hyper-V/WSL2 Layer Adds Complexity

Docker on Windows doesn't run containers natively. Architecture:

```
Windows Server
└── Hyper-V / WSL2
    └── Linux VM (managed by Docker)
        ├── all containers run here
```

**Problems this causes:**
- **Hyper-V must be enabled** — some hardware doesn't support VT-x, some Server editions don't include Hyper-V
- **Conflicts with other virtualization** — VMware, VirtualBox can't coexist with Hyper-V
- **WSL2 networking quirks** — network bridge occasionally resets on reboot
- **File I/O across boundary** — Windows volumes mounted into containers are 2-5x slower than native
- **Time sync issues** — WSL2 VM clock can drift after sleep/hibernate, causing wrong timestamps

**Real scenario:** Server hibernates overnight. Next morning containers have timestamps 8 hours behind. Audit trail entries show wrong times. Fix: `wsl --shutdown` and restart Docker.

---

### 4. Client IT Needs Docker Knowledge

Factory IT teams know Windows Services, not Docker.

| Task | Docker Command | Difficulty for Windows admin |
|---|---|---|
| Check services | `docker-compose ps` | Unfamiliar |
| Read logs | `docker logs digilog-api --tail 100` | "Where's the log file?" |
| Restart one service | `docker-compose restart api` | "Can't I use Services?" |
| Update version | `docker-compose pull && up -d` | "What does pull mean?" |
| Check disk | `docker system df` | "C: is full but I can't find files" |
| Debug networking | `docker network inspect` | Gives up |

**Impact:** Every support call requires Docker knowledge. At 2 AM when the on-call IT person sees "app offline," they don't know `docker-compose restart`.

**Mitigation:** Create wrapper scripts (`check-status.ps1`, `restart-all.ps1`, `view-logs.ps1`) that hide Docker commands behind simple PowerShell scripts.

---

### 5. File I/O is Slower Through Docker on Windows

Docker volumes on Windows traverse multiple layers:

```
App inside container → Linux ext4 → WSL2/Hyper-V → Windows NTFS
```

| Operation | Native | Docker on Windows | Difference |
|---|---|---|---|
| PostgreSQL random reads | ~5,000 IOPS | ~2,500 IOPS | 2x slower |
| File write (uploads) | ~500 MB/s | ~200 MB/s | 2.5x slower |
| npm install | ~30 seconds | ~90 seconds | 3x slower |
| Prisma migrations | ~5 seconds | ~15 seconds | 3x slower |

**Impact for your app:** Bulk CSV upload of 500 filters takes ~10s native vs ~25s Docker. Normal page loads are barely affected.

---

### 6. Debugging Inside Containers is Harder

**Native debugging:**
```powershell
pm2 logs digilog-api                                    # check logs
psql -U digilog -d digilog_db -c "SELECT 1"            # check DB
notepad C:\DigiLog\api\.env                             # check config
curl -k https://localhost:3000/health                   # check API
```

**Docker debugging:**
```powershell
docker logs digilog-api --tail 100                                           # check logs
docker exec -it digilog-postgres psql -U digilog -d digilog_db -c "SELECT 1" # check DB
docker exec -it digilog-api cat /app/.env                                     # check config
curl -k https://localhost:3000/health                                         # check API
```

Additional Docker debugging pain:
- Container won't start → no logs → need `docker inspect` for exit code
- Network issues between containers → `docker network inspect`
- Disk full inside Docker but Windows shows free space → `docker system df`

---

### 7. Docker Image Size and Registry Management

| Image | Size |
|---|---|
| node:20-slim | ~200 MB |
| timescale/timescaledb:latest-pg18 | ~500 MB |
| emqx/emqx:5 | ~300 MB |
| redis:7-alpine | ~30 MB |
| nginx:stable-alpine | ~40 MB |
| Your API image | ~300 MB |
| **Total** | **~1.4 GB** |

- First deployment needs ~1.4 GB download
- Old images accumulate over time
- Docker's WSL2 virtual disk can grow to 50+ GB without cleanup
- Client won't know to run `docker system prune`

---

### 8. Docker Compose Restart Loops Can Hide Problems

With `restart: always`, containers auto-restart on crash.

**The problem:** A container with a fatal config error restart-loops forever:
- CPU spikes to 100%
- Container shows "Up 3 seconds" — looks running but is crash-looping
- Logs fill up with repeated crash messages
- Docker's log driver doesn't rotate by default on Windows

**Real scenario:** Database password changes but API container has old password. Container crashes, restarts, crashes — 1000 times/hour. Logs consume 10 GB.

**Mitigation:** Use `restart: on-failure` with `max-retries`. Configure Docker log rotation.

---

## When to Use Method B

- Dev team manages the server (not client IT)
- Client IT has Docker experience
- You want identical dev/staging/production environments
- Easy rollback is a priority
- Server has 16+ GB RAM

## When NOT to Use Method B

- Client IT doesn't know Docker
- Enterprise client requiring license approval
- Server has limited RAM (8 GB or less)
- Client wants direct filesystem access to everything
