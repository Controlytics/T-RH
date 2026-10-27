# Device Certificates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A profile switch "Require device certificate" makes the server refuse an instrument's data on every channel unless the device connects with its own platform-issued client certificate.

**Architecture:** A separate device CA (files + env) lets the API issue one certificate per instrument; the instrument stores the certificate's random issue id (pinning). One pure decision function compares the issue id the connection presented (TLS socket on HTTPS/WS, EMQX `cert_subject` on MQTT, none on raw TCP) with the instrument's current one when its profile requires it. Inert unless the device CA is configured.

**Tech Stack:** Fastify 5 / Node 24 `tls`, Prisma 6 + PostgreSQL, EMQX 5.3.2 HTTP authenticator, `@peculiar/x509@2.1.0` (new), `adm-zip` (existing), React 19 + SWR.

**Spec:** `docs/superpowers/specs/2026-10-27-device-certificates-design.md`

## Global Constraints

- New dependency pinned EXACTLY: `"@peculiar/x509": "2.1.0"` in `apps/api/package.json` (2.2.0 is under two weeks old).
- Device CA env: `DEVICE_CA_CERT_PATH`, `DEVICE_CA_KEY_PATH`; server CA for the bundle: `TLS_CA_PATH` (default `rootCA.pem` beside `TLS_CERT_PATH`). Both device-CA paths set AND readable = feature available; otherwise inert.
- Certificate subject: `O=DigiLog Device, serialNumber=<issueId>, CN=<instrument code>`; `issueId` = 32 lowercase hex chars (`randomBytes(16)`); CN is NOT checked.
- Device cert: RSA 2048, SHA-256, `CA:FALSE`, `keyUsage digitalSignature, keyEncipherment`, `extendedKeyUsage clientAuth`, 10 years capped at the CA's `notAfter`; private key PKCS#1 PEM. Device CA: RSA 2048, `CN=DigiLog Device CA`, `CA:TRUE` critical, `keyCertSign, cRLSign` critical, 20 years.
- Refusal codes exactly: `DEVICE_CERTIFICATE_REQUIRED`, `DEVICE_CERTIFICATE_NOT_ISSUED`, `DEVICE_CERTIFICATE_MISMATCH`; inert: `DEVICE_CA_NOT_CONFIGURED`.
- New audit actions exactly `DEVICE_CERTIFICATE_ISSUED`, `DEVICE_CERTIFICATE_REVOKED` (98 → 100 actions, 111 → 113 templates, categories unchanged). No new permission, no new reauth action (mirror `regenerate-token`: `INSTRUMENT_UPDATE` + `enforceReauthAlways`).
- Every new response field is DECLARED in the route's response schema — Fastify strips undeclared fields silently (this repo's most repeated bug).
- Migration hand-authored at `apps/api/prisma/migrations/20261027120000_device_certificates/migration.sql`; strip any `DROP TABLE "instrument_telemetry_history"` Prisma emits; apply to `compliance_core_db` AND `compliance_core_db_test`.
- `prisma generate` fails (EPERM) while the operator's local API (`tsx watch`) runs — stop it only with the operator's OK, relaunch it the way `start-app.ps1` does.
- Tests: API `cd apps/api && npx vitest run <file> --pool=forks --poolOptions.forks.singleFork=true`; web test files ONE AT A TIME, judged by exit code; `cd apps/api && npm run lint`; `cd apps/web && npx tsc --noEmit -p .`. Never run two agents' tests at once on the shared test DB.
- Shell scripts LF; anything with a backslash written via the Write tool. Commits on `data-layer`, NOT pushed. `scripts/install.ps1` / `scripts/linux/digilog-lib.sh` already carry an uncommitted generator fix the operator chose to let ride along — commit those files whole.

## Review Focus

1. **Nothing changes when nothing is switched on** — with the device CA configured but every profile OFF, a client with no certificate still gets 200 on ingest and `/api/health`, and the EMQX hook still allows the bridge and an ordinary device. Test in Task 6 (HTTPS real-TLS) and Task 5 (hook).
2. **Re-issue kills the old certificate at once** (cache invalidated, not after the 10 s TTL). Test in Task 6: old cert → 403 immediately after re-issue.
3. **Renaming an instrument keeps its certificate valid** (CN not checked). Test in Task 3.
4. **A certificate from another CA counts as none**, never as a pass. Test in Task 6 (real TLS) — EMQX refuses it at the handshake by itself.
5. **Configured, then the CA files disappear** (env still set, file deleted): a REQUIRED instrument fails closed (refused), status shows `available: false`, issue returns 409. Test in Task 2 (`deviceCaAvailable` false when file missing) and Task 4.

