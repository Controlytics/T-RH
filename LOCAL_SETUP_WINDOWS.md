# compliance-core — Local Windows Setup Guide

**Purpose:** everything a developer (or Claude) needs to clone, set up and run
**this fork** on a Windows machine. §9A–§9D (instrument ingest: HTTP / TCP /
MQTT via EMQX, MQTTS, downlinks, the child roster, RTC sync) are the part root
`CLAUDE.md` cites and are unchanged.

> **Rewritten 2026-10-05 (audit DOCS-8).** Until then §1–§9 and §10–§15 walked a
> new developer through *upstream DigiLog*: a `digilog_db` on `:3000` / `:5175`,
> "61 model tables including the Phase 2 filter management tables", a sidebar of
> Filter Operations / Cleaning Cycles / PM Schedules, an `apps/android/` tree and
> `start-digilog.bat`. None of that exists here; following it produced the
> sibling-checkout mix-up root `CLAUDE.md` warns about (a bare `npx vite` on 5175
> proxied to the DigiLog backend on 3000). Every number below came from a
> command run that day; re-derive before quoting.

---

## 1. Prerequisites

### 1.1 Node.js 24.x
- The version is pinned in ONE place: root `package.json` `engines.node`
  (`"24.x"`) and the matching `.nvmrc`. The Linux `.deb` build refuses any other
  major (`scripts/linux/build-deb.sh`) and the Windows installer's Node zip must
  match the ABI of the native modules compiled on the build machine.
- Verify: `node -v` → `v24.x.x`. This machine: v24.14.1, npm 11.11.0.

### 1.2 PostgreSQL 18
- https://www.postgresql.org/download/windows/ — remember the superuser password;
  port **5432**.
- **No TimescaleDB, no Redis / Memurai.** Vanilla PostgreSQL 18 is all the app
  needs: the job queue (graphile-worker) and every table live in it.

### 1.3 Git
- https://git-scm.com/download/win — `git --version`.

### 1.4 EMQX 5.3.2 — only if you work on instrument ingest
- Not needed to run the app, log in, or use anything but device telemetry over
  MQTT. When you do need it, §9A.3 below is the setup (the same 5.3.2 the
  customer installers bundle; the dev box runs it from an unzipped folder,
  started by `scripts/start-app.ps1`).

---

## 2. Clone the Repository

```bash
git clone https://github.com/Controlytics/T-RH.git compliance-core
cd compliance-core
git checkout data-layer
```

Work and push on `data-layer`. `final-user-management` is a FROZEN backup — never
commit to it. There is no `main`.

---

## 3. Create the Databases

Two databases, same user. The test database is NOT optional: the vitest suite
refuses to run against anything but a `*_test` name (`apps/api/vitest.env.ts`),
and a migration applied to only one of them makes every instrument-touching e2e
500.

```sql
CREATE USER digilog WITH PASSWORD 'digilog123';
CREATE DATABASE compliance_core_db OWNER digilog;
CREATE DATABASE compliance_core_db_test OWNER digilog;
GRANT ALL PRIVILEGES ON DATABASE compliance_core_db TO digilog;
GRANT ALL PRIVILEGES ON DATABASE compliance_core_db_test TO digilog;
\c compliance_core_db
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO digilog;
\c compliance_core_db_test
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO digilog;
```

> `apps/api/.env.example` and the customer installer (`scripts/provision-db.ps1`)
> name the database `digilog_db`. This checkout uses `compliance_core_db` so it
> cannot collide with the sibling DigiLog checkout on the same Postgres. Either
> name works — what matters is that `DATABASE_URL` names the one you created.

---

## 4. Create the Environment File

The API reads **`apps/api/.env`** (nothing reads a root `.env`). Start from the
example and change the keys below:

```bash
cp apps/api/.env.example apps/api/.env
```

| Key | This checkout | Why |
|---|---|---|
| `DATABASE_URL` | `postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public` | the database from §3 |
| `PORT` / `API_PORT` | `3001` | the example says 3000, which is the sibling checkout's API |
| `WEB_PORT` | `5176` | `start-app.ps1` reads it; a bare `npx vite` defaults to 5175 and proxies to :3000 |
| `API_HTTPS` | `true` | mkcert certs in `certs/server.{key,crt}`, signed by `%LOCALAPPDATA%\mkcert\rootCA.pem` (NOT `certs/rootCA.pem`) |
| `ALLOWED_ORIGINS` | add `https://localhost:5176` | CORS for the dev SPA origin |
| `JWT_SECRET` | any long random string (≥32 chars) | dev only; `VERIFICATION_TOKEN_SECRET` is no longer read (removed 2026-10-05, audit SEC-5) |
| `INITIAL_ADMIN_PASSWORD` | set it **before seeding** | the seed THROWS without it; there is no hardcoded default and no forced change on first login |
| `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `INGEST_TCP_PORT` | optional | §9A–§9D |

---

## 5. Install Dependencies

```bash
npm install
```

Installs the whole workspace (root + `apps/api` + `apps/web` + `packages/shared`
+ `packages/queue`).

---

## 6. Set Up the Database

Run every step against BOTH databases — pass `DATABASE_URL` explicitly rather
than trusting whichever `.env` was loaded.

```bash
cd apps/api
npx prisma generate            # stop `tsx watch` first — it EPERMs on Windows while the API runs
DATABASE_URL=postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public      npx prisma migrate deploy
DATABASE_URL=postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test?schema=public npx prisma migrate deploy
INITIAL_ADMIN_PASSWORD='<choose one>' npx prisma db seed     # seeds the dev DB; repeat with the test URL
cd ../..
```

The migrations build **37 models and 13 enums** (`grep -cE "^model "` /
`"^enum "` on `apps/api/prisma/schema.prisma`, 2026-10-05), including the
partitioned `instrument_telemetry_history` table that `prisma migrate diff`
wants to DROP — never run `db push`; `npm run db:migrate` runs
`scripts/check-migration-safety.mjs` first for that reason.

The seed creates the default roles, the `superadmin` user with the password you
passed, and the auto-discovered config rows. It is single-tenant: no
organisations.

---

## 7. Build

```bash
npm run build          # turbo: @digilog/shared -> @digilog/queue -> @digilog/api -> @digilog/web
```

After ANY change under `packages/shared/`, rebuild it before testing either app:
`npm run build -w @digilog/shared`.

---

## 8. Run

### 8.1 The launcher (recommended)

```bat
start-app.bat    REM wraps scripts/start-app.ps1: verifies Postgres (and EMQX if configured),
                 REM starts the API on :3001 and Vite on :5176 with API_PROXY_TARGET set; idempotent
stop-app.bat
```

### 8.2 By hand (two terminals)

```bash
# Terminal 1 — API, auto-reload
cd apps/api && npx tsx watch src/app.ts            # https://localhost:3001

