# Configuration Audit — DigiLog (21cfrlogbook)

**Date:** 2026-06-29
**Branch:** RFID
**Auditor:** Claude (Opus 4.8)

---

## How to read this report

Every finding is tagged by **how it was verified**, because that determines how much to trust it:

| Tag | Meaning |
| --- | --- |
| ✅ **REPO-VERIFIED** | Proven from the repo itself (file contents, `ls`, `grep`, an empirical `node`/`npm` run). No external knowledge involved. Trust fully. |
| 📦 **REGISTRY-VERIFIED** | "Latest version" comes from a live `npm outdated` run against the npm registry. Trust fully. |
| 🌐 **DOC-VERIFIED** | A behavior/breaking-change claim backed by a cited official URL (release notes, migration guide). Trust, but the URL is the authority, not this doc. |
| ⚠️ **UNVERIFIED** | Could not be confirmed from an authoritative source. Treated as "needs a doc check," never asserted as fact. |

### Scope and honest limits

- This audit covers the project's **configuration files** (build, lint, TS, test, ORM, env, container/cert, monorepo). It is **not** a line-by-line audit of every config key of every one of the ~60 npm dependencies — that is mostly a version-currency question, answered in **Part B** via `npm outdated`, not 13 sections of prose.
- Most sections of the original 13-section template legitimately come back **"no issues found."** That is the correct answer, not a gap. I did not manufacture findings to fill a table.
- **Section 13 (migration patch) is a *proposal*, not applied.** Config changes that depend on external version behavior, and major-version upgrades, should be confirmed before any file is mutated.
- The Android Gradle catalogs (`RFID/gradle/`, `rfid_scan_app/gradle/`, `apps/android/android/`) were inventoried but their version currency against Maven/Google is **out of scope** for a doc-verified pass here — flagged in Part D as "needs a dedicated check."

### Config files reviewed (live tree, `old/` and `.worktrees/` excluded)

| File | Tool | Read |
| --- | --- | --- |
| `package.json` (root) | npm workspaces / turbo / madge | ✅ |
| `turbo.json` | Turborepo 2.x | ✅ |
| `knip.json` | knip 5 | ✅ |
| `apps/api/package.json` | Fastify/Prisma backend | ✅ |
| `apps/api/tsconfig.json` | TypeScript 5.9 | ✅ |
| `apps/api/vitest.config.ts` | Vitest 3 | ✅ |
| `apps/api/.env.example` | runtime env template | ✅ |
| `apps/api/prisma/schema.prisma` (generator/datasource) | Prisma 6 | ✅ |
| `apps/web/package.json` | React 19 SPA | ✅ |
| `apps/web/tsconfig.json` | TypeScript 5.9 | ✅ |
| `apps/web/vite.config.ts` | Vite 6 + PWA + Tailwind | ✅ |
| `apps/web/eslint.config.js` | ESLint 9 flat config | ✅ |
| `apps/web/vitest.config.ts` | Vitest 3 | ✅ |
| `apps/web/.env.production` | build-time env | ✅ |
| `packages/shared/{package,tsconfig}.json` | shared lib | ✅ |
| `packages/queue/{package,tsconfig}.json` | graphile-worker | ✅ |
| `certs/ssl.conf` | OpenSSL cert SAN | ✅ |
| `.env.example` (root) | prisma-CLI env template | ✅ |
| `.claude/settings.{json,local.json}` | harness | ✅ |

**Root `.env.example` (✅ REPO-VERIFIED):** contains only `DATABASE_URL`, explicitly documented as read "ONLY by `npx prisma` CLI commands run from the repo root." Consistent with `apps/api/.env.example`. **No drift.**

### Config categories the task named — explicitly checked, NOT present (✅ REPO-VERIFIED)

A "100% exhaustive" audit must state absence, not omit it. `git ls-files` over the live tree (`old/`, `.worktrees/` excluded) found **none** of:

| Category | Result |
| --- | --- |
| CI/CD (`.github/workflows/`, `.gitlab-ci`, `Jenkinsfile`, `azure-pipelines`, `.circleci`) | **None.** Only `.github/ISSUE_TEMPLATE/bug_report.md` exists. No automated pipeline config to audit. |
| Docker / Compose | **No `Dockerfile` or compose file in the tree.** Only a *doc*, `docs/deployment-methods/method-b-docker-compose.md` (describes a method; no actual compose file backs it). |
| Kubernetes / Helm | **None.** |
| `.npmrc` | **None** (npm defaults; `packageManager: npm@11.6.2` pinned in root `package.json`). |
| `.editorconfig` | **None.** |
| IDE (`.vscode/`, `.idea/`) | **None tracked.** |

