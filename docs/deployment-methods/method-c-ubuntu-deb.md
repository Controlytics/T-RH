# Method C: Ubuntu / Debian `.deb` package

**Status: SHIPPED (2026-09-09) — the Linux counterpart of the Windows `Setup.exe`.**
One file, `digilog_<version>_amd64.deb`, installs the whole system on an intranet
server with **no internet access and no reverse proxy**. Built by
`.github/workflows/build-deb.yml` (or `scripts/linux/build-deb.sh` on any Ubuntu
22.04+ box) — the build host is the only place the internet is needed.

## What the package contains

| Path | Contents |
|---|---|
| `/opt/digilog/node/bin/node` | Portable Node.js 24 (official linux-x64 build) |
| `/opt/digilog/runtime/` | Compiled API, built web UI, production `node_modules` (Prisma engines for openssl 1.1 **and** 3.0 hosts, prebuilt `bcrypt`), migrations, `seed.mjs`, `crontab.txt` |
| `/opt/digilog/pgsql/` | Portable PostgreSQL 18 (zonky build, self-contained `lib/`) |
| `/opt/digilog/emqx/` | EMQX 5.3.2 MQTT broker (ubuntu20.04 build, bundled Erlang); config rendered at install from `/opt/digilog/emqx-templates/` — the SAME templates the Windows installer uses |
| `/opt/digilog/scripts/` | `digilog-lib.sh` (provisioning library), `digilog-backup.sh` |
| `/lib/systemd/system/` | `digilog-db`, `digilog-emqx`, `digilog-api` services; `digilog-backup` service + timer |

Created at install, survive upgrade **and** `apt remove` (destroyed only by `apt purge`):

| Path | Contents |
|---|---|
| `/var/lib/digilog/db` | The private PostgreSQL cluster, port **5433**, localhost only |
| `/var/lib/digilog/uploads`, `/emqx`, `/backups` | Uploads; the broker's retained slots and built-in database; nightly dumps |
| `/etc/digilog/digilog.env` | Every secret and setting the API reads (`EnvironmentFile=`), `0640 root:digilog`, generated **once** |
| `/etc/digilog/certs/` | Local CA + server cert (CN = LAN IPv4; SAN: localhost, hostname, 127.0.0.1, LAN IPv4 as both DNS and IP — some modem TLS stacks read DNS entries only), and the **device CA** `device-ca.{pem,key}` that issues each instrument's client certificate (since 2026-10-27; created on install and on upgrade, never replaced) |
| `/etc/digilog/initial-admin-password.txt` | Only when no `DIGILOG_ADMIN_PASSWORD` was given at install; root-only; delete after first login |
| `/var/log/digilog/` | Provisioning and backup logs (services log to the journal) |

"Any Ubuntu version from 22.04": the vendored Node, PostgreSQL and EMQX are
self-contained downloads, but `bcrypt` and the Prisma engines are built on the
workflow's `ubuntu-22.04` runner (glibc 2.35) — the oldest hosted runner GitHub
still offers (20.04 retired 2025). **20.04 is untested** (corrected 2026-10-05;
this paragraph used to say "oldest supported runner" and "20.04+"). Nothing
links against the host's `libssl`/`libicu`. Declared dependencies are only
`libc6 (>= 2.31)`, `openssl`, `adduser`, `procps`, `ca-certificates` — all in
`ubuntu-minimal`. Tested by the workflow's smoke install on the runner; the
site's IQ should repeat it on the target release.

## Install

```bash
# copy the .deb to the server (USB, SCP — no internet needed), then:
sudo DIGILOG_ADMIN_PASSWORD='ChooseAStrongOne1' apt install ./digilog_1.0.0_amd64.deb
```

Post-install (`DEBIAN/postinst`, root) does what `scripts/install.ps1` does on
Windows: creates the `digilog` service user and directories; generates the CA
and server certificate; writes `digilog.env` with strong random secrets; `initdb`
the private cluster, creates the `digilog` role and `digilog_db`, applies
`prisma/sql/extensions.sql` (ltree, pgcrypto), runs `prisma migrate deploy` and
the seed with the bundled `node` only; renders the broker config; enables and
starts the three services and the backup timer; waits for
`https://127.0.0.1:3000/api/health`. Omit `DIGILOG_ADMIN_PASSWORD` and a
password is generated into `/etc/digilog/initial-admin-password.txt`.

