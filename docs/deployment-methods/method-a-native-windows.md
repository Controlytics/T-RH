# Method A: Native Windows Install

**Status: CHOSEN METHOD — now shipped as the Setup.exe installer — HISTORICAL EVALUATION DOC**

> **This is the method DigiLog ships — now productized as the `DigiLog-Setup-<ver>.exe` installer.** The installer bundles its own **portable PostgreSQL** and registers the `DigiLogDB` + `DigiLogAPI` Windows services, so the "five separate installers to manage" (Node + PostgreSQL + Memurai + EMQX + Nginx) that this doc's body treats as Method A's main *con* **no longer apply** — the installer handles it. The multi-service stack below is also gone: TimescaleDB + MQTT/EMQX/Mosquitto removed 2026-06, Redis/Memurai 2026-05, Nginx + PM2 in Phase 4, the server-side PDF engine 2026-07-04. The current stack is PostgreSQL 18 (`digilog_db`) + one Node process (Fastify serving the SPA + `/api/*` on `:3000` HTTPS). **For the deployment runbook see [`docs/PHARMA_DEPLOYMENT_21CFR.md`](../PHARMA_DEPLOYMENT_21CFR.md)** and [`tasks/EXE-PACKAGING-PLAN.md`](../../tasks/EXE-PACKAGING-PLAN.md). The prose below is preserved as the original evaluation rationale for *why* native Windows was chosen.

Install PostgreSQL, Memurai, EMQX, Nginx, and Node.js directly on Windows. PM2 manages the API process.

---

## How It Works

Each service is installed as a standalone Windows application:

| Software | Version | Install Method | Runs As |
|---|---|---|---|
| Node.js | 20+ or 22+ | MSI installer | PM2 manages it |
| PostgreSQL 18 | + TimescaleDB | EDB installer + Stack Builder | Windows Service (auto) |
| Memurai | Developer/Enterprise | MSI installer | Windows Service (auto) |
| EMQX | 5.x | ZIP extract | Windows Service or manual |
| Nginx | Stable | ZIP extract | Manual or NSSM service |

## Pros

### 1. Simple to Understand
Every service is a visible Windows program. The client's IT team can find them in Task Manager, Windows Services, and installed programs. No abstraction layers.

### 2. No Docker Knowledge Needed
Factory IT teams manage Active Directory, printers, and Windows updates. They understand Windows Services. Docker, containers, and Linux are foreign concepts they don't need to learn.

### 3. Packaged Installer (updated)
This pro is now realised as the **`DigiLog-Setup-<ver>.exe`** installer — even less for client IT to do than the loose scripts this doc originally listed:
- `scripts/build-installer.ps1` — builds the bundle + portable Postgres + `Setup.exe` (Inno Setup)
- `scripts/install.ps1` → `provision-db.ps1` + `register-services.ps1` — run by the installer (DB + `DigiLogDB`/`DigiLogAPI` services)
- `scripts/upgrade.ps1` — data-safe in-place upgrade
- `docs/PHARMA_DEPLOYMENT_21CFR.md` — deployment runbook + printable 21 CFR checklist
- *(the original loose scripts `package-for-production.ps1` / `install-on-target.ps1` / `start-digilog.bat` / `stop-digilog.bat` were removed)*