This matches the project's "local Windows only, no live prod" posture (per `CLAUDE.md`).

---

## Part A — Repo-internal drift (✅ all REPO-VERIFIED)

These are the highest-value findings: 100% provable, fully actionable, no external dependency. They are real misconfigurations and stale references, not version-currency noise.

### A-1. `knip.json` references a workspace that was deleted

- **File:** `knip.json:22`
- **Current:** `"packages/db": { "entry": ["src/index.ts!"], "project": "src/**/*.ts" },`
- **Problem:** `packages/db` was deleted in Phase 7 (2026-06-11..06-17). Live `ls packages/` returns only `queue` and `shared`. Knip will warn about (or choke on) a configured workspace whose directory does not exist.
- **Fix:** delete the `"packages/db"` line from the `workspaces` map.
- **Severity:** Low (tooling noise), but trivially correct.

### A-2. `npx nx build …` is referenced everywhere — there is no `nx` in this project

- **Files (active set):** `CLAUDE.md:56`, `packages/shared/CLAUDE.md:8` & `:14`, `docs/CONTRIBUTING.md:84`, `future/frontend/PATTERNS.md:121`, `README.md:123`. (Also in several `tasks/*.md` history files — lower priority.)
- **Problem:** `ls nx.json packages/*/nx.json apps/*/nx.json` → **no `nx.json` anywhere**, and `nx` is not a dependency. The build system is **Turborepo** (`turbo.json`, `turbo` in root devDeps). Every `npx nx build shared` instruction will fail. `README.md:123` is doubly wrong — `npx nx build shared && npx nx build db && npx nx build queue` references both `nx` **and** the deleted `db` package.
- **Correct command** (verified against `package.json` scripts): `npm run build` (root, runs `turbo run build`), or per-package `npm run build -w @digilog/shared`, or `cd packages/shared && npm run build` (which runs `tsc`).
- **Fix:** replace all live-doc `npx nx build <pkg>` with the turbo/npm equivalent.
- **Severity:** Medium — these are *active operator instructions* in `CLAUDE.md` and package docs; following them fails.

### A-3. Build-time API URL is inconsistent across docs — but the live cert DOES cover it

> **CORRECTION (2026-06-29):** An earlier draft of this finding claimed the TLS cert did **not** cover the API URL and flagged a High-severity APK TLS-failure risk. That was based on grepping `certs/ssl.conf` (a stale *template*) instead of the actually-served `certs/server.crt`. **The claim was wrong.** `openssl x509 -in certs/server.crt -ext subjectAltName` shows the live cert's SAN list includes `192.168.1.53`, `192.168.1.55`, `192.168.1.22`, `10.162.206.32` (and more). The functional risk does **not** exist. The real, much smaller finding is template drift (below).

- **Current state (✅ verified):** `apps/web/.env.production` set to `https://192.168.1.53:3000` (the confirmed current IP); live `server.crt` SAN already includes `192.168.1.53`; `rootCA.pem` unchanged so tablet trust persists. An APK rebuilt from this env file will connect over TLS without error.
- **Doc inconsistency (Low):** prose still names older IPs in several places — `CLAUDE.md:72` / `OFFLINE_SYNC_ARCHITECTURE.md` / `APPLICATION_REPORT.md:330` say `192.168.1.22`. Cosmetic; update opportunistically.
- **Template drift (Low):** `certs/ssl.conf` and `certs/server.ext` list only the *old* SANs (`192.168.1.22, 10.11.230.146, 10.247.103.32, ...`) and are out of sync with the live `server.crt`. They are not consulted unless someone re-signs the cert using them — at which point the current IPs (incl. `.53`/`.55`) would be silently dropped. **Recommend:** sync `server.ext`/`ssl.conf` `[alt_names]` to match the live cert's SAN list so a future regen doesn't lose coverage.
- **Severity:** Low (was incorrectly High). No functional TLS risk for current IPs.

### A-4. `.env.production` value formatting (style nit — NOT a bug)

- **File:** `apps/web/.env.production:1` — `VITE_API_URL= "https://…"` has a leading space and wrapping double-quotes.
- **Verified empirically:** `dotenv.parse('VITE_API_URL= "https://10.162.206.32:3000"')` → `{"VITE_API_URL":"https://10.162.206.32:3000"}`. dotenv trims the space and strips the quotes, so Vite receives the clean value. **This parses correctly.**
- **Recommendation:** normalize to `VITE_API_URL=https://<ip>:3000` (no space, no quotes) for consistency with `.env.example` style. Cosmetic only.

