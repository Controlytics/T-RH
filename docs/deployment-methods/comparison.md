# Deployment Methods — Side-by-Side Comparison & Final Verdict

> **HISTORICAL EVALUATION — stack has changed since this was written.** DigiLog now ships as a single **`DigiLog-Setup-<ver>.exe`** (Inno Setup) installer that bundles its own portable PostgreSQL + registers Windows services — i.e. **Method A (Native Windows), productized**. The multi-service stack the tables below compare (EMQX/Mosquitto MQTT, Redis/Memurai, TimescaleDB, Nginx, PM2) has been **removed** (TimescaleDB + MQTT 2026-06, Redis 2026-05, Nginx/PM2 Phase 4, server-side PDF engine 2026-07-04); the current stack is PostgreSQL 18 (`digilog_db`) + one Node process. The matrix below is retained as the **decision record** — why native Windows was chosen over Docker / IIS / cloud — not as a current install guide. **For the deployment runbook read [`docs/PHARMA_DEPLOYMENT_21CFR.md`](../PHARMA_DEPLOYMENT_21CFR.md).**

---

## Feature Comparison

| Factor | A: Native Windows | B: Docker Compose | C: WSL2 Linux | D: Hybrid | E: IIS | F: Cloud |
|---|---|---|---|---|---|---|
| **Setup difficulty** | Medium | Medium | Hard | Hard | Hard | Hard |
| **Ongoing maintenance** | Medium | Low | Medium | High | Medium | Low |
| **Client IT skill needed** | **Low** | High | High | High | Medium | High |
| **Reliability** | Good | Good | **Fragile** | Good | Good | Good* |
| **Internet required** | **No** | **No** | **No** | **No** | **No** | **YES** |
| **Data on-premises** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **No** |
| **21 CFR compliance** | **Easy** | Easy | Easy | Easy | Easy | **Hard** |
| **Cost** | **$0** | License | $0 | License | $0 | **$200+/mo** |
| **Scripts already built** | **Yes** | Partial | Partial | No | No | No |
| **Rollback ease** | Hard | **Easy** | Medium | Medium | Hard | **Easy** |
| **RAM overhead** | **~770 MB** | ~3 GB | ~1.5 GB | ~2 GB | ~800 MB | N/A |
| **Redis quality** | Memurai (clone) | **Real Redis 7** | **Real Redis 7** | **Real Redis 7** | Memurai (clone) | **Managed Redis** |
| **Auto-start on boot** | Manual setup | **Automatic** | Manual | Mixed | **Automatic** | **Managed** |
| **Remote debugging** | Medium | Hard | Medium | Hard | Medium | Hard |
| **Static file performance** | Fast (Nginx) | Fast (Nginx) | Fast (Nginx) | Fast (Nginx) | **Slower (IIS)** | Fast |
| **WebSocket reliability** | **Stable** | **Stable** | Fragile | **Stable** | **Fragile** | **Stable** |

*Cloud reliability depends on internet connectivity

---

## Con Severity Matrix

### Critical Cons (can block deployment)

| Con | Methods Affected |
|---|---|
| Internet required for operation | F (Cloud) |
| Data off-premises (21 CFR compliance) | F (Cloud) |
| Docker Desktop license for enterprise | B (Docker), D (Hybrid) |
| Windows Server version incompatibility | C (WSL2) |
| Port forwarding breaks on reboot | C (WSL2) |

### High-Severity Cons (significant ongoing pain)

| Con | Methods Affected |
|---|---|
| Client IT needs Docker knowledge | B (Docker), D (Hybrid) |
| Client IT needs Linux knowledge | C (WSL2) |
| Two management paradigms | D (Hybrid) |
| IIS reverse proxy complexity | E (IIS) |
| IIS WebSocket fragility | E (IIS) |
| WSL2 networking resets | C (WSL2) |
| Monthly cloud costs | F (Cloud) |
| EMQX not managed in cloud | F (Cloud) |

### Medium-Severity Cons (manageable)

| Con | Methods Affected |
|---|---|
| No isolation (Windows Update risk) | A (Native), E (IIS) |
| Manual version upgrades | A (Native), E (IIS) |
| No easy rollback | A (Native), E (IIS) |
| PM2 auto-start flaky on Windows | A (Native), D (Hybrid) |
| RAM overhead | B (Docker), C (WSL2), D (Hybrid) |
| File I/O slower | B (Docker), C (WSL2) |
| Debugging inside containers | B (Docker) |
| Cross-filesystem speed | C (WSL2) |
| Backup complexity with Docker | B (Docker), D (Hybrid) |