---

### Task 1: Decision, subject parsing and refusal records

**Files:**
- Create: `apps/api/src/modules/instruments/device-certificate.ts`
- Test: `apps/api/src/modules/instruments/__tests__/device-certificate.test.ts`

**Interfaces:**
- Produces:
  - `type DeviceCertRefusal = 'DEVICE_CERTIFICATE_REQUIRED' | 'DEVICE_CERTIFICATE_NOT_ISSUED' | 'DEVICE_CERTIFICATE_MISMATCH'`
  - `type DeviceCertVerdict = { ok: true } | { ok: false; code: DeviceCertRefusal }`
  - `deviceCertificateDecision(a: { required: boolean; currentIssueId: string | null; presentedIssueId: string | null }): DeviceCertVerdict`
  - `issueIdFromEmqxSubject(subject: unknown): string | null` — finds the `SERIALNUMBER=` component (key case-insensitive, components split on `,`), returns it only if it matches `/^[0-9a-f]{32}$/`.
  - `issueIdFromTlsSocket(socket: unknown): string | null` — `null` unless `socket.authorized === true`; then `getPeerCertificate().subject.serialNumber`, same regex.
  - `refusalReason(code: DeviceCertRefusal, transport: string): string` — e.g. `Refused on mqtt: this instrument's profile requires a device certificate and none was presented.`
  - `recordCertificateRefusal(instrumentId: string, transport: string, code: DeviceCertRefusal): Promise<void>` — one dead letter (via `writeDeadLetters` from `telemetry.repository.ts`, `rawPayload: null`) per `instrumentId|transport|code` per 60 s; never throws.
  - `resetCertificateRefusalLimiter(): void` (tests).

- [ ] **Step 1: Write the failing unit tests**
  - every row of the spec's decision table (5 cases);
  - `issueIdFromEmqxSubject('CN=Test,SERIALNUMBER=' + hex32 + ',O=DigiLog Device') === hex32`; `''` → null; `'CN=Test'` → null; `'SERIALNUMBER=iss-7f3a9c'` → null (not hex32); `'serialnumber=' + hex32` → hex32; a CN containing `,SERIALNUMBER=` + other hex BEFORE the real one is not possible to forge past the DB check — assert only that the FIRST well-formed component is returned;
  - `issueIdFromTlsSocket({ authorized: false, getPeerCertificate: () => ({ subject: { serialNumber: hex32 } }) }) === null`; authorized true → hex32; authorized true with `{}` cert → null;
  - `recordCertificateRefusal` twice within 60 s writes ONE dead letter (mock `writeDeadLetters`), different transport writes two; after `vi.advanceTimersByTime(60_001)` writes again.
- [ ] **Step 2: Run** `npx vitest run src/modules/instruments/__tests__/device-certificate.test.ts --pool=forks --poolOptions.forks.singleFork=true` → FAIL (module missing).
- [ ] **Step 3: Implement** the module (pure functions + a `Map<string, number>` limiter).
- [ ] **Step 4: Run** → PASS. `npm run lint` clean.
- [ ] **Step 5: Commit** `feat(ingest): one device-certificate decision shared by every channel`.