### A-5. CLAUDE.md still documents an `nx`-based shared-build workflow in its Build Commands block

- Covered by A-2; called out separately because `CLAUDE.md` is the file loaded into every session and its "Shared packages" build line (`npx nx build shared && npx nx build queue`) is the most-read instance. Fixing it has outsized value.

> **Note on the many `old/…` and `tasks/…` matches** for `packages/db` / `@digilog/db` / `nx`: those are archived/historical docs and code-review logs. Several active docs (`BACKEND_GUIDE.md`, `PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`) already carry a dated "HISTORICAL" banner for the Phase-7 removals — those are correctly handled and **not** flagged here. Only the live, un-bannered, instruction-bearing references above need fixing.

---

## Part B — Dependency currency (📦 REGISTRY-VERIFIED via `npm outdated`)

`npm outdated` was run across all workspaces on 2026-06-29. "Latest" is the live npm-registry value. The project pins majors with caret ranges (`^6.1.0` etc.), so being behind a major is **intentional and safe** — these are upgrade *opportunities*, not breakage. Config-relevant majors are analyzed in Part C.

### Behind by a MAJOR version (config/behavior implications — see Part C)

| Package | Installed | Latest | Config-file impact? |
| --- | --- | --- | --- |
| `@prisma/client` / `prisma` | 6.19 | **7.8.0** | **Yes** — schema.prisma generator change (C-1) |
| `vite` | 6.4 | **8.1.0** | **Yes** — `manualChunks` / `customResolver` (C-2) |
| `@vitejs/plugin-react` | 4.7 | **6.0.3** | Yes — forces Vite 8 (C-2) |
| `vite-plugin-pwa` | 0.20 | **1.3.0** | Low — shape unchanged; needs 1.3.0 for Vite 8 (C-2) |
| `tailwind-merge` | 2.6 | **3.6.0** | **Yes** — v3 is the correct version for Tailwind v4 (C-2) |
| `eslint` / `@eslint/js` | 9.39 | **10.6 / 10.0** | Low — flat config still valid; eslintrc removed (C-3) |
| `typescript` | 5.9 | **6.0.3** | Low — your tsconfig options unaffected (C-3) |
| `vitest` | 3.2 | **4.1.9** | Low — your `test` options unaffected (C-3) |
| `zod` | 3.25 | **4.4.3** | Code-level (not config) — breaking (C-1) |
| `nodemailer` | 8.0 | **9.0.1** | Behavior — TLS now validated by default (C-1) |
| `graphile-worker` | 0.16.6 | **0.17.2** | Low — pool-locking change (C-1) |
| `@fastify/multipart` | 9.4 | **10.0.0** | Still Fastify-5 compatible (C-1) |
| `@fastify/rate-limit` | 10.3 | **11.1.0** | Still Fastify-5 compatible (C-1) |
| `@fastify/swagger-ui` | 5.2 | **6.0.0** | Still Fastify-5 compatible (C-1) |
| `lucide-react` | 0.474 | **1.22.0** | None (icon set) |
| `@hookform/resolvers` | 4.1 | **5.4.0** | Code-level |
| `@napi-rs/canvas` | 0.1.100 | **1.0.1** | None (API stable) |
| `dotenv` | 16.6 | **17.4.2** | Low |
| `csv-parse` | 6.2 | **7.0.0** | Code-level |
| `bcrypt` | 5.1 | **6.0.0** | Code-level |
| `jsdom` | 25.0 | **29.1.1** | Test-only |
| `@capacitor/*` | 8.3 | **8.4.1** | Patch within major |

### Behind only by minor/patch (safe `npm update`, no config change)

`fastify` 5.7→5.9 · `turbo` 2.8→2.10 · `@fastify/static` 9.0→9.1 · `jose` 6.1→6.2 · `tailwindcss`/`@tailwindcss/vite` 4.1→4.3 · `react`/`react-dom` 19.2.4→19.2.7 · `react-router-dom` 7.13→7.18 · `swr` 2.4.0→2.4.2 · `pg` 8.18→8.22 · `tsx` 4.21→4.22 · `react-hook-form` 7.71→7.80 · `dayjs`, `ldapts`, `sanitize-html`, `adm-zip`, `jspdf-autotable`, `typescript-eslint` 8.59→8.62, and several `@types/*`.