### 4. Direct Filesystem Access
Config files, logs, uploads, and backups are all in standard Windows folders. Client can browse to `C:\DigiLog\`, open files in Notepad, copy backups to USB drives.

### 5. Lowest RAM Overhead
No virtualization layer. Services run directly on the OS.

| Component | RAM Usage |
|---|---|
| Node.js API | ~200 MB |
| PostgreSQL | ~200 MB |
| Memurai | ~50 MB |
| EMQX | ~300 MB |
| Nginx | ~20 MB |
| **Total** | **~770 MB** |

### 6. No Internet Required
Everything runs on the local network. Internet outages don't affect the application.

### 7. Data Stays On-Premises
All data is on the client's physical server. No third-party cloud access. Simple for 21 CFR Part 11 compliance.

---

## Cons

### 1. Five Separate Installers to Manage

Each service has its own installation steps, configuration file format, update process, log location, and Windows Service registration.

| Software | Config File | Log Location |
|---|---|---|
| Node.js API | `.env` | PM2 logs (`pm2 logs`) |
| PostgreSQL | `postgresql.conf` | `pg_log/` directory |
| Memurai | `memurai.conf` | Windows Event Log |
| EMQX | `emqx.conf` | `log/` in EMQX directory |
| Nginx | `nginx.conf` | `logs/` in Nginx directory |

**Impact:** When something breaks, you have to check 5 different places. Compare to Docker where `docker-compose ps` and `docker-compose logs` show everything.

**Mitigation:** Your install script handles initial setup. Create a `check-health.ps1` script that checks all 5 services in one command.

---

### 2. Memurai is a Redis Clone, Not Real Redis

Memurai is a Windows port of Redis maintained by a third-party company, not by the Redis team.

**What works fine today:**
- BullMQ job queues
- Pub/sub for WebSocket events
- All current DigiLog features

**Potential problems:**
- **Version lag** — Redis is at 7.4+, Memurai tracks ~Redis 7.2. New Redis features arrive months later.
- **License** — Memurai Developer Edition has a "not for production" clause. Enterprise requires a paid license (contact Memurai for pricing).
- **Community support** — Tiny community compared to Redis. Very few Stack Overflow answers.
- **Testing gap** — BullMQ and Node.js Redis libraries test against real Redis, not Memurai. Subtle protocol differences could surface during upgrades.

**Real scenario:** You upgrade BullMQ to a new version that uses a Redis 7.4 command. It works on real Redis everywhere. On Memurai it crashes because that command isn't implemented yet.

**Mitigation:** Pin BullMQ version. Don't upgrade Redis libraries without testing against Memurai first.

---

### 3. EMQX Windows Builds Lag Behind Linux

EMQX is primarily a Linux product. Windows builds are secondary.

- **Release delay** — Windows builds may come days/weeks after Linux releases
- **Missing features** — Some plugins are Linux-only
- **Less testing** — EMQX CI/CD pipeline focuses on Linux
- **Performance** — Erlang/OTP (EMQX runtime) is ~10-20% slower on Windows
- **No systemd** — Must create Windows Service manually or use NSSM

**Impact for your app:** Low at current scale. Your MQTT usage is basic (filter events, IoT telemetry). Would matter if scaling to hundreds of IoT devices.

---

### 4. No Isolation — One Bad Update Can Break Everything

All services share the same Windows OS. No containers or sandboxes.

**What can go wrong:**
- **Windows Update breaks Node.js** — Security patch changes DLL loading. API crashes.
- **PostgreSQL upgrade breaks TimescaleDB** — Extension not compatible with new PG version.
- **Port conflicts** — Client installs another app that takes port 3000 or 5432.
- **PATH pollution** — Client installs different Node.js version for another app.
- **DLL conflicts** — Two apps need different Visual C++ runtime versions.
- **Antivirus interference** — Windows Defender quarantines `node.exe` or Memurai data files.

**Real scenario:** IT pushes a Windows Update overnight. Next morning Memurai won't start due to a networking change. API logs show "Redis connection refused." You debug for hours before realizing it's a Windows Update issue.

**Mitigation:** Test after every Windows Update cycle. Create a restore point before updates. Document which Windows components each service depends on.

---

### 5. Manual Version Upgrades for Each Component

No automated update mechanism. Each upgrade is manual:

| Component | Upgrade Process |
|---|---|
| Node.js | Download new MSI, run installer, restart PM2 |
| PostgreSQL | EDB upgrade wizard, possibly `pg_upgrade` for major versions |
| TimescaleDB | Download new DLL, replace in PG extensions, `ALTER EXTENSION` |
| Memurai | Download new MSI, run installer, restart service |
| EMQX | Download new ZIP, replace folder, reconfigure, restart |
| Nginx | Download new ZIP, replace exe, test config, restart |

**Problems:**
- No rollback if upgrade fails
- Downtime during upgrades (especially PostgreSQL major versions)
- Must manually verify compatibility between all component versions
- Client may never upgrade, running old versions with security vulnerabilities

**Mitigation:** Document a tested compatibility matrix. Only upgrade when necessary. Create full backup before any upgrade.

---

### 6. No Easy Rollback

If a deployment goes wrong:

1. Find the previous `digilog-production.zip` (do you still have it?)
2. Stop PM2
3. Delete current `api/` folder
4. Extract old `api/` from old ZIP
5. Run `npm ci --omit=dev` again (5-10 minutes)
6. Maybe rollback database migrations (Prisma has no built-in down migration)
7. Restart PM2
8. Hope the old code works with the current database schema

**The danger:** If the new version added database columns, old code ignores them (usually fine). If the new version dropped or renamed columns, old code crashes.

**Mitigation:** Always backup the database before deploying. Keep previous 3 versions of the ZIP. Test migrations in a staging environment first.

---

### 7. Service Auto-Start is Not Automatic for All Services

| Service | Auto-starts on boot? | How |
|---|---|---|
| PostgreSQL | Yes | Windows Service (EDB installer) |
| Memurai | Yes | Windows Service (MSI installer) |
| EMQX | Depends | Some versions auto-register, some don't |
| Nginx | No | Must use NSSM to create a service |
| API (PM2) | No | Must run `pm2-startup install` (flaky on Windows) |

**PM2 on Windows issues:**
- `pm2-startup` uses `pm2-windows-startup` npm package (not updated since 2021)
- Creates a scheduled task, not a proper Windows Service
- If Windows user account changes or password expires, PM2 won't start
- Windows Updates can silently disable the startup task

**Real scenario:** Power outage → server reboots → PostgreSQL and Memurai come back → PM2 doesn't start → API is down → nobody notices until a tablet user reports "can't log in."

**Mitigation:** Use NSSM for ALL services including the API (replace PM2 with NSSM). Set up a scheduled task that checks service health every 5 minutes.

---

### 8. Remote Debugging is Harder

Compared to Linux (`ssh user@server`), Windows remote access requires:
- RDP (Remote Desktop) — needs port open, may conflict with client firewall
- TeamViewer/AnyDesk — client must install and accept
- PowerShell Remoting (WinRM) — requires configuration

Once connected, no `grep`, `tail -f`, `top` by default. PowerShell equivalents are more verbose.

**Mitigation:** Set up RDP during initial deployment. Create diagnostic scripts that the client can run and email the output.

---

## When to Use Method A

- Client is a factory with basic Windows admin skills
- Single-server deployment
- Data must stay on-premises
- 21 CFR Part 11 compliance required
- No Docker experience at client site
- Budget-conscious (no cloud or Docker license costs)

## When NOT to Use Method A

- Client specifically requests Docker
- Client mandates IIS
- Multiple servers / high availability required
- Dev team wants identical environments everywhere
