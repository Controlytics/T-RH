# Known Issues & Gotchas

These are real-world constraints verified from code + project memory, not speculation. Don't file bugs for these unless the underlying cause has changed.

> **Windows Server deployment:** the authoritative deep-dive is `windowsIssues.md` at the repo root — 18 issues across hard blockers / soft blockers / operational hassles, each with mitigations. This file lists the operator-facing summary; the rewrite plan to eliminate paid-tool / heavy-binary dependencies is in `docs/plans/2026-04-29-windows-friendly-rewrite.md`.

## Environment / infrastructure

- **Use `tsx watch` for dev, compiled JS for prod-style builds.** PM2 / EC2 are no longer in scope (removed in commit `251be95`). Production-style local builds: `npx tsc -p apps/api/tsconfig.json` then `node apps/api/dist/app.js`.
- ~~**TimescaleDB database is `digilog_tsdb`, not `digilog_db`.**~~ *(REMOVED 2026-06-17 — `digilog_tsdb` + TimescaleDB dropped with the data-ingestion tear-out; only `digilog_db` remains, vanilla Postgres with no TimescaleDB extension.)*
- ~~**Redis is now optional…**~~ *(REMOVED 2026-05-01 — Redis/Memurai is gone entirely. The job queue is graphile-worker on Postgres and pub/sub is in-process (EventEmitter bus); `ioredis` uninstalled and pub/sub consumers torn out in Phase 6/7.)*
- ~~**MQTT broker is now Mosquitto 2.0**~~ *(REMOVED 2026-06-17 — MQTT broker (Mosquitto/EMQX) + `install-mosquitto.ps1` + `/api/internal/mqtt/refresh-acl` all torn out with the data-ingestion tear-out; no broker anymore.)*
- **PDF/chart pipeline is now puppeteer-core + Edge + @napi-rs/canvas**, not bundled-Chromium puppeteer + chartjs-node-canvas. Phase 3 swap dropped the ~150 MB Chromium download and the node-gyp/MSVC build chain. `PUPPETEER_EXECUTABLE_PATH` env var overrides the auto-detected Edge path.
- **Fastify strips response fields not declared in the schema.** If a property "disappears" over the wire, the schema is the likely suspect, not the handler.
- **Role permissions go stale after a DB restore.** `roles` table is rewritten — either reseed from `seed.ts` or `UPDATE` directly. Symptom: users suddenly lose access after a restore test.
- **Local HTTPS requires `certs/server.key` + `certs/server.crt`.** `API_HTTPS=true` without the cert files crashes startup. mkcert is the easiest way; install `certs/rootCA.pem` on the tablet system cert store for APK to trust.
- **Cycle `profile_id` is locked at start.** Reassigning a block's profile does NOT migrate in-progress cycles — they retain the original profile until terminated.

## Frontend + APK

- **`navigator.onLine` is unreliable on Android WebViews.** Use `lib/connectivity.ts` which fans out the Capacitor Network plugin + `navigator.onLine` + `/api/health` probe every 15 s + on `visibilitychange`. Do not read `navigator.onLine` directly.
- **Capacitor WebView ignores `network_security_config` for `fetch()`.** Trying to `fetch()` a self-signed HTTPS API fails. Either use `CapacitorHttp` (already configured) or install a properly-trusted cert (mkcert) system-wide on the tablet.
- **The APK bakes in `https://192.168.1.22:3000`.** If you change the dev host IP or run the API on a different host, you must rebuild the APK (`apps/android` → `cap sync` → `gradlew assembleDebug`).
- **No frontend unit tests.** Any React change rides on manual QA + Playwright traces. Be deliberate.

## Offline model

- **Offline cycles replay FIFO, skip conflicts.** If the server state has diverged (e.g., another operator already advanced the cycle), the replay is skipped and the UI surfaces it. Don't assume every queued op lands.
- **Cached auth enables tablet reload without re-login.** Rotating the JWT secret invalidates cached auth — users see a login screen on the next action.
- **Pipeline graph is cached, but only the active one.** If you swap cleaning profiles while the tablet is offline, the old pipeline is still in effect until the tablet re-syncs.

## Permissions + config

- **Config tabs are independent.** Don't expect changes on one tab to "auto-sync" to another. Sidebar, permissions, reauth — all separate. User feedback rule is explicit about this.
- **SUPER_ADMIN bypasses frontend permission checks** (`isSuperAdmin || perms.includes`). Don't rely on a permission missing from a super-admin to hide UI — use roles for that.
- **Feature toggle needs 12 touchpoints.** Missing any of them leads to a UI-vs-API mismatch that's expensive to track down. Check `future/frontend/PATTERNS.md` section 10.
- **"Compile clean" doesn't mean "works".** Always curl endpoints after backend changes (user rule).

## 21 CFR / audit

- **UUIDs are hidden in the audit trail.** If a QA reviewer complains about not seeing IDs, that's intentional for anti-tamper reasons.
- **Mandatory remarks on every approval/decision UI** except filter cleaning stages (documented exception).

## Historical / not currently active

- ~~**Phase 1 IoT platform features** (UNS, rule chains, alarms) are still present…~~ *(REMOVED — rule chains + alarms 2026-05-17; UNS + the rest of the ingestion layer 2026-06-17. None of these exist anymore.)*
- **LDAP integration** is present but not widely tested in production environments — flag any issue here as P1 and attach the LDAP config (sanitised).

## Open, unresolved decisions

Flagged here so QA knows these are not bugs, just pending product decisions:

- Windows deployment path (A–H including IIS) — not chosen yet.
- RFID UKB vs SDK mode as the default shipping configuration.
- `RFID` branch → `main` merge strategy.
