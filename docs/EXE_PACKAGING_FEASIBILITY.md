# DigiLog — Can it be packaged as an `.exe`? (Feasibility & Required Changes)

**Date:** 2026-06-25
**Question:** Can this application be turned into a Windows `.exe`, and if so, what changes are needed?
**Short answer:** **Yes — but not as a single double-click file.** The realistic, low-risk path is a **Windows installer `.exe`** that bundles the Node runtime + the built app + PostgreSQL and registers it as a background Windows service. A true *single self-contained binary* is fighting this stack and is not recommended.

---

## 1. TL;DR verdict

| Approach | Single file? | Feasible? | Verdict |
|---|---|---|---|
| **A. Installer `.exe`** (Inno Setup / NSIS) bundling Node + app + Postgres + NSSM service | No (one installer that lays down files) | ✅ **Yes — recommended** | Builds directly on the existing `DEPLOY-WINDOWS.md` / NSSM work. ~Low–medium effort. |
| **B. Electron desktop app** | Yes-ish (`.exe` app + installer) | ✅ Possible | Good if you want a "desktop app" feel. Still needs Postgres. Medium effort. |
| **C. `pkg` / Node SEA single binary** | Yes (one `.exe`) | ⚠️ Partially | Blocked/painful because of native modules (Prisma engine, `bcrypt`, `@napi-rs/canvas`) + ESM + external Postgres. Not recommended. |

**Recommendation: Option A.** It produces the `.exe` the customer double-clicks to *install*, after which DigiLog runs as a service and opens in the browser — without the customer ever touching Node, npm, or a terminal.

---

## 2. Why a single "double-click and it runs" `.exe` is hard here

DigiLog is a **client-server web application**, not a self-contained desktop program. At runtime it is:

```
[ Browser / APK ]  ──HTTPS──►  [ Fastify Node process :3000 ]  ──►  [ PostgreSQL 18 server ]
                                  • serves the React SPA (static)        • app data
                                  • REST API                             • graphile-worker job queue
                                  • graphile-worker tasks                  (Postgres-only)
```

Two facts from the codebase shape everything:

1. **The Fastify API already serves the SPA** (`@fastify/static`, see `apps/api/src/app.ts` + `DEPLOY-WINDOWS.md`: *"The Fastify API serves the SPA's static bundle directly on :3000"*). So there is **one** Node process to package, not two. ✅ This helps.
2. **It hard-depends on a PostgreSQL server.** This is the single biggest reason there is no trivial one-file exe — see §3.

---

## 3. The hard dependencies that block naive bundling

These are the things a packager must account for. Each is real in this repo.

| Dependency | Why it complicates an `.exe` | Handling |
|---|---|---|
| **PostgreSQL 18 server** | It's a separate server process with its own data dir — you can't "compile it into" a Node binary. The app uses Postgres-specific features (triggers, sequences, partial unique indexes, `gen_random_uuid()`, JSONB) **and** `graphile-worker`, which is **Postgres-only**. Switching to SQLite is a months-long rewrite and is **not viable**. | Bundle **PostgreSQL portable** in the installer, or require it as a prerequisite. (See §5.) |
| **Prisma query engine** (`@prisma/client`, `prisma`) | Ships a native binary (`query_engine-windows.dll.node`). `pkg`/SEA don't pick it up automatically; it must be shipped beside the app. We hit this exact file-lock during dev. | Ship `node_modules/.prisma` + `@prisma/client` next to the app; set `PRISMA_QUERY_ENGINE_LIBRARY` if relocating. |
| **`bcrypt` ^5** | Native node-gyp addon (`.node`). Doesn't bundle cleanly into a single binary. | Keep as a real file in `node_modules`, **or** swap to pure-JS `bcryptjs` (drop-in, see §6). |
| ~~**`@napi-rs/canvas`**~~ | **N/A — removed 2026-07-04** with the reports PDF engine (was a native `.node`). No longer bundled. | — |
| ~~**`puppeteer-core` + Edge**~~ | **N/A — removed 2026-07-04.** No server-side PDF/Edge rendering anymore; PDF export is client-side (jsPDF). | — |
| **HTTPS certs** (`certs/server.{key,crt}`) | The APK and HTTPS require real certs (mkcert). | Installer generates/installs certs + trusts the root CA. |
| **`uploads/` + writable paths** | The app writes uploads, logs. A read-only `Program Files` install breaks this. | Put writable dirs under `%ProgramData%` or the install dir with write perms. |
| **ESM (`"type": "module"`)** | `pkg` historically targets CJS; ESM support is weak. Pushes you away from Option C. | Favors Option A/B (run real `node`). |