# Terminal 2 — SPA. BOTH variables are required: vite.config.ts defaults to
# port 5175 and proxies /api to https://localhost:3000, the sibling checkout.
cd apps/web && WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001 npx vite --host
```

### 8.3 Production-style

```bash
npm run build
cd apps/api && node dist/app.js       # serves the built SPA and /api/* from one process
```

---

## 9. Verify

1. Open **https://localhost:5176** and log in as `superadmin` with the
   `INITIAL_ADMIN_PASSWORD` you seeded (on this machine it is the one recorded
   in root `CLAUDE.md` "Default Login").
2. The sidebar a SUPER_ADMIN sees is the **14** items in
   `packages/shared/src/types/sidebar-items.ts` (`grep -c "id: '"`, 2026-10-05):
   Dashboard, Functional Locations, Alarms, Users, Admin Requests, Configuration,
   Notifications, Audit Trail, System Health, Instruments, Debug Traces, Data
   Report, Reports, Settings. Other roles see what Roles & Access grants.
3. API liveness (401 is NOT a pass here — `/api/health` is public and returns 200):

```bash
curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://localhost:3001/api/health
# Swagger UI: https://localhost:3001/docs
```

`curl` on Windows uses Schannel and fails with exit 60 on a valid local chain
unless given `--ssl-revoke-best-effort`; an exit 60 is not evidence of a bad
certificate.

---

## 9A. Instrument Ingest Listeners

*(Numbered 9A rather than 10 so the section numbers below did not all shift.)*

Instruments send telemetry over one of seven live transports. All seven land in
the same `ingestPayload()` core — the same parsing, gateway fan-out,
dead-lettering and last-seen stamping — so a listener only ever obtains bytes
and a token.

| Transport | Runs when | Where |
|---|---|---|
| HTTP / HTTPS | always | `POST /api/ingest/v1/telemetry` on the API port; TLS is `API_HTTPS=true` |
| WS / WSS | always | `GET /api/ingest/v1/ws` on the API port; TLS is the same `API_HTTPS=true` listener |
| TCP | `INGEST_TCP_PORT` is set | its own socket server, newline-delimited JSON |
| MQTT | `MQTT_BROKER_URL` is set | an external EMQX broker on 1883; the API is a *subscriber*, not a broker |
| MQTTS | broker has an `ssl` listener | the **same** EMQX broker on 8883 — see §9B; the API side is unchanged |

> **THE UI'S "live" CLAIM IS COMPILE-TIME, NOT A PROBE.** `LIVE_TRANSPORTS` in
> `apps/web/src/routes/instruments/live-transports.ts` is a constant, so the
> Instruments page asserts all seven are live on **every** machine, including one
> with no broker installed. It records that each was verified once, on the
> developer's machine — it is not a health check of yours. MQTT and MQTTS in
> particular are live only if **you** have done §9A.3 and §9B. Until then a
> technician following the on-screen MQTTS example will get a connection refused
> with no hint why.

### 9A.1 HTTP / HTTPS and WebSocket — nothing to configure

Both are always on. Verify with a real instrument token (create an instrument in
the UI and copy the token it shows once):

```bash
curl -sk -X POST https://localhost:3000/api/ingest/v1/telemetry \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"t": 21.5, "h": 47}'
# -> {"accepted":2}
```

The WebSocket endpoint takes the token either in the `Authorization: Bearer`
header on the upgrade or as the first frame `{"token":"..."}`, then one JSON
reading per frame. `wss://` is the identical route behind `API_HTTPS=true`.

### 9A.2 Raw TCP

```bash
# apps/api/.env
INGEST_TCP_PORT=1884
```

Unset means the listener does not start at all — upgrading never silently opens
a port. The first line must be `{"token":"..."}`; every line after it is one
reading. Limits are fixed in code, not env-configurable: 64 KB per line, a 5 s
deadline to send the token, a 15-minute post-auth idle timeout, and 200
concurrent connections.

> **RAW TCP IS PLAINTEXT.** There is no TLS on this listener, so the device
> token crosses the wire in the clear and anyone who can capture the traffic can
> replay it indefinitely. Keep this port on a trusted VLAN and never expose it to
> the internet. This is inherent to the transport, not a gap waiting to be
> closed — use HTTPS or WSS for anything leaving the plant floor.

### 9A.3 MQTT via EMQX 5.3.2

> **THE WIRE ADDRESSES INSTRUMENTS BY CODE (2026-09-04; it was the UUID from
> 2026-08-07 to then).** The MQTT client id and the topic segment are the
> instrument's `code`, e.g. `CWH/RDU/001-00` — operator: "i want client id as
> CWH/RDU/001-00". A code may contain `/`; the broker substitutes `${clientid}`
> literally, so that device publishes to `instruments/CWH/RDU/001-00/telemetry`
> and the bridge matches a fixed prefix and suffix rather than counting levels.
>
> What made the UUID interlude necessary was that a code of `+` or `#` in the
> ACL template matched EVERY instrument. That was refused at REGISTRATION from
> 2026-09-04 to 2026-09-16 (`instrumentCodeTopicViolation`); **the operator had
> that guard removed on 2026-09-16.** There is no character rule on a code now.
> Consequence: a code containing `+` or `#` cannot publish at all (the broker
> refuses a wildcard in a publish topic), and under this file ACL a `+` client
> id matches every instrument's topics. Do not register such a code.
>
> **`etc/acl.conf` DID change and the broker was restarted**: the bridge's
> subscribe and publish grants are `instruments/#`, because `+` is exactly one
> level and cannot reach a slot whose code carries slashes. The device-side
> `${clientid}` rules are unchanged. The hand-added 2026-09-03 "TEMPORARY TEST
> GRANT" for client id `35dd00b3-…` was removed at the same time.
>
> **BREAKING for a device configured with its UUID:** it is refused at CONNECT
> (`Connection refused: Not authorized`) until reconfigured with its code as
> client id and in its topics. Retained downlink slots were MOVED, not
> abandoned: `scripts/migrate-mqtt-topics-to-code.ts` cleared the 102 UUID-keyed
> slots and republished them code-keyed on 2026-09-04.

EMQX 5.3.2 is installed at `C:\Users\hello\emqx-5.3.2` (the last release with a
Windows build). Start it with `bin\emqx.cmd start`.

> **On a CUSTOMER machine none of this section is done by hand (2026-09-08).**
> The `Setup.exe` installer ships the broker and `scripts/provision-emqx.ps1`
> renders `etc/emqx.conf` + `etc/acl.conf` from `scripts/emqx/`, registers the
> `emqx` service and opens the firewall. The rendered config is the SAME shape
> as this box's `data/configs/cluster.hocon` with two deliberate differences:
> the dashboard binds `127.0.0.1` only, and there is ONE authenticator — the
> HTTPS hook — because since 2026-09-08 the hook also admits the ingest bridge
> by `MQTT_USERNAME` / `MQTT_PASSWORD` (constant-time compare), so the
> built-in-database user this box carries is not needed there. This section
> stays as the reference for WHY each setting exists and for driving the dev
> broker by hand.

#### The dashboard — http://localhost:18083

**`admin` / `DigiLog@2026`** on this machine (set 2026-08-06). The shipped
`admin` / `public` does not work: EMQX forces a change at first login, and this
password was reset with

```bash
C:\Users\hello\emqx-5.3.2\bin\emqx_ctl.cmd admins passwd admin '<new-password>'
# → ok
```

That command is also the way back in when nobody remembers the password — it
needs no old password, only a shell on this box, which is worth knowing in both
directions.

> **This is a real credential in a tracked file, and the listener is on
> `0.0.0.0:18083`, not loopback.** Anyone who can reach this machine on the LAN
> can reach the dashboard, and from there reconfigure the ACL, the authenticator
> chain, and the retained store — i.e. everything §9A.3 and §9B rest on. It is
> written down here at the operator's request, for a single-developer local
> install. **A shared or plant-floor install must change it and must not carry
> it in the repo** — and should bind the dashboard to `127.0.0.1` while it is at
> it (`dashboard.listeners.http.bind` in `etc/emqx.conf`).