> **Note:** `react-router-dom` and `swr` are 5+ minors behind despite frequent releases — worth a routine `npm update` (no config impact).

---

## Part C — Major-version migration analysis (🌐 DOC-VERIFIED, URLs cited)

Each claim below was confirmed by a sub-agent against an official source. The URL is the authority.

### C-1. Backend majors

- **Prisma 6 → 7 — schema.prisma change required.** `generator client { provider = "prisma-client-js" }` is **deprecated (not yet removed)** in Prisma 7. The new provider is **`prisma-client`** (Rust-free); it makes the `output` field **mandatory** (client no longer emitted into `node_modules`), and `url`/`directUrl` move out of the `datasource` block into a `prisma.config.ts`. Imports change from `@prisma/client` to the generated output path. → **Staying on Prisma 6 is fine; upgrading to 7 is a deliberate schema migration, not a drop-in.** Source: <https://www.prisma.io/docs/orm/v6/more/upgrades/to-v7>
- **zod 3 → 4 — breaking, but not a config file.** Top-level validators (`z.email()` vs `z.string().email()`), unified `error` API, `._def`→`._zod.def`. Incremental path: zod 3.25+ ships `zod/v3` and `zod/v4` subpaths. Source: <https://zod.dev/v4/changelog>
- **Fastify plugin majors are all still Fastify-5 compatible** — `@fastify/multipart` 10, `@fastify/rate-limit` 11, `@fastify/swagger-ui` 6 each declare `fastify ^5.0.0`. No Fastify-6 requirement. Sources: the respective `package.json` at each release tag, e.g. <https://github.com/fastify/fastify-rate-limit/blob/v11.1.0/package.json>
- **nodemailer 8 → 9 — behavioral breaking change.** `createTransport` signature unchanged, but remote-content HTTPS (attachment URLs, OAuth2 endpoints, proxy CONNECT) now **validates TLS certs by default**. Self-signed hosts need `tls.rejectUnauthorized=false`. Source: <https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md>
- **graphile-worker 0.16 → 0.17** — jobs now `locked_by` WorkerPool id (matters for Worker Pro), migrations stored as JS strings. `run`/`runMigrations` API surface unchanged. Source: <https://github.com/graphile/worker/blob/main/RELEASE_NOTES.md>

### C-2. Frontend build chain

- **Vite 6 → 8 — two genuinely breaking config items.** (1) `build.rollupOptions.output.manualChunks` **object form is removed in Vite 8** (Rolldown); your `vite.config.ts` uses the object form (`vendor`, `swr`) → **must migrate**. (2) `resolve.alias` `customResolver` is gone — you don't use it, so safe. Min Node for Vite 8: 20.19+/22.12+. Sources: <https://vite.dev/blog/announcing-vite8>, <https://vite.dev/guide/migration>
- **@vitejs/plugin-react 6 requires Vite 8** and no longer bundles Babel. A plain `react()` entry still works. Source: <https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md>
- **vite-plugin-pwa 0.20 → 1.x — config shape unchanged** (`VitePWA({registerType, manifest, workbox, includeAssets})` still valid). Need **1.3.0** specifically for Vite-8 peer support. Sources: <https://github.com/vite-pwa/vite-plugin-pwa/releases>, <https://vite-pwa-org.netlify.app/guide/change-log>
- **Tailwind 4.1 → 4.3 — non-breaking minor.** Only deprecation: `start-*`/`end-*` → `inset-s-*`/`inset-e-*` (backward compatible). Safe `npm update`. Source: <https://github.com/tailwindlabs/tailwindcss/releases>
- **tailwind-merge 2 → 3 — breaking, and the version you actually want on Tailwind v4.** v2 supports Tailwind v3; **a Tailwind-v4 project should be on tailwind-merge v3** (theme keys, validators, modifier positioning changed). This is the one frontend upgrade with a correctness angle, not just currency. Source: <https://github.com/dcastil/tailwind-merge/releases/tag/v3.0.0>

> ⚠️ **UNVERIFIED:** whether `server.https` and `build.sourcemap: 'hidden'` changed across Vite 7/8 — not mentioned in the migration guide (absence ≠ confirmation of "unchanged"). Re-check against the Vite 7/8 migration guide before any Vite upgrade.

### C-3. Tooling

