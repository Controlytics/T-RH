# Plan — T&RH Monitoring Windows Setup.exe + Update.exe

Spec: `docs/superpowers/specs/2026-11-19-windows-packaging-design.md`. Stage 1 audit:
`docs/audit/2026-11-19-deployment-packaging-audit.md` (untracked). Tracking: `tasks/todo.md` (top section).

**Rules for every task:** never run Setup.exe / `install.ps1` / `register-services.ps1` on the dev laptop;
every behaviour is proven on the Windows runner; a task is done only when its runner assertion is green;
commit / push only on the operator's word; CHANGELOG + docs per the Documentation Sync Rule.

## Touch points (found before any edit)

| Area | Files | Why they move |
|---|---|---|
| Installer | `installer/DigiLog.iss` → `installer/TRH-Monitoring.iss`; new `installer/TRH-Monitoring-Update.iss`, `installer/components.json`, `installer/notices/` | names, AppId, wizard, [Code] orchestration, update package |
| Install scripts | `scripts/{install,upgrade,uninstall,provision-db,apply-schema,provision-emqx,register-services,unregister-services,register-backup-task,backup-db,stage-runtime,build-bundle,build-installer,verify-windows-deployment}.ps1` | names, `-DataRoot`, transcripts, ACLs, firewall, recovery, state file, cert generation, password file |
| New scripts | `scripts/{update,repair,health-check,collect-diagnostics,restore-db,common}.ps1`, `scripts/generate-certs.mjs`, `scripts/release/{manifest,build-update,pe-scan,fetch-components}.mjs` | update, repair, diagnostics, release tooling |
| Shared with Linux | `scripts/emqx/{emqx.conf.template,acl.conf,api_key.bootstrap.template}` (read by `scripts/linux/digilog-lib.sh` + `build-deb.sh`) | only the acl.conf comment changes; the `.deb` must stay green |
| App (minimal) | `apps/api/src/app.ts` (health `version`/`build`, wait for DB at boot), new `apps/api/src/lib/release-info.ts`, `apps/api/src/modules/rule-engine/services.ts:1060` (`SERVER_VERSION` read `npm_package_version`), `apps/api/tsconfig.json` (exclude `src/test-support`), web System Health version line (there is no About page) | version exposure (N3), N4, dead test code in dist |
| Tests | `apps/api/src/lib/__tests__/installer-contract.test.ts` (reads script text), health e2e, `public-paths` test (unchanged path), new release-tool unit tests | contracts move with the scripts |
| CI | new `.github/workflows/build-windows.yml`; `build-deb.yml` untouched | runner tests |
| Root | `package.json` (`version: 1.0.0`) | version source |
| Docs | `docs/deployment-methods/method-a-native-windows.md`, `DEPLOY-WINDOWS.md`, `LOCAL_SETUP_WINDOWS.md` (installer parts), `docs/PHARMA_DEPLOYMENT_21CFR.md` (S9-31), `CLAUDE.md`, `apps/api/CLAUDE.md`, `CHANGELOG.md`, new `docs/guides/windows-install/` (PDFs + developer release guide) | names, behaviour, manuals |

## Phase A — foundations (app + repo, no installer behaviour yet) — DONE 2026-11-19

Built as below except: the default release file is `<runtime>/release.json` found relative to the code
(`RELEASE_INFO_PATH` only overrides it — a `.deb` upgrade never adds env keys, N7); the health route moved to
`lib/health-route.ts` so the e2e helper registers the real one (it had a stand-in); the `.deb` build writes
`release.json` and its smoke install asserts version + build (the only installed proof before Phase D); there
is no About page, so the version is on System Health only. CHANGELOG 2026-11-19 has the detail.

- A1 Root `package.json` `version: 1.0.0`; `lib/release-info.ts` reads `RELEASE_INFO_PATH` / fallback;
  `/api/health` returns `version` + `build` (declared in the schema — mutation-check by deleting the
  declaration); web About + System Health show it. The rule engine's Tenant details node
  (`modules/rule-engine/services.ts:1060`, `SERVER_VERSION`) falls back to `npm_package_version`,
  which is unset under WinSW and systemd — it reads release-info instead (branding override kept).
  Tests: health e2e asserts both fields; the Tenant details node test asserts the release version.
