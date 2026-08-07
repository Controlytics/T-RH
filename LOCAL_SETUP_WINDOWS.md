# DigiLog — Local Windows Setup Guide

**Purpose:** This file contains everything Claude (or a developer) needs to clone, set up, and run the DigiLog application locally on a Windows machine. Follow every step exactly.

> ⚠️ **2026-06-17 — TimescaleDB + Mosquitto no longer required.** The data-ingestion subsystem was removed in Phase 7 of the cleanup. You only need vanilla PostgreSQL 18 (no TimescaleDB extension), no MQTT broker, and no telemetry-related `.env` keys (`TSDB_*` / `MQTT_*` / `EMQX_*` / `UNS_ROOT_PREFIX` are all gone). This guide has been updated accordingly. See `CHANGELOG.md` Phase 7 entry + root `CLAUDE.md` System Stats for what's current.

---

## 1. Prerequisites — Install These First

### 1.1 Node.js v20 (LTS)
- Download: https://nodejs.org/en/download — select **v20.x LTS** (NOT v22)
- Verify: `node -v` should show `v20.x.x`
- npm comes bundled: `npm -v` should show `10.x.x`

### 1.2 PostgreSQL 18
- Download PostgreSQL 18: https://www.postgresql.org/download/windows/
- During install: remember the superuser password (e.g. `postgres`)
- Port: **5432** (default)
- No TimescaleDB extension is needed — the time-series subsystem was removed in Phase 7 (2026-06-17). Vanilla PostgreSQL 18 is all DigiLog requires.

### 1.3 Redis — RETIRED (Phase 4, 2026-05-01)
DigiLog no longer uses Redis. **Do not install Memurai or Redis.** Phase 2
moved the job queue to Postgres (graphile-worker); Phase 4 moved pub/sub
and RPC correlation in-process (EventEmitter bus + Map TTL cache). Skip
this section entirely — there is nothing to install for the pub/sub layer.

### 1.4 Git
- Download: https://git-scm.com/download/win
- Verify: `git --version`

> **No MQTT broker required.** The data-ingestion subsystem (Mosquitto/MQTT,
> TimescaleDB) was removed wholesale in Phase 7 (2026-06). There is no broker
> to install for local dev.

---

## 2. Clone the Repository

```bash
git clone https://github.com/pankajexa/21cfrlogbook.git
cd 21cfrlogbook
git checkout DigitalFMS
```

---

## 3. Create Databases

Open **pgAdmin** or **psql** and run:

```sql
-- Create the application user
CREATE USER digilog WITH PASSWORD 'digilog123';

-- Create the main database (Prisma)
CREATE DATABASE digilog_db OWNER digilog;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE digilog_db TO digilog;

-- Connect to digilog_db and enable pgcrypto (used for UUID / hashing)
\c digilog_db
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO digilog;
```

> **Note:** There is only one application database now — `digilog_db` (Prisma).
> The former `digilog_tsdb` TimescaleDB database was dropped in Phase 7
> (2026-06-17) along with the data-ingestion subsystem.

---

## 4. Create Environment Files

### 4.1 Root `.env` (copy to project root AND `apps/api/.env`)

Create the file `21cfrlogbook/.env` with this content:

```env
# --- PostgreSQL (Prisma) ---
DATABASE_URL=postgresql://digilog:digilog123@localhost:5432/digilog_db?schema=public

# --- Redis — RETIRED (Phase 4, 2026-05-01) ---
# Pub/sub moved in-process via EventEmitter bus. RPC correlation moved to
# Map TTL cache. REDIS_* env vars are no longer read by anything.
# (TimescaleDB env keys were removed in Phase 7 — none are read anymore. MQTT
#  keys came back on 2026-08-06 for the instrument ingest bridge — a different
#  subsystem entirely. They are OPTIONAL; see section 9A.)

# --- SMTP (optional) ---
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=

# --- JWT Configuration ---
JWT_SECRET=LOCAL_DEV_SECRET_CHANGE_IN_PRODUCTION_1234567890abcdefghijklmnopqrstuvwxyz
VERIFICATION_TOKEN_SECRET=LOCAL_DEV_VERIFY_SECRET_CHANGE_IN_PRODUCTION_1234567890abcdefghijklmn
JWT_EXPIRES_IN=8h

# --- Server Configuration ---
NODE_ENV=development
API_PORT=3000

# --- CORS Configuration ---
CORS_ORIGIN=http://localhost:5175
ALLOWED_ORIGINS=http://localhost:5175,http://localhost:3000

# --- Upload Configuration ---
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880
```

