# DigiLog — Pharma On-Premise Deployment Guide (`.exe`, No Reverse Proxy, 21 CFR Part 11)

**Date:** 2026-06-25
**Scope:** How to deploy DigiLog on-premise in a regulated (21 CFR Part 11 / GxP) pharmaceutical environment as a Windows installer `.exe`, served over HTTPS by a single service **without any reverse proxy (no Nginx / no IIS)**, and the exact code/config changes required to get there.

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Can it ship as an `.exe`? | **Yes** — as a `DigiLog-Setup.exe` installer (not a single all-in-one binary; PostgreSQL + native modules can't be melted into one file). |
| On-premise for pharma? | **Yes — preferred.** GxP favours on-premise (data sovereignty, validation control, works air-gapped). |
| Reverse proxy (Nginx/IIS) needed? | **No** — once the small change in §3.1 is applied, one Fastify service on `:3000` serves the SPA **and** the API **and** uploads over HTTPS. |
| HTTPS approach? | Replace dev `mkcert` self-signed certs with a certificate **issued by the organisation's internal CA**, bound to an **internal DNS hostname** (not an IP). |
| App rewrite needed? | **No.** This is packaging + config + one small static-serving addition. The Part 11 features (hash-chained audit, e-signatures, reauth) already exist. |

---

## 2. Why no reverse proxy is required

A reverse proxy (Nginx/IIS) is normally used to (a) terminate TLS, (b) serve the static SPA, and (c) route `/api` to the backend. DigiLog can do **all three inside the single Fastify process**:

```
                         ┌──────────────────────────────────────────────┐
   Browser / APK ──HTTPS──►  Fastify service on :3000 (Windows service)  │
   https://digilog.   │      • TLS terminated here (server.key/crt)      │
   pharma.local       │      • serves the React SPA  (apps/web/dist)     │  ──► PostgreSQL 18
                      │      • serves /api/*  (REST)                      │      (local service)
                      │      • serves /uploads/*                          │      + graphile-worker
                      └──────────────────────────────────────────────────┘
```

- **TLS termination:** Fastify already runs HTTPS natively (`API_HTTPS=true`, `certs/server.{key,crt}`). No proxy needed for TLS.
- **API routing:** all endpoints are under `/api/*` (and `/uploads/*`) — already handled.
- **SPA serving:** ⚠️ **this is the one gap** — see §3.1. Today the API serves only `/uploads/`; the SPA is served separately by Vite. The change in §3.1 makes Fastify serve the SPA too, closing the gap and removing any need for a second web server or proxy.

**Bonus — same-origin = no CORS:** when the SPA and API are served from the same origin (`https://digilog.pharma.local:3000`), the browser makes same-origin calls, so CORS config becomes irrelevant for the web client (still relevant only for the APK, which is a different origin).

> Optional: a reverse proxy is still *allowed* if corporate policy wants to terminate TLS at a hardware load balancer, run on port 443, or add WAF rules. It is **not required**.

---

## 3. Required changes

### 3.1 Code change — make Fastify serve the SPA (enables "no reverse proxy")

Today `apps/api/src/app.ts` registers `@fastify/static` only for `/uploads/`. Add a second static root for the built SPA **plus an SPA fallback** so client-side routes (e.g. `/filters`, `/audit`) return `index.html` instead of 404.

Add after the existing static/route registrations in `apps/api/src/app.ts`:

```ts
// Serve the built SPA (production). webDist points at apps/web/dist.
import path from 'node:path';
const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist'); // adjust to bundle layout

await app.register(fastifyStatic, {
  root: webDist,
  prefix: '/',
  decorateReply: false,        // a second @fastify/static must not re-decorate
  wildcard: false,
});

// SPA fallback: any non-/api, non-/uploads path → index.html (client-side routing)
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url && (req.raw.url.startsWith('/api') || req.raw.url.startsWith('/uploads'))) {
    return reply.code(404).send({ error: 'NOT_FOUND' });
  }
  return reply.sendFile('index.html', webDist);
});
```

Notes:
- Guard the fallback so genuine `/api/*` 404s still return JSON (not HTML) — otherwise API clients break.
- This is the **only** functional code change required for the no-proxy single-service model. Everything else is config/packaging.
- The existing `DEPLOY-WINDOWS.md` text says the API already serves the SPA; the code does not. Apply this change to make that statement true.

### 3.2 HTTPS / TLS — replace dev certs with internal-CA certs

| Item | Dev (today) | Pharma production |
|---|---|---|
| Certificate | mkcert self-signed | **Issued by the org internal CA** (e.g. Microsoft AD Certificate Services) |
| Trust | manually install `rootCA.pem` per device | Domain machines **auto-trust** the enterprise root CA via Group Policy; tablets via MDM |
| Address | `https://192.168.1.55:3000` (IP) | **Internal DNS hostname**, e.g. `https://digilog.pharma.local` (cert CN/SAN must match) |
| TLS version | default | **TLS 1.2+ only**, strong ciphers (`helmet` already enabled) |
| Renewal | none | owned by **IT PKI**; track expiry |

Place the issued `server.key` / `server.crt` where `API_HTTPS` reads them (`certs/`). Public CAs (Let's Encrypt) do **not** apply — they need a public domain; intranet systems use the internal CA.

### 3.3 Configuration / secrets (`apps/api/.env`, production values)

| Key | Dev value (must change) | Production value |
|---|---|---|
| `NODE_ENV` | `development` | **`production`** |
| `JWT_SECRET` | `LOCAL_DEV_SECRET_CHANGE_IN_PRODUCTION…` | **strong random** — `node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"` |
| `VERIFICATION_TOKEN_SECRET` | dev placeholder | strong random (different value) |
| `OFFLINE_REPLAY_SECRET` | already random — keep stable | stable 32+ char random |
| `DATABASE_URL` | `digilog:…@localhost/digilog_db` | same DB, **strong DB password** |
| `CORS_ORIGIN` / `ALLOWED_ORIGINS` | localhost dev ports | the production hostname only |
| `UPLOAD_DIR` | `./uploads` | a **writable** path, e.g. `%ProgramData%\DigiLog\uploads` (not read-only `Program Files`) |

Frontend build: set `apps/web/.env.production` → `VITE_API_URL=https://digilog.pharma.local:3000` **before** `vite build`, so the APK and any absolute calls target the production hostname. (For the same-origin browser case, relative `/api` also works.)

### 3.4 Host / OS

- **Windows Server** (recommended) on a server-grade machine, not a desktop.
- **NTP time sync** to a trusted source — **critical**: the audit trail is hash-chained and timestamped; clock integrity is an inspection point.
- DigiLog API + PostgreSQL run as **auto-start Windows services** (NSSM), restart-on-crash, boot persistence.

---

## 4. The installer `.exe` — what it bundles and does

Build `DigiLog-Setup.exe` with **Inno Setup** or **NSIS**. On run it:

1. Lays down a **portable Node.js LTS** (v20) — not a global install.
2. Lays down the **built app**: `apps/api/dist`, `apps/web/dist`, `packages/*/dist`, a pruned production `node_modules` (so native binaries — Prisma engine, `bcrypt` — are real files; `@napi-rs/canvas` was removed 2026-07-04 with the reports PDF engine), `node_modules/.prisma`, and `apps/api/prisma/migrations/`.
3. Bundles **PostgreSQL 18 portable**; runs `initdb` into `%ProgramData%\DigiLog\pgdata`, creates the `digilog` role + `digilog_db`, then **`prisma migrate deploy`** — which rebuilds the **complete** schema in one step (tables, the `deviation_number_seq`/`qnn_seq` sequences, 5 triggers, 6 functions, partial unique index) thanks to the squashed baseline migration.
4. Installs the **internal-CA server certificate** (or generates a CSR for IT to sign) and ensures the root CA is trusted.
5. Generates `apps/api/.env` with **strong random secrets** + `NODE_ENV=production` + the production hostname.
6. Registers **NSSM services**: `PostgreSQL` and `DigiLogAPI` (auto-start, restart-on-crash).
7. Creates a **shortcut** to `https://digilog.pharma.local:3000`.
8. Registers a **nightly DB backup** (Task Scheduler task "DigiLog Nightly Backup" → `scripts\backup-db.ps1` → `pg_dump` of `digilog_db` into `%ProgramData%\DigiLog\backups`, 14-day rotation, runs as SYSTEM with no stored password). Outcome is written every run to `backups\LAST-BACKUP-STATUS.txt` (OK/FAIL + timestamp) and appended to `logs\backup.log`; a failed run also sets a non-zero Task Scheduler "Last Run Result". **Copying dumps off-box, and periodically test-restoring them, are site procedures the installer does not perform** — see §5.2.

**Result:** the customer double-clicks one `.exe`, clicks through Setup, and DigiLog runs as a service with no Node/npm/terminal and **no reverse proxy**.

---

## 5. 21 CFR Part 11 / GxP deployment requirements

The application already provides the Part 11 *technical* controls; production deployment adds the *procedural/validation* layer. Both are needed for a compliant system.

### 5.1 Already in the application (technical controls)
- **Audit trail** — SHA-256 **hash-chained**, tamper-evident, append-only (DB trigger blocks deletes).
- **Electronic signatures / approvals** — decision/approval flows require remarks; re-authentication for sensitive actions.
- **Access control** — permission-based RBAC, session management, single-tab enforcement, password policy.
- **Record integrity** — immutable filter-event log with checksums; versioned profiles/cycles.

### 5.2 Deployment / procedural controls to put in place
- **Computer System Validation (CSV):** IQ (install qualification — the `.exe` install verified against a protocol), OQ (operational qualification — features behave per spec), PQ (performance qualification — works in the real workflow). The installer should be **versioned and reproducible** so IQ is repeatable.
- **Change control:** documented procedure for app/DB/cert changes; the baseline migration + git history support this.
- **Backup & disaster recovery:** scheduled, tested DB restores; off-box/offsite copies; documented RTO/RPO.
- **Time synchronisation:** NTP — audit timestamps must be trustworthy.
- **Security hardening:** strong unique secrets (no `CHANGE_IN_PRODUCTION`), least-privilege DB role, TLS 1.2+, OS patching, restricted host access.
- **Account lifecycle & training:** documented user provisioning/de-provisioning, role assignment, and operator training records.
- **Data retention & archival:** per the org's GxP record-retention policy.

### 5.3 Inspection-readiness checklist
- [ ] Validated, version-locked installer (IQ/OQ/PQ executed + signed)
- [ ] Internal-CA TLS cert on a proper hostname; root CA trusted org-wide
- [ ] Production secrets generated; dev placeholders gone
- [ ] `NODE_ENV=production`; CORS locked to the production origin
- [ ] NTP synced; audit-trail hash chain verified intact
- [ ] Scheduled backups running — installer-registered "DigiLog Nightly Backup" task present, and `%ProgramData%\DigiLog\backups\LAST-BACKUP-STATUS.txt` reads `OK` with **last night's** timestamp (a stale timestamp means the job is not protecting records)
- [ ] Restore **tested** from a dump, and **offsite copies** configured — site SOP, *not* installer-provided (§5.2)
- [ ] Services auto-start + restart-on-crash (NSSM)
- [ ] Change-control + access-control SOPs in place

---

## 6. Step-by-step deployment runbook

**One-time build (engineering):**
1. Apply the SPA-serving change (§3.1).
2. Set `apps/web/.env.production` → production hostname; `turbo run build`.
3. Assemble the bundle (Node + dist + prod `node_modules` + `.prisma` + migrations + Postgres portable).
4. Author the Inno Setup/NSIS script (§4); produce `DigiLog-Setup.exe`.
5. Validate: run the installer on a clean VM, confirm `migrate deploy` rebuilds the schema, app loads over HTTPS, login works, audit/e-sig function.

**On the customer site (IT, with QA oversight):**
6. Obtain the server cert from the internal CA for `digilog.pharma.local` (add DNS A-record).
7. Run `DigiLog-Setup.exe` → Setup wizard (install path, DB password, hostname, cert).
8. Installer initialises Postgres, runs `migrate deploy`, writes `.env` with strong secrets, registers services, configures backups.
9. Verify HTTPS loads on domain machines with **no cert warning** (enterprise root CA trusted).
10. Execute IQ/OQ/PQ protocols; capture evidence; sign off.
11. Enrol tablets (APK) via MDM with the internal root CA trusted; point them at the hostname.

---

## 7. Tab communication, session control & real-time (origin matters)

This is directly tied to the no-reverse-proxy / single-hostname decision, because all of it is **per-origin**.

### 7.1 Single-tab enforcement — how it actually works
DigiLog enforces "one active tab / one user per browser" via **`localStorage` + a heartbeat** (`apps/web/src/hooks/use-single-tab.ts`), using keys `digilog_active_tab_id`, `digilog_tab_heartbeat`, `digilog_active_user_id`. It is **purely client-side** and **scoped to the browser origin**.

> Correction to older docs: this is implemented with **`localStorage`**, not `BroadcastChannel`. It does not use the server or any reverse proxy.

**Production implication — pick ONE origin:** `localStorage` is keyed per `scheme + host + port`. If operators reach the app via *different* origins — e.g. `https://digilog.pharma.local:3000` on one PC and `https://192.168.1.55:3000` on another, or a mix of `http`/`https` — the single-tab guard on one origin **cannot see** tabs opened on the other, so the protection can be silently bypassed. **Standardise every client on the same hostname + scheme + port.** The no-reverse-proxy single-service model (everything on `https://digilog.pharma.local:3000`) gives this naturally.

### 7.2 Cross-device session control (the real guard)
Tab enforcement is per-browser; the **authoritative one-session-per-account** control is **server-side** — the API returns `SESSION_CONFLICT` when a second login is attempted for an account that already has an active session (you can force-takeover explicitly). This is independent of tabs/origin and is what actually prevents concurrent use across machines. It is the Part 11-relevant control (attributable actions to one authenticated user).

### 7.3 Real-time / WebSocket
`@fastify/websocket` is **registered on the server** (`app.ts`), but the SPA currently has **no live WebSocket client** (data is fetched via SWR/HTTP; Phase 4 moved internal pub/sub to an in-process EventEmitter). So today there is nothing extra to proxy.

**If/when a WebSocket channel is used:** because the API serves over HTTPS on `:3000`, the browser connects with **WSS to the same origin** — no reverse proxy required. *If* a reverse proxy is later introduced, it **must enable WebSocket upgrade** (`Upgrade`/`Connection` headers) or real-time will silently fail — another reason the single-service, no-proxy model is simpler here.

### 7.4 Deployment checklist for tab/session correctness
- [ ] All clients use the **same origin** (`https://<hostname>:3000`) — no IP/hostname or http/https mixing
- [ ] Server-side single-session (`SESSION_CONFLICT`) verified during OQ
- [ ] If a proxy is ever added: WebSocket upgrade enabled + same-origin preserved

---

## 8. Bottom line

- **`.exe`:** ✅ Yes — a `DigiLog-Setup.exe` installer (not a single binary).
- **On-premise:** ✅ Yes — the right model for pharma GxP.
- **No reverse proxy:** ✅ Yes — after the one small SPA-serving change (§3.1), a single Fastify HTTPS service on `:3000` serves SPA + API + uploads. Nginx/IIS optional, not required.
- **HTTPS:** ⚠️ Replace dev mkcert with an **internal-CA cert on an internal hostname**.
- **21 CFR Part 11:** the app has the technical controls; production needs the **CSV/validation + secrets + NTP + backup/DR + SOP** layer.
- **App rewrite:** ❌ Not needed. Packaging + config + one static-serving addition.

> Effort: ~3–6 engineering days for the installer + SPA change + validation harness; CSV/IQ-OQ-PQ paperwork is a parallel QA effort sized by your quality system.