Three pages carry the whole picture, all under **Monitoring** (verified against
5.3.2's menu — Retained Messages is *not* under Management, where its config
lives):

- **Monitoring → Clients** — every connected device by client ID, with its
  username (= its device token) and `delivered_msgs`, the honest answer to "did
  that device actually receive the attribute downlink". `digilog-bridge` appears
  here too.
- **Monitoring → Subscriptions** — both directions on one screen:
  `digilog-bridge → instruments/#` (uplink — it ignores its own downlink
  slots by suffix) and each device → `instruments/<its code>/attributes`
  (downlink).
- **Monitoring → Retained Messages** — one row per instrument attribute slot,
  QoS 1, published by `digilog-bridge`, with **Show Payload** revealing the
  exact `{attributes, changed, ts}` JSON the device holds. This is the closest
  thing to "what does that device currently believe its attributes are".

#### Watching attribute messages ARRIVE, inside the dashboard

**There is no message log.** EMQX does not record message bodies, so no page
replays traffic after the fact — Retained Messages shows only the *last*
message per topic, and a topic with no live subscriber shows nothing new. That
is the usual reason "I can't see the attribute data in the dashboard": nothing
is subscribed, so there is nothing to see.

The fix is **Diagnose → WebSocket Client**, which connects as a real MQTT
client and streams into a live **Received** table. Connect it *as the device* —
the same rule as everywhere else, and the ACL admits nothing less:

| Field | Value |
|---|---|
| Host / Port / Path | `localhost` / `8083` / `/mqtt` (the `ws:default` listener) |
| **Client ID** | the instrument's **code**, e.g. `CWH/RDU/001-00` (shown on its detail page's Connection card) |
| **Username** | that instrument's **device token** (Reveal token on its page) |
| Password | leave empty |

Then **Subscribe** to `instruments/<code>/attributes` (or
`instruments/<gwCode>/attributes/#` for a gateway). Verified 2026-08-06: the
subscribe delivers the retained message immediately, tagged **Retain** in the
table, and every subsequent add/modify/delete appears as a new row within a
second, payload and all.

> A generic client id will NOT work here, and the failure is silent-ish — the
> auth hook refuses any CONNECT whose client id is not the token's instrument
> code, so the tool just fails to connect. That is the same binding the
> telemetry and attribute ACL rules rest on, not a quirk of this page.

The same facts are available without the dashboard:

```bash
emqx_ctl retainer info      # how many retained messages exist
emqx_ctl retainer topics    # one line per instrument attribute slot
emqx_ctl clients list       # per-device delivered_msgs
emqx_ctl broker metrics     # messages.received / .sent / .dropped
```

#### The bridge's own connection

```bash
# apps/api/.env
MQTT_BROKER_URL=mqtt://127.0.0.1:1883
MQTT_USERNAME=digilog-bridge
MQTT_PASSWORD=<the bridge's own broker password — NOT a device token>
# MQTT_CLIENT_ID=digilog-ingest-bridge   # must stay stable across restarts
```

Devices publish to `instruments/<code>/telemetry`; the bridge subscribes
`instruments/#` at QoS 1 (a code carries slashes, which `+` cannot span),
takes everything between `instruments/` and `/telemetry` as the code, silently
ignores its own `…/attributes` and `…/children` retained slots, and hands each
payload to the ingest core with `transport: 'mqtt'`.

**Three accepted payload shapes** (`modules/instruments/payload-parser.ts`):

```jsonc
{ "t": "25.7", "h": "46.3" }                    // flat     -> this instrument
{ "values": { "t": "25.7", "h": "46.3" } }      // envelope -> this instrument
{ "devices": { "CH-A": { "t": "25.7" } } }      // batch    -> a gateway's children, keyed by code
{ "devices": [ { "devN": "CH-A", "t": "25.7" }, … ] }   // batch, LIST: each block names its code under `devN` (2026-09-05)
{ "devN": "CH-A", "t": "25.7", "h": "46.3" }              // ONE child per message, on the GATEWAY's topic/token (2026-09-05):
                                                          // a flat payload from a gateway that carries a string `devN` is
                                                          // routed to that child, `devN` stripped — the plant's firmware form
```

`ts`/`timestamp`, `quality` and `devices` are reserved at the TOP level; every
other key is stored verbatim as a reading with its JSON type preserved. A QUOTED
number is a reading — `coerceReading()` in `@digilog/shared` is the one definition
— so `"25.7"` is 25.7 and raises no sensor-failure alarm.

**The envelope was added 2026-09-03** for a logger that changed format in the
field and could not be changed back. It is unwrapped ONLY when `values` holds an
object and the payload carries no other reading keys: `{"values":{"t":1},"t":25}`
is ambiguous, so it is NOT unwrapped and both are stored, because unwrapping
there would silently DISCARD a reading. `values` as a number, string or array is
an ordinary reading and is left alone.

**Key NAMES are administered, payload SHAPE is not.** Which key means temperature
is `telemetry-slots` config (ordered alias lists); the three shapes above are
hardcoded, because the parser is deliberately PURE and threading config into it
would cost that. If a second envelope name appears, make it a config then.

**A device connects as: username = its device token, client ID = its instrument
UUID.** Both, or the broker refuses it.

#### The three pieces of EMQX configuration, and why each is load-bearing

**1. `etc/acl.conf`** — edited in place; the stock file is preserved as
`etc/acl.conf.orig`. The source path is `${EMQX_ETC_DIR}/acl.conf`, so a restart
reloads it.

```erlang
{allow, {username, {re, "^dashboard$"}}, subscribe, ["$SYS/#"]}.

%% the ingest bridge — the only client allowed to read the whole tree.
%% `#` since 2026-09-04: codes carry slashes and `+` is exactly one level.
{allow, {username, "digilog-bridge"}, subscribe, ["instruments/#"]}.

%% a device may publish to ITS OWN topic only (${clientid} = its CODE)
{allow, all, publish, ["instruments/${clientid}/telemetry"]}.

%% DOWNLINK (see §9B.6). The bridge is the only publisher on the attribute and
%% children trees; a device reads its own slot and, if it is a gateway, its
%% children's.
{allow, {username, "digilog-bridge"}, publish, ["instruments/#"]}.
{allow, all, subscribe, ["instruments/${clientid}/attributes", "instruments/${clientid}/attributes/#"]}.
{allow, all, subscribe, ["instruments/${clientid}/children"]}.

{deny, all, subscribe, ["$SYS/#", {eq, "#"}]}.
{deny, all}.
```

> **THE SINGLE MOST IMPORTANT LINE IN THIS DOCUMENT.** The stock `acl.conf`
> ships **two** allow-all rules — `{allow, all}.` and
> `{allow, {ipaddr, "127.0.0.1"}, all, ["$SYS/#", "#"]}.` — and **both must be
> removed**. Leave either in place and the topic ACL silently does nothing: any
> device holding any valid token can publish any other instrument's telemetry.
> Worse, every happy-path test still passes, and a cross-topic test run from the
> same machine is a **false pass**, because every local test client is on
> `127.0.0.1` and the second rule waves it straight through. If you are
> reinstalling EMQX, check this before you trust any ACL test result.

**2. The authenticator chain** (`POST /api/v5/authentication`, persisted to
`data/configs/cluster.hocon`). Order matters: the built-in database resolves the
bridge's own user and *ignores* everything else, falling through to the HTTP
hook for devices.

```jsonc
// (a) the bridge's own broker credential — built-in database
// POST /api/v5/authentication/password_based:built_in_database/users
{ "user_id": "digilog-bridge", "password": "<choose one; put it in MQTT_PASSWORD>" }

