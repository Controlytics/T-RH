# Device certificates — a profile can require every device to prove itself with its own certificate

**Date:** 2026-10-27
**Status:** design, approved to proceed ("yes client wants it, go ahead, only for testing profile instruments")

## The ask, in the operator's words

1. After the AWS server certificate was re-issued (Quectel modems now pass TLS): "without ssl cert i
   wont receive any data for only test instrument is it possible or not"
2. Offered MQTT-SSL-only / device certificates / nothing: "both https and mqtt and other
   communication ways also i need to receive data when user used ssl at that time only"
3. Told that the server cannot see whether a device loaded `ca.crt`, so the only server-provable form
   is a certificate the DEVICE presents, and asked whether a client or auditor wants it: "yes client
   wants it, go ahead, only for testing profile instruments"

## Intent

A client wants proof that a test instrument's readings are accepted **only** when the device connects
over SSL **with a certificate**. Loading the server's `ca.crt` on the device is invisible to the
server (it is a check inside the device; the connection looks identical either way), so the only
thing the server can enforce and prove is **mutual TLS**: the device presents its OWN certificate,
issued by the platform, and the server refuses that instrument's data on every channel when it does
not.

Scope is a **profile switch**: "Require device certificate". On AWS it is switched on for
**"Testing Profile"** (one instrument today, `Test`, standalone, HTTPS). Every other profile — and
every install that never configures a device CA — behaves exactly as today.

## Goals

- **G1 — Profile switch** `requireDeviceCertificate`, default OFF. SUPER_ADMIN only, reason
  required, audited with before/after like every other profile change.
- **G2 — One certificate per instrument**, issued from the app (Instrument page → Device
  certificate): Issue, Re-issue, Revoke. Issuing returns a one-time bundle (`client.crt`,
  `client.key`, `ca.crt`); the private key is never stored by the server.
- **G3 — Enforcement on every device channel**, one decision function used by all of them:
  HTTPS `POST /api/ingest/v1/telemetry`, WebSocket `/api/ingest/v1/ws`, MQTT (EMQX hook — covers
  1883 and 8883), raw TCP listener.
- **G4 — Evidence.** Every refused attempt is a dead letter on the instrument (the existing
  "Rejected payloads" card), naming the channel and why. Issue / revoke are audited.
- **G5 — Inert until configured.** Without a device CA the API does not request client
  certificates, EMQX does not verify them, the switch cannot be turned on, and nothing changes.

## Non-goals

- CRL / OCSP. Revocation is by **pinning**: the instrument stores the issue id of its ONE current
  certificate; re-issue or revoke makes every older certificate fail at once.
- Client certificates for browsers or users.
- Changing the server CA or server certificate (re-issued this morning; untouched).
- Making certificates mandatory for profiles that do not switch it on.

## Anti-goals (would be a failure even if it "works")

- Any change to how browsers, the EMQX auth hook, or existing devices connect when the switch is off
  everywhere. (Checked on AWS before the switch is flipped: browser login, bridge reconnect +
  `mqtt-auth` 200, a server-auth-only device.)
- A second identity rule per channel (fingerprint on HTTPS, subject on MQTT). ONE rule: the
  certificate's issue id equals the instrument's current issue id.
- The API reading the SERVER CA key (`rootCA.key`, root-only). The device CA is separate.

## Facts this design rests on (measured, not assumed)

- **Spike, local EMQX 5.3.2, 2026-10-27**, throwaway listener `ssl:spike` with `verify = verify_peer`,
  `fail_if_no_peer_cert = false`, `cacertfile` = a device CA, hook body
  `cert_subject = "${cert_subject}"`, `cert_common_name = "${cert_common_name}"`:
  - no client certificate → TLS connects, hook receives `cert_subject: ""`, `cert_common_name: ""`;
  - device certificate `/O=DigiLog Device/serialNumber=iss-7f3a9c/CN=Test` → hook receives
    `"CN=Test,SERIALNUMBER=iss-7f3a9c,O=DigiLog Device"` and `"Test"`;
  - CN `CWH/RDU/001-00` arrives intact;
  - a client certificate from another CA → **handshake refused** (`unknown ca`), the hook is never
    called.
  - `authentication: [...]` inside a listener's config works on 5.3.2; the
    `/listeners/{id}/authentication` REST route does not exist there (404).
