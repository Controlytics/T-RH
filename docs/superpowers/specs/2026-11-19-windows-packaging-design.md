# T&RH Monitoring — Windows Setup.exe + Update.exe (design)

**Date:** 2026-11-19 · **Status:** for operator review — nothing built yet.
**Inputs:** the operator's 19-phase packaging Master Prompt; Stage 1 audit
`docs/audit/2026-11-19-deployment-packaging-audit.md` (untracked); 2026-11-07 audit §9 (S9-*).

## 1. Operator decisions (2026-11-19)

| # | Decision | Chosen |
|---|---|---|
| D1 | Product name | **T&RH Monitoring** (display). Folder / service / file names carry no `&` (it breaks `emqx.cmd` and npm `.cmd` shims): `TRH-Monitoring`. New AppId `{351D02AE-8A99-4F37-B6E6-9349E175EAF0}` (no customer has installed, so nothing depends on the old string). |
| D2 | Updates | **Manifest-delta Update.exe.** Files roll back freely; the database is restored only when a migration failed before the API restarted on the new version; after that, fix forward. A change to Node / PostgreSQL / EMQX binaries ships as a full Setup.exe. |
| D3 | Build + test | **GitHub Windows runner** (`windows-2022`), like `build-deb.yml`. Representative, not clean: the image ships Node, PostgreSQL and the VC++ runtimes. Never install on the dev laptop. |
| D4 | Layout | **In this repo** (`installer/`, `scripts/`, new `scripts/release/`). |
| D5 (default) | First version | **1.0.0**, single source = root `package.json` `version`. |
| D6 (default) | Signing | Unsigned until a certificate is bought (`build-installer.ps1 -Sign` stays wired). SmartScreen warns until then; the manual says so. |

Judgement calls in this design the operator should check (§9 lists them again):
- the broker service keeps EMQX's own internal name `emqx` (its launcher hard-codes it); only its
  display name becomes "T&RH Monitoring – MQTT broker";
- the internal database name / role stay `digilog_db` / `digilog` (never shown to a user; the `.deb`
  and the backup tools use the same names);
- `/api/health` gains the version (it is unauthenticated, so the version becomes visible on the
  network — needed so an update can verify itself without a login);
- certificates are generated with the bundled Node + the already-shipped `@peculiar/x509`, not
  OpenSSL (closes S9-16 without shipping a second crypto toolchain).

## 2. Names and layout

