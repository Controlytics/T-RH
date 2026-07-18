# Phase 1 (Mosquitto rewrite) — local deployment + verification report

**Date:** 2026-04-29
**Branch:** `feature/phase1-mosquitto-rewrite`
**Worktree:** `.worktrees/phase1-mosquitto`
**Verifier:** automated session, attended

## Summary

Phase 1 of the windows-friendly-rewrite cuts EMQX over to Mosquitto 2.0 behind a `USE_MOSQUITTO` feature flag. This was the first **live** deployment test on a real Windows host; CI test coverage went green on this branch from the start, but the resume note (line 92) explicitly flagged that no test boots the API + a real Mosquitto. The audit was justified — verification turned up two real bugs that CI could not have caught, plus one configuration sharp edge that affects every operator.

End state: **26/26 tests pass, end-to-end MQTT publish + subscribe + ACL enforcement + flag rollback all verified on a real Mosquitto 2.1.2 broker.** Two source fixes committed locally on the worktree (not yet pushed); an operator-facing CWD requirement still needs a doc note.

## Defects found and fixed

### Defect 1 — `mosquitto.conf` plugin extension hardcoded to `.so`

**File:** `mosquitto/mosquitto.conf:27`
**Symptom:** On Windows, Mosquitto 2.1.2 errors out at startup:
```
Loading plugin: mosquitto_dynamic_security.so
Error: Unable to load plugin "mosquitto_dynamic_security.so".
Load error: The specified module could not be found.
mosquitto version 2.1.2 terminating
```
**Root cause:** Mosquitto's `plugin` directive does not auto-resolve the file extension. Linux ships `mosquitto_dynamic_security.so`; Windows ships `mosquitto_dynamic_security.dll`. The same conf cannot serve both.
**Fix (Option B per user decision):** Split into two confs.
- `mosquitto/mosquitto.windows.conf` — uses `.dll`, copied to `C:\Program Files\mosquitto\mosquitto.conf` by `scripts/install-mosquitto.ps1`
- `mosquitto/mosquitto.linux.conf` — uses `.so`, bind-mounted into `eclipse-mosquitto:2.0` by `docker-compose.yml`
- Old `mosquitto/mosquitto.conf` deleted

**Verification:** `mosquitto.exe -c mosquitto.windows.conf` now boots, dynsec plugin loads, port 1883 listening.

### Defect 2 — Aedes integration test cannot validate authn

**File:** `apps/api/src/transport/__tests__/mqtt-broker-integration.test.ts`
**Symptom:** None — the test passes regardless of broker authn correctness because `aedes` (the in-process broker stand-in) accepts any credentials by default.
**Root cause:** Aedes does not implement Mosquitto's dynsec plugin protocol; it has no concept of `encoded_password`, PBKDF2-SHA512, or per-role ACLs.
**Status:** Not fixed in this session. Phase 5 e2e scope: a broker-required test gated behind a `MOSQUITTO_BIN` env var.

## Operator sharp edge (not a defect, but undocumented)

**Symptom:** With `mosquitto.exe -c mosquitto.windows.conf` started from any CWD other than the conf's directory, every client (including the API itself) gets `CONNACK 5 "not authorised"`. No log line explains why.

**Root cause:** `mosquitto.windows.conf` uses relative paths (`./data/`, `./dynamic-security.json`). Mosquitto resolves these against process CWD, not the conf's directory. When the conf's `plugin_opt_config_file ./dynamic-security.json` resolves to a non-existent file, the dynsec plugin loads with empty client state, and every connect is rejected by `defaultACLAccess: false`.