**IMPORTANT:** Copy the same file to `apps/api/.env`:
```bash
cp .env apps/api/.env
```

---

## 5. Install Dependencies

```bash
npm install
```

This installs all dependencies for the monorepo (root + apps/api + apps/web + packages/*).

---

## 6. Set Up the Database

### 6.1 Generate Prisma Client
```bash
cd apps/api
npx prisma generate
```

### 6.2 Run Migrations
```bash
npx prisma migrate deploy
```

> This creates all 61 model tables including the Phase 2 filter management tables, equipment groups, and checklist profiles.

### 6.3 Seed the Database
```bash
npx prisma db seed
```

> This creates: 6 default roles (SUPER_ADMIN through VIEWER), superadmin user (username: `superadmin`, password: `Admin@123`), system config entries (auto-discovered), permission constants, and the system template kinds (DigiLog is single-tenant, no organizations created).

```bash
cd ../..
```

---

## 7. Build the Project

```bash
npm run build
```

This runs `turbo build` which builds all packages in dependency order:
1. `@digilog/shared` (shared types)
2. `@digilog/queue` (graphile-worker wrapper)
3. `@digilog/api` (Fastify backend — TypeScript -> JavaScript)
4. `@digilog/web` (React frontend — Vite build)

---

## 8. Run the Application

### 8.1 Development Mode (with hot reload)

Open **two terminals**:

**Terminal 1 — Backend API:**
```bash
cd apps/api
npx tsx watch src/app.ts
```
API runs on http://localhost:3000

**Terminal 2 — Frontend:**
```bash
cd apps/web
npx vite --host
```
Frontend runs on http://localhost:5175

### 8.2 Using Batch Scripts
```bash
start-digilog.bat    # Starts API and Frontend (no Redis, no MQTT broker)
stop-digilog.bat     # Stops all services
```

### 8.3 Production Mode

```bash
# Build first
npm run build

# Start API
cd apps/api
node dist/app.js

# Serve frontend (use any static server)
cd ../web
npx vite preview
```

---

## 9. Verify It Works

1. Open http://localhost:5175 in your browser
2. Login: **superadmin** / **Admin@123**
3. You should see the dashboard
4. Check the sidebar for:
   - Filter Operations
   - Cleaning Cycles
   - Checklists
   - Cleaning Profiles
   - Filter Profiles
   - PM Schedules
   - Equipment Groups

### API Health Check
```bash
curl http://localhost:3000/api/health
# or in browser: http://localhost:3000/docs (Swagger UI)
```

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
  -d '{"temperature": 21.5}'
# -> {"accepted":1}
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

EMQX 5.3.2 is installed at `C:\Users\hello\emqx-5.3.2` (the last release with a
Windows build). Start it with `bin\emqx.cmd start`.

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
  `digilog-bridge → instruments/+/telemetry` (uplink) and each device →
  `instruments/<its code>/attributes` (downlink).
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
| **Client ID** | the instrument **code**, e.g. `DLSTD-1786017252` |
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
`instruments/+/telemetry` at QoS 1 and hands each payload to the ingest core
with `transport: 'mqtt'`.

**A device connects as: username = its device token, client ID = its instrument
code.** Both, or the broker refuses it.

#### The three pieces of EMQX configuration, and why each is load-bearing

**1. `etc/acl.conf`** — edited in place; the stock file is preserved as
`etc/acl.conf.orig`. The source path is `${EMQX_ETC_DIR}/acl.conf`, so a restart
reloads it.

```erlang
{allow, {username, {re, "^dashboard$"}}, subscribe, ["$SYS/#"]}.

%% the ingest bridge — the only client allowed to read the whole tree
{allow, {username, "digilog-bridge"}, subscribe, ["instruments/+/telemetry"]}.

%% a device may publish to ITS OWN topic only
{allow, all, publish, ["instruments/${clientid}/telemetry"]}.

%% DOWNLINK (see §9B.6). The bridge is the only publisher on the attribute
%% tree; a device reads its own slot and, if it is a gateway, its children's.
{allow, {username, "digilog-bridge"}, publish, ["instruments/+/attributes", "instruments/+/attributes/+"]}.
{allow, all, subscribe, ["instruments/${clientid}/attributes", "instruments/${clientid}/attributes/#"]}.

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
  -m '{"temperature": 21.5}'
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
| standalone | `instruments/<code>/attributes` |
| child of a gateway | `instruments/<gatewayCode>/attributes/<childCode>` |

A child has **no broker connection of its own**, so its change has to reach the
gateway that fans out for it — addressed to the child, on the gateway's tree.
The gateway subscribes `instruments/<gatewayCode>/attributes/#`, which covers
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

Subscribe as the device itself (client id = instrument code, username = its
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

Two publish patterns, not one: `+` is exactly one level, so
`instruments/+/attributes` does **not** cover a child's three-segment topic.

The subscribe rule templates on `${clientid}`, and that is only meaningful
because `POST /api/ingest/v1/mqtt-auth` refuses any CONNECT whose client id is
not the token's instrument code — the same binding that makes the telemetry
publish rule real. A gateway's client id *is* the gateway code, so
`instruments/${clientid}/attributes/#` covers its children and nothing else.

> The exact-topic pattern is **redundant** — `instruments/${clientid}/attributes/#`
> alone permits a subscribe to `instruments/<code>/attributes` and delivers on
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

- **deleting an instrument** — `instruments/<code>/attributes` keeps its last
  message forever;
- **unlinking a child from its gateway** — the old
  `instruments/<gw>/attributes/<child>` slot is stranded, and the child's own
  topic stays empty until its next attribute change;
- **moving a child to a different gateway** — same, on the previous gateway.

None leaks a secret (attributes are registry metadata, and only the instrument's
own client id can read the slot; after a delete, no token resolves to that code
at all, so nothing can even connect as it). It is stale data on the broker, not
an exposure. `code` is immutable, so renaming is not a fourth case.

### 9C. The CHILD ROSTER — telling a gateway who its children are

Added 2026-08-07. The attribute downlink above announces a child only when that
child *changes*, so a linked-but-untouched child was invisible to its gateway,
and link/unlink published nothing at all. A gateway could not answer "which
instruments am I responsible for" from the broker alone. One retained slot per
gateway now carries the whole membership:

```
instruments/<gatewayCode>/children
{"children":[{"code":"DLCH-1786017252","name":"DL child","isActive":true}],
 "ts":"2026-08-07T05:08:25.154Z"}
```

**A sibling topic, not a segment under `…/attributes/`.** Instrument codes allow
`[A-Za-z0-9._-]`, so any reserved segment inside the attribute subtree could be
collided with by a real code. The cost is one extra subscription on the device;
`instruments/<gwCode>/attributes/#` does **not** cover it.

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

---

## 10. Project Structure

```
21cfrlogbook/
├── apps/
│   ├── api/                    # Fastify backend (TypeScript)
│   │   ├── prisma/
│   │   │   ├── schema.prisma   # Database schema (61 models, 23 enums)
│   │   │   ├── seed.ts         # Database seeder
│   │   │   └── migrations/     # SQL migrations
│   │   └── src/
│   │       ├── app.ts          # Entry point
│   │       ├── modules/        # 33 API modules
│   │       ├── plugins/        # Auth, CORS, etc.
│   │       └── lib/            # Shared utilities
│   ├── web/                    # React frontend (Vite + Tailwind)
│   │   └── src/
│   │       ├── main.tsx        # Router + routes
│   │       ├── routes/         # 20+ route groups
│   │       ├── components/     # Shared components
│   │       └── lib/            # API client, hooks
│   └── android/                # Capacitor Android app
├── packages/
│   ├── shared/                 # Shared types & Zod schemas
│   └── queue/                  # graphile-worker wrapper (Postgres-backed)
├── turbo.json                  # Turborepo build config
├── start-digilog.bat           # Windows start script
├── stop-digilog.bat            # Windows stop script
└── package.json                # Root workspace config
```

---

## 11. Key Configuration

| Config | Value | Notes |
|--------|-------|-------|
| API Port | 3000 | Fastify backend |
| Web Dev Port | 5175 | Vite dev server |
| PostgreSQL | localhost:5432 | User: digilog, DB: digilog_db (PG 18) |
| ~~Redis~~ | ~~localhost:6379~~ | RETIRED (Phase 4) — pub/sub now in-process |
| Default Login | superadmin / Admin@123 | Created by seed |

---

## 12. Common Commands

```bash
# Install dependencies
npm install

# Build everything
npm run build

# Run dev mode (both API + Web)
npm run dev

# Database commands
cd apps/api
npx prisma generate          # Regenerate Prisma client
npx prisma migrate dev       # Create + apply new migration
npx prisma migrate deploy    # Apply pending migrations
npx prisma db seed           # Seed default data
npx prisma studio            # Visual DB browser on localhost:5555

# Run tests
npx turbo run test

# Build only API
npx turbo build --filter=@digilog/api

# Build only Web
npx turbo build --filter=@digilog/web
```

---

## 13. Troubleshooting

### "Module not found" errors
```bash
npm install
npx turbo build --force
```

### Prisma client errors
```bash
cd apps/api
npx prisma generate
cd ../..
npm run build
```

### Database connection errors
- Check PostgreSQL is running: `pg_isready`
- (Phase 4: Redis is no longer used; this step is no longer needed.)
- Verify .env DATABASE_URL matches your PostgreSQL credentials
- Ensure the `digilog_db` database exists (there is no longer a separate TimescaleDB database)

### Port conflicts
- API (3000): `netstat -ano | findstr :3000`
- Web (5175): `netstat -ano | findstr :5175`
- PostgreSQL (5432): `netstat -ano | findstr :5432`
- (Phase 4: Redis port 6379 is no longer used by DigiLog.)

### Windows-specific issues
- Use **Git Bash** or **WSL2** for running commands (not CMD)
- If `bcrypt` fails to install, run: `npm install --build-from-source bcrypt`
- If `sharp` errors occur: `npm install --platform=win32 --arch=x64 sharp`

---

## 14. Git Information

| Field | Value |
|-------|-------|
| Repository | https://github.com/pankajexa/21cfrlogbook.git |
| Branch | DigitalFMS |

---

## 15. Architecture Summary

- **Backend:** Fastify 5 + TypeScript + Prisma ORM + graphile-worker job queue
- **Frontend:** React 19 + Vite 6 + Tailwind CSS 4 + SWR + React Router 7
- **Database:** PostgreSQL 18 + Prisma migrations (single `digilog_db` database)
- **Queue:** PostgreSQL + graphile-worker (notification, PM-overdue, session-sweep tasks + cron)
- **Auth:** JWT tokens with bcrypt password hashing, session management

### Phase 2: Digital Filter Management System
- 6 backend modules: cleaning-profiles, filter-profiles, filter-operations, pm-schedules, checklist-profiles, equipment-groups
- 14+ frontend pages: operations, profiles, cycles, checklists, PM, AHU dashboard, traceability, equipment, bulk-upload, retirement
- 11+ database tables: filter_cleaning_profiles, filter_pipeline_stages, filter_pipeline_connections, filter_profiles, cleaning_cycles, filter_events, pm_schedules, pm_schedule_entries, pm_executions, equipment_groups, equipment_group_instruments, checklist_profiles, checklist_questions
- Visual pipeline editor with STAGE, CHECKLIST, START, END nodes
- Server-side checklist enforcement, race condition protection, input sanitization

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