### Task 2: Schema, migration, identity and child map carry the certificate facts

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model `Instrument`, model `InstrumentProfile`)
- Create: `apps/api/prisma/migrations/20261027120000_device_certificates/migration.sql`
- Modify: `apps/api/src/modules/instruments/ingest-auth.ts` (`IngestIdentity`, `resolveInstrumentByToken`)
- Modify: `apps/api/src/modules/instruments/listeners/mqtt-bridge.ts:581` (`lookupByCode`)
- Modify: `apps/api/src/modules/instruments/gateway-children.ts`, `gateway-fanout.ts` (`ChildRef`)
- Create: `apps/api/src/modules/instruments/device-ca.ts` (availability + loading only; issuing is Task 3)
- Test: `apps/api/src/modules/instruments/__tests__/device-ca.test.ts`, existing `src/e2e/instrument-ingest.test.ts`, `gateway-ingest.test.ts`, `mqtt-ingest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Prisma `Instrument`: `deviceCertIssueId String? @map("device_cert_issue_id")`, `deviceCertFingerprint String? @map("device_cert_fingerprint")`, `deviceCertNotAfter DateTime? @map("device_cert_not_after") @db.Timestamptz(3)`, `deviceCertIssuedAt DateTime? @map("device_cert_issued_at") @db.Timestamptz(3)`, `deviceCertIssuedBy String? @map("device_cert_issued_by")`.
  - Prisma `InstrumentProfile`: `requireDeviceCertificate Boolean @default(false) @map("require_device_certificate")`.
  - `IngestIdentity` gains `deviceCert: { required: boolean; issueId: string | null }` (from the instrument's profile flag and `deviceCertIssueId`), filled by `resolveInstrumentByToken` AND `lookupByCode`.
  - `ChildRef` gains `requiresCertificate: boolean`.
  - `device-ca.ts`: `deviceCaPaths(): { certPath: string; keyPath: string } | null`; `deviceCaAvailable(): boolean` (both env set and both files exist, checked per call); `loadDeviceCa(): Promise<{ certPem: string; keyPem: string } | null>` (cached by path; `resetDeviceCaCache()`); `serverCaPem(): string | null` (`TLS_CA_PATH`, else `rootCA.pem` beside `TLS_CERT_PATH`, else null).

- [ ] **Step 1: Write failing tests** — `device-ca.test.ts`: env unset → `deviceCaAvailable() === false`, `loadDeviceCa()` null; env set to two temp files → true; env set but cert file deleted → false (Review Focus 5). Add to `instrument-ingest.test.ts`: a token-resolved identity for an instrument in a profile with `requireDeviceCertificate: true` has `deviceCert.required === true` (call `resolveInstrumentByToken` directly after `invalidateIngestAuthCache()`).
- [ ] **Step 2: Run** both → FAIL.
- [ ] **Step 3: Implement** schema + migration (`ALTER TABLE instruments ADD COLUMN …` ×5, `ALTER TABLE instrument_profiles ADD COLUMN require_device_certificate BOOLEAN NOT NULL DEFAULT false`); `npx prisma migrate deploy` on both databases (`DATABASE_URL` explicit each time); `npx prisma generate` (needs the local API stopped — ask); `select` the two facts in `resolveInstrumentByToken`, `lookupByCode`, `childMapFor`; `device-ca.ts`.
- [ ] **Step 4: Run** the new tests + `instrument-ingest`, `gateway-ingest`, `mqtt-ingest`, `mqtt-auth` e2e → PASS; `npm run lint` clean.
- [ ] **Step 5: Commit** `feat(instruments): certificate facts on the instrument, the profile and the ingest identity`.

### Task 3: Issue a device certificate

**Files:**
- Modify: `apps/api/package.json` (+ `"@peculiar/x509": "2.1.0"`), root `package-lock.json`
- Modify: `apps/api/src/modules/instruments/device-ca.ts`
- Create: `apps/api/scripts/create-device-ca.ts` (local dev / manual: writes the two files, refuses to overwrite)
- Test: `apps/api/src/modules/instruments/__tests__/device-ca.test.ts`

**Interfaces:**
- Consumes: Task 2 `loadDeviceCa`, `serverCaPem`.
- Produces:
  - `createDeviceCaFiles(certPath: string, keyPath: string): Promise<void>` — refuses (throws) if either exists.
  - `issueDeviceCertificate(code: string): Promise<{ issueId: string; certificatePem: string; privateKeyPem: string; fingerprint: string; notBefore: Date; notAfter: Date }>` — throws `DeviceCaNotConfiguredError` when inert. `fingerprint` = lowercase SHA-256 hex, no colons.
  - `buildCertificateBundle(issued, serverCa: string | null): Buffer` — zip with `client.crt`, `client.key`, and `ca.crt` when `serverCa` is non-null.

- [ ] **Step 1: Write failing tests** (temp CA from `createDeviceCaFiles`): issued cert verifies against the CA with Node `X509Certificate#verify(ca.publicKey)` and `checkIssued`; `subject` contains `serialNumber=<issueId>` and `CN=<code>`; EKU includes `1.3.6.1.5.5.7.3.2`; `ca === false`; private key PEM starts `-----BEGIN RSA PRIVATE KEY-----` and its public key equals the cert's; `notAfter <= CA notAfter`; two issues give different `issueId`s; a code with `/` (`CWH/RDU/001-00`) round-trips in the CN; the zip lists exactly the three names; `createDeviceCaFiles` refuses an existing path.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `@peculiar/x509` over `crypto.webcrypto` (`x509.cryptoProvider.set(webcrypto)`; if the 2.x build needs `reflect-metadata`, import it once in `device-ca.ts` and add it pinned too — check before adding). Convert the generated key to PKCS#1 with `crypto.createPrivateKey(...).export({ type: 'pkcs1', format: 'pem' })`.
- [ ] **Step 4: Run** → PASS; `npm run lint` clean (scripts are type-checked too).
- [ ] **Step 5: Commit** `feat(instruments): issue device certificates from a separate device CA`.