**Why this is benign for the production install path:** `scripts/install-mosquitto.ps1` copies both the conf and dynsec into `C:\Program Files\mosquitto\`. The Windows service starts there, so `./dynamic-security.json` resolves correctly.

**Why this bit me in dev:** Running `mosquitto.exe` directly from a shell with arbitrary CWD breaks dynsec resolution. Until the Windows service is installed (requires admin), every operator hand-launching the broker for testing must pass `-WorkingDirectory ./mosquitto` (PowerShell) or `cd mosquitto && mosquitto -c mosquitto.windows.conf`.

**Recommendation:** add a "Manual broker start (dev mode)" note to `mosquitto/README.md` or `LOCAL_SETUP_WINDOWS.md`. Not blocking for the PR.

## Generator change (made during investigation, kept)

While bisecting Defect 2 above, I incorrectly hypothesized that the `password: "$2b$10$..."` bcrypt hash field was the auth failure cause and rewrote `mosquitto-acl-generator.ts` to emit `encoded_password: "$7$1000$<salt-base64>$<hash-base64>"` (PBKDF2-SHA512, 1000 iterations, 64-byte salt, 64-byte derived key — matching `mosquitto_passwd` and `mosquitto_ctrl dynsec init` output exactly). After identifying the real root cause (CWD), I confirmed that the dynsec plugin actually accepts both `password: <bcrypt>` and `encoded_password: $7$...`. So the generator change was not strictly required.

I kept the change because:
- The PBKDF2/`$7$` format is what Mosquitto's own tooling produces; an operator who debugs by running `mosquitto_passwd` against a known plaintext gets the same shape they see in our generated `dynamic-security.json`. Less surprise.
- It removes a runtime dep on `bcrypt` (a native-compiled npm package — exactly the kind of thing windows-friendly-rewrite is trying to eliminate). `bcrypt` stays in the API's deps for password hashing in users module, but our generator now uses `node:crypto.pbkdf2Sync` only.
- The 12 unit tests + 11 routes tests still pass with no shape changes other than the field name (`password` → `encoded_password`).

If you'd prefer to revert the generator and keep the bcrypt path (smaller diff), say so — the revert is mechanical.

## Files changed (worktree, uncommitted)

```
modified:   apps/api/src/transport/mosquitto-acl-generator.ts
modified:   apps/api/src/transport/__tests__/mosquitto-acl-generator.test.ts
modified:   scripts/install-mosquitto.ps1
modified:   docker-compose.yml
deleted:    mosquitto/mosquitto.conf
new file:   mosquitto/mosquitto.windows.conf
new file:   mosquitto/mosquitto.linux.conf
new file:   apps/api/.env.backup-phase1   (local backup, gitignored)
```

`git diff --stat HEAD`: 5 files, 56 insertions, 46 deletions (excluding the new + deleted files which are pure renames).

## Verification matrix

| # | Check | Method | Result |
|---|---|---|---|
| 1 | Phase 1 deliverables present | inspect 4 new + 3 modified files | ✅ |
| 2 | Vitest green | 3 test files, 26 tests | ✅ 26/26 |
| 3 | Mosquitto boots on Windows with our conf | `mosquitto.exe -c mosquitto.windows.conf` | ✅ after Defect 1 fix |
| 4 | Port 1883 listening | `Get-NetTCPConnection -LocalPort 1883` | ✅ |
| 5 | API boots with `USE_MOSQUITTO=true` | tsx watch + log inspection | ✅ "MQTT broker mode: Mosquitto" |
| 6 | Mosquitto-only routes mounted | `GET /docs/json`, filter for `mqtt` | ✅ only `/api/internal/mqtt/refresh-acl` |
| 7 | `/refresh-acl` writes dynsec atomically | `POST` with valid Bearer | ✅ 200, 14 devices, 0 skipped, JSON written |
| 8 | `/refresh-acl` rejects bad Bearer | wrong + missing token | ✅ 401 + 401 |
| 9 | API auto-connects to Mosquitto as admin | broker log: `Sending CONNACK to digilog-server (0, 0)` | ✅ |
| 10 | Device pub to its own UNS topic accepted | `mosquitto_pub -u <token> -P <token> -t digilog/v1/pfi-block/telemetry` | ✅ CONNACK 0, PUBLISH received |
| 11 | Device pub to OTHER device's UNS denied | same pub but to `digilog/v1/some-other-block/telemetry` | ✅ broker logs `Denied PUBLISH` |
| 12 | Wrong password rejected | `mosquitto_pub -u <token> -P wrong` | ✅ CONNACK 5 + `disconnected: not authorised` |
| 13 | Flip `USE_MOSQUITTO=false` mounts legacy EMQX webhook routes | tsx restart, `GET /docs/json` | ✅ `/api/internal/mqtt/{auth,acl,superuser}` mounted, `refresh-acl` gone |

## Outstanding items

These are NOT regressions caused by this session — they're carried over from the original Phase 1 commit:

- **Mosquitto Windows service install requires admin.** `scripts/install-mosquitto.ps1` was not exercised end-to-end in this session because the bash environment is non-elevated. The script's logic was inspected line-by-line; the only modification is the new `mosquitto.windows.conf` source filename. A user-driven elevated PowerShell run is still needed to confirm the full install + service registration path (steps 5–7 of the script).
- **Aedes integration test does not exercise dynsec authn.** See Defect 2.
- **Manual-broker-start-needs-CWD operator note.** See "Operator sharp edge" above.
- **`mqtt-broker-integration.test.ts` should grow a real-broker variant** gated behind `MOSQUITTO_BIN` env var. Phase 5 scope per the resume note.

## State left behind

| | State |
|---|---|
| Mosquitto process | Stopped |
| API process | Stopped |
| `apps/api/.env` (worktree) | Restored to `USE_MOSQUITTO=false`. `MOSQUITTO_*` vars retained for future testing. Backup at `apps/api/.env.backup-phase1` (untracked). |
| `mosquitto/dynamic-security.json` | Removed (gitignored anyway; was never meant to be committed). |
| `mosquitto/mosquitto.windows.conf` `log_dest` | Restored to `stdout` + level `notice` (had been temporarily set to `file ./mosquitto.log` + `log_type all` for debugging). |
| `mosquitto/data/` | Clean (no persistence files). |
| Test artifacts (b*.log, official-test.json, pwfile, test-pwfile.conf) | All removed. |
| Tests on disk | Updated assertions for `encoded_password` field; all 26 pass. |

## Suggested next steps

1. **You decide** whether to revert the PBKDF2 generator change. If you keep it, commit on the Phase 1 branch as a fix-up.
2. Commit the conf split + the install-script and docker-compose pointer updates as a single fix-up commit on `feature/phase1-mosquitto-rewrite`. Suggested message: `fix(mosquitto): split conf into windows/linux variants for plugin extension`.
3. Add the CWD operator note to `mosquitto/` (one new short README, or amend `LOCAL_SETUP_WINDOWS.md`).
4. Re-run `./scripts/install-mosquitto.ps1` from an elevated PowerShell to verify the full install + service-registration path end-to-end before merging the PR.
5. Restore the pre-Phase-1 stash (`git stash pop` from main checkout) before starting Phase 2.