**Key takeaway:** the blocker is not the JavaScript — it's the **PostgreSQL server + native `.node` binaries**. Any approach must ship/locate those; it can't melt them into one file.

---

## 4. The three options in detail

### ✅ Option A — Windows Installer `.exe` (RECOMMENDED)

Produce one `DigiLog-Setup.exe` (built with **Inno Setup** or **NSIS**) that, when run, installs and wires everything up. This is the natural extension of the existing `DEPLOY-WINDOWS.md` + `scripts/install-services-phase5.ps1` (NSSM) work.

**What the installer bundles & does:**
1. Lays down a **portable Node.js runtime** (e.g. `node.exe` v18/20 LTS — *not* a global install).
2. Lays down the **built app**: `apps/api/dist/`, `apps/web/dist/`, `packages/*/dist/`, and a **production `node_modules`** (so native binaries are real files).
3. Bundles **PostgreSQL 18 portable** (the zip distribution), runs `initdb`, creates the `digilog` role + `digilog_db`, and **runs `prisma migrate deploy`** (this is exactly why we just built the replayable baseline migration — a fresh DB now rebuilds in one command).
4. Generates **mkcert certs** + installs the root CA into the Windows trust store.
5. Registers two **Windows services via NSSM**: PostgreSQL and the DigiLog API (auto-start on boot, restart-on-crash). The services already exist in concept (`DigiLogAPI-Phase5`).
6. Drops a **Desktop/Start-menu shortcut** that opens `https://localhost:3000` (or `:5175`) in the default browser.
7. Writes a generated `apps/api/.env` with **strong random secrets** (JWT, verification, offline-replay) — not the dev placeholders.