### Low-Severity Cons (minor inconvenience)

| Con | Methods Affected |
|---|---|
| Memurai vs real Redis | A (Native), E (IIS) |
| EMQX Windows build lag | A (Native), E (IIS) |
| Docker image size / disk growth | B (Docker), D (Hybrid) |
| Docker restart loops hiding problems | B (Docker), D (Hybrid) |
| IIS slower static serving | E (IIS) |
| Cloud latency | F (Cloud) |

---

## Decision Matrix by Client Type

### Factory with Windows Server + Basic IT Team
**Winner: Method A (Native Windows)**
- IT team knows Windows, not Docker or Linux
- Data stays on-premises (21 CFR compliance)
- No ongoing cloud costs
- Deployment scripts already exist

### Factory with Windows Server + Technical IT Team
**Winner: Method A or B**
- If IT knows Docker → Method B for easier maintenance
- If IT prefers native → Method A for simplicity

### Enterprise Client Mandating IIS
**Winner: Method E (IIS)**
- Only option when Nginx is not allowed
- Expect extra work for WebSocket configuration

### Multi-Factory with Cloud Preference
**Winner: Method F (Cloud)**
- Centralized data across locations
- Requires reliable internet at all sites
- Requires 21 CFR Part 11 cloud validation

### Dev/Staging Environment
**Winner: Method B (Docker Compose)**
- Quick setup, easy teardown
- Matches production if production uses Docker

---

## Recommendation

### For DigiLog's typical client (single factory, Windows Server, basic IT):

## Method A: Native Windows Install

**Reasons:**

1. **Client compatibility** — Factory IT teams know Windows Services, not Docker/Linux. The learning curve for Method A is the lowest.

2. **21 CFR Part 11** — Data on-premises with full physical control. No cloud compliance complications.

3. **No internet dependency** — Factory operations continue during internet outages. Everything runs on the LAN.

4. **Zero ongoing cost** — Client already has the server. No Docker licenses, no cloud bills.

5. **Installer ready** — Method A is now **productized as the `DigiLog-Setup-<ver>.exe` installer** (Inno Setup): it bundles portable PostgreSQL, provisions the DB, and registers the `DigiLogDB` + `DigiLogAPI` Windows services. Built by `scripts/build-installer.ps1`; deployment runbook in `docs/PHARMA_DEPLOYMENT_21CFR.md`. *(The old manual `package-for-production.ps1` / `install-on-target.ps1` scripts were removed 2026-07-04.)*

6. **Proven** — This is how the application has been running during development and testing.

### The only reasons to deviate:

| Situation | Switch to |
|---|---|
| Client specifically requests Docker | Method B |
| Client mandates IIS | Method E |
| Client has no on-premises server | Method F |
| Multiple factories, centralized data | Method F |

---

## Quick Reference: How to Deploy with Method A (current)

Method A now deploys via the packaged installer — there is no manual multi-service setup:

```
BUILD MACHINE                        CLIENT SERVER
─────────────                        ─────────────
1. scripts/build-installer.ps1       2. Run DigiLog-Setup-<ver>.exe
   → DigiLog-Setup-<ver>.exe            (elevated). It bundles + does:
   (needs Inno Setup 6)                 - portable PostgreSQL (no pre-install)
                                        - provision DB + migrate + seed
                                        - register DigiLogDB + DigiLogAPI services
                                        - HTTPS cert + config

                                     3. Trust the root CA + install the APK
                                        on each tablet

                                     4. Verify: scripts/verify-windows-deployment.ps1
                                        (API /health + graphile-worker schema)
```

> The old manual flow (install Node/PG/Memurai/EMQX/Nginx by hand, create `digilog_db` + `digilog_tsdb`, run `install-on-target.ps1`, configure Nginx, `pm2 save`) is gone — those subsystems and scripts were removed.

See **[`docs/PHARMA_DEPLOYMENT_21CFR.md`](../PHARMA_DEPLOYMENT_21CFR.md)** for the complete step-by-step runbook (installer, internal-CA HTTPS, 21 CFR controls, tablet/APK).
