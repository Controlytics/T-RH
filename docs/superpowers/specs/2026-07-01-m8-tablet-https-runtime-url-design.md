# M8 — Tablet HTTPS-on-LAN + Runtime Server URL — Design

**Date:** 2026-07-01
**Status:** Approved design (pre-implementation)
**Milestone:** M8 of the customer Setup.exe effort (`tasks/EXE-PACKAGING-PLAN.md` §13)
**Depends on:** M6 (installer orchestration) + M7 (done). Server-side enabler already
landed: `app.ts` reads `TLS_KEY_PATH`/`TLS_CERT_PATH` (commit `6e721f0`).

---

## 1. Problem & goal

The customer desktop install must **also** serve the Android tablet/APK over the LAN
(user decision, 2026-07-01). Two blockers today:

1. **No HTTPS the tablet trusts.** The Capacitor WebView `fetch()` rejects self-signed
   certs and plain HTTP causes a TLS parse error on login. The server must present
   HTTPS on the LAN with a cert the tablet trusts.
2. **The APK's server address is baked at build time.** `VITE_API_URL` is a compile-time
   constant read in ~8 places with no runtime override, so one distributable APK cannot
   reach an arbitrary customer's PC.

**Goal:** one distributable APK that, on first launch, asks the operator for the server
address, connects over HTTPS to the customer's bundled server, and trusts that server's
CA after the operator installs it on the tablet. No per-customer APK rebuild.

**Non-goals (YAGNI):** QR/auto-discovery pairing (manual entry chosen); changing the
desktop-browser experience (stays same-origin HTTP/HTTPS on localhost); a per-customer
baked-CA APK (rejected — that is the per-customer-rebuild path we are avoiding).

---

## 2. Trust model (why an APK change is unavoidable)

`apps/android/.../res/xml/network_security_config.xml` currently trusts only
`src="system"` (OS CAs) + `@raw/rootca` (a specific mkcert CA baked into the APK). It has
**no `<certificates src="user" />`**, so since Android 7 the tablet will not trust a CA the
operator installs. We adopt **Trust model A**: add `src="user"`, rebuild the APK once, and
have the operator install the server-generated `rootCA.pem` on the tablet. This keeps a
single APK for all customers (the alternative — baking each customer's CA into the APK —
is the per-customer-rebuild path we rejected).

---

## 3. Part 1 — Client: runtime server URL (the feature)

### 3.1 Base-URL resolver (`apps/web/src/lib/api-base.ts`, new)

Single source of truth for the API base URL, resolved in precedence order:

```
getApiBase(): string
  1. localStorage['digilog.serverUrl']   (runtime, set by the config screen)
  2. window.__API_BASE__                  (existing runtime-override precedent)
  3. import.meta.env.VITE_API_URL         (build-time; blank for the APK build)
  4. ''                                    (same-origin — desktop browser default)
```

- Also `setApiBase(url)` (writes `localStorage['digilog.serverUrl']` + `window.__API_BASE__`)
  and `clearApiBase()`.
- At boot in `main.tsx`, before any API call, set `window.__API_BASE__` from the stored
  value so synchronous reads see it.
- Normalize on save: trim, strip a trailing `/`, require an `http(s)://host[:port]` shape.

### 3.2 Replace the scattered reads

Replace every `import.meta.env.VITE_API_URL ?? ''` (and the ad-hoc
`window.__API_BASE__ ?? ...`) with `getApiBase()` in: `lib/api-client.ts`,
`lib/connectivity.ts`, `lib/pdf-report.ts` (2 sites), `lib/url-utils.ts`,
`components/hard-cutoff-blocker.tsx`, `routes/auth/guest-request.tsx`,
`routes/mobile/mobile-login.tsx`. (Grep for `VITE_API_URL` before implementing to catch any
added since.) `url-utils.ts` `API_BASE` becomes a getter/function so callers can't capture a
stale `''` at module-load.

### 3.3 Server Address screen (`apps/web/src/routes/mobile/server-config.tsx`, new)

- A simple form: a text field pre-filled from the stored value (or blank), placeholder
  `https://192.168.1.55:3000`, and a **Connect** button. Light theme, matches existing
  mobile screens.
