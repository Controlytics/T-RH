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
| `/opt/digilog/pgsql/` | PostgreSQL 18, built from the official source by `build-deb.sh` (server, `psql`, `pg_dump`, `pg_isready`, the `ltree` + `pgcrypto` extensions; links only libc, libssl3 and zlib — no ICU, no readline) |
| `/opt/digilog/emqx/` | EMQX 5.3.2 MQTT broker (ubuntu20.04 build, bundled Erlang); config rendered at install from `/opt/digilog/emqx-templates/` — the SAME templates the Windows installer uses |
| `/opt/digilog/scripts/` | `digilog-lib.sh` (provisioning library), `digilog-backup.sh` |
| `/lib/systemd/system/` | `digilog-db`, `digilog-emqx`, `digilog-api` services; `digilog-backup` service + timer |

Created at install, survive upgrade **and** `apt remove` (destroyed only by `apt purge`):

| Path | Contents |
|---|---|
| `/var/lib/digilog/db` | The private PostgreSQL cluster, port **5433**, localhost only |
| `/var/lib/digilog/uploads`, `/emqx`, `/backups` | Uploads; the broker's retained slots and built-in database; nightly dumps |
| `/etc/digilog/digilog.env` | Every secret and setting the API reads (`EnvironmentFile=`), `0640 root:digilog`, generated **once** |
| `/etc/digilog/certs/` | Local CA + server cert (CN = LAN IPv4; SAN: localhost, hostname, 127.0.0.1, LAN IPv4 as both DNS and IP — some modem TLS stacks read DNS entries only), and — only if device certificates are enabled — the **device CA** `device-ca.{pem,key}` that issues each instrument's client certificate (since 2026-10-27; OPT-IN, never replaced) |
| `/etc/digilog/initial-admin-password.txt` | Only when no `DIGILOG_ADMIN_PASSWORD` was given at install; root-only; delete after first login |
| `/var/log/digilog/` | Provisioning and backup logs (services log to the journal) |

"Any Ubuntu version from 22.04": the vendored Node and EMQX are self-contained
downloads, but `bcrypt`, the Prisma engines and — since 2026-11-18 —
**PostgreSQL itself** are built on the workflow's `ubuntu-22.04` runner
(glibc 2.35) — the oldest hosted runner GitHub still offers (20.04 retired
2025). **20.04 is untested and cannot work**: the bundled PostgreSQL links the
host's `libssl.so.3` / `libcrypto.so.3` (OpenSSL 3) and `libz.so.1`, and 20.04
ships OpenSSL 1.1 (corrected 2026-10-05 and again 2026-11-18; this paragraph
said "Nothing links against the host's `libssl`" until then — true of the zonky
bundle, false of the source build). No `libicu` / `libreadline` link (built
`--without-icu --without-readline`); `build-deb.sh` refuses a PostgreSQL that
links anything outside glibc, libssl3 / libcrypto3, libz and its own `lib/`. Declared
dependencies are `libc6 (>= 2.31)`, `openssl`, `adduser`, `procps`,
`ca-certificates` — all in `ubuntu-minimal`; `openssl` pulls in `libssl3`
(22.04) / `libssl3t64` (24.04), and `zlib1g` is Priority: required, so neither
is declared by name. Tested by the workflow's smoke install on 22.04 (first
fully green run 44321799003, 2026-11-18); the site's IQ should repeat it on
the target release — 24.04 included, which no run has installed on.

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
(since 2026-11-16 the reseed only CREATES a missing setting or help article,
keeps field labels, and creates `superadmin` only on a database with no users —
builds before that reset `password-policy`, `login-security`, `session`,
`datetime` and the e-signature matrix `action-reauth`, re-enabled or re-created
`superadmin` and reset field labels, so after upgrading FROM such a build check
those settings, the user list and the labels; audit 2026-11-07 S2-C1 / S10-1),
re-renders the broker config
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

**Device certificates (2026-10-27) are OPT-IN**: `sudo DIGILOG_DEVICE_CERTIFICATES=1 apt install ./digilog_<version>_amd64.deb`, or on an installed box `sudo bash -c '. /opt/digilog/scripts/digilog-lib.sh && digilog_ensure_device_ca && digilog_provision_emqx && systemctl restart digilog-api digilog-emqx'`. Back the device CA up with the server CA: a new one orphans every issued certificate. With the device CA present, HTTPS and
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
# Locally on Ubuntu 22.04+ (Node 24 — root package.json `engines`; dpkg-deb, curl, tar, xz, bzip2,
# file, and the PostgreSQL build deps:  sudo apt-get install build-essential libssl-dev zlib1g-dev):
scripts/linux/build-deb.sh --version 1.0.0
```

Pinned inputs (override with env vars): `NODE_VERSION=24.20.0`,
`PG_VERSION=18.6` (the official source, SHA-256-verified, built on the runner with `--without-icu --without-readline --with-ssl=openssl`; until 2026-11-18 a zonky portable bundle, which had no `psql` / `pg_dump` / `pg_isready`),
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