### Task 4: Device-certificate routes and audit actions

**Files:**
- Create: `apps/api/src/modules/instruments/device-certificate-routes.ts` (a plugin registered from `instruments/routes.ts` with `await app.register(...)`, inheriting `/api/instruments`)
- Modify: `apps/api/src/modules/instruments/routes.ts` (register)
- Modify: `packages/shared/src/types/audit-actions.ts`, `packages/shared/src/types/audit-templates.ts` (same category as `INSTRUMENT_TOKEN_REGENERATED`)
- Test: `apps/api/src/e2e/device-certificate.e2e.test.ts`

**Interfaces:**
- Consumes: Task 2 columns + `deviceCaAvailable`/`serverCaPem`; Task 3 `issueDeviceCertificate`, `buildCertificateBundle`; existing `enforceReauthAlways`, `visibleInstrumentWhere`, `invalidateIngestAuthCache`, `kickMqttClient`, `auditLog`, `buildContext`, `codeLabel`.
- Produces (all declared in response schemas):
  - `GET /:id/device-certificate` (INSTRUMENT_READ) → `{ available: boolean; required: boolean; profileName: string; issued: null | { issueId; fingerprint; issuedAt; issuedBy; notAfter } }`
  - `POST /:id/device-certificate` (INSTRUMENT_UPDATE + `enforceReauthAlways('ISSUE_DEVICE_CERTIFICATE')`) → `{ issued: {…same…}; fileName: string; bundle: string /* base64 zip */ }`; 409 `DEVICE_CA_NOT_CONFIGURED`.
  - `DELETE /:id/device-certificate` (same gate, action string `REVOKE_DEVICE_CERTIFICATE`) → `{ success: true }`; 409 `NOT_ISSUED` when none.
  - Audit `DEVICE_CERTIFICATE_ISSUED` (`afterValue: { code, issueId, fingerprint, notAfter, replacedIssueId }`), `DEVICE_CERTIFICATE_REVOKED` (`beforeValue: { code, issueId, fingerprint }`), short `signatureMeaning` (VARCHAR 255).

- [ ] **Step 1: Write failing e2e** (own SUPER_ADMIN fixture user; temp device CA via `createDeviceCaFiles` + env in `beforeAll`, env removed in `afterAll` first): GET before issue → `issued: null, available: true`; POST without password → 401; with → 200, bundle unzips to three files, DB row has the new issue id, one `DEVICE_CERTIFICATE_ISSUED` row; second POST → different issue id and `replacedIssueId` = first; DELETE → issue id null + one `REVOKED` row; DELETE again → 409 `NOT_ISSUED`; env removed → GET `available: false`, POST 409 `DEVICE_CA_NOT_CONFIGURED`; OPERATOR without the instrument in scope → 404; **rename the instrument code, GET still shows the same issue id** (Review Focus 3).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** routes (one transaction for row update + audit; then `invalidateIngestAuthCache(id)`, `invalidateChildMapCache(gatewayId)` when a child, `kickMqttClient(code, …)`), registry + templates.
- [ ] **Step 4: Run** the e2e + `apps/api/src/lib/__tests__/audit-actions-registry.test.ts` + `packages/shared` `audit-actions.test.ts` → PASS; lint clean.
- [ ] **Step 5: Commit** `feat(instruments): issue, re-issue and revoke a device certificate (audited)`.

### Task 5: Profile switch and the MQTT hook

**Files:**
- Modify: `apps/api/src/modules/instrument-profiles/routes.ts` (GET props, POST/PUT accept `requireDeviceCertificate`)
- Modify: `apps/api/src/modules/instruments/mqtt-auth-routes.ts`
- Test: `apps/api/src/e2e/instrument-profiles.e2e.test.ts` (new block), `apps/api/src/e2e/mqtt-auth.test.ts` (new block)

