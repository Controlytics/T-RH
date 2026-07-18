# Method D: Hybrid (Docker Infra + Native App)

**Status: Niche use case — only for technical teams — HISTORICAL EVALUATION DOC**

> **2026-04-29 update:** windows-friendly-rewrite changed the stack: EMQX → Mosquitto 2.0, BullMQ + Memurai → graphile-worker on Postgres (no separate queue service), Nginx + PM2 → Fastify-direct on `:3000`. This evaluation predates those swaps; DigiLog now ships as the native-Windows `DigiLog-Setup-<ver>.exe` installer, and the deployment runbook is [`docs/PHARMA_DEPLOYMENT_21CFR.md`](../PHARMA_DEPLOYMENT_21CFR.md).
>
> **2026-06 update (Phase 7):** the entire data-ingestion subsystem — MQTT (Mosquitto), TimescaleDB, and Redis — was removed. The MQTT-broker, TimescaleDB, and Redis containers shown below **no longer apply**; DigiLog now runs on a single vanilla PostgreSQL 18 database with no broker or cache service. This page is retained as a historical evaluation only.

PostgreSQL, Redis, and EMQX run in Docker containers. API and Nginx run natively on Windows.

---

## How It Works

```
Docker (infrastructure services):
├── timescale/timescaledb:latest-pg18   (:5432)
├── redis:7-alpine                       (:6379)
└── emqx/emqx:5                         (:1883, :18083)

Native Windows (application layer):
├── Node.js + PM2 → digilog-api         (:3000)
└── Nginx → serves SPA + reverse proxy  (:80, :443)
```

Infrastructure in containers (easy to upgrade, real Redis). Application runs natively (easy to debug, direct filesystem access).

## Pros

### 1. Real Redis + Real EMQX Images
Official Docker images. No Memurai dependency. No EMQX Windows build lag.

### 2. Easy Database Upgrades
Change one line in `docker-compose.yml`:
```yaml
# Before
image: timescale/timescaledb:2.16-pg18
# After
image: timescale/timescaledb:2.17-pg18
```
Run `docker-compose up -d postgres`. Done.

### 3. API Runs Natively — Easy to Debug
```powershell
pm2 logs digilog-api           # direct log access
notepad C:\DigiLog\api\.env    # edit config directly
curl -k https://localhost:3000 # test immediately
```
No `docker exec` needed for the API.

### 4. Database Volumes Survive Container Rebuilds
Docker volumes persist data independently of containers. Rebuild or upgrade containers without losing data.

---

## Cons

### 1. Still Needs Docker Desktop

Same licensing and installation issues as Method B. Enterprise clients need approval.

| Tier | Cost |
|---|---|
| Personal (small companies) | Free |
| Pro | $5/user/month |
| Business | $24/user/month |

**Impact:** High — can block deployment at enterprise clients.

---

### 2. Two Management Paradigms

The admin needs to know BOTH Docker AND native Windows:

| Service | Location | Check Status | Restart | View Logs |
|---|---|---|---|---|
| PostgreSQL | Docker | `docker-compose ps` | `docker-compose restart postgres` | `docker logs postgres` |
| Redis | Docker | `docker-compose ps` | `docker-compose restart redis` | `docker logs redis` |
| EMQX | Docker | `docker-compose ps` | `docker-compose restart emqx` | `docker logs emqx` |
| API | Native | `pm2 list` | `pm2 restart digilog-api` | `pm2 logs digilog-api` |
| Nginx | Native | Task Manager | `nginx -s reload` | `logs/error.log` |

**The confusion:**
- "Database is down" → use Docker commands
- "API is down" → use PM2 commands
- "Website not loading" → check Nginx native logs

No single dashboard. No single restart command. Two mental models required.

**Real scenario:** Client calls: "nothing works." You walk them through:
1. `docker-compose ps` — check containers
2. `pm2 list` — check API
3. Check Nginx process in Task Manager

Three different tools, three different interfaces. Client gets confused.

---

### 3. Network Bridging Between Docker and Native

Docker containers run in their own network. The native API connects to containers via port mapping.

```
Native API (localhost:3000)
  → connects to → Docker PostgreSQL (localhost:5432 via port mapping)
  → connects to → Docker Redis (localhost:6379 via port mapping)
  → connects to → Docker EMQX (localhost:1883 via port mapping)
```

**Problems:**
- **Port conflicts** — If Windows already has PostgreSQL installed natively, port 5432 is taken. Docker can't map to it.
- **Firewall interference** — Windows Firewall may block Docker's port mappings while allowing native services
- **Latency** — Traffic crosses the Hyper-V/WSL2 network bridge. Adds ~1-2ms per query. Page with 20 queries = 20-40ms extra.

---

### 4. Backup Complexity

Database lives inside Docker. Backups need Docker commands:

```powershell
# Native backup (simple):
pg_dump -U digilog -F c -f backup.dump digilog_db

# Docker backup (needs exec):
docker exec digilog-postgres pg_dump -U digilog -F c digilog_db > backup.dump
```

**Volume locations:**
- Database files are in Docker volumes, not visible Windows folders
- Location: `\\wsl$\docker-desktop-data\data\docker\volumes\...`
- Client can't browse to the folder and copy files

---

### 5. Split Auto-Start Configuration

| Service | Auto-start method |
|---|---|
| Docker containers | Docker Desktop auto-start + `restart: always` |
| API (PM2) | `pm2-startup install` (flaky on Windows) |
| Nginx | NSSM service wrapper |

Three different auto-start mechanisms. If any one fails, part of the app is down.

---

### 6. No Existing Scripts

Unlike Method A (which has `install-on-target.ps1` and `package-for-production.ps1`), the hybrid approach has no pre-built scripts. You would need to write:
- Docker Compose file for infra services only
- Modified install script that sets up both Docker and native
- Modified health check script that checks both Docker and PM2
- Modified backup script using Docker exec

---

## When to Use Method D

- Technical team that wants reliable database infrastructure (real Redis, easy PG upgrades) but needs easy API debugging
- Dev team manages the server directly
- Server has 16+ GB RAM

## When NOT to Use Method D

- Client IT manages the server (two paradigms is too confusing)
- You want pre-built deployment scripts (none exist for this method)
- Simple single-server deployment (Method A is simpler)