Then open `https://<server-ip>:3000`, log in as `superadmin`, change the
password. Other machines and tablets must trust `/etc/digilog/certs/rootCA.pem`.

## Upgrade

```bash
sudo apt install ./digilog_1.1.0_amd64.deb
```

`prerm upgrade` stops only the API (the database stays up); `postinst configure
<old-version>` takes a `pg_dump` to `/var/lib/digilog/backups/pre-upgrade-v…`
**before** any schema change, runs the forward-only `migrate deploy` + reseed
(never touches an existing superadmin password), re-renders the broker config
from the new templates, restarts the broker and starts the API. A failed backup
aborts before any schema change.

## Remove / purge

```bash
sudo apt remove digilog   # program gone; database, uploads, audit records, secrets, certs STAY
sudo apt purge  digilog   # destroys /var/lib/digilog, /etc/digilog, /var/log/digilog and the service user
```

## Operating it

```bash
systemctl status digilog-db digilog-emqx digilog-api digilog-backup.timer
journalctl -u digilog-api -f
cat /var/lib/digilog/backups/LAST-BACKUP-STATUS.txt
sudo -u digilog LD_LIBRARY_PATH=/opt/digilog/pgsql/lib /opt/digilog/pgsql/bin/psql -h 127.0.0.1 -p 5433 -U digilog digilog_db
sudo -u digilog /opt/digilog/emqx/bin/emqx_ctl status
# repair the broker config / service from a root shell:
. /opt/digilog/scripts/digilog-lib.sh && digilog_provision_emqx && systemctl restart digilog-emqx
```

**Device certificates (2026-10-27).** With the device CA present, HTTPS and
MQTTS ask every client for a certificate and verify one against the device CA,
but never require one — browsers and devices without a certificate connect as
before. A profile switched to **Require device certificate** (Configuration →
Instrument Attributes) refuses its instruments' data on every channel unless
the device presents the certificate issued from Instruments → the instrument →
**Device certificate**. Raw TCP and plain 1883 can never carry one.

Ports: **3000** HTTPS (web + API), **1883** MQTT, **8883** MQTTS, **18083**
EMQX dashboard on loopback only (`admin` / `EMQX_DASHBOARD_PASSWORD` from
`digilog.env`). PostgreSQL 5433 is localhost only. Open 3000, 1883 and 8883 in
the site firewall (`ufw allow 3000,1883,8883/tcp`) if one is active; the package
does not change firewall rules.

The MQTT security model is the same as on Windows and is documented in
`docs/PHARMA_DEPLOYMENT_21CFR.md` §4a and `LOCAL_SETUP_WINDOWS.md` §9A.3: one
authenticator (the API's HTTPS hook, which also admits the ingest bridge by its
own credential), `no_match = deny`, and the rendered `acl.conf`.

## Build

```bash
# GitHub Actions: push a tag  v1.0.0  -> Release with the .deb attached;
# any push to data-layer touching the packaging inputs -> workflow artifact.
# Locally on Ubuntu 22.04+ (Node 24 — root package.json `engines`; dpkg-deb, curl, unzip, xz):
scripts/linux/build-deb.sh --version 1.0.0
```

Pinned inputs (override with env vars): `NODE_VERSION=24.20.0`,
`PG_VERSION=18.6.0` (zonky `embedded-postgres-binaries-linux-amd64`),
`EMQX_VERSION=5.3.2`, `EMQX_DISTRO=ubuntu20.04`. The broker version is pinned to
the same one the Windows installer ships so both platforms run one broker.

## Not covered

- The APK / tablets: unchanged; point them at `https://<server-ip>:3000` with
  `rootCA.pem` installed.
- A site-signed certificate: drop your own `server.key` / `server.crt` /
  `rootCA.pem` into `/etc/digilog/certs/` and restart `digilog-api` and
  `digilog-emqx`.
- Migrating a Windows installation to Linux: `pg_dump` there, `psql` here
  (same PostgreSQL major), copy `/uploads` and `digilog.env`'s `AUDIT_CHAIN_KEY`
  — losing that key makes every keyed audit row permanently unverifiable.