// (b) the device hook — EMQX holds no device passwords, it asks us per CONNECT
// POST /api/v5/authentication
{
  "mechanism": "password_based", "backend": "http", "enable": true,
  "method": "post",
  // SUPERSEDED — use the HTTPS + verify_peer form in §9B.3. Shown here only so
  // the chain's shape is readable in one place. The port must match API_PORT
  // (3001 in this repo), and `localhost` does not work — see §9B.3.
  "url": "http://127.0.0.1:3001/api/ingest/v1/mqtt-auth",
  "headers": { "content-type": "application/json" },
  "body": { "clientid": "${clientid}", "username": "${username}", "password": "${password}" },
  "pool_size": 8, "connect_timeout": "5s", "request_timeout": "5s"
}
```

Because the broker asks per connection rather than caching a credential,
**revocation is immediate** — `POST /api/instruments/:id/regenerate-token`
invalidates the resolver cache and the very next CONNECT is refused.

**3. Authorization settings** (`PUT /api/v5/authorization/settings`):

```jsonc
{ "no_match": "deny", "deny_action": "disconnect", "cache": { "enable": false } }
```

`no_match = deny` reverses EMQX's permissive default; without it the ACL's final
`{deny, all}.` is the only thing standing between a device and every topic.
Turning the ACL cache off keeps a per-client topic decision from being
remembered, which makes the deny path testable.

#### Why the client ID matters

EMQX can template a topic ACL only on `${clientid}` or `${username}` — and our
username **is** the secret device token, which must never appear in a topic. So
`${clientid}` is the only usable binding, and `POST /api/ingest/v1/mqtt-auth`
denies any CONNECT whose `clientid` is not the token's instrument code. That is
what turns `{allow, all, publish, ["instruments/${clientid}/telemetry"]}` into a
real authorisation rule instead of an honour system. **A subscriber never learns
who published**, so there is no check the bridge could do instead — remove
either leg and the protection is gone with no error anywhere.

#### Verifying it

```bash
# publish as a device (mosquitto_pub, or a node script using the `mqtt` package)
mosquitto_pub -h 127.0.0.1 -p 1883 -i "<INSTRUMENT-CODE>" \
  -t "instruments/<INSTRUMENT-CODE>/telemetry" -u "<DEVICE-TOKEN>" -P "" \
  -m '{"temperature": 27.5}'
```

> **`-P ""` IS NOT OPTIONAL, EVEN THOUGH THE PASSWORD IS EMPTY.** `mosquitto_pub`
> given `-u` without `-P` sends a CONNECT carrying a username and **no password
> field at all**, and EMQX rejects that before it ever calls our hook — the HTTP
> authenticator's `total` metric stays at 0. The client prints
> `Connection Refused: bad user name or password`, which reads exactly like a bad
> token and sends you off to regenerate a perfectly good one. Add `-P ""` and the
> same token connects. This bit the MQTT examples in the UI too; they now carry
> the flag.

Then check the reading in the UI, or straight from the database:

```sql
SELECT key, value, ts FROM instrument_telemetry_latest
 WHERE instrument_id = (SELECT id FROM instruments WHERE code = '<INSTRUMENT-CODE>');
```

Two negative checks are worth more than the positive one — run **both**, since
either alone proves nothing:

- publish with instrument **A**'s token to instrument **B**'s topic → the broker
  disconnects on the PUBLISH and nothing lands against B;
- connect with instrument A's token but B's client ID → `Connection refused:
  Not authorized` at CONNECT.

If either succeeds, re-read the stock-ACL warning above.

> **THE AUTHENTICATOR'S OWN HOP CARRIES THE DEVICE TOKEN.** Whatever the device
> uses to reach the broker, the broker then forwards that token to us in the
> hook's request body. Over plain `http://` it crosses even loopback in the
> clear, and with `API_HTTPS=true` it does not connect at all. §9B replaces this
> with HTTPS and real certificate verification; do that before treating either
> MQTT or MQTTS as secure.

---

## 9B. MQTTS — MQTT over TLS on 8883

Verified end to end on 2026-08-06: a `mosquitto_pub` over 8883 validating the
broker against a CA file landed a reading in `instrument_telemetry_latest`, and
all three negative checks were re-run **over TLS** rather than carried over from
port 1883 (a TLS listener is a different code path in the broker).

MQTTS changes two things and nothing else, both on the broker. The API side is
untouched.

#### Three hops, three different secrets — and only two get TLS

This is the part worth reading slowly, because "is it encrypted?" has a
different answer at each step and the reasons are not interchangeable.

| Hop | What crosses it | Protection | Why |
|---|---|---|---|
| device → broker (8883) | the **device token** | TLS, client validates the broker against the CA file | leaves the machine, per-device secret |
| broker → API hook | the **same device token**, forwarded in the hook body | HTTPS + `verify_peer` | same secret; encrypting the first hop and not this one would be theatre |
| API bridge → broker (1883) | the **bridge's own static broker credential** | **plaintext, deliberately** | never leaves `127.0.0.1`, and carries no device secret |

The third row is a decision, not an oversight. No device token is ever presented
on it — the bridge is a *subscriber*, and a subscriber presents no credential
belonging to any instrument. Anyone positioned to read loopback traffic already
owns the host, where the TLS private key sits on disk regardless.

> **REVISIT THIS IF THE BROKER EVER MOVES OFF LOOPBACK.** The moment
> `MQTT_BROKER_URL` names another host, the bridge credential becomes a real wire
> secret and this hop needs TLS. Budget for code, not config: `app.ts` forwards
> only `username`/`password` into `mqtt.connect()`, so there is no CA option
> today, and Node does not read the Windows certificate store — so an `mqtts://`
> bridge means a new env var and a new client option, not just changing the
> scheme.

### 9B.1 Which CA file — read this before anything else

> **`certs/rootCA.pem` IN THIS REPO DID NOT SIGN `certs/server.crt`.** They are
> two unrelated CAs: `server.crt` is issued by **mkcert's** CA, while
> `certs/rootCA.pem` is a separate hand-rolled "DigiLog Root CA". Handing a
> client `--cafile certs/rootCA.pem` therefore fails, and it fails in a way that
> looks like a broken listener rather than a wrong CA. (Root `CLAUDE.md` still
> describes the certs as "rooted by `certs/rootCA.pem`" — that sentence is
> wrong.) Find the real one:
>
> ```bash
> mkcert -CAROOT          # -> C:\Users\hello\AppData\Local\mkcert
> openssl verify -CAfile "$(mkcert -CAROOT)/rootCA.pem" certs/server.crt
> # -> certs/server.crt: OK
> ```
>
> Everything below uses `C:/Users/hello/AppData/Local/mkcert/rootCA.pem`.
>
> A related trap when checking by hand on Windows: `curl` uses Schannel here and
> returns exit 60 `revocation status is unknown` for a perfectly valid local
> chain. Add `--ssl-revoke-best-effort` before concluding the chain is bad.

### 9B.2 The broker's TLS listener