| Thing | Value |
|---|---|
| Display name / publisher | T&RH Monitoring / Controlytics |
| Program folder | `{autopf}\TRH-Monitoring` (user may change) |
| Data folder | `{commonappdata}\TRH-Monitoring` — passed to **every** script (`-DataRoot`), never a literal `C:\` |
| Services | `TRH-DB` (PostgreSQL), `TRH-API` (WinSW → Node), `emqx` (display "T&RH Monitoring – MQTT broker") |
| Scheduled task | `T&RH Monitoring Nightly Backup` |
| Firewall rules | group `T&RH Monitoring`: API port, MQTT, MQTTS — Domain + Private profiles only, delete-then-add |
| CA | `T&RH Monitoring Local CA`; its thumbprint recorded in `install-state.json` so uninstall can remove it |
| Start menu | T&RH Monitoring (opens the app) · Check health · Repair · Collect support logs · Uninstall |

Data-folder contents: `config\digilog.env`, `config\install-state.json`, `db\`, `certs\`, `emqx\`,
`uploads\`, `backups\`, `logs\` (`logs\install\`, `logs\update\`, API, PostgreSQL), `updates\history.json`.
**ACL:** `config`, `certs`, `db`, `backups`, `emqx` and `{app}\emqx\etc` = SYSTEM + Administrators only,
inheritance removed (closes S4-13 / S9-3 / S9-4). `uploads` and `logs`: SYSTEM + Administrators
full, Users none.

## 3. Versioning and the release manifest

- Version = root `package.json` `version` (semantic). Build = CI run number; commit = git SHA.
- The build writes `runtime\release.json` `{product, version, build, commit, date}`; the API reads
  it once (`RELEASE_INFO_PATH` override → `<runtime>/release.json` by default → root `package.json`
  + `-dev` → `unknown`) and returns `version` / `build` from `/api/health` (declared in the response
  schema); System Health shows it with the commit and build date. (This said "under Help / About" —
  there is no About page; corrected 2026-11-19 when Phase A was built.)
- `{app}\release-manifest.json` (written by `scripts/release/manifest.mjs`):

```json
{
  "product": "T&RH Monitoring", "appId": "{351D02AE-…}",
  "version": "1.1.0", "build": 57, "commit": "<sha>", "date": "2026-…",
  "schema": { "lastMigration": "20261118120000_…", "count": 58 },
  "components": { "node": "24.x.y", "postgresql": "18.x", "emqx": "5.3.2", "winsw": "x.y.z" },
  "updatableFrom": ["1.0.0", "1.0.1"], "minUpdaterVersion": 1,
  "files": [{ "path": "runtime/api/dist/app.js", "size": 1234, "sha256": "…" }]
}
```

Per-install files (rendered `emqx\etc\*.conf`, `service\TRH-API.xml`, `DigiLog.url`) are excluded.
Manifests are published as GitHub Release assets with the Setup.exe and `SHA256SUMS`, so the Update
Builder can fetch the previous one without committing multi-MB JSON.

## 4. Reproducible build (`scripts/build-installer.ps1`, rewritten)

1. Clean room from a **commit / tag** (`git worktree add --detach`), never the working tree
   (closes S9-13: uncommitted edits and stale `dist` can no longer ship). `-OutDir` outside OneDrive.
2. Inputs pinned in `installer/components.json` (URL + SHA-256 for the Node zip, PostgreSQL 18
   binaries zip, EMQX 5.3.2 zip, WinSW); the build downloads and **refuses a hash mismatch**.
3. `npm ci` → build shared / queue / API / web / seed **in the clean room** → `npm ci --omit=dev`
   + `prisma generate` + graphile patch check (existing) → stage.
4. Stage only what runs: `api/dist` (tests and `src/test-support` excluded), `api/prisma`
   (`schema.prisma`, `migrations`, `sql`, `seed.mjs` — no archives, no `.ts`), `web/dist`,
   crontab, production `node_modules`, `release.json`, third-party notices.
5. **PE-import scan** of every `.exe/.dll/.node` in the stage: each imported DLL must be in the stage
   or in a Windows system baseline list; a VC++ runtime import fails the build until the redist is
   bundled (answers the open VC++ question on a runner that has VC++ installed).
6. Manifest + `SHA256SUMS` → ISCC (`installer/TRH-Monitoring.iss`) → `TRH-Monitoring-Setup-<ver>.exe`.

## 5. Setup.exe (first install, upgrade-by-full-installer, re-run = repair)

**Wizard (plain language):** Welcome → Licence + third-party notices → **System check** (custom
page: Windows ≥ 10 / Server 2016, 64-bit, admin, free disk ≥ 5 GB on the data drive, RAM ≥ 4 GB
warn-only, ports API 3000 / DB 5433 / MQTT 1883 / MQTTS 8883 / 18083 free — a busy port names the
owning program and stops; an existing `emqx` service from another product stops with a message) →
Install location → **Administrator account** (password + confirm, the app's password policy shown) →
**Network** (detected addresses, choose the one devices use; API port) → Ready → Progress with one
plain sentence per step ("Preparing the database…", "Setting up the background components…") →
**Final check** (version, location, database, three services, health) → Finish with "Open T&RH
Monitoring now".

**Mechanics:**
- The orchestrator runs from `[Code]` (`Exec`, not a hidden `[Run]` line); a non-zero exit stops
  Setup with the plain-language step that failed and the log path (closes the open half of S9-14).
  Each script writes a transcript to `logs\install\<op>-<timestamp>.log`; secrets are never printed.
- The admin password goes to the script in a file under Setup's own temp folder (ACL'd, deleted
  after use) — never on a command line, never in Setup's log (`dontlogparameters`; closes S9-21).
  The same rule for `psql`: role passwords via a temp SQL file, not `-c` (S9-25 pattern on Windows).
- **Fresh vs upgrade vs repair vs reattach** decided by `config\install-state.json`
  (`{version, status: "complete", caThumbprint, ports, address}` written only at the very end of a
  successful install) plus the registry, not by the env file (closes S9-15):
  - no state, no data → fresh;
  - state complete, older version → upgrade; same version → repair; newer installed → refuse;
  - data present but no services (uninstalled earlier) → **reattach**: register services against
    the kept database, then run the upgrade path;
  - a failed fresh install leaves `status: "failed"`; re-running cleans what that attempt created
    (only when the database holds no rows written after provisioning) and starts again.
- Certificates: `scripts/generate-certs.mjs` (bundled Node + `@peculiar/x509`): CA, server certificate
  (CN = chosen address, SAN DNS + IP for that address, `localhost`, `127.0.0.1`), optional device CA.
  Re-generable from Repair when the address changes (S9-11 IP part).
- `INSTRUMENT_TOKEN_KEY` generated (S9-24); `OFFLINE_REPLAY_SECRET`, `JWT_EXPIRES_IN`, `capacitor://`
  origin and the tablet shortcut dropped (N5).