**Pros:** Customer sees a normal "Setup.exe → Next → Next → Finish" install. No Node/npm/terminal. Reuses existing deploy assets. Lowest risk — runs the *real* `node`, so all native modules just work. Survives reboots.
**Cons:** Not a single file (it's an installer that lays down a folder). Installer is ~150–300 MB (Node + Postgres + node_modules).

---

### ✅ Option B — Electron desktop app

Wrap the app as an Electron desktop application: the Electron **main process spawns the compiled Fastify API** as a child process (or runs it in-process), and the Electron window loads the SPA. Ship via `electron-builder` → `DigiLog.exe` + installer.

**Pros:** Feels like a real desktop app (own window, icon, no browser chrome). Single app identity.
**Cons:** Still needs **PostgreSQL** (same as A — bundle portable or require it). Larger footprint (Electron ≈ Chromium ~150 MB on top). You'd be running a server inside a desktop shell — more moving parts than A for a fundamentally server-style app. Worth it only if "desktop app on one machine" is the actual product vision.

---

### ⚠️ Option C — `pkg` / Node SEA single binary (API only)

Compile `apps/api` into one `digilog-api.exe`.

**Why it's painful here:**
- **ESM** (`"type": "module"`) — `pkg` is CJS-oriented; `vercel/pkg` is archived. Node's built-in **SEA** is still maturing and awkward with ESM + many deps.
- **Native modules** (`@prisma/client` engine, `bcrypt`, `@napi-rs/canvas`) — must be shipped as external files *anyway*, so you don't even get a clean single file.
- **Still needs external PostgreSQL** — so even if it worked, it's not "one exe that runs everything."

**Verdict:** Lots of fiddling for a result that's *still* not self-contained. Only consider if you specifically want a single API binary and accept shipping the `.node` files + Postgres beside it.

---

## 5. The PostgreSQL question (most important design decision)

You must pick one:

| Strategy | What it means | Trade-off |
|---|---|---|
| **A. Bundle PostgreSQL portable** *(recommended)* | Installer ships the PG18 zip, runs `initdb` into `%ProgramData%\DigiLog\pgdata`, registers it as a service. | Biggest installer, but **fully turnkey** — customer needs nothing pre-installed. |
| **B. Require Postgres as a prerequisite** | Installer checks for PG17+/18 and prompts the user to install it first. | Smaller installer, but adds a manual step + version-mismatch support burden. |
| **C. Embedded SQLite** | ❌ **Not viable.** Would require dropping `graphile-worker`, all triggers/functions/sequences/partial-indexes, JSONB usage, and rewriting Prisma for SQLite. Months of work + loses 21 CFR-relevant DB guarantees. | Don't. |

Because of the baseline migration we just created, **strategy A's "create + migrate the DB" step is now a single `prisma migrate deploy`** that rebuilds the complete schema (tables, the `deviation_number_seq`/`qnn_seq` sequences, 5 triggers, 6 functions, partial unique index). That directly de-risks the installer.

---

## 6. Concrete change-list for the recommended path (Option A)

**Build / packaging (new work):**
1. **Production build script** — `turbo run build` then assemble a `dist-bundle/` containing: `apps/api/dist`, `apps/web/dist`, `packages/*/dist`, a pruned production `node_modules`, `node_modules/.prisma`, `@prisma/client`, the native `.node` files (`bcrypt`, `@napi-rs/canvas`), and `apps/api/prisma/migrations/`.
2. **Bundle a portable Node LTS** (`node.exe` v20) — do *not* rely on a global Node.
3. **Bundle PostgreSQL 18 portable** + an `initdb`/`createdb`/`migrate deploy` bootstrap script.
4. **Write the Inno Setup / NSIS script** that installs the above, registers NSSM services, generates certs + `.env` (with strong secrets), and creates the shortcut.
5. **Confirm the API serves the SPA in prod** — it does (`@fastify/static`); verify the web-dist root is correct in the bundle (one of the two `fastifyStatic` registrations must point at `apps/web/dist`).

**Small code/config changes (low risk):**
6. **Writable paths** — ensure `UPLOAD_DIR` and any log/temp paths resolve to a writable location (e.g. `%ProgramData%\DigiLog\uploads`), not read-only `Program Files`.
7. **(Optional) Swap `bcrypt` → `bcryptjs`** — pure-JS, removes one native-addon headache. Drop-in API-compatible; re-hashing is *not* needed (bcryptjs verifies existing bcrypt hashes). Only do this if you also pursue Option C; for Option A it's unnecessary since `node` loads the native addon fine.
8. **Secrets generation** — installer must generate `JWT_SECRET`, `VERIFICATION_TOKEN_SECRET`, `OFFLINE_REPLAY_SECRET` (today's `.env` uses dev placeholders that literally say `CHANGE_IN_PRODUCTION`).
9. **`NODE_ENV=production`** in the generated `.env`.
10. **PDF engine** — verify `detectEdgePath()` finds Edge on the target machine; document Edge as a requirement (it ships with Windows 10/11).

**Nothing to rewrite:** Prisma, graphile-worker, the API, the SPA, the auth flow — all run unchanged. This is packaging, not re-architecting.

---

## 7. Effort & risk

| Option | Rough effort | Main risks |
|---|---|---|
| **A. Installer** | **2–5 days** | Postgres portable bootstrap (initdb perms, service registration); cert trust on target; writable-path fixes. All well-trodden. |
| **B. Electron** | 4–8 days | Electron + child-process lifecycle; still must solve Postgres; larger build. |
| **C. Single binary** | 3–7 days, **high uncertainty** | ESM + native modules + still needs Postgres → likely abandoned mid-way. |

---

## 8. Recommendation

**Go with Option A — a Windows installer `.exe`.** It is the only approach that:
- gives the customer a clean "Setup.exe → installed app" experience with **no Node/npm/terminal**,
- runs the **real `node`** runtime so every native module (Prisma, bcrypt, canvas) just works,
- reuses your existing `DEPLOY-WINDOWS.md` + NSSM service work,
- and leverages the **replayable baseline migration we just built** to provision the database in one `migrate deploy`.

A literal "compile the whole thing into one `app.exe`" is not realistic for this stack because of the PostgreSQL server dependency and the native `.node` binaries — and chasing it (Option C) burns time for a result that still isn't self-contained.

> If the real goal is "the customer runs one file and DigiLog works," **Option A delivers exactly that** — the one file is the *installer*. If the goal is literally "a single portable binary with zero install," that is **not achievable** without dropping PostgreSQL, which the application fundamentally requires.