EMQX 5.x already opens 8883 using a throwaway self-signed cert in `etc/certs/`
that nothing trusts. Override it to the same mkcert pair the API serves HTTPS
with, so **one** CA file lets a device validate both the broker and the API.
Appended to `etc/emqx.conf` (stock preserved as `etc/emqx.conf.orig`):

```hocon
listeners.ssl.default {
    bind = "0.0.0.0:8883"
    ssl_options {
        certfile = "C:/Users/hello/compliance-core/certs/server.crt"
        keyfile  = "C:/Users/hello/compliance-core/certs/server.key"
        verify = verify_none
        fail_if_no_peer_cert = false
    }
}
```

`verify = verify_none` **here is about client certificates** (mutual TLS), which
we do not use — a device authenticates with a token as its MQTT username, not a
client cert. It says nothing about the device's verification of the broker, and
it is not the same setting as the authenticator's `ssl.verify` below. Confirm
the listener is serving the right certificate rather than EMQX's stock one:

```bash
echo | openssl s_client -connect 127.0.0.1:8883 -servername localhost \
    -CAfile "$(mkcert -CAROOT)/rootCA.pem" 2>&1 | grep "Verify return code"
# -> Verify return code: 0 (ok)
```

### 9B.3 The authenticator over HTTPS, verifying the certificate

Replaces the plain-HTTP `url` from §9A.3. `PUT /api/v5/authentication/password_based:http`:

```jsonc
{
  "mechanism": "password_based", "backend": "http", "enable": true,
  "method": "post",
  // 127.0.0.1, NOT localhost — see the note below
  "url": "https://127.0.0.1:3001/api/ingest/v1/mqtt-auth",
  "headers": { "content-type": "application/json" },
  "body": { "clientid": "${clientid}", "username": "${username}", "password": "${password}" },
  "pool_size": 8, "connect_timeout": "5s", "request_timeout": "5s",
  "ssl": {
    "enable": true,
    "verify": "verify_peer",
    "cacertfile": "C:/Users/hello/AppData/Local/mkcert/rootCA.pem",
    "server_name_indication": "localhost"
  }
}
```

Three details, each of which cost a debugging round:

- **The port must match `API_PORT`** (`3001` in this repo, not the `3000` used
  elsewhere in this document).
- **Use `127.0.0.1`, not `localhost`.** On Windows `localhost` resolves to `::1`
  first and the API binds only `127.0.0.1` and the LAN address, so Erlang — which
  does not fall back the way `curl` does — fails with `econnrefused`. The symptom
  at the client is an ordinary CONNECT refusal with nothing in the API log.
- **`server_name_indication` stays `localhost`** so hostname verification checks
  against the cert's `DNS:localhost` SAN while the connection goes to the IPv4
  literal.

`verify_peer` against the real CA was chosen over `verify_none`, and it is not
decorative — pointing `cacertfile` at the *other* (wrong) CA in `certs/` makes
every CONNECT start failing, which is how it was proven to be enforcing rather
than silently accepting. Check the connector before blaming a device:

```bash
curl -s -u '<api-key>:<secret>' \
  http://127.0.0.1:18083/api/v5/authentication/password_based:http/status
# -> "status":"connected", and `metrics.total` rises with each CONNECT
```