- **TypeScript 5.9 → 6.0 — your three tsconfig options are unaffected.** `moduleResolution: "bundler"` ✅, `module: "ESNext"` is now the default ✅, `target: "ES2022"` ✅ (only `es5` deprecated). 6.0 deprecates `outFile`, `moduleResolution: node/classic`, etc. — none used here. Source: <https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/>
- **ESLint 9 → 10 — flat config (`eslint.config.js`) is the *only* supported format**; your config shape is valid. eslintrc is fully removed; config lookup now starts per-file (monorepo-relevant). Min Node 20.19+. Sources: <https://eslint.org/blog/2026/02/eslint-v10.0.0-released/>, <https://eslint.org/docs/latest/use/migrate-to-10.0.0>
- **typescript-eslint** — spreading `...tseslint.configs.recommended` into the flat array (as in `apps/web/eslint.config.js`) is current recommended usage. Source: <https://typescript-eslint.io/getting-started/>
- **Vitest 3 → 4 — your `test` options (`globals`, `environment`, `include`, `setupFiles`, `pool`, `fileParallelism`) are NOT breaking-listed.** Vitest 4 requires Vite ≥ 6 (you have 6.4 ✅). Breaking changes are elsewhere (coverage remapping, `workspace`→`projects`, reporter hooks). Source: <https://vitest.dev/guide/migration.html>
- **Turbo — `"tasks"` key is correct** (renamed from `"pipeline"` in 2.0; you already use `tasks` ✅). **One nit:** `$schema: https://turbo.build/schema.json` now **301-redirects** to `https://turborepo.dev/schema.json` (domain rebrand). It still resolves, but the canonical value is the `turborepo.dev` one. Source: <https://turborepo.dev/repo/docs/reference/configuration>

---

## Part D — Android / native (inventory only)

| Catalog | agp | kotlin | composeBom | Note |
| --- | --- | --- | --- | --- |
| `RFID/gradle/libs.versions.toml` | 8.7.3 | 2.1.0 | 2024.12.01 | newer Kotlin/BOM than the other catalog |
| `rfid_scan_app/gradle/libs.versions.toml` | 8.13.2 | 2.0.21 | **2024.09.00** | older Compose BOM; AGP newer |

- **Inconsistency (✅ REPO-VERIFIED):** the two Kotlin/Compose catalogs disagree (`kotlin` 2.1.0 vs 2.0.21; Compose BOM 2024.12 vs 2024.09; AGP 8.7.3 vs 8.13.2). If both apps are meant to track the same toolchain, align them.
- **Currency:** ⚠️ **UNVERIFIED** — AGP/Kotlin/Compose-BOM latest versions were **not** checked against Google's Maven/JetBrains here. Needs a dedicated Android-toolchain pass.

---

## Mapping to the requested 13-section template