- **Connect** validates by `fetch(<url>/api/health)` (must return a 2xx/JSON health
  response) before saving. On success: `setApiBase(url)`, then reload the app so all
  modules re-resolve the base. On failure: inline error ("Couldn't reach the server at
  <url>. Check the address, that the server is on, and that you installed the DigiLog
  certificate."), nothing saved.
- Includes a short hint linking to the certificate-install step.

### 3.4 Gating & reachability

- **Only on Capacitor native** (`window.Capacitor?.isNativePlatform?.()`). On the desktop
  browser the base stays `''` (same-origin) and the screen never appears.
- On native: if no stored URL, route to the Server Address screen **before** login.
- A **"Change server address"** affordance on the login screen (native only) reopens the
  screen, so a changed server IP is fixable without reinstalling the APK.
- When a native session cannot reach the server (health/login network failure), surface a
  path back to the Server Address screen (reuse the existing connectivity/hard-cutoff
  signals rather than inventing new detection).

### 3.5 APK build config

- `apps/web/.env.production`: set `VITE_API_URL=` (blank) so the shipped APK has no baked
  address and first launch prompts. (The desktop bundle already builds with a relative/
  empty base per M1.)

---

## 4. Part 2 — Server: HTTPS-on-LAN in `install.ps1`

Fresh-install path only (upgrade preserves the existing certs, like secrets):

1. **Detect the LAN IPv4** (the default-route interface's address).
2. **Probe `pgsql\bin\openssl.exe`** (EDB PG18 ships it). If absent, fail with a clear
   message (fallback options noted in the plan; not implemented now).
3. **Generate certs once into `C:\ProgramData\DigiLog\certs`** (data dir → survives
   upgrades; regenerating would re-break tablet trust): a rootCA + a server cert whose
   **SAN = the LAN IP + `localhost` + `127.0.0.1`**, reusing the repo's `ssl.conf`/
   `server.ext` SAN approach.
4. **Env (`digilog.env`):** `API_HTTPS=true`, `TLS_KEY_PATH`/`TLS_CERT_PATH` →
   `ProgramData\certs\server.{key,crt}`, `ALLOWED_ORIGINS=https://localhost:3000,https://<LAN-IP>:3000`.
5. **Trust the CA on the server** (so the PC's own browser under `SERVE_WEB` HTTPS doesn't
   warn): `Import-Certificate rootCA.pem -CertStoreLocation Cert:\LocalMachine\Root`.
6. **Export `rootCA.pem`** to `ProgramData\DigiLog\certs\rootCA.pem` + a Start-menu
   "Install tablet certificate" helper/readme for the operator to sideload onto the tablet.
7. **Health check + `DigiLog.url` shortcut** become `https://localhost:3000` (trusted after
   step 5).
8. Upgrade path leaves all of the above intact (certs in the data dir; env preserved).

---

## 5. Part 3 — APK: trust an operator-installed CA

- Add `<certificates src="user" />` to
  `apps/android/.../res/xml/network_security_config.xml` (Trust model A, §2).
- Rebuild the APK once. Keep the existing `@raw/rootca` + `system` anchors (backward
  compatible with the current dev/test setup).

---

## 6. Error handling

- **Bad/unreachable URL at Connect:** health-check fails → inline error, nothing saved.
- **Server IP changed after setup:** operator reopens "Change server address"; if the app
  can't reach the server it auto-returns to that screen.
- **CA not installed on tablet:** HTTPS handshake fails → the same "couldn't reach / check
  the certificate" error, with the cert-install hint.
- **DHCP renumber (static-IP prerequisite):** breaks the cert SAN; documented as an install
  prerequisite (require a DHCP reservation / static LAN IP).

---

## 7. Testing & honest limits

- **Unit (jsdom, `apps/web`):** `getApiBase()` precedence (stored > window > env > '');
  `setApiBase`/`clearApiBase`; URL normalization (trailing slash, whitespace, scheme
  required). Server-config screen: Connect calls health, saves on 2xx, shows error on
  failure (mock fetch).
- **Typecheck** api + web clean; existing suites unaffected (desktop base stays `''`).
- **Deferred gates (cannot verify in this dev environment):** the full tablet round-trip
  (HTTPS on the LAN + operator CA install + real connect + login) needs a **real Android
  device on a customer-like LAN**; openssl cert generation runs on the customer/build
  machine. These are documented deferred gates, same class as M5–M7's build/VM gates.

---

## 8. Files touched (summary)

**New:** `apps/web/src/lib/api-base.ts`, `apps/web/src/routes/mobile/server-config.tsx`,
unit tests.
**Edit (client):** `main.tsx` (boot + route gate), the ~8 base-URL read sites,
`apps/web/.env.production`.
**Edit (server):** `scripts/install.ps1` (cert-gen + env + CA import/export + https health/
shortcut), `installer/DigiLog.iss` (https shortcut URL, "Install tablet certificate"
helper).
**Edit (APK):** `apps/android/.../res/xml/network_security_config.xml`.
**Docs:** `tasks/EXE-PACKAGING-PLAN.md` (M8 done rows), CHANGELOG, memory.

---

## 9. Sequencing

1. Client feature (resolver + reads + screen + gating + tests) — the bulk, fully
   dev-testable.
2. APK network-security one-liner.
3. Server-side `install.ps1` cert-gen (authored; openssl runs on the build/customer
   machine).
4. Docs + the deferred device-validation runbook addendum.