**Interfaces:**
- Consumes: Task 1 decision + `issueIdFromEmqxSubject` + `recordCertificateRefusal`; Task 2 identity + `childMapFor` `requiresCertificate`; Task 2 `deviceCaAvailable`.
- Produces: profile payloads carry `requireDeviceCertificate: boolean` (declared in `profileProps`); PUT response carries `instrumentsWithoutCertificate: number` (declared). Hook reads `cert_subject` from the EMQX body.

- [ ] **Step 1: Write failing e2e**
  - Profiles: non-SA PUT `requireDeviceCertificate: true` → 403 `SUPER_ADMIN_ONLY`; SA without `reason` → 400 `REASON_REQUIRED`; SA with reason and CA unset → 409 `DEVICE_CA_NOT_CONFIGURED`; with CA → 200, `instrumentsWithoutCertificate` = the fixture profile's instrument count, one `INSTRUMENT_PROFILE_UPDATED` row whose before/after show the flag; turning it OFF needs a reason, never 409.
  - Hook (`app.inject` POST `/api/ingest/v1/mqtt-auth`): instrument in a required profile, certificate issued — `cert_subject: ''` → deny + one dead letter (`transport: 'mqtt'`); matching `SERIALNUMBER=<issueId>` → allow; stale issue id → deny; profile OFF + `cert_subject: ''` → allow (Review Focus 1); the bridge credential still allows with `cert_subject: ''`; a GATEWAY with one required child and no certificate → deny, with the gateway's own current certificate → allow.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — profile: SA-only for this field, `reason` when it changes, 409 when turning ON while inert, count = instruments of the profile with `deviceCertIssueId: null`; after commit `invalidateIngestAuthCache()` (all), `invalidateChildMapCache()` (all), `kickMqttClient` for each instrument of the profile and each of their gateways. Hook: after the client-id check, `required = identity.deviceCert.required || (identity.isGateway && [...childMap.values()].some(c => c.requiresCertificate))`; decision with `presentedIssueId = issueIdFromEmqxSubject(body.cert_subject)`; refused → `recordCertificateRefusal` + DENY.
- [ ] **Step 4: Run** both files → PASS; lint clean.
- [ ] **Step 5: Commit** `feat(profiles): require a device certificate per profile; the MQTT hook enforces it`.

### Task 6: HTTPS, WebSocket, raw TCP and gateway fan-out enforce it; HTTPS requests client certificates