| # | Section | Result |
| --- | --- | --- |
| 1 | Removed configs | **A-1** (`knip.json` → deleted `packages/db`); `README.md` `nx build db`. |
| 2 | Deprecated configs | Prisma `prisma-client-js` generator (**C-1**, deprecated in v7, you're on v6 so not yet urgent); Tailwind `start-*/end-*` utilities (**C-2**); TS `es5`/`outFile` (not used). |
| 3 | Renamed configs | Turbo `pipeline`→`tasks` (**already done** ✅); Turbo schema host `turbo.build`→`turborepo.dev` (**C-3**, cosmetic). |
| 4 | Newly available configs | None required for current versions. On upgrade: Prisma `prisma.config.ts`, Vitest `projects`. |
| 5 | Missing recommended configs | **No `engines.node` field in any `package.json`** (✅ REPO-VERIFIED). Defensible to add one: Vite 8 / plugin-react 6 / ESLint 10 all now floor at Node 20.19+/22.12+, and `CLAUDE.md` already assumes Node 20+. An `"engines": { "node": ">=20.19" }` in root `package.json` makes that contract explicit and lets npm warn on mismatch. Otherwise: `apps/web/eslint.config.js` intentionally minimal (documented); `packages/queue` has no vitest config (documented as intentional). |
| 6 | Incorrect values | **A-2** (`npx nx build` — wrong tool). (A-3's "IP not in cert SAN" was corrected — the live cert covers it; only template drift remains.) |
| 7 | Invalid sections | **A-1** (`knip.json` `packages/db` block). |
| 8 | Breaking changes | All in **Part C** (Vite 8 manualChunks, tailwind-merge 3, Prisma 7, zod 4, nodemailer 9). None affect the *current* pinned versions — they are upgrade-time concerns. |
| 9 | Compatibility issues | None functional — live `server.crt` covers current IPs incl. `192.168.1.53` (A-3 corrected). Plugin majors confirmed Fastify-5 safe (**C-1**). |
| 10 | Performance | Vite 8 (Rolldown) is the only material build-perf lever — gated behind the manualChunks migration (**C-2**). No quick wins missing in current config. |
| 11 | Security | `apps/api/.env.example` already documents strong defaults (JWT ≥32 chars, 1h TTL, `TRUST_PROXY` off by default, TLS on). **Cert hygiene OK:** `git ls-files certs/` tracks only the public `server.crt` — **`server.key` is NOT tracked** (✅ REPO-VERIFIED), so no private key is committed. nodemailer 9's default cert validation (**C-1**) would be a security *improvement* on upgrade. No insecure setting found. |
| 12 | Best practice | tsconfig/eslint-flat/vite/vitest configs are current and idiomatic for their pinned majors. Primary debt is **doc drift (Part A)**, not config quality. |
| 13 | Migration patch | Below — **proposed, not applied.** |

---

## Section 13 — Proposed changes (NOT applied — confirm first)

### Tier 1 — Safe, no version change, fixes real drift (recommend applying)

1. **`knip.json`** — remove the dead workspace line:
   ```diff
   -    "packages/db": { "entry": ["src/index.ts!"], "project": "src/**/*.ts" },
   ```
2. **`apps/web/.env.production`** — ✅ **DONE** (2026-06-29): normalized formatting and set to the confirmed current IP `https://192.168.1.53:3000`. Live `server.crt` already covers `.53`, so **no cert regen needed**; rebuild the web bundle + APK only if the tablet must target the new IP. (Optional hygiene: sync `certs/server.ext` + `certs/ssl.conf` `[alt_names]` to the live cert's SAN list so a future re-sign doesn't drop current IPs.)
3. **`turbo.json`** — optional canonical schema host:
   ```diff
   -  "$schema": "https://turbo.build/schema.json",
   +  "$schema": "https://turborepo.dev/schema.json",
   ```
4. **Docs (`CLAUDE.md:56`, `packages/shared/CLAUDE.md:8/14`, `docs/CONTRIBUTING.md:84`, `future/frontend/PATTERNS.md:121`, `README.md:123`)** — replace `npx nx build <pkg>` with `npm run build -w @digilog/<pkg>` (or `npm run build` at root). Fix `README.md:123` to drop the `db` package.
5. **Routine `npm update`** for the minor/patch list in Part B (no config change).

### Tier 2 — Major upgrades (each is its own task; do NOT batch)

- **tailwind-merge 2 → 3** — *recommended*: you're on Tailwind v4, v3 is the matching major. Smallest, highest-correctness-value upgrade.
- **Vite 6 → 8** (+ `@vitejs/plugin-react` 6 + `vite-plugin-pwa` 1.3) — requires migrating `manualChunks` to function form and re-verifying `server.https`/`build.sourcemap` (⚠️ unverified). One coordinated PR.
- **Prisma 6 → 7** — schema.prisma generator migration + `prisma.config.ts`. Deliberate, well-scoped, follow the official v7 upgrade guide.
- **zod 3 → 4**, **ESLint 9 → 10**, **TypeScript 5.9 → 6**, **Vitest 3 → 4**, **nodemailer 8 → 9** — independent upgrades, each low config-risk per Part C, but each touches code/behavior. Sequence them, don't bundle.

---

## Final verification checklist

- [x] Every live config file inventoried and read (table above), including the root `.env.example`.
- [x] Hidden/nested configs included (`.claude/`, both `.env*`, gradle catalogs, `certs/ssl.conf`).
- [x] Task-named categories (CI/CD, Docker/K8s, IDE, `.npmrc`, `.editorconfig`) explicitly searched; absence stated, not omitted.
- [x] `engines.node` checked (absent — flagged §5); private key tracking checked (`server.key` untracked — §11).
- [x] "Latest version" claims come from a live `npm outdated`, not memory.
- [x] Every behavior/breaking-change claim carries a cited official URL, or is marked ⚠️ UNVERIFIED.
- [x] Drift findings proven by `ls`/`grep`/`node`, not asserted.
- [x] No findings manufactured to fill empty template sections.
- [x] Migration patch proposed, not applied.
- [x] **A-3 corrected** (2026-06-29): live `server.crt` SAN verified via `openssl` — covers current IP `192.168.1.53`; `.env.production` set; no cert regen needed.
- [ ] **Open / needs you:** Android toolchain currency (Part D); whether to rebuild the APK for the new IP; whether to proceed with any Tier-2 upgrade.