- A2 API waits for the database at boot (retry every 5 s, logs "waiting for database", gives up after
  10 min with a clear error) before `discoverAndRegisterConfigs()` (N4). Unit test with a failing
  first query.
- A3 `apps/api/tsconfig.json` excludes `src/test-support`; confirm `dist` has no `test-support`.
- A4 `scripts/emqx/acl.conf` comment without a user path; the `.deb` build stays green.

## Phase B — reproducible build

- B1 `installer/components.json` (URL + SHA-256 per input) + `scripts/release/fetch-components.mjs`
  (download, verify, cache outside OneDrive).
- B2 `build-installer.ps1` rewritten: `git worktree add --detach <commit>`, full build inside the clean
  room, stage only runtime files (spec §4.4), `release.json`, notices.
- B3 `scripts/release/pe-scan.mjs` (PE import table reader, no dependency) + Windows baseline list;
  fails on an unresolved import.
- B4 `scripts/release/manifest.mjs` → `release-manifest.json` + `SHA256SUMS`. Unit tests (hashing,
  exclusions, stable ordering).

## Phase C — Setup.exe

- C1 `TRH-Monitoring.iss`: names, AppId, MinVersion, version info, icon, licence + notices pages.
- C2 System-check page ([Code]: OS, arch, admin, disk, RAM, ports with owning process, foreign
  `emqx` service).
- C3 Administrator page (password + confirm, policy text) → password file in `{tmp}`;
  `dontlogparameters`; psql passwords via temp SQL file.
- C4 Network page (detected IPv4 addresses, API port) → passed to the orchestrator.
- C5 Orchestration from `[Code]` with per-step plain-language status, exit codes, transcripts in
  `logs\install\`, failure page with the step and log path.
- C6 `generate-certs.mjs` (CA, server, optional device CA) replaces every `openssl` call (S9-16).
- C7 ACLs (spec §2), firewall group on Domain + Private, bounded service recovery, CA thumbprint.
- C8 `install-state.json` and the fresh / upgrade / repair / reattach / failed-retry decision (S9-15).
- C9 Full-installer upgrade: `[InstallDelete]` runtime (N2), PostgreSQL-minor / EMQX binary
  replacement (N1), refuse PG major change.
- C10 Final check page + "Open T&RH Monitoring now".
- C11 Uninstall: services, task, firewall group, CA, keep-or-delete data page with double confirm.
- C12 Drop DigiLog leftovers (N5) and write `INSTRUMENT_TOKEN_KEY`.

## Phase D — runner workflow (fresh install)

- D1 `build-windows.yml` on `windows-2022`: build, silent install, the fresh-install assertions of
  spec §8, artefacts. **Needs the operator's OK to push** (each run uses Actions minutes).
- D2 Negative tests: port occupied, failed fresh install retried.
- D3 Decide S9-17 (EMQX from Program Files) from the run; apply the fallback if needed.

## Phase E — Update.exe

- E1 `scripts/release/build-update.mjs` + `update-manifest.json` + release notes; unit tests (diff,
  deletions, component change → requiresFullInstaller).
- E2 `TRH-Monitoring-Update.iss` + `scripts/update.ps1` (spec §6 sequence, verification, backup,
  apply, migrate, health, rollback report).
- E3 Runner: update N → N+1 with data preserved; failing-migration rollback; corrupt package refused;
  wrong `from` version refused.

## Phase F — reliability tools

- F1 `repair.ps1` (+ runner: deleted file, deleted service).
- F2 `health-check.ps1`, `collect-diagnostics.ps1` (redaction unit-tested), `restore-db.ps1` (runner:
  dump → restore into a scratch database → row counts match).
- F3 Runner: uninstall keeping data → reinstall reattaches; uninstall deleting data.

## Phase G — documentation

- G1 Non-technical **Installation Guide** and **Update Guide** (PDF, numbered steps, screenshots with
  arrows, common errors, collecting logs, support contact).
- G2 **Developer Deployment and Release Guide** (build, version bump, release, Update Builder, signing,
  CI, rollback policy).
- G3 Sync the active doc set (method-a, DEPLOY-WINDOWS, PHARMA doc, CLAUDE.md counts, CHANGELOG).

## Phase H — reports

- H1 Installation / update / recovery test reports generated from the runner logs, each case marked
  executed / not executable here; known limitations (reboot, clean VM, GPO, non-C: drive, signing,
  PostgreSQL major upgrade) with the exact operator steps.