**Files:**
- Create: `apps/api/src/lib/https-options.ts`
- Modify: `apps/api/src/app.ts:76-89` (use it)
- Modify: `apps/api/src/modules/instruments/ingest-routes.ts`, `listeners/ws-listener.ts` (auth + per-frame re-check), `listeners/tcp-listener.ts` (auth line), `ingest-core.ts` (`ingestPayload` arg), `gateway-fanout.ts` (`fanoutDevices` option)
- Test: `apps/api/src/lib/__tests__/https-options.test.ts`, `apps/api/src/e2e/device-certificate-tls.e2e.test.ts` (real TLS), additions to `ws-ingest.test.ts`, `tcp-ingest.test.ts`, `gateway-ingest.test.ts`, `src/modules/instruments/__tests__/gateway-fanout.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `buildHttpsOptions(env: NodeJS.ProcessEnv, defaultCertDir: string): { key: Buffer; cert: Buffer; requestCert?: true; rejectUnauthorized?: false; ca?: Buffer } | null` — `null` unless `API_HTTPS === 'true'`; adds the three client-cert fields only when `deviceCaAvailable()`.
  - `ingestPayload({ …, certificateVerified?: boolean })` — `undefined` (MQTT, judged at CONNECT) = verified.
  - `fanoutDevices(devices, childMap, ts, gatewayCode, opts?: { certificateVerified?: boolean })` — a child with `requiresCertificate` and `certificateVerified === false` is rejected with reason naming the device certificate.
  - Channel rule: HTTPS `presented = issueIdFromTlsSocket(req.raw.socket)`; refused → `recordCertificateRefusal` + 403 `{ error: code }`; WS same at auth and on every frame after `reauthorizeConnection` (close `4403`); TCP `presented = null`; each passes `certificateVerified = presented !== null && presented === identity.deviceCert.issueId`.

- [ ] **Step 1: Write failing tests**
  - `https-options.test.ts`: `API_HTTPS` unset → null; set, no device CA → only key/cert; with CA → `requestCert: true, rejectUnauthorized: false, ca`.
  - `device-certificate-tls.e2e.test.ts`: a Fastify instance with `https: buildHttpsOptions(...)` (temp server cert + temp device CA) registering `ingestRoutes` at `/api/ingest/v1`, `listen({ port: 0 })`; `https.request` with `ca` = the temp server CA:
    - free-profile instrument, no client cert → 200 (Review Focus 1);
    - required instrument, no client cert → 403 `DEVICE_CERTIFICATE_REQUIRED` + one dead letter `transport: 'http'`;
    - valid client cert → 200;
    - re-issue (call `issueDeviceCertificate` + update the row + `invalidateIngestAuthCache`), old cert → 403 `DEVICE_CERTIFICATE_MISMATCH` immediately (Review Focus 2);
    - client cert from a second, unrelated CA → 403 `DEVICE_CERTIFICATE_REQUIRED` (Review Focus 4).
  - `gateway-fanout.test.ts`: required child + `certificateVerified: false` → rejected; `true` or `undefined` → accepted.
  - `gateway-ingest.test.ts`: gateway batch over `app.inject` (no TLS) with one required child → that child dead-lettered, sibling stored.
  - `tcp-ingest.test.ts`: required instrument's token line → socket closed + dead letter `transport: 'tcp'`; free instrument unchanged.
  - `ws-ingest.test.ts`: required instrument → close `4403` + dead letter `transport: 'ws'`; profile switched ON mid-connection → the next frame closes the socket.
- [ ] **Step 2: Run** each file → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** every file above plus `instrument-ingest`, `mqtt-ingest`, `mqtt-auth` → PASS; lint clean.
- [ ] **Step 5: Commit** `feat(ingest): HTTPS, WebSocket, TCP and gateway batches refuse a required instrument without its certificate`.

### Task 7: EMQX template, provisioning, local broker and AWS rollout script

**Files:**
- Modify: `scripts/emqx/emqx.conf.template` (SSL listener `verify = @@SSL_VERIFY@@`, `cacertfile = "@@SSL_CACERT_FILE@@"`; hook body `cert_subject = "${cert_subject}"`, `cert_common_name = "${cert_common_name}"`)
- Modify: `scripts/linux/digilog-lib.sh` (`digilog_ensure_device_ca` beside `digilog_ensure_certs`, env lines via `env_ensure`, render the two tokens: `verify_peer` + device CA when present, else `verify_none` + `rootCA.pem`), `scripts/linux/debian/postinst` (call it), `scripts/aws/provision-ubuntu.sh` (call it)
- Modify: `scripts/install.ps1`, `scripts/provision-emqx.ps1` (same, Windows)
- Create: `scripts/aws/enable-device-certificates.sh` — dry run by default; `--apply`: device CA (if absent, `0640 root:digilog` key), env lines (`DEVICE_CA_CERT_PATH`, `DEVICE_CA_KEY_PATH`, `TLS_CA_PATH`), `digilog_provision_emqx` (renders the template AND provisions the owed EMQX API key), restart API then EMQX, then checks: `/api/health` 200 with `--cacert rootCA.pem` and NO client cert, `emqx ctl listeners` ssl running, bridge client connected, last `mqtt-auth` 200s; restores the backed-up `digilog.env` + `emqx.conf` and restarts if any check fails.
- Modify: `docs/deployment-methods/aws-ubuntu-instance.md`, `docs/deployment-methods/method-c-ubuntu-deb.md` (device CA files, env, how to enable)

**Interfaces:**
- Consumes: env names from Global Constraints.
- Produces: rendered EMQX config with the two tokens; the rollout script's dry-run/apply contract above.

- [ ] **Step 1: Write a render check** — a bash test (`scripts/linux/__tests__/render-emqx.sh`, or inline in the task) that sources `digilog-lib.sh` with a temp `DIGILOG_CFG`, runs only the `sed` render on the template twice (device CA present / absent) and asserts: no `@@` left; `verify = verify_peer` + device CA path / `verify = verify_none` + `rootCA.pem`; `cert_subject = "${cert_subject}"` present.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the scripts. Local dev: run `npx tsx scripts/create-device-ca.ts certs/device-ca.pem certs/device-ca.key`, add the three env lines to `apps/api/.env` (`TLS_CA_PATH` = `%LOCALAPPDATA%\mkcert\rootCA.pem` — `certs/rootCA.pem` signs nothing here), reconfigure the LOCAL broker's `ssl:default` (verify_peer + device CA) and the global authenticator body through the EMQX REST API (`PUT /api/v5/listeners/ssl:default`, `PUT /api/v5/authentication/password_based:http`), save the previous JSON of both first.
- [ ] **Step 4: Run** the render check → PASS; `bash -n` on every touched `.sh`; the AWS script's dry run in a temp dir with `CERT_DIR`/`ENV_FILE` overrides; local broker: an MQTTS client with no certificate and a plain 1883 client still CONNECT (both free instruments), the bridge stays connected.
- [ ] **Step 5: Commit** `feat(emqx): verify device certificates on MQTTS and pass the subject to the hook; provisioning + AWS rollout`.

### Task 8: Web — certificate card and profile switch

**Files:**
- Create: `apps/web/src/routes/instruments/device-certificate-card.tsx`
- Modify: `apps/web/src/routes/instruments/detail.tsx` (render beside `TokenPanel`)
- Create: `apps/web/src/routes/config/profile-device-certificate.tsx`
- Modify: `apps/web/src/routes/config/instrument-attributes.tsx` (render it for the selected profile, SUPER_ADMIN only)
- Test: `apps/web/src/routes/instruments/__tests__/device-certificate-card.test.tsx`, `apps/web/src/routes/config/__tests__/profile-device-certificate.test.tsx`

**Interfaces:**
- Consumes: Task 4 routes and shapes; Task 5 `requireDeviceCertificate`, `instrumentsWithoutCertificate`; the re-auth pattern `token-panel.tsx` already uses for `regenerate-token`.
- Produces: `DeviceCertificateCard({ instrumentId, canManage }: { instrumentId: string; canManage: boolean })`; `ProfileDeviceCertificateSwitch({ profile }: { profile: { id: string; name: string; requireDeviceCertificate: boolean } })`.

- [ ] **Step 1: Write failing tests** — card: `available: false` → shows "Device certificates are not set up on this server" and no buttons; `required: true, issued: null` → "Required by profile <name> — not issued: this instrument's data is being refused"; issued → shows expiry date and the first 16 chars of the fingerprint, Re-issue + Revoke; Issue → password dialog → POST with the re-auth header → a download is triggered (spy on `URL.createObjectURL`) and "The private key is not kept — store this file safely" shows. Switch: toggling ON opens the reason dialog; submit sends `{ requireDeviceCertificate: true, reason }`; a 200 with `instrumentsWithoutCertificate: 1` shows "1 instrument has no certificate yet — its data will be refused"; 409 shows the server message.
- [ ] **Step 2: Run** each file alone → FAIL.
- [ ] **Step 3: Implement** in the UI v3 language used on the page (existing card + dialog components; the boolean is an on/off toggle, per the config convention).
- [ ] **Step 4: Run** each file alone → exit 0; `npx tsc --noEmit -p .` clean; the existing `detail` and `instrument-attributes` test files still pass one at a time.
- [ ] **Step 5: Commit** `feat(web): device certificate card on the instrument; require-certificate switch on the profile`.

### Task 9: Docs, counts and the end-to-end check

**Files:**
- Modify: `docs/feature-notes.md` (new note at the top), `CHANGELOG.md`, root `CLAUDE.md` System Stats (audit 98 → 100 / 111 → 113), `apps/api/CLAUDE.md`, `docs/recreation/06-api/endpoints.md` (three routes), `tasks/todo.md`

- [ ] **Step 1:** Re-derive every count with the commands in root `CLAUDE.md`; stale-stat sweep for `98`/`111` audit wording across the active doc set.
- [ ] **Step 2:** Full API suite single-fork (`cd apps/api && npm test`) and every web test file under `routes/instruments` and `routes/config` one at a time → all exit 0. Record the numbers.
- [ ] **Step 3:** Local end to end on :3001 (operator's OK to restart the API): issue a certificate for a local test instrument in a profile switched ON; `curl` POST telemetry without the cert → 403; with `--cert client.crt --key client.key` → 200; MQTTS with `mqtt` client and the cert → CONNACK, without → refused; the web app logs in and the card shows the issued certificate.
- [ ] **Step 4: Commit** `docs: device certificates`.