- Services: WinSW `<onfailure>` restart, restart, then none; `<resetfailure>` 1 h. `sc failure` with
  the same bounded policy on `TRH-DB` and `emqx` (closes the unbounded loop and the missing recovery).
- Upgrade by full Setup.exe: `[InstallDelete]` the whole `{app}\runtime` before copying (N2); when
  the manifest's PostgreSQL **minor** or EMQX version differs, stop that service and replace its
  binaries (N1); a PostgreSQL **major** change is refused with a message (needs `pg_upgrade`, out of
  scope). Then the existing `upgrade.ps1` sequence (custom-format `pg_dump` first).
- Broker from a path with a space (S9-17): proven or disproven on the runner first; fallback = the
  broker's program files under `{commonappdata}\TRH-Monitoring\emqx-5.3.2` with the locked ACL.

## 6. Update.exe (`installer/TRH-Monitoring-Update.iss` + `scripts/update.ps1`)

**Update Builder** (`scripts/release/build-update.mjs`): previous manifest + new stage → changed /
new / deleted files (by SHA-256), migrations added, component changes, env keys added,
`update-manifest.json` (`from` list, `to`, files with hashes, deletions, migrations,
`requiresFullInstaller` when Node / PostgreSQL / EMQX / WinSW change), release notes from
`CHANGELOG.md`, payload folder → ISCC → `TRH-Monitoring-Update-<from>-to-<to>.exe` (same AppId, so
Add/Remove Programs shows the new version).

