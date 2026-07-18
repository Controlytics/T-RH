# DigiLog — Customer `Setup.exe` Packaging Plan

**Status:** PLAN ONLY — no code changes yet. Approve before execution.
**Author:** drafted 2026-06-30
**Goal chosen by user:** a **customer-facing `Setup.exe`** (Inno Setup installer) that installs DigiLog on a fresh Windows PC, **with PostgreSQL bundled**, and runs it as an auto-starting Windows service.
**Out of scope:** the Android APK (`apps/android`) and the native RFID Kotlin app (`rfid_scan_app`) — both are unaffected and keep talking to the installed server over the LAN exactly as today.

---

## 0. TL;DR — what we are building

A single `DigiLog-Setup-vX.Y.Z.exe` that, on double-click:

1. Installs the app + a private Node.js runtime + a private PostgreSQL 18 into `C:\Program Files\DigiLog`.
2. Creates an isolated database under `C:\ProgramData\DigiLog\db` (the customer's data lives here, separate from the program).
3. Generates stable secrets, applies the schema, seeds the `superadmin` account.
4. Registers **two Windows services** (PostgreSQL + DigiLog API) set to auto-start on boot.
5. Drops a Start-menu / desktop shortcut that opens `http://localhost:3000`.

The customer needs **nothing pre-installed** — no Node, no Postgres, no certs.

---

## 1. Why these decisions (the honest reasoning)

| Decision | Why |
|----------|-----|
| **Bundle PostgreSQL** (don't assume it exists) | A customer's IT can't be trusted to have PG 18 on the right port with the right user. Bundling portable Postgres on a **private port (5433)** with its **own data dir** makes it turnkey and avoids clashing with any Postgres they already run. Also keeps audit data in one known, isolated, backup-able location (21 CFR §11). |
| **Localhost over plain HTTP** | The exe serves only `localhost`. The mkcert/HTTPS dance exists today *only* so the Android APK can connect. The **desktop install can run HTTP on localhost** and drop all cert complexity. The APK keeps using HTTPS against the same machine via a separate listener / reverse setup (see §9 — APK connectivity is a known follow-up, not a blocker for the desktop product). |
| **Windows service, not a console window** | Survives reboots, no operator typing `tsx`/`vite`. Professional. |
| **Inno Setup** as the installer tool | Free, mature, scriptable (Pascal), the de-facto standard for Windows app installers. NSIS is the alternative; Inno is friendlier. |
| **Data dir under `C:\ProgramData\DigiLog`** | Survives app upgrades and uninstall. Never co-located with the program files. |

---

## 2. Schema upgrades — DECISION LOCKED: real migrations, no `db push`

> **User directive (2026-06-30):** The product is built for **customer upgrades**, not local-only. The `db push` approach is **eliminated**. This section is a committed decision, not an option.

> **⚠️ PLAN CORRECTION (M0 executed 2026-06-30):** The original draft of this section assumed a naive `db push` setup with a stale baseline that needed *regenerating from `schema.prisma`*. **That was wrong and that step is now deleted** — regenerating from the datamodel would have silently dropped the triggers, functions, manual sequences, and partial unique index that the existing baseline (a `pg_dump`) correctly preserves. The actual state and verified results are below.

### 2.0 — Verified actual state (M0 run, 2026-06-30)

The migration infrastructure was **already converted from `db push` to migrations** by prior work (commit `5141131`, 2026-06-25, *"baseline migration history; make migrate deploy replayable"*). Evidence gathered this session:

- The baseline `00000000000000_baseline/migration.sql` is a full `pg_dump --schema-only` of the live DB — it includes 6 trigger functions, 3 manual sequences, and the `idx_cleaning_cycles_one_in_progress_per_filter` partial unique index that `schema.prisma` cannot express. **It must never be regenerated from the datamodel.**
- Prior incremental migrations are archived under `prisma/migrations_archive_20260624/` (29 migrations). Out-of-band raw objects live in `prisma/sql/{extensions,invariants}.sql`.
- `prisma migrate status` against dev → **"Database schema is up to date!"** (baseline recorded as applied in `_prisma_migrations`).
- `git log` of `schema.prisma` since the baseline commit → **zero commits, no uncommitted changes** → baseline is current.
- **Authoritative acceptance gate PASSED:** built a throwaway `digilog_m0_scratch` DB from empty → `extensions.sql` → `prisma migrate deploy` → then `prisma migrate diff --from-url <scratch> --to-url <dev>` returned **`-- This is an empty migration.`** i.e. a fresh `migrate deploy` reproduces the live dev schema **exactly**. Fresh customer installs are schema-safe. ✅

**Net result:** the scary "db push problem" was **largely already solved**. M0 is therefore *not* a conversion — it shrinks to (a) two real fresh-install bugs found & one fixed (below), (b) document the forward-authoring workflow, (c) a drift guard, (d) seed idempotency — already mostly satisfied.

### 2.0.1 — Bugs M0 surfaced (fresh-install blockers)

1. **🔴 FIXED — seed crashed on fresh installs.** `prisma/seed.ts` still seeded the **deleted** `IngestionSystemConfig` model (dropped in the 2026-06-17 ingestion tear-out) → `prisma.ingestionSystemConfig` is `undefined` → seed threw mid-run, leaving help articles + template kinds unseeded. Latent since 2026-06-17 because dev never re-seeds from scratch. **Removed the dead block (seed.ts lines 331–409). Re-verified: seed now completes** — 33 help articles, 6 template kinds, DB invariants applied, *"Seed completed successfully!"*.
2. **🟡 INSTALLER REQUIREMENT — extensions before deploy.** The baseline uses `ltree`/`pgcrypto` (68 refs) but contains **no `CREATE EXTENSION`**. A bare-DB `migrate deploy` fails unless `prisma/sql/extensions.sql` runs **first**. The installer (§7 step) must `CREATE EXTENSION ltree, pgcrypto` before `migrate deploy`.
3. **🟡 INSTALLER REQUIREMENT — `INITIAL_ADMIN_PASSWORD`.** The seed refuses to run without `INITIAL_ADMIN_PASSWORD` set (security guard against a hardcoded default — `seed.ts:72-75`). The installer must set it (prompt the admin, or generate + force-change). The superadmin `upsert` does **not** overwrite the password on re-run → **seed is already upgrade-safe** for the admin account.

---

**Historical finding (for context):** before commit `5141131`, the project evolved the schema with `prisma db push` (hence the CLAUDE.md `db push --accept-data-loss` references). That era is over; the rules below make it stay over.

**Why `db push` is banned for this product:**
- `db push` compares `schema.prisma` to the DB and **alters the DB to match** — it can and will **drop columns/tables** to converge, with no migration history, no review, and no rollback.
- That is fine for a throwaway dev DB. It is **unacceptable** against a customer's live, audited database that must never silently lose a 21 CFR §11 record.
- A `Setup.exe` for **v2** must apply v2's schema changes to a customer's **existing v1 data** safely, forward-only, and audited.

**The committed model:**
- Every schema change from now on is captured as a checked-in, reviewed `migration.sql` under `apps/api/prisma/migrations/`.
- Installers (fresh **and** upgrade) apply schema **only** via `prisma migrate deploy` — forward-only, never destructive, records each step in the DB's `_prisma_migrations` table.
- `prisma db push` is **forbidden** in any path that touches a customer database, and we add a guard to prevent it (see §2.2).

### 2.1 — Baseline status: DONE & VERIFIED (do NOT regenerate)

The conversion from `db push` to migrations is **already complete** (§2.0). The baseline is a `pg_dump` that `migrate deploy` replays correctly, and the M0 acceptance gate proved a fresh deploy reproduces dev exactly. **There is no baseline regeneration to do — doing so would drop out-of-band objects.**

The repeatable acceptance-gate procedure (re-run before every release to prove fresh installs still match dev):

1. `CREATE DATABASE digilog_scratch; ` then apply `prisma/sql/extensions.sql` (ltree + pgcrypto).
2. `DATABASE_URL=<scratch> npx prisma migrate deploy`.
3. `DATABASE_URL=<scratch> INITIAL_ADMIN_PASSWORD=… npx tsx prisma/seed.ts` (smoke-test the full install path).
4. `npx prisma migrate diff --from-url <scratch> --to-url <dev> --script` → must print `-- This is an empty migration.`
5. Drop the scratch DB.

### 2.1b — Forward-authoring workflow (the genuine remaining gap)

Because the baseline is a `pg_dump` **superset** of `schema.prisma` (it carries triggers/functions/sequences the datamodel can't express), `prisma migrate dev` will report "drift" and its shadow-DB auto-generation is unreliable here. The archived history shows the intended pattern: **hand-authored, timestamped migration folders** (e.g. `20260530_filter_reverse_mirror/migration.sql`). The forward workflow for a schema change is therefore:

1. Edit `schema.prisma`.
2. Generate the *table/column* delta SQL: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` — review it, and **strip the out-of-band noise** (the triggers/functions/sequences that are managed in `prisma/sql/*`).
3. Hand-author any new raw objects (triggers/invariants) into the same migration **and** keep `prisma/sql/*.sql` in sync (defense-in-depth for dev).
4. Save as `prisma/migrations/<UTC-timestamp>_<name>/migration.sql`.
5. Run the §2.1 acceptance gate to prove `deploy` reproduces the new dev schema.
6. `prisma migrate resolve --applied <name>` on existing populated DBs (dev/test) so they don't re-run it.

> **Never** `prisma db push` and **never** `prisma migrate dev`'s auto-baseline against a populated DB. Both are unsafe given the out-of-band objects.

### 2.2 — Guardrails so `db push` can't sneak back

- **Remove convenience scripts** that invoke `db push`; replace with `migrate deploy` equivalents in `package.json`.
- **Drift guard — ✅ IMPLEMENTED** as `scripts/verify-migrations.ps1` (run via `npm run db:verify-migrations`). It builds a throwaway scratch DB from migrations (extensions → `migrate deploy`) and asserts it diffs **empty** against the dev DB; exits 1 with the offending delta on drift. This is the *correct* guard — the naive `migrate diff --from-migrations --to-schema-datamodel --exit-code` would **always false-fail** because the `pg_dump` baseline is a superset of `schema.prisma` (out-of-band triggers/functions/sequences read as permanent "drift"). Verified PASS 2026-06-30. **TODO:** wire it into CI (it currently runs locally on Windows; needs a psql + Postgres service in the CI runner).
- **Doc rule** in `apps/api/CLAUDE.md`: "Schema changes ship as hand-authored timestamped migrations (see EXE-PACKAGING-PLAN §2.1b). `db push` and `migrate dev` auto-gen are forbidden against any populated DB — they can destroy customer audit data." (This supersedes the existing `db push --accept-data-loss` guidance, now obsolete for anything customer-facing.)

### 2.3 — Why this fully removes the "db push issue"

With §2.1 done and §2.2 enforced, **every** customer database — fresh or upgraded — is built and evolved exclusively by reviewed, forward-only migrations recorded in `_prisma_migrations`. There is no code path that can silently drop a column on a customer. Upgrades (§8) become deterministic and auditable, which is exactly what a 21 CFR §11 product requires.

---

## 3. Architecture of the installed product

```
C:\Program Files\DigiLog\                 (program — replaced on upgrade)
├─ runtime\
│  ├─ node.exe                            (bundled portable Node 20+)
│  ├─ api\dist\app.js                     (compiled backend, entry point)
│  ├─ api\node_modules\                   (incl. native: bcrypt, @napi-rs/canvas, @prisma/client + engine)
│  ├─ api\prisma\                         (schema.prisma + migrations + seed)
│  ├─ web\dist\                           (built React UI — served by the backend, see §5)
│  └─ queue\crontab.txt                   (graphile-worker crontab; path preserved or via MAINTENANCE_CRONTAB_PATH)
├─ pgsql\                                 (bundled PostgreSQL 18 binaries: initdb, postgres, pg_ctl, psql)
├─ service\
│  └─ winsw\                              (WinSW or nssm wrapper exes that run node + postgres as services)
├─ tools\
│  └─ provision.ps1 / migrate.ps1         (install-time DB provisioning + upgrade scripts)
└─ Uninstall...

C:\ProgramData\DigiLog\                    (DATA — survives upgrade AND uninstall)
├─ db\                                     (PostgreSQL data directory — initdb target)
├─ uploads\                               (UPLOAD_DIR — user-uploaded files, report assets)
├─ logs\                                   (api + postgres + service logs)
└─ config\
   └─ digilog.env                          (generated secrets + connection string — see §6)
```

**Two services:**
1. `DigiLogDB` — runs `pgsql\bin\postgres.exe -D C:\ProgramData\DigiLog\db` on port **5433**.
2. `DigiLogAPI` — runs `runtime\node.exe runtime\api\dist\app.js` with env loaded from `digilog.env`, depends on `DigiLogDB`.

---

## 4. Build pipeline (produces the installer)

Run on the dev machine to create the `Setup.exe`. Encapsulate as `scripts/build-installer.ps1`.

1. **Clean install deps** at the workspace root (`npm ci`) so native modules build against the bundled Node's ABI.
2. **Build shared packages:** `npm run build -w @digilog/shared && npm run build -w @digilog/queue`.
3. **Build backend:** `npx tsc -p apps/api/tsconfig.json` → `apps/api/dist`.
4. **Build frontend:** `cd apps/web && npx vite build` → `apps/web/dist`.
   - Set `VITE_API_URL` to **empty / relative** for the desktop build so the UI calls the same origin (`http://localhost:3000`) instead of a baked IP. (The APK build keeps its own `.env.production` with the LAN IP — separate artifact.)
5. **Stage `runtime/`:** copy `apps/api/dist`, a **production** `node_modules` (`npm ci --omit=dev` in a CLEAN checkout — never against the live repo, it would wipe dev deps), `apps/api/prisma`, `apps/web/dist`, `packages/queue/crontab.txt`, and a portable `node.exe`. **Verified specifics (M2, 2026-06-30):**
   - **Portable Node:** the official `node-vXX-win-x64.zip` ships `node.exe` as a single self-contained binary — extract just that. **ABI pin:** native modules are compiled for a specific ABI (the dev build used Node 24.14.1 → ABI 137). The bundled `node.exe` MUST be the same Node **major** the native modules were built against, or `bcrypt`/`@napi-rs/canvas`/Prisma fail to load. Either bundle Node 24 (matches current build) or pick an LTS and `npm rebuild` the native modules against it before staging. *(M5 decision: pin one Node version for both the native build and the bundled runtime.)*
   - **Workspace junctions must be dereferenced.** `node_modules/@digilog/{shared,queue,api,web}` are **Windows junctions** into `packages/` and `apps/`. A naive copy ships dangling links — the staged tree must replace them with the real built `dist` of each workspace package (or ship `packages/*/dist` + `apps/api/dist` and keep relative paths).
   - **Prisma engine:** `node_modules/.prisma/client/query_engine-windows.dll.node` (≈20 MB) must be in the staged tree. Set `PRISMA_QUERY_ENGINE_LIBRARY` if the runtime can't auto-locate it.
   - **Size:** the full dev `node_modules` is ≈1.5 GB; a production prune (`--omit=dev`, dropping vite/vitest/tsc/turbo/etc.) is mandatory to keep the installer reasonable.
6. **Stage `pgsql/`:** download the **PostgreSQL 18 Windows binary zip** (EnterpriseDB / "binaries only" distribution), extract `bin/` + `lib/` + `share/`.
7. **Stage `service/`:** include WinSW (or nssm) wrapper exe + per-service XML config.
8. **Compile installer:** run Inno Setup (`ISCC.exe DigiLog.iss`) → `dist/DigiLog-Setup-vX.Y.Z.exe`.

**Native-module caveat (verified in code):** the backend depends on `bcrypt` (native) and Prisma's engine (native). These must be **built/copied for the exact Node version we bundle**. If the bundled Node's ABI differs from the dev machine's, rebuild with `npm rebuild` against the target Node before staging. *(`@napi-rs/canvas` was also native but was removed 2026-07-04 with the reports PDF engine — no longer a bundling concern.)*

---

## 5. Required code change #1 — backend serves the UI

**Today:** `apps/api/src/app.ts:161` registers `@fastify/static` **only for `/uploads/`**. The React UI is served by Vite (dev) or baked into the APK. For the desktop product, the **backend must serve the built SPA**.

**Change:** add a second static root for the web build + SPA fallback:
- Register `@fastify/static` with `root = runtime/web/dist`, serving `/` (so `index.html`, JS, CSS load).
- Add a `setNotFoundHandler` that, for non-`/api` GET requests, returns `index.html` (client-side routing fallback for React Router).
- Guard it behind an env flag (e.g. `SERVE_WEB=true`) so dev behavior is unchanged.

**Touch points — verified during M1 (2026-06-30):**
- ✅ `/api/*` routes still match first; unknown `/api/*` returns JSON (not HTML) — API contract preserved.
- ✅ `/uploads/*` still served (uploads static keeps `decorateReply:false`; the web static instance owns `sendFile`).
- ✅ `/docs` (Swagger) still served in dev, still **gated 401 in production** — the SERVE_WEB auth bypass deliberately excludes `/docs`.
- ✅ WebSocket path unaffected.
- 🔧 **Auth-hook gap fixed (the real touch point):** `plugins/auth.ts` has a global `onRequest` that 401s everything not in a public allowlist — so static assets + the login page itself were blocked. Added a narrow bypass: when `SERVE_WEB=true`, GET/HEAD requests that are **not** `/api`, `/uploads`, or `/docs` pass as public (the SPA's own `/api/*` data calls still go through full auth). This does not widen protected-uploads or Swagger access.
- CORS: with same-origin serving the UI no longer needs cross-origin; keep `ALLOWED_ORIGINS` correct for the APK (the installer sets it).

---

## 6. Required code change #2 — config via env, generated at install

The installer must generate **stable** secrets **once** at first install and persist them to `C:\ProgramData\DigiLog\config\digilog.env`. Regenerating on upgrade would break sessions and **invalidate every outstanding offline-replay grant** (see `.env.example` warning on `OFFLINE_REPLAY_SECRET`).

Installer-generated `digilog.env`:
```
DATABASE_URL=postgresql://digilog:<generated-pw>@localhost:5433/digilog_db?schema=public
JWT_SECRET=<64-byte base64, generated once>
VERIFICATION_TOKEN_SECRET=<64-byte base64, generated once>
OFFLINE_REPLAY_SECRET=<48-byte hex, generated once — MUST be stable across restarts/upgrades>
JWT_EXPIRES_IN=1h
NODE_ENV=production
PORT=3000
API_HTTPS=false            # localhost desktop = plain HTTP
SERVE_WEB=true             # new flag from §5
UPLOAD_DIR=C:\ProgramData\DigiLog\uploads
ALLOWED_ORIGINS=http://localhost:3000   # plus LAN origin(s) if the APK connects
MAINTENANCE_CRONTAB_PATH=...\runtime\queue\crontab.txt   # if path differs from bundled layout
```

**Code-side notes (verified):**
- `app.ts:350` reads `process.env.PORT ?? '3000'` (NOT `API_PORT` — the `.env.example` `API_PORT` key is read only by `deployment-check`). Installer must set `PORT`.
- App binds `host: '0.0.0.0'` (`app.ts:352`) — fine; localhost reachable, and LAN reachable for the APK if a firewall rule is added.
- The backend loads env via `dotenv/config` at startup. The service wrapper must point the process at `digilog.env` (e.g. `DOTENV_CONFIG_PATH` or copy/symlink, or the WinSW XML sets the env vars directly).

---

## 7. Install-time sequence (the installer script does this)

1. **Pre-flight:** check Windows version, admin rights, port 3000 + 5433 free; if a previous DigiLog is installed, branch to **upgrade** (§8).
2. **Copy files** into `C:\Program Files\DigiLog`.
3. **Create data dirs** under `C:\ProgramData\DigiLog` (`db`, `uploads`, `logs`, `config`).
4. **initdb:** `pgsql\bin\initdb -D C:\ProgramData\DigiLog\db -U postgres --auth=scram-sha-256 -E UTF8`.
5. **Configure PG:** write `postgresql.conf` (`port=5433`, `listen_addresses='localhost'`) + `pg_hba.conf` (scram local only).
6. **Register + start `DigiLogDB` service**; wait for it to accept connections (`pg_isready`).
7. **Provision DB:** create role `digilog` (random pw → into `digilog.env`), `CREATE DATABASE digilog_db OWNER digilog`.
8. **Generate `digilog.env`** with all secrets (§6).
9. **Apply schema (order matters — verified in M0):**
   - **a. Extensions first:** `CREATE EXTENSION IF NOT EXISTS ltree; CREATE EXTENSION IF NOT EXISTS pgcrypto;` (apply `prisma/sql/extensions.sql`). **Required** — the baseline uses these but doesn't create them; `migrate deploy` fails on a bare DB otherwise.
   - **b. Migrate:** `prisma migrate deploy` (applies the baseline on a fresh DB; on upgrades applies only missing migrations). **No `db push`, ever.**
   - **c. Seed:** run the seed with **`INITIAL_ADMIN_PASSWORD` set** (the seed throws without it — `seed.ts:72`). Creates `superadmin` + roles + system config + 33 help articles + 6 template kinds, and applies `invariants.sql`.
   - **Seed idempotency: confirmed in M0.** The seed is all `upsert` and does **not** overwrite the admin password on re-run, so upgrades that re-seed won't reset customer data. (Still re-confirm per release that new reference-data upserts don't clobber customer-edited rows.)
10. **Register `DigiLogAPI` service** (depends on `DigiLogDB`), start it.
11. **Health check:** poll `http://localhost:3000/health` until 200/401 (TLS-up style check).
12. **Firewall rule** (optional, for APK/LAN): allow inbound TCP 3000.
13. **Shortcuts** → `http://localhost:3000`.
14. Show "Install complete — default login superadmin / Admin@123" page.

---

## 8. Upgrade sequence (v(N) → v(N+1)) — IMPLEMENTED (M6, 2026-07-01)

The Inno constraint drives the ordering: `[Files]` copy runs **before** the `[Run]`
orchestrator, and you cannot overwrite a running exe. Solution:

1. **`PrepareToInstall()`** (before the copy): detect upgrade via the presence of
   `C:\ProgramData\DigiLog\config\digilog.env`; `net stop DigiLogAPI` so
   `runtime\node.exe` + the WinSW service exe unlock. **`DigiLogDB` is left running.**
2. **`[Files]` copy:** `runtime\` + `service\` + `scripts\` are replaced
   (`ignoreversion`); **`pgsql\` is `onlyifdoesntexist`** so the running
   `postgres.exe` is never overwritten (no lock) and the DB stays up for the backup.
   `C:\ProgramData` is never touched.
3. **`upgrade.ps1`** (the `[Run]` upgrade entry, `Check: IsUpgrade`):
   a. Validate a prior install (env file + initialised cluster) or abort.
   b. Ensure `DigiLogDB` is accepting connections (`pg_isready`, start if needed).
   c. **`pg_dump` → `C:\ProgramData\DigiLog\backups\pre-upgrade-v<ver>-<ts>.sql`.
      FATAL on failure — we never migrate an audited DB unbacked.**
   d. **`apply-schema.ps1`** = forward-only `prisma migrate deploy` (only unseen
      migrations, recorded in `_prisma_migrations`) + the **idempotent seed**
      (throwaway `INITIAL_ADMIN_PASSWORD`; the superadmin upsert never overwrites
      an existing password). Same shared step as fresh install → zero drift.
   e. Restart `DigiLogAPI`; health-check `http://localhost:3000/api/health`.
4. `digilog.env` secrets are **preserved, never regenerated** (regenerating would
   kill live sessions + every outstanding offline-replay grant).
5. **Rollback (manual, documented — not automated):** on failure `upgrade.ps1`
   prints the exact `pre-upgrade-*.sql` to restore; operator restores it and
   reinstalls the previous program version. Failure window: new program files on
   old schema until the restore runs.

> **⚠️ Coverage caveat — "upgrade tested" ≠ "migration-on-populated-DB tested".** M6
> proved the **fresh baseline** path (scratch DB: `migrate deploy` → 70 tables →
> seed) and the upgrade **orchestration** (dry-run + backup/stop/restart wiring). The
> forward `migrate deploy` against a *populated* customer DB is a no-op today (no v2
> migration folder exists yet) — it is unexercised until a real v(N+1) migration is
> authored. That path is Prisma core (forward-only, `_prisma_migrations`-tracked), but
> the first real v2 must run the §2.1 acceptance gate AND a populated-DB upgrade test
> before shipping.
>
> **⚠️ Per-release re-seed integrity check (21 CFR §11 — do NOT skip):** the
> upgrade re-runs the seed, which `upsert`s reference data (help articles, template
> kinds, system config, default roles). Confirm per release that these upserts do
> **not** clobber rows a customer has *edited* in the UI — an upsert `update` branch
> that overwrites a customer-tuned config/help article silently is a data-integrity
> regression. The superadmin-password case is already safe (update branch omits it);
> audit every other seed upsert's update branch when adding reference data.

---

## 9. Known follow-ups / open questions (not blockers for v1 desktop)

1. **APK connectivity to a desktop install.** The APK is built for `https://<LAN-IP>:3000` and the WebView `fetch()` rejects self-signed certs. If customers also use the tablet against this PC, we need either (a) a second HTTPS listener with an installed root CA on the tablet, or (b) keep the existing HTTPS-on-3000 model and serve HTTP only on a loopback alias. **Decide whether the desktop product must also serve the tablet.** If yes, the "plain HTTP" simplification in §1 needs revisiting.
2. **§2 migration discipline** — must be resolved before first customer upgrade.
3. **Code signing.** An unsigned `Setup.exe` triggers SmartScreen warnings. For a customer product, budget for an **Authenticode code-signing certificate** (and ideally EV for instant SmartScreen reputation).
4. **Antivirus false positives** on a freshly-built, unsigned, Node-bundling exe are common — signing mitigates.
5. **PostgreSQL licensing** — PG is PostgreSQL-licensed (permissive, redistributable). ✅ No issue bundling. Verify the same for the chosen PG Windows binary distribution.
6. **Backup/restore UX** — the app already has a dynamic backup/restore feature; confirm it points at `C:\ProgramData\DigiLog` paths after install.
6b. **✅ RESOLVED in M6 (2026-07-01) — uploads now honor `UPLOAD_DIR`.** New single source of truth `apps/api/src/lib/uploads-dir.ts` exports `UPLOADS_ROOT` (= `UPLOAD_DIR` if set, else the cwd-independent `apps/api/uploads` fallback computed from the lib file's own location). Wired into **all four** touch points: the static serve (`app.ts`), the profile-photo writer (`modules/uploads/routes.ts`), the **report-PDF writer** (`modules/reports/service.ts` — this one was the worst: `path.resolve('uploads/reports')` was **cwd-relative**, so under the Windows service it wrote into `runtime\api\dist` and stored that absolute path in the DB, guaranteeing a deleted-file 404 after upgrade), and the deployment-check health probe. Verified: `UPLOAD_DIR` unset -> `apps/api/uploads` (dev unchanged); set -> `C:\ProgramData\DigiLog\uploads`. The installer's `digilog.env` already sets `UPLOAD_DIR=C:\ProgramData\DigiLog\uploads`, so customer uploads land outside the program dir and survive upgrades. *(No 4th writer: branding logos live in config JSON, not on disk.)*
7. **Disk footprint:** installer ≈ 200–300 MB (Node + Postgres + node_modules + Chromium-less PDF via system Edge). Confirm acceptable.
8. **Edge dependency for PDF** — `puppeteer-core` auto-detects Edge (present on all modern Windows). If a locked-down customer image lacks Edge, set `PUPPETEER_EXECUTABLE_PATH` or bundle a Chromium. Low risk.

---

## 10. Milestones & sequencing

| # | Milestone | Deliverable | Risk |
|---|-----------|-------------|------|
| **M1** | **Backend-serves-UI bundle** (§5) | ✅ **DONE (2026-06-30).** `SERVE_WEB=true node dist/app.js` serves the full SPA + API from one process (verified compiled, NODE_ENV=production, real login round-trip). Added `scripts/build-bundle.ps1`. Fixed the auth-hook gap (static assets/SPA were 401'd). | Low — foundation for everything |
| **M2** | **Portable runtime staging** (§4) | ✅ **Core PROVEN (2026-06-30).** Ran the compiled bundle with a downloaded portable `node.exe` (Node 24.14.1) and **global Node removed from PATH** — server booted, served the SPA, real login worked, and all three native addons load: **bcrypt** (hash+compare / correct-vs-wrong password), **@napi-rs/canvas** (drew + exported PNG), **Prisma query engine** (health `SELECT 1`). **Deferred to M5:** assembling the pruned, junction-dereferenced `runtime/` folder (needs a clean-room `npm ci --omit=dev`; recipe captured in §4 step 5). | Native-ABI risk retired |
| **M3** | **Bundled Postgres provisioning** (§7 steps 4-9) | ✅ **DONE (2026-06-30).** `scripts/provision-db.ps1` initdb's a private isolated cluster (scram/UTF8), pins port + localhost, starts it, creates the app role+DB, applies extensions, `migrate deploy`, seeds. Verified end-to-end on :5433: provisioned (roles=6, superadmin=1), the **real app connected + logged in** against it, then torn down — dev DB on :5432 never touched. Uses PG18 binaries (same ones the portable zip ships). | — |
| **M4** | **Windows services** | ✅ **DONE (2026-06-30).** `scripts/register-services.ps1` (+ `unregister-services.ps1`): DB via native `pg_ctl register -S auto`; API via generated WinSW XML (`<depend>DigiLogDB`, auto-start, restart-on-failure, rolling logs). Both AST-syntax-clean + ASCII; `-DryRun` reviewed. **Linchpin verified:** the API loads ALL config (PORT/SERVE_WEB/DATABASE_URL) from `DOTENV_CONFIG_PATH` so the service XML holds no secrets. Live register/start needs admin → done at install time (M5). | Native-config risk retired |
| **M5** | **Inno Setup installer** | ✅ **AUTHORED + VALIDATED (2026-06-30).** `installer/DigiLog.iss` (thin: copy files, admin-password page, run orchestrators, shortcuts) + `scripts/install.ps1` (secrets -> digilog.env -> provision -> register-services -> firewall -> health), `uninstall.ps1` (stop/remove services, **preserve data**), `stage-runtime.ps1` (runtime assembly w/ junction dereference), `build-installer.ps1` (clean-room `npm ci --omit=dev` -> stage -> ISCC). All PS scripts AST-clean, ASCII, dry-run exit 0; staging dereference sources verified real. **3 real bugs found+fixed:** `$PSScriptRoot` sibling resolution, array-vs-hashtable splatting (positional-bind bug), missing `exit 0` (stale `$LASTEXITCODE`). **GATES (build/customer machine only):** compiling `.iss`->Setup.exe needs Inno Setup 6; test-install needs admin; clean-room prod `npm ci` needs the build machine. | Compile + install test deferred to build machine |
| **M0** | **Migration discipline** (§2.0–2.3) | ✅ **DONE (2026-06-30).** Verified prior conversion (acceptance gate empty-diff); fixed the broken fresh-install seed; built+tested the drift guard (`scripts/verify-migrations.ps1`, `npm run db:verify-migrations`, PASS); documented the forward-authoring workflow in `apps/api/CLAUDE.md`; fixed the `db:migrate` footgun (`migrate dev`→`migrate deploy`). **Only leftover:** wire the drift guard into CI (needs a Postgres-equipped runner). | — |
| **M6** | **Upgrade + uninstall safety** (§8) | ✅ **DONE (2026-07-01).** (1) **Uploads-dir ship-blocker fixed** (§9.6b — `lib/uploads-dir.ts` + 4 sites honor `UPLOAD_DIR`; report-PDF cwd-relative bug fixed). (2) **Customer-runnable schema apply** — `prisma` CLI moved to runtime `dependencies` (keeps CLI + `@prisma/engines` schema engine after `npm ci --omit=dev`); seed precompiled to `prisma/seed.mjs` (esbuild, in `build-bundle.ps1`) since `tsx` is pruned; **proven end-to-end on a scratch DB with only `node`** (no npx/tsx): `node …/prisma/build/index.js migrate deploy` (70 tables) + `node prisma/seed.mjs` (roles/superadmin/33 help/invariants). This also repaired the M3 `provision-db.ps1`, which used the now-unavailable `npx`. (3) **Shared `apply-schema.ps1`** (migrate+seed, node-only w/ npx/tsx dev fallback) used by BOTH fresh + upgrade so they can't drift. (4) **`upgrade.ps1`** — validate prior install → ensure DB up → stop API → **pg_dump backup (FATAL on failure)** → apply-schema (throwaway admin pw; upsert preserves password) → restart API → health; preserves `digilog.env` secrets; manual rollback documented. (5) **`DigiLog.iss`** — detects upgrade (env file present), skips admin page, stops `DigiLogAPI` in `PrepareToInstall()` before the file copy; **`pgsql` copied `onlyifdoesntexist`** so the DB stays up for the live backup and postgres.exe never locks the copy. (6) **Uninstall** already preserves `ProgramData` (verified). **DEFERRED GATES (build/customer machine only, same class as M5):** ISCC compile, an actual admin test-install, and a real clean-room `npm ci --omit=dev` + bundled-node run of migrate/seed. | **High** — data-loss surface |
| **M7** | **Code signing + clean-VM acceptance test** | ✅ **DONE (2026-07-01), minus the signed artifact (needs a cert).** (1) **Signing scaffold** in `build-installer.ps1` — optional `-Sign` with `-CertPath`(PFX)`/-CertPassword` or `-CertSubject` (store cert) + RFC3161 `-TimestampUrl`; locates `signtool.exe` from the newest Windows SDK; **no-op + explicit "UNSIGNED" warning when `-Sign` omitted**, fails hard if requested-but-unresolvable (no silently-unsigned "signed" build). signtool locator verified on this machine (SDK 10.0.26100). (2) **Clean-VM acceptance runbook** — `tasks/M7-CLEAN-VM-ACCEPTANCE-RUNBOOK.md`: fresh VM -> install -> services auto-start -> login -> data-in-ProgramData -> reboot -> upgrade-preserves-data+secrets -> uninstall-preserves-ProgramData, with SmartScreen-warnings-are-expected called out. **User decision (2026-07-01): scaffold now, sign later** (no cert purchased yet) — so the shipped exe stays unsigned until a cert is bought and `-Sign` is used. **DEFERRED:** the actual signed build (procure OV/EV Authenticode cert) + running the runbook on a real VM (both need a build/VM machine). | Low (mostly procurement) |
| **M8** | **Tablet HTTPS-on-LAN + APK server-address** (reopens §9.1) | ✅ **DONE (2026-07-01), minus the device-validation gate (needs real Android hardware on a LAN).** Three shipped parts: **(1) Client** — `apps/web/src/lib/api-base.ts` `getApiBase()` resolver (localStorage `digilog.serverUrl` → `window.__API_BASE__` → `VITE_API_URL` → `''`); wired into all ~8 base-URL read sites + boot init in `main.tsx`; native-only first-launch "Server Address" screen (`routes/mobile/server-config.tsx`) with `/api/health` validation; native gating + "Change server address" login link; `apps/web/.env.production` `VITE_API_URL` blanked + force-tracked via `.gitignore` negation. **(2) Server** — `install.ps1` generates a rootCA + server cert (SAN = LAN IP + localhost) into `C:\ProgramData\DigiLog\certs` via bundled openssl; sets `API_HTTPS=true`, `TLS_KEY_PATH`, `TLS_CERT_PATH`, `https` `ALLOWED_ORIGINS`; imports rootCA into `LocalMachine\Root`; health-check updated to `https://`. `DigiLog.iss` updated: https shortcut URL + "Install tablet certificate" Start-menu helper. **(3) APK** — `network_security_config.xml` now trusts `src="user"` (operator-installed CAs), keeping `src="system"` + `@raw/rootca`. **DEFERRED gate (cannot verify in dev):** full tablet round-trip — real Android device on a LAN + operator installs `rootCA.pem` + APK first-launch server-address entry + Connect (health check) + login over HTTPS. See §7 of the acceptance runbook. | **High** — device validation deferred |

**Recommended first action:** do **M0** (migration discipline) and **M1** (backend-serves-UI bundle) — both are foundational. M0 is the one that makes customer upgrades safe and removes the `db push` risk for good; M1 proves the single-process model end-to-end. Neither requires installer tooling, so they're the right place to start.

---

## 11. Decisions

**Settled:**
- ✅ **Customer upgrades are a first-class requirement** (not local-only). — user, 2026-06-30
- ✅ **Real Prisma migrations; `db push` eliminated** (§2). — user, 2026-06-30
- ✅ **Bundle PostgreSQL**, data path `C:\ProgramData\DigiLog`. — user, 2026-06-30
- ✅ **§9.1 — the desktop install MUST also serve the Android tablet over the LAN.** — user, 2026-07-01. This turns on HTTPS-on-LAN (M8, §13). The "localhost HTTP only" simplification is retired.
- ✅ **§9.3 — code signing: scaffold now, sign later.** — user, 2026-07-01. No cert purchased yet; `build-installer.ps1 -Sign` is wired and ready. Shipped builds stay unsigned (SmartScreen/AV warnings) until a cert is bought.

**All M8 decisions resolved and implemented.** Option (b) — runtime-configurable server-address screen — was chosen and shipped; see §13 for the full design + the deferred device-validation gate.

---

## 12. What does NOT change

- Android APK (`apps/android`) + RFID Kotlin app (`rfid_scan_app`) — separate artifacts, untouched **(revisited in M8/§13 — serving the tablet does change the APK's server-address story)**.
- All 35 API modules, the audit hash-chain, offline sync, reports — run identically; they just run inside a bundled Node + bundled Postgres instead of a dev-installed one.
- The dev workflow (`tsx watch` + `vite`) stays exactly as is; the `SERVE_WEB` flag and the bundle scripts are additive.

---

## 13. M8 — Tablet HTTPS-on-LAN + APK server-address (DONE — device validation deferred)

**Why this exists:** the user chose (2026-07-01) that the desktop install must **also**
serve the Android tablet/APK over the LAN. The Capacitor WebView `fetch()` rejects
self-signed certs and plain HTTP causes a Capacitor TLS parse error on login, so the
server must present HTTPS with a cert the tablet trusts, on the customer's LAN IP.

### 13.0 ✅ Trust model resolved — APK change shipped (2026-07-01)

`apps/android/.../res/xml/network_security_config.xml` originally trusted **only** `src="system"`
(OS-shipped CAs) + `@raw/rootca` (a specific mkcert CA baked into the APK), with no
`<certificates src="user" />`. Since Android 7, the tablet would **not** have trusted a CA the
operator installs — blocking the "generate CA at install → operator installs it" flow in §13.1.

**Resolved: Trust model A was implemented.** `network_security_config.xml` now includes
`<certificates src="user" />` alongside `src="system"` and `@raw/rootca`. The APK is rebuilt
once; the operator installs `rootCA.pem` on the tablet (Settings → Security → Install
certificate) and it is trusted. One APK for all customers. The per-customer per-APK-rebuild
approach (Trust model B) was rejected.

**Remaining validation gate:** the full round-trip (real Android device + LAN + operator CA
install + APK server-address entry + login over HTTPS) cannot be verified in this dev
environment — it is the M8 deferred gate, documented in runbook §7.

### 13.1 Server side (needs the §13.0 Trust-model-A APK change to actually be trusted)

1. **Cert generation at install, ONCE, into `C:\ProgramData\DigiLog\certs`** (data dir →
   survives upgrades; regenerating on upgrade would re-break tablet trust, same logic as
   secrets preservation). A rootCA + a server cert whose **SAN includes the PC's LAN IP +
   `localhost` + `127.0.0.1`**. **Probe first:** the EDB PG18 zip usually ships
   `pgsql\bin\openssl.exe` → reuse the existing `certs/ssl.conf` + `server.ext` SAN flow,
   no extra bundled binary. (Fallback: bundle `mkcert.exe`, or PowerShell
   `New-SelfSignedCertificate` + export — but the app consumes PEM `server.key`/`server.crt`,
   which openssl produces directly, so openssl is the cleanest fit.)
2. **Make the hardcoded cert path env-configurable** — `app.ts:71-76` reads
   `../../../certs/server.{key,crt}`. Add `TLS_CERT_PATH` / `TLS_KEY_PATH` env (default to
   the current relative path so **dev is unchanged**; mirrors the `UPLOAD_DIR` fix). Installer
   points them at `ProgramData\certs`.
3. **`install.ps1` env changes:** `API_HTTPS=true`, `TLS_CERT_PATH`/`TLS_KEY_PATH`,
   `ALLOWED_ORIGINS=https://localhost:3000,https://<LAN-IP>:3000`. The firewall rule (TCP 3000)
   already exists.
4. **Trust the CA on the SERVER too** (so the PC's own browser doesn't warn under
   `SERVE_WEB` HTTPS) — import `rootCA.pem` into `LocalMachine\Root`. Then the health-check
   in install/upgrade becomes `https://localhost:3000/...` (trusted, no cert-bypass hacks).
5. **Export `rootCA.pem`** to an obvious place (e.g. `ProgramData\DigiLog\certs\rootCA.pem` +
   a Start-menu "Install tablet certificate" helper) for the operator to sideload onto the
   tablet (Settings → Security → Install certificate), per the existing APK-trust runbook.
6. **Static-IP prerequisite (document loudly):** DHCP renumbering breaks the cert SAN (and,
   in option (a), the APK). Require a DHCP reservation / static LAN IP for the server PC.

### 13.2 Client side — ✅ Option (b) chosen and DONE

**Decision (user, 2026-07-01):** option (b) — runtime-configurable server URL — was chosen
and implemented. `apps/web/.env.production` `VITE_API_URL` is now blank (force-tracked via
`.gitignore` negation). At runtime, `apps/web/src/lib/api-base.ts` `getApiBase()` resolves
the base URL as: localStorage `digilog.serverUrl` → `window.__API_BASE__` → `VITE_API_URL`
→ `''` (same-origin desktop fallback). Wired into all ~8 base-URL read sites + boot init in
`main.tsx`.

**First-launch server-address screen** (`apps/web/src/routes/mobile/server-config.tsx`): on
native (Capacitor), if no `digilog.serverUrl` is stored, the APK routes to this screen
before login. The operator enters `https://<LAN-IP>:3000`; the screen validates it against
`/api/health` and persists on success. A "Change server address" link is also available from
the login page. Desktop (non-Capacitor) skips the screen entirely.

**One APK for all customers** — no per-site rebuild. Per-customer APK rebuild (option a) was
rejected as operationally heavy (every IP change re-breaks both the cert SAN and the APK).