- Node `tls` with `requestCert: true, rejectUnauthorized: false, ca: <device CA>` completes the
  handshake for clients with no certificate; `socket.authorized` + `getPeerCertificate()` give the
  verdict and the subject (`subject.serialNumber`, `subject.CN`). The CertificateRequest names only
  the device CA, so a browser with no certificate from it is not prompted. (Verified in the build —
  see Testing.)
- AWS: plain HTTP is closed (port 80 no answer; plain HTTP on 443 refused); 1883 is open; the raw
  TCP listener is not configured (`INGEST_TCP_PORT` unset, port not in the security group).
- AWS profile **"Testing Profile"** holds one instrument, `Test` (not a gateway, no gateway, last
  seen over HTTPS).

## Design

### Device CA

- Files `device-ca.pem` (public) and `device-ca.key` (private), created ONCE per install, never
  regenerated (regenerating would orphan every issued device certificate).
- Env: `DEVICE_CA_CERT_PATH`, `DEVICE_CA_KEY_PATH`. Both set and readable → feature available.
  Either missing → feature inert (G5).
- Key readable by the API's service user only (`0640 root:digilog` on Linux); the server CA key keeps
  its `0600 root`.
- RSA 2048, SHA-256, `CN=DigiLog Device CA`, `basicConstraints CA:TRUE (critical)`,
  `keyUsage keyCertSign, cRLSign (critical)`, 20 years. *(Builder's call: validity.)*
- Created by: `digilog-lib.sh` (`.deb` + AWS provision), `install.ps1` (Windows installer), a
  dry-run-first AWS rollout script for the live box, and by hand (documented) for local dev.

### Device certificate

- Issued by the API with `@peculiar/x509` (new dependency; Node can parse but not sign X.509).
- Subject `O=DigiLog Device, serialNumber=<issueId>, CN=<instrument code>`. `issueId` = random
  128-bit hex. **The CN is informational and is NOT checked** — renaming an instrument does not break
  its certificate; the issue id is the identity.
- RSA 2048, SHA-256, `basicConstraints CA:FALSE`, `keyUsage digitalSignature, keyEncipherment`,
  `extendedKeyUsage clientAuth`, valid 10 years, never past the device CA's own expiry.
  *(Builder's call: validity.)*
- Private key returned as PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`) — the form embedded TLS stacks accept
  most widely. *(Builder's call.)*
- Bundle (zip): `client.crt`, `client.key`, `ca.crt` (the SERVER CA the device already uses —
  `TLS_CA_PATH`, default `rootCA.pem` beside `TLS_CERT_PATH`).

### Storage

Nullable columns on `instruments` (no new model):
`device_cert_issue_id`, `device_cert_fingerprint` (SHA-256 hex), `device_cert_not_after`,
`device_cert_issued_at`, `device_cert_issued_by`.
`instrument_profiles.require_device_certificate BOOLEAN NOT NULL DEFAULT false`.
History lives in the audit trail.

### Routes (instruments module)

- `GET /api/instruments/:id/device-certificate` — status: required-by-profile, issued metadata,
  `available` (device CA configured). INSTRUMENT_READ, visibility-scoped.
- `POST /api/instruments/:id/device-certificate` — issue / re-issue. Mirrors
  `regenerate-token`: `INSTRUMENT_UPDATE` + `enforceReauthAlways`, visibility-scoped, audited
  (`DEVICE_CERTIFICATE_ISSUED`, new), ingest-auth cache invalidated, MQTT session kicked. Returns
  metadata + the bundle (base64 zip) ONCE. 409 `DEVICE_CA_NOT_CONFIGURED` when inert.
- `DELETE /api/instruments/:id/device-certificate` — revoke. Same gate; audited
  (`DEVICE_CERTIFICATE_REVOKED`, new); cache invalidated; session kicked.

### Profile switch

- `PUT /api/instrument-profiles/:id` accepts `requireDeviceCertificate`. SUPER_ADMIN only for this
  field (the measurements precedent). `reason` required when it changes. Turning it ON when the
  device CA is not configured → 409 `DEVICE_CA_NOT_CONFIGURED`. The response tells how many of the
  profile's instruments have no certificate yet (their data will be refused).
- Any change invalidates the ingest-auth cache and kicks the MQTT sessions of the profile's
  instruments (best effort — see MQTT below).

### Enforcement — ONE decision

`deviceCertificateDecision({ required, currentIssueId, presentedIssueId })`:

| required | presented | current | verdict |
|---|---|---|---|
| false | anything | anything | accept |
| true | none | — | refuse `DEVICE_CERTIFICATE_REQUIRED` |
| true | some | null | refuse `DEVICE_CERTIFICATE_NOT_ISSUED` |
| true | X | Y ≠ X | refuse `DEVICE_CERTIFICATE_MISMATCH` |
| true | X | X | accept |

`required` and `currentIssueId` ride on the cached ingest identity (`resolveInstrumentByToken`), so
the per-reading cost stays a map lookup. "Presented" comes from each channel:

- **HTTPS / WebSocket:** the request's socket — `authorized === true` and
  `getPeerCertificate().subject.serialNumber`. A certificate from another CA is `authorized ===
  false` → treated as none.
- **MQTT:** the EMQX hook body's `cert_subject`, `SERIALNUMBER=<hex>` component. Plain 1883 always
  sends `""`. EMQX itself refuses a certificate from another CA at the handshake.
- **Raw TCP:** never TLS → always none.

Refusals: HTTPS 403 `{error}`; WebSocket close; TCP close; MQTT `deny`. Each writes ONE dead letter
per instrument + channel + reason per 60 s (a reconnect storm must not flood the table), reason text
naming the channel, e.g. *"Refused on mqtt: this instrument's profile requires a device certificate
and none was presented."*

### Gateways (fail closed)

A cert-required instrument reported BY a gateway is accepted only when the gateway's own connection
passed the decision with the gateway's current certificate:

- HTTPS / WS / TCP: the batch fan-out drops (dead-letters) cert-required children unless the
  connection presented the gateway's current certificate.
- MQTT: the hook requires a certificate from a gateway when ANY linked child requires one.

### MQTT is judged at CONNECT

EMQX consults the hook only at CONNECT. A switch change, issue or revoke kicks the affected sessions
through `broker-kick.ts` so they reconnect and are judged again. **That kick needs the EMQX REST API
key, which AWS does not have yet** — until it is provisioned, a change takes effect on MQTT at the
device's next reconnect. The AWS rollout provisions the key (it was already owed).

### EMQX configuration

- SSL listener: `verify = verify_peer`, `fail_if_no_peer_cert = false`, `cacertfile` = device CA —
  only when a device CA exists; otherwise unchanged (`verify_none`).
- Global HTTP authenticator body gains `cert_subject` and `cert_common_name`.
- Both rendered from `scripts/emqx/emqx.conf.template` (new placeholders), by `digilog-lib.sh` and
  `provision-emqx.ps1`.

### Web

- Instrument page: a **Device certificate** card — status (required by profile; issued on / by,
  expires, fingerprint; or "not issued"), Issue / Re-issue / Revoke behind the same password
  re-auth as the token, the bundle downloaded at once with a one-line "the key is not kept — store
  this file" notice.
- Instrument Profiles editor: the **Require device certificate** toggle (SUPER_ADMIN), reason
  dialog, and the "N instruments have no certificate yet" warning.
- No client-side policy: the server returns `required` and `available`; the browser renders them.

## Rollout on AWS (operator-confirmed at each step)

1. Push + deploy the code (lockfile moves → `npm ci`; one migration). Inert: no env yet.
2. Dry-run-first script on the box: create the device CA (if absent), add the env lines, provision
   the EMQX API key, re-render EMQX config, restart API + EMQX, then prove: browser login, bridge
   reconnect + `mqtt-auth` 200, TLS from a client without a certificate still works.
3. In the app: issue the `Test` certificate, give the bundle to the device engineer, switch
   "Testing Profile" ON (reason). The engineer loads `client.crt` + `client.key` (Quectel
   `seclevel` 2) and retests; a send without them shows up as a refused dead letter.

## Testing

- Unit: the decision table; subject parsing (`SERIALNUMBER=` from EMQX's string; absent; empty).
- e2e: hook allow/deny matrix through `app.inject` with `cert_subject`; issue / revoke routes (gate,
  audit, pinning — the old certificate refused after re-issue); profile switch (SA-only, reason,
  409 when inert).
- **Real-TLS e2e** for HTTPS (an `https` Fastify listener on a free port with the device CA):
  no certificate → 403 for a required instrument and 200 for a free one; valid → 200; re-issued old
  → 403; other-CA certificate → 403. `app.inject` never goes through TLS, so this is the only proof
  of `socket.authorized`.
- Gateway fan-out: a required child in a gateway batch without the gateway certificate is
  dead-lettered.
- Browser: the web app loads and logs in against an API with `requestCert` on.

## Left to the builder

Validity periods, key format, file names inside the zip, dead-letter wording, card layout, and the
dead-letter rate-limit bookkeeping — each marked above or obvious from the code around it.
