# DigiLog Setup.exe - Clean-VM Acceptance Runbook (M7)

**Purpose:** prove `DigiLog-Setup-<ver>.exe` installs, runs, upgrades, and uninstalls
correctly on a **fresh Windows machine with nothing pre-installed** (no Node, no
PostgreSQL, no Visual C++ toolchain, no certs). This is the M7 capstone gate before
shipping to a customer.

**Environment:** a clean Windows 10 or 11 x64 VM. Take a **snapshot** before Test 1 so
you can re-run from a pristine state. Run everything as a local Administrator.

> **EXPECTED, not a bug:** the current builds are **unsigned** (M7 chose "scaffold
> signing, sign later"). Windows **SmartScreen** ("Windows protected your PC") and some
> antivirus will warn on the unsigned `Setup.exe`. Click **More info -> Run anyway**.
> Do **not** log these as failures - they disappear once the exe is signed (M7 signing
> step: `build-installer.ps1 -Sign -CertPath <pfx> ...`).

---

## 0. Pre-flight (before Test 1)

- [ ] VM is a clean image; snapshot taken.
- [ ] `node --version` and `psql --version` both **error** (nothing pre-installed - that's the point).
- [ ] Ports free: `Test-NetConnection localhost -Port 3000` and `-Port 5433` both **fail** to connect.
- [ ] `C:\Program Files\DigiLog` and `C:\ProgramData\DigiLog` do **not** exist.
- [ ] At least ~1.5 GB free disk (installer ~200-300 MB + PG data + node_modules).

---

## 1. Fresh install

1. [ ] Double-click `DigiLog-Setup-<ver>.exe`. (SmartScreen -> More info -> Run anyway.)
2. [ ] Wizard: accept the install dir; set an **initial admin password** (>= 8 chars) on the prompt page.
3. [ ] Let it run (status: "Setting up the DigiLog database and services..."). This can take a minute.
4. [ ] Wizard reports success.

**Verify install:**
- [ ] `Get-Service DigiLogDB, DigiLogAPI` -> both **Running**, StartType **Automatic**.
- [ ] `C:\Program Files\DigiLog\{runtime,pgsql,service,scripts}` all present.
- [ ] `C:\ProgramData\DigiLog\{db,uploads,logs,config,backups}` present; `config\digilog.env` exists with `JWT_SECRET`, `OFFLINE_REPLAY_SECRET`, `DATABASE_URL` (port 5433), `UPLOAD_DIR=C:\ProgramData\DigiLog\uploads`.
- [ ] Open the Start-menu / desktop **DigiLog** shortcut -> browser opens the app.
- [ ] Log in as `superadmin` / <the password you set> -> **forced password change** on first login works.
- [ ] No console window is left open (it runs as a service).

---

## 2. Data location (the UPLOAD_DIR / ProgramData guarantee)

- [ ] Upload a **profile photo** (a user's avatar). Confirm the file appears under `C:\ProgramData\DigiLog\uploads\photos\` (NOT under `Program Files`).
- [ ] Generate a **report PDF**. Confirm it appears under `C:\ProgramData\DigiLog\uploads\reports\` (NOT under `Program Files\...\runtime`).
- [ ] Both files render/download correctly in the UI (served path == written path).

---

## 3. Reboot resilience

- [ ] Reboot the VM.
- [ ] After boot (no login to Windows required for services), `Get-Service DigiLogDB, DigiLogAPI` -> both **Running**.
- [ ] App reachable again at the shortcut URL; existing login/session behaves.

---

## 4. Upgrade v(N) -> v(N+1)  (data + secrets preserved)

> Build a higher-version installer: `build-installer.ps1 -AppVersion <N+1> ...`. For a
> real schema test the v(N+1) build must contain an actual new migration folder;
> otherwise `migrate deploy` is a no-op (still valid for the data-preservation test).

Before upgrading, record state to compare after:
- [ ] Note the superadmin can log in; note counts of a few records (e.g. users, any filters/reports you created); copy the current `config\digilog.env` aside.

Run the upgrade:
1. [ ] Run `DigiLog-Setup-<N+1>.exe` on the machine that already has v(N).
2. [ ] The wizard **does NOT** show the admin-password page (upgrade detected via existing `digilog.env`).
3. [ ] Status shows "Backing up and upgrading the DigiLog database...".

**Verify upgrade:**
- [ ] A backup exists: `C:\ProgramData\DigiLog\backups\pre-upgrade-v<N+1>-<timestamp>.sql`, non-empty.
- [ ] `Get-Service DigiLogAPI` -> Running; app reachable.
- [ ] Log in as `superadmin` with the **original** password (unchanged by the reseed).
- [ ] All previously created data is intact (counts match; your photo + report still present).
- [ ] `config\digilog.env` is **identical** to the copy you set aside (secrets NOT regenerated).
- [ ] `C:\ProgramData\DigiLog` was never wiped; `Program Files\DigiLog\runtime` shows the new version's files.

---

## 5. Uninstall  (data preserved by default)

1. [ ] Uninstall via Settings -> Apps -> DigiLog (or the Start-menu uninstaller).
2. [ ] `Get-Service DigiLogDB, DigiLogAPI` -> both **removed** (not found).
3. [ ] `C:\Program Files\DigiLog` removed.
4. [ ] **`C:\ProgramData\DigiLog` is PRESERVED** - `db`, `uploads`, `backups`, audit records all still on disk (21 CFR Part 11).
5. [ ] Firewall rule "DigiLog API" removed.

**Reinstall-over-preserved-data (optional but recommended):**
- [ ] Re-run `DigiLog-Setup-<ver>.exe`. It should detect the preserved `digilog.env` + DB cluster, skip the admin page, reuse the existing data, and the old superadmin/password + records still work.

---

## 6. Full purge (optional - destructive)

- [ ] From an elevated shell: `powershell -File "C:\Program Files\DigiLog\scripts\uninstall.ps1" -PurgeData` (or run before uninstalling program files).
- [ ] `C:\ProgramData\DigiLog` is now **removed**. (Only ever do this when the customer explicitly wants their data destroyed.)

---

---

## 7. Tablet connect over HTTPS (DEFERRED — needs a real Android device on a LAN)

> This section **cannot be checked off in this dev environment.** It requires a real Android
> tablet running the DigiLog APK, on the same LAN as the installed server PC.

**Prerequisite:** Tests 1–3 above pass on the server PC. `C:\ProgramData\DigiLog\certs\rootCA.pem`
exists (generated by `install.ps1` during Test 1).

Steps:
1. [ ] Copy `C:\ProgramData\DigiLog\certs\rootCA.pem` to the tablet (e.g. via USB or a network share).
2. [ ] On the tablet: **Settings → Security → Install certificate** (or "Install from storage" depending on Android version) → select `rootCA.pem` → name it "DigiLog CA" → install for **VPN and apps**.
3. [ ] Open the **DigiLog APK** on the tablet. On first launch (no stored server address) the app should display the **"Server Address"** setup screen.
4. [ ] Enter `https://<LAN-IP>:3000` (the server PC's LAN IP, e.g. `https://192.168.1.55:3000`) and tap **Connect**. The health check should pass — the tablet trusts the server cert because it trusts the installed rootCA.
5. [ ] Log in as `superadmin` / <the password you set during install>. Login should succeed over HTTPS with no TLS errors.
6. [ ] Verify that filter operations, offline sync indicator, and basic navigation work normally.

**If the health check fails at step 4:** confirm the rootCA was installed correctly (Settings → Security → Trusted credentials → User tab should show "DigiLog CA"); confirm the server PC's firewall allows inbound TCP 3000 from the LAN; confirm `API_HTTPS=true` in `C:\ProgramData\DigiLog\config\digilog.env`.

---

## Sign-off

| Test | Result | Notes |
|------|--------|-------|
| 0 Pre-flight | [ ] pass | |
| 1 Fresh install + login | [ ] pass | SmartScreen warning expected (unsigned) |
| 2 Data in ProgramData | [ ] pass | photo + report under ProgramData\uploads |
| 3 Reboot resilience | [ ] pass | |
| 4 Upgrade preserves data + secrets | [ ] pass | backup file present |
| 5 Uninstall preserves ProgramData | [ ] pass | |
| 6 Purge (optional) | [ ] pass | |
| 7 Tablet HTTPS connect | [ ] DEFERRED | Needs real Android device on LAN |

**Blockers to fix before customer ship (independent of this runbook):**
- Sign the installer (removes SmartScreen/AV warnings) - `build-installer.ps1 -Sign ...`.
- Run Test 7 on a real Android tablet (M8 deferred gate) — rootCA install + APK server-address + login over HTTPS.
- Authenticate/verify the bundled PostgreSQL binary distribution license (permissive; confirm the chosen zip).