`metrics.total` staying at 0 while clients are refused means the hook is not
being reached at all — look at the CONNECT itself (§9A.3's `-P ""` note), not at
the token.

### 9B.4 Publishing over MQTTS

The paste-ready command an operator actually needs — this is what the
Instruments page shows:

```bash
mosquitto_pub -h localhost -p 8883 \
  --cafile "C:\Users\hello\AppData\Local\mkcert\rootCA.pem" \
  -i "<INSTRUMENT-CODE>" \
  -t "instruments/<INSTRUMENT-CODE>/telemetry" \
  -u "<DEVICE-TOKEN>" \
  -P "" \
  -m '{"t": 21.5, "h": 47}'
```

Use `-h localhost` (or a hostname/IP in the cert's SAN list), not an arbitrary
address — the client verifies the name against the certificate. Reach for the
CA file, never `--insecure`, which discards the only thing TLS is buying.

Then read the row **back out of the database** rather than trusting a silent
exit — a QoS 0 publish to a forbidden topic exits 0 having been thrown away:

```sql
SELECT key, value, ts FROM instrument_telemetry_latest
 WHERE instrument_id = (SELECT id FROM instruments WHERE code = '<INSTRUMENT-CODE>');
```

### 9B.5 The three negative checks, over TLS

Re-run these against 8883 even if they passed on 1883. Publish at **QoS 1**
(`-q 1`): at QoS 0 a denied publish still exits 0, so the test passes for the
wrong reason.

| Check | Expected |
|---|---|
| A publishes to B's topic | broker disconnects (`Error: The connection was lost`), `authorization_permission_denied` in `log/emqx.log.1`, and **nothing** lands against B |
| A's token under B's client id | `Connection Refused: not authorised` at CONNECT |
| revoked token | next CONNECT refused — after the 10 s `resolveInstrumentByToken` cache expires, or immediately via `POST /api/instruments/:id/regenerate-token`, which invalidates it |

> **THE STOCK-`acl.conf` TRAP APPLIES TO TLS EXACTLY AS IT DOES TO PLAINTEXT.**
> `acl.conf` is broker-wide, not per-listener, so the two stock allow-all rules
> flagged in §9A.3 — `{allow, all}.` and
> `{allow, {ipaddr, "127.0.0.1"}, all, [...]}` — void the topic ACL on 8883 too,
> and every check in the table above becomes a false pass while looking green.
> A TLS connection from this machine is still on loopback. If you reinstall or
> upgrade EMQX, re-check `acl.conf` before trusting any result here.

---

### 9B.6 Attribute downlink — the one path that runs platform → device

Everything above is **uplink**: a device publishes, we ingest. Changing an
instrument's attribute in the UI goes the other way, and it is the only thing in
this system that does. There is still no RPC and no command channel — a device
cannot be told to *do* anything, only what its attributes now are.

#### The topic scheme — one retained slot per instrument

| Instrument | Topic |
|---|---|
| standalone | `instruments/<id>/attributes` |
| child of a gateway | `instruments/<gatewayId>/attributes/<childId>` |

A child has **no broker connection of its own**, so its change has to reach the
gateway that fans out for it — addressed to the child, on the gateway's tree.
The gateway subscribes `instruments/<gatewayId>/attributes/#`, which covers
every child *and* the gateway's own slot (MQTT's `#` matches its own parent
level; verified against EMQX 5.3.2, not assumed).

**Per-instrument topics are load-bearing, not cosmetic.** MQTT retains only the
**last** message per topic. One shared `instruments/<gw>/attributes` slot would
mean a gateway coming back from a power cut is handed whichever child changed
most recently and silently loses every other child's state.

#### The payload — state *and* delta, in one message

```json
{ "attributes": { "assetTag": "AT-99412" },
  "changed":    { "calibrationDue": null },
  "ts": "2026-08-06T11:40:00.000Z" }
```

`attributes` is that instrument's **complete current set** after the change, so a
device that was offline can reconstruct the truth from the retained message
alone. `changed` is the delta for this one operation. A value of **`null` means
the attribute was removed** — the key is absent from `attributes` and present as
`null` in `changed`, in the same message, and both halves are the point.

Published at **QoS 1, `retain: true`**, and **after the database transaction
commits, never inside it** — publishing first means a rolled-back edit can leave
a device holding a change the platform does not have, and a retained one, so it
survives. A publish failure is logged and **never fails the attribute write**:
the database is the source of truth, the broker is a delivery mechanism. With
`MQTT_BROKER_URL` unset there is no bridge, no downlink, and attribute edits
behave exactly as they did before this path existed.

#### Watching it — paste this

Subscribe as the device itself (client id = instrument CODE, username = its
token; the password is ignored). Then change an attribute in the UI.

```bash
# a standalone instrument
"/c/Program Files/mosquitto/mosquitto_sub.exe" -h 127.0.0.1 -p 1883 \
  -i TEMP-01 -u "<TEMP-01's device token>" -P x \
  -t "instruments/TEMP-01/attributes" -v

# a gateway — its own slot AND every child's, in one subscription
"/c/Program Files/mosquitto/mosquitto_sub.exe" -h 127.0.0.1 -p 1883 \
  -i GW-01 -u "<GW-01's device token>" -P x \
  -t "instruments/GW-01/attributes/#" -v
```

Subscribing **after** the change works too — that is what `retain` buys. Add
`-d` to see the `r1` flag on a retained delivery, which is how you tell a
replayed message from a live one.

#### Retention must be on DISC, or a broker restart wipes every slot

EMQX 5.x defaults to `retainer.backend.storage_type = ram`, and that default
**silently defeats this design**: the retained message is the only copy of an
instrument's attribute set on the broker, so a restart erases it and a device
reconnecting afterwards receives *nothing* — not stale state, no state — until
someone happens to edit an attribute on that instrument again. Verified on this
machine: a retained probe published before `emqx stop` was gone after
`emqx start`. Appended to `etc/emqx.conf` (stock preserved as `emqx.conf.orig`):

```hocon
retainer {
    enable = true
    msg_expiry_interval = 0
    backend {
        type = built_in_database
        storage_type = disc
    }
}
```

`msg_expiry_interval = 0` (never expire) is EMQX's own default and is what we
want — an attribute set is current until it is replaced. It is stated explicitly
because the shipped `etc/examples/retainer.conf.example` sets it to `5s`, and
copying that example wholesale would expire every slot after five seconds.

#### The ACL, and the one property that must hold

Two rules, both in `etc/acl.conf` (full file listed in §9A.3):

```erlang
{allow, {username, "digilog-bridge"}, publish, ["instruments/+/attributes", "instruments/+/attributes/+"]}.
{allow, all, subscribe, ["instruments/${clientid}/attributes", "instruments/${clientid}/attributes/#"]}.
```

One publish pattern for the bridge since 2026-09-04, `instruments/#`: `+` is
exactly one level, and a slot keyed on a code such as `CWH/RDU/001-00` is
several. (It used to be `instruments/+/attributes` plus
`instruments/+/attributes/+`.)

The subscribe rule templates on `${clientid}`, and that is only meaningful
because `POST /api/ingest/v1/mqtt-auth` refuses any CONNECT whose client id is
not the token's instrument CODE — the same binding that makes the telemetry
publish rule real. A gateway's client id *is* its code, so
`instruments/${clientid}/attributes/#` covers its children and nothing else.

> The exact-topic pattern is **redundant** — `instruments/${clientid}/attributes/#`
> alone permits a subscribe to `instruments/<id>/attributes` and delivers on
> it (confirmed by removing the exact pattern, restarting, and re-testing). It is
> kept deliberately: the rule granting a device its own slot should not rest on a
> subtlety of `#`, and a later edit narrowing the wildcard form must not take the
> standalone case with it.

Negative checks, all confirmed against the live broker — each ends with **no
SUBACK** and a disconnect (`authorization.deny_action = disconnect`), which
`mosquitto_sub` shows as an endless CONNECT/SUBSCRIBE retry loop:

| Check | Expected |
|---|---|
| device A subscribes `instruments/<B>/attributes` | denied, disconnected |
| device A subscribes `instruments/+/attributes` (wildcard fishing) | denied, disconnected |
| device A subscribes `instruments/<GW>/attributes/<child>` where A is not GW | denied, disconnected |
| device A subscribes **its own** topic | `SUBACK 0` — proves it is not blanket-deny |

> **THE STOCK-`acl.conf` TRAP APPLIES HERE TOO.** With `{allow, all}.` or
> `{allow, {ipaddr, "127.0.0.1"}, all, [...]}` restored, every row in that table
> becomes a false pass while looking green — every test client on this machine is
> on loopback. Check the file's final contents, not just that the test went green.
> Also confirm `authorization.cache.enable = false` in
> `data/configs/cluster.hocon`: a cached allow is the other way a negative check
> passes for the wrong reason.

#### Known gap: retained messages outlive what they describe

A retained message is cleared only by publishing a **zero-byte payload with
`retain: true`** to the same topic. Nothing does that today, so three cases
strand a slot the platform will never revisit:

- **deleting an instrument** — `instruments/<id>/attributes` keeps its last
  message forever;
- **unlinking a child from its gateway** — the old
  `instruments/<gw>/attributes/<child>` slot is stranded, and the child's own
  topic stays empty until its next attribute change;
- **moving a child to a different gateway** — same, on the previous gateway.

None leaks a secret (attributes are registry metadata, and only the instrument's
own client id can read the slot; after a delete, no token resolves to that code
at all, so nothing can even connect as it). It is stale data on the broker, not
an exposure. `code` became changeable on 2026-09-16 (`PUT /api/instruments/:id {code}`): the platform clears the old retained slots and republishes under the new code; the DEVICE must reconnect with the new client id, and the old id is refused from the moment the rename commits.

### 9C. The CHILD ROSTER — telling a gateway who its children are

Added 2026-08-07. The attribute downlink above announces a child only when that
child *changes*, so a linked-but-untouched child was invisible to its gateway,
and link/unlink published nothing at all. A gateway could not answer "which
instruments am I responsible for" from the broker alone. One retained slot per
gateway now carries the whole membership:

```
instruments/<gatewayId>/children
{"children":[{"code":"DLCH-1786017252","name":"DL child","isActive":true}],
 "ts":"2026-08-07T05:08:25.154Z"}
```

**A sibling topic, not a segment under `…/attributes/`.** Instrument codes allow
`[A-Za-z0-9._-]`, so any reserved segment inside the attribute subtree could be
collided with by a real code. The cost is one extra subscription on the device;
`instruments/<gwId>/attributes/#` does **not** cover it.

**Whole membership, never a delta**, for the same reason the attribute payload
carries the complete set: the retained message is the only copy, and a gateway
returning from a power cut must reconstruct the truth from it alone. Sorted by
code, so an unchanged membership serialises identically and a gateway diffing
two messages sees a difference only when one exists. **Inactive children are
included, flagged `isActive: false`** — dropping them would make a deactivated
child indistinguishable from an unlinked one, and those need opposite handling.

**Republished on:** link, unlink, move (BOTH gateways), a child created already
linked, a child deleted, and a child renamed or (de)activated — `name` and
`isActive` are in the payload, so an edit carrying no `gatewayId` still
republishes. A gateway created or promoted publishes its own (possibly empty)
roster at once, so a gateway can tell "no children" from "the broker lost it".

**Cleared, not stranded.** Deleting a gateway, or turning gateway mode off,
publishes a **zero-byte retained** message to the slot. This is the only place
in the codebase that clears a retained message, and it is deliberate: unlike a
stranded attribute slot (stale metadata about a code nothing can connect as any
more), a stranded roster **names instruments that are still live** and have just
been orphaned.

**It is not an authorisation surface.** The database decides which credential may
write for which instrument (`gateway-children.ts`); a gateway acting on a stale
roster still cannot write for an instrument that is no longer its child. Publish
failures are logged (`[downlink:children]`) and swallowed — they never fail the
operator's edit.

Two ACL rules, both **above** the `{deny, all}.` catch-all (below it they match
nothing, silently):

```erlang
{allow, {username, "digilog-bridge"}, publish, ["instruments/+/children"]}.
{allow, all, subscribe, ["instruments/${clientid}/children"]}.
```

**`etc/acl.conf` is read at boot only — a broker restart is required** after
editing it. Verified live on 2026-08-06 EMQX 5.3.2 after restarting:

| Check | Result |
|---|---|
| gateway subscribes `instruments/<its own code>/children` | `SUBACK 0`, roster delivered |
| a rename of its child, no `gatewayId` in the request | new roster arrives within a second |
| a *different* instrument's valid token subscribes to that topic | no SUBACK, disconnect loop, `authorization_permission_denied` in `log/emqx.log.1` |

### 9C.1 The CHILD ATTRIBUTE CHANGE — one event topic per gateway

Added 2026-09-05 and reshaped twice the same day. The operator first asked for
*"one message for all children with full set"*; on seeing the retained dump
arrive the moment the gateway subscribed, *"when ever any instrument attribute
value was changed send at that time only"*; and on seeing the changed child's
whole set arrive, *"only changed key should sent"*. So the topic is an EVENT
carrying exactly the change:

```
instruments/<gatewayCode>/children/attributes        (QoS 1, NOT retained)
{"gateway":"IOTGW01",
 "devices":[{"devN":"CWH/RDU/002-01","Location":"LCMS Room-II"}]}
```

- **Published only when a child's attribute changes** — in the app, or from a
  device report (§9C.2). One message per key. Link, unlink and a gateway's own
  edit publish nothing here; membership is the roster's (§9C).
- **Not retained.** A gateway that subscribes is handed nothing until
  something moves. A gateway that wants STATE on connect subscribes to the
  per-child slots (§9B), which stay retained and carry the complete set.
- **Only the changed key**, under the child's `devN`, in the telemetry batch's
  shape. A removed key is carried as `null`. No timestamp (operator: "remove
  the time stamp"); the audit row carries when.
- Under `/children/`, not `/attributes`, because `instruments/<gw>/attributes`
  is the gateway's OWN slot.

The retained bundle that briefly lived on this topic was cleared with
`npx tsx apps/api/scripts/clear-child-attribute-bundles.ts --apply`.

One ACL change, on the existing subscribe line — **boot-only file, restart the
broker**; the AWS broker needs the same:

```erlang
{allow, all, subscribe, ["instruments/${clientid}/children", "instruments/${clientid}/children/attributes"]}.
```

The bridge's `instruments/#` publish grant already covers it. Wiring is pinned
by `src/e2e/instrument-child-attributes-bundle.test.ts` (4 cases) and the
payload by `modules/instruments/__tests__/child-attributes-bundle.test.ts`.

### 9C.2 The ATTRIBUTE REPORT — the device writes attributes (device → platform)

Added 2026-09-05 (operator: *"create two topics for attributes, one will i
publish one will i receive"*). §9C.1 is the receive side; this is the publish
side. The device PUBLISHES to its own report topic, in the telemetry batch's
shape with attribute values where readings would be:

```
instruments/<code>/attributes/report

{"Location":"LCMS Room-II","Make":"Global"}                       # a standalone instrument's OWN attributes
{"devices":[{"devN":"CWH/RDU/001-00","Location":"LCMS Room-II"}]} # a gateway, for its linked children
{"devN":"CWH/RDU/001-00","Location":"LCMS Room-II"}               # a gateway, one child per message
```

- **Same rules as telemetry**: a gateway writes only for its own linked
  children (the child map); a foreign or unknown `devN` is dead-lettered; a
  non-gateway sending `devices` is refused. `devN` is never stored.
- **Every accepted write is audited as `INSTRUMENT_ATTRIBUTE_REPORTED`** — a
  system action with no user; the reporting device's code is in the row and
  the reason reads "Reported by device … over MQTT". An UNCHANGED value is
  neither written nor audited, so firmware re-reporting its configuration every
  minute does not fill the hash chain.
- **Which keys a device may write is administered**: Configuration →
  Instrument Attributes → *Device-writable attribute keys*. Blank = any key
  (the operator's choice). A refused key is dead-lettered by name so the
  firmware author can see it. The role-based edit gate is not consulted — a
  device is not a role; this list is the control that stands in for it.
- After the commit the per-instrument slot (§9B) and the gateway's bundle
  (§9C.1) are republished, so the device reads back what the platform holds.
- `report` joined `MQTT_RESERVED_TOPIC_SEGMENTS`: a code may not END in it.

ACL, one publish grant on the existing line — **boot-only, restart the
broker**; AWS needs the same:

```erlang
{allow, all, publish, ["instruments/${clientid}/telemetry", "instruments/${clientid}/attributes/report"]}.
```

Pinned by `src/e2e/mqtt-attribute-report.test.ts` (8) and
`modules/instruments/__tests__/attribute-report.test.ts` (5).

### 9D. RTC SYNC — the platform tells devices the time

Added 2026-09-05 (operator: *"create another topic for rtc sync,
{"method":"getTime"} user will send request with this key, when ever we
receive request we need to send utc time, and also request is received or not
for every minute that current time utc time stamp should sent, this is global,
add it for gateway instrument"*).

```
device → platform    instruments/<code>/rtc-request     {"method":"getTime"}
platform → devices   digilog/rtc/time                    {"unix":1788607800000}
```

- **The time topic is GLOBAL** — one message every 10 minutes, on the
  wall-clock boundary (:00, :10, :20 …), that every gateway subscribes to;
  a request from any active instrument triggers
  the same message at once. It sits outside `instruments/` so the bridge's
  `instruments/#` subscription never hands it back to itself, and so the ACL
  grants every device a subscribe on one literal topic. Not retained: a clock
  read on connect must be fresh.
- The payload is exactly `{"unix":<epoch MILLISECONDS>}`, one key, a 13-digit
  number (operator: "you have to send the payload like this it seems
  {"unix":1792221233122}") — the unit the gateway already sends as `ts`. The
  shape moved three times on 2026-09-05; the firmware parser is the authority.
  There is no zone on the wire — an RTC holds UTC.
- The tick runs inside the API process (`startRtcTicker`, `app.ts`), alive
  only while the bridge is; anything but `{"method":"getTime"}` on the request
  topic is ignored with a log line. `rtc-request` joined the reserved last
  segments.

ACL, three edits — **boot-only, restart the broker**; AWS needs the same:

```erlang
{allow, all, publish, ["instruments/${clientid}/telemetry", "instruments/${clientid}/attributes/report", "instruments/${clientid}/rtc-request"]}.
{allow, {username, "digilog-bridge"}, publish, ["instruments/#", "digilog/rtc/time"]}.
{allow, all, subscribe, ["digilog/rtc/time"]}.
```

Pinned by `listeners/__tests__/rtc-sync.test.ts` (parse, payload, the ticker
under fake timers) and `e2e/mqtt-rtc-sync.test.ts` (over the real bridge).

---

## 10. Project Structure

```
compliance-core/
├── apps/
│   ├── api/                    # Fastify backend (TypeScript, ESM) — port 3001 here
│   │   ├── prisma/
│   │   │   ├── schema.prisma   # 37 models, 13 enums (2026-10-05)
│   │   │   ├── seed.ts         # seeder — needs INITIAL_ADMIN_PASSWORD
│   │   │   └── migrations/     # hand-checked SQL migrations (partitioned telemetry table)
│   │   ├── scripts/            # operational + one-shot scripts (one-shots carry a `// ONE-SHOT` header)
│   │   └── src/
│   │       ├── app.ts          # entry point; registers the 25 modules, ingest listeners, job runner
│   │       ├── modules/        # 25 API modules (`ls | wc -l`, 2026-10-05); config/defs/ holds 36 config defs
│   │       ├── plugins/        # auth, rbac, cors, …
│   │       ├── workers/        # the 6 graphile-worker tasks
│   │       └── lib/            # audit hash chain, config discovery/registry, sanitize, …
│   └── web/                    # React 19 SPA (Vite 6, Tailwind v4) — port 5176 here
│       └── src/
│           ├── main.tsx        # 53 <Route> definitions (2026-10-05)
│           ├── routes/         # pages; routes/config/ holds 22 config pages
│           ├── components/     # shared components
│           ├── hooks/          # 25 entries incl. __tests__ (2026-10-05)
│           └── lib/            # 22 entries incl. __tests__ (2026-10-05)
├── packages/
│   ├── shared/                 # permissions (45), reauth actions (57), sidebar items (15), PERMISSION_TREE, zod schemas
│   └── queue/                  # graphile-worker wrapper + crontab.txt
├── scripts/                    # start-app / stop-app, installer build + provisioning, linux/ (.deb), emqx/ templates
├── docs/                       # docs/recreation/ is a 2026-07-25 snapshot; docs/archive/ is history
├── Layouts/                    # the client's floor drawings (CWH/) the traced plans are measured from
├── start-app.bat / stop-app.bat
├── turbo.json
└── package.json                # workspaces; engines.node = 24.x
```

There is **no** `apps/android/`, `rfid_scan_app/` or `packages/db` — verified
`ls apps/ packages/` 2026-10-05.

---

## 11. Key Configuration

| Config | This checkout | Code default | Notes |
|---|---|---|---|
| API port | **3001** (HTTPS) | 3000 | `apps/api/.env` `PORT` / `API_PORT` |
| Web dev port | **5176** | 5175 | `WEB_PORT`; `start-app.ps1` sets it |
| Vite `/api` proxy | https://localhost:3001 | https://localhost:3000 | `API_PROXY_TARGET` — the default is the SIBLING checkout |
| PostgreSQL | `localhost:5432`, user `digilog`, `compliance_core_db` + `compliance_core_db_test` | `digilog_db` | PG 18, no extensions beyond pgcrypto |
| EMQX (optional) | 1883 / 8883, dashboard 18083 loopback | — | §9A.3 / §9B |
| Default login | `superadmin` / the seeded `INITIAL_ADMIN_PASSWORD` | none — the seed throws without one | no forced change on first login |

---

## 12. Common Commands

```bash
npm install                      # all workspaces
npm run build                    # everything, in dependency order
npm run build -w @digilog/shared # after any packages/shared change
npm run dev                      # turbo dev (API + web) — prefer start-app.bat, which sets the ports

# Database (pass DATABASE_URL explicitly; there are several .env files on this machine)
cd apps/api
npx prisma generate              # stop tsx watch first on Windows (EPERM otherwise)
npx prisma migrate dev           # create + apply a migration — then READ it: strip any DROP of the partitioned table
npx prisma migrate deploy        # apply pending migrations — run against BOTH databases
npx prisma db seed               # needs INITIAL_ADMIN_PASSWORD
npx prisma studio

# Tests — run web test files ONE AT A TIME and gate on the exit code
npx turbo run test
cd apps/web && npx vitest run src/routes/<page>/<file>.test.tsx

# Live counts (root CLAUDE.md "Live-count verification") — run before quoting any number
grep -cE "^model " apps/api/prisma/schema.prisma
ls apps/api/src/modules/ | wc -l
grep -cE "<Route" apps/web/src/main.tsx
```

---

## 13. Troubleshooting

### The app "works" but shows the wrong data
You ran a bare `npx vite`: it serves on 5175 and proxies `/api` to
https://localhost:3000 — the sibling DigiLog checkout's backend. Use
`start-app.bat`, or set `WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001`.

### Every instrument e2e returns 500
A migration was applied to `compliance_core_db` but not `compliance_core_db_test`
(or the reverse). Run `prisma migrate deploy` against both (§6).

### `prisma generate` → EPERM
`tsx watch` holds the generated client open on Windows. Stop the API first.

### "Module not found" / stale shared types
```bash
npm install && npm run build -w @digilog/shared && npx turbo build --force
```

### Database connection errors
- `pg_isready`; check `DATABASE_URL` in `apps/api/.env` names a database that exists (§3).

### Port conflicts
- API (3001): `netstat -ano | findstr :3001` — Web (5176): `findstr :5176` —
  Postgres (5432): `findstr :5432` — EMQX (1883/8883/18083) if running.

### Windows-specific
- Use Git Bash or PowerShell; there is no WSL2 or Docker on the dev laptop, and
  virtualization is off — Linux native modules are built by the GitHub runner
  (`.github/workflows/build-deb.yml`), never here.
- If `bcrypt` fails to install: `npm install --build-from-source bcrypt`.
- `curl` exit 60 against https://localhost:3001 is Schannel revocation checking,
  not a broken chain — add `--ssl-revoke-best-effort`.

---

## 14. Git Information

| Field | Value |
|-------|-------|
| Repository | https://github.com/Controlytics/T-RH.git (since 2026-10-06; sivamunnangi1211/TRH_GGP is the frozen old remote) |
| Working branch | `data-layer` |
| Frozen backup | `final-user-management` — do not commit to it |

---

## 15. Architecture Summary

- **Backend:** Fastify 5 + TypeScript (ESM) + Prisma 6 on PostgreSQL 18; graphile-worker
  job queue in the same database (**7** tasks: `notification`, `notification_retry`,
  `password_expiry_check`, `session_sweep`, `telemetry_partition_maintenance`,
  `alarm_evaluation`, `alarm_webhook` — the `taskList` in `apps/api/src/app.ts`,
  2026-10-12). Instrument ingest over HTTP, WebSocket, raw TCP and MQTT (EMQX 5.3.2).
- **Frontend:** React 19 + Vite 6 + Tailwind v4 + SWR + React Router 7, served
  same-origin by the API in production.
- **Domain:** 21 CFR Part 11 administration — users, roles, hash-chained audit trail,
  e-signature re-auth, notifications — plus instrument monitoring: telemetry,
  five alarm sources, functional locations, floor plans, report review workflow.
- **Not here:** the DigiLog filter / cleanroom domain, RFID, tablets, offline sync,
  multi-tenancy, TimescaleDB, Redis. See root `CLAUDE.md` "Filter domain — REMOVED"
  and `docs/recreation/02-inventory/absent-subsystems.md`.