**Run sequence** (each step logged to `logs\update\`):
1. Find the install (registry → folder; `install-state.json`; `release-manifest.json` → version,
   schema). Not installed / version not in `from` / `requiresFullInstaller` → plain message naming
   the Setup.exe needed; nothing changed.
2. Show current and target version and the release notes.
3. Pre-checks: admin, free disk ≥ payload × 3 + database size, `TRH-DB` up, services present.
4. Extract the payload to `{app}\.update\<to>\`; **verify every file's SHA-256 against
   `update-manifest.json`** (a corrupt or edited package is refused before anything changes).
5. Back up to `backups\update-<from>-<to>-<ts>\`: the files to be replaced or deleted, `digilog.env`,
   `install-state.json`, the release manifest, and a custom-format `pg_dump`.
6. Stop `TRH-API` (and `emqx` only if broker files change).
7. Apply files (replace, add, delete) → `apply-schema.ps1` (migrate deploy + seed) → env keys
   append-only with safe defaults → re-render broker config if its templates changed.
8. Start services; health must report `version == to`, `db: connected`, `jobRunner: running`
   within 120 s.
9. Success → write `release-manifest.json`, `install-state.json`, `updates\history.json`; keep the
   backup (pruned to the last 3).
   **Failure** → stop the API; restore files + env + state from step 5; **restore the database only
   if the failure happened before step 8 started the API on the new version**; start the old
   version; verify its health; write `logs\update\rollback-<ts>.md` (what failed, what was restored,
   whether the old version is healthy). After a successful start on the new version, no automatic
   database restore — fix forward.

## 7. Repair, uninstall, health, diagnostics

- **Repair** (`scripts/repair.ps1`, Start menu, also run by Setup on a same-version re-run):
  verify every file against `release-manifest.json` (missing / changed → "run the same-version
  Setup.exe" with the list), re-register missing services, re-apply ACLs, firewall rules, scheduled
  task and broker config, regenerate the server certificate if the address changed (asks), health
  check. Never touches `digilog.env` secrets or the database.
- **Uninstall:** stop and remove services, task, firewall group, CA (by recorded thumbprint), program
  files. Then a page: "Keep your data (recommended)" / "Delete all data" — delete needs a second
  confirmation stating it removes the database, audit trail, uploads and backups.
- **Health check** (`scripts/health-check.ps1`, extends `verify-windows-deployment.ps1`): services,
  ports, `/api/health` (version, db, jobRunner), broker status, disk space, backup task last result,
  certificate expiry, Windows time sync status (S9-18, report only). Plain PASS / FAIL lines + exit code.
- **Collect support logs** (`scripts/collect-diagnostics.ps1`): zip to the Desktop with install /
  update / API / PostgreSQL / broker logs, manifests, `install-state.json`, service states, port
  owners, health output, system info, and `digilog.env` with **every value redacted except
  non-secret keys** (PORT, paths, URLs without credentials).
- **Restore** (`scripts/restore-db.ps1`): restore a custom-format dump into the cluster (operator
  use, confirmation required); exercised by CI.

## 8. Testing on the runner (`.github/workflows/build-windows.yml`)

Build → **fresh install** (silent, password file) → assert: three services running and
auto-start; ports; `/api/health` `version`, `db`, `jobRunner: running`; login over the API; create
an instrument, send a reading over HTTPS and over MQTT, read it back; backup task, firewall group,
ACLs (`icacls` — Users have no access to `config`, `certs`, `db`); CA in Root. → **service restart**
in dependency order (stand-in for a reboot — a hosted runner cannot reboot; the real reboot test is
the operator's) → **update N → N+1** (N+1 = same tree + a CI-only probe migration and a changed
file) with data preserved → **failed update** (CI-only failing migration) → files and database
restored, old version healthy, rollback report written → **repair** after deleting a file / a service
→ **uninstall keeping data** → **reinstall reattaches** (same admin password, readings still there)
→ **uninstall deleting data** → nothing left except Setup logs → **negative**: port 3000 occupied →
Setup stops at the system check with the owning process named. Artefacts: Setup.exe, Update.exe,
manifests, `SHA256SUMS`, every log, a generated test report (executed / not executable here).

## 9. Risks and open points

- EMQX 5.3.2 from `Program Files` (S9-17) — first runner run decides; fallback in §5.
- VC++ runtime need — settled by the PE scan, not by the runner.
- Wizard screenshots for the PDF manual: attempted on the runner's desktop session; if that fails,
  the operator captures them on the test PC. The manual is not finished without real screenshots.
- A real reboot, a truly clean Windows, a domain GPO blocking scripts (S9-23), a non-C: system drive
  — operator tests on their own machine; the runbook lists them.
- PostgreSQL major upgrades (18 → 19) are out of scope.
- Code signing waits for a certificate.
- Judgement calls for the operator: broker service name stays `emqx`; internal DB names stay
  `digilog_db` / `digilog`; the version is visible on `/api/health`; Node-based certificates.

## 10. Out of scope

The Linux `.deb` and AWS deploy (except shared templates staying compatible); an online update
server; multi-tenant installs; PostgreSQL major upgrades; app business logic (the one app-code
change is the version in `/api/health` and the UI, plus the API waiting for the database at boot —
N4).
