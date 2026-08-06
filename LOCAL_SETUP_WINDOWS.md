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

MQTTS changes two things and nothing else. The API is untouched — the bridge
still subscribes over loopback plaintext, because broker and API are the same
host and that hop never reaches a network.

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
