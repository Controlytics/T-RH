#!/usr/bin/env bash
# Shared provisioning functions for the DigiLog .deb — sourced by DEBIAN/postinst
# (install + upgrade) and usable from a root shell for repair:
#   . /opt/digilog/scripts/digilog-lib.sh && digilog_provision_emqx
#
# Linux counterpart of scripts/install.ps1 + provision-db.ps1 + apply-schema.ps1
# + provision-emqx.ps1. Same layout decisions as the Windows installer:
#   program  /opt/digilog          (replaced on upgrade)
#   data     /var/lib/digilog      (db, uploads, emqx, backups — survives upgrade and remove; gone only on purge)
#   config   /etc/digilog          (digilog.env with the generated secrets; certs/)
#   logs     /var/log/digilog
# Everything runs as the unprivileged service user `digilog`; PostgreSQL refuses
# root anyway. Secrets are generated ONCE and never regenerated (regenerating
# would invalidate sessions and make every keyed audit row unverifiable).

DIGILOG_USER="${DIGILOG_USER:-digilog}"
OPT="${DIGILOG_OPT:-/opt/digilog}"
DATA="${DIGILOG_DATA:-/var/lib/digilog}"
CFG="${DIGILOG_CFG:-/etc/digilog}"
LOGDIR="${DIGILOG_LOG:-/var/log/digilog}"
ENV_FILE="$CFG/digilog.env"
CERT_DIR="$CFG/certs"
API_PORT="${DIGILOG_API_PORT:-3000}"
PG_PORT="${DIGILOG_PG_PORT:-5433}"
MQTT_PORT="${DIGILOG_MQTT_PORT:-1883}"
MQTTS_PORT="${DIGILOG_MQTTS_PORT:-8883}"
DASHBOARD_PORT="${DIGILOG_DASHBOARD_PORT:-18083}"

NODE="$OPT/node/bin/node"
PG_BIN="$OPT/pgsql/bin"
EMQX="$OPT/emqx/bin/emqx"
EMQX_CTL="$OPT/emqx/bin/emqx_ctl"
API_DIR="$OPT/runtime/api"
export LD_LIBRARY_PATH="$OPT/pgsql/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 1; }
secret() { openssl rand -hex "${1:-24}"; }
as_digilog() { runuser -u "$DIGILOG_USER" -- "$@"; }

env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" | head -1 | tr -d '\r'; }
# Append KEY=VALUE only if KEY is absent. Returns the effective value on stdout.
env_ensure() {
  local cur; cur="$(env_get "$1")"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return; fi
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  printf '%s' "$2"
}

digilog_ensure_user_dirs() {
  if ! getent passwd "$DIGILOG_USER" >/dev/null; then
    adduser --system --group --home "$DATA" --no-create-home --shell /usr/sbin/nologin "$DIGILOG_USER"
  fi
  install -d -m 0750 -o "$DIGILOG_USER" -g "$DIGILOG_USER" "$DATA" "$DATA/uploads" "$DATA/emqx" "$DATA/backups" "$LOGDIR"
  install -d -m 0700 -o "$DIGILOG_USER" -g "$DIGILOG_USER" "$DATA/db"
  install -d -m 0750 -o root -g "$DIGILOG_USER" "$CFG" "$CERT_DIR"
  # EMQX writes its generated configs under data_dir and its logs under its own log/.
  chown -R "$DIGILOG_USER:$DIGILOG_USER" "$OPT/emqx"
}

# HTTPS certs: a local CA + a server cert whose SAN covers localhost, 127.0.0.1
# and this host's LAN IPv4 (same as install.ps1). Reused if present.
digilog_ensure_certs() {
  local ca="$CERT_DIR/rootCA.pem" cakey="$CERT_DIR/rootCA.key" key="$CERT_DIR/server.key" crt="$CERT_DIR/server.crt"
  if [ -s "$crt" ]; then log "Reusing certs in $CERT_DIR"; return; fi
  local lan; lan="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -n "$lan" ] || lan=127.0.0.1
  local ext="$CERT_DIR/server.ext"
  cat > "$ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
subjectAltName = @alt
[alt]
DNS.1 = localhost
DNS.2 = $(hostname -s 2>/dev/null || echo digilog)
IP.1 = 127.0.0.1
IP.2 = $lan
EOF
  openssl genrsa -out "$cakey" 2048 >/dev/null 2>&1
  openssl req -x509 -new -nodes -key "$cakey" -sha256 -days 3650 -subj "/CN=DigiLog Local CA" -out "$ca"
  openssl genrsa -out "$key" 2048 >/dev/null 2>&1
  openssl req -new -key "$key" -subj "/CN=$lan" -out "$CERT_DIR/server.csr"
  openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$ca" -CAkey "$cakey" -CAcreateserial -days 3650 -sha256 -extfile "$ext" -out "$crt" >/dev/null 2>&1
  [ -s "$crt" ] || die "server certificate generation failed"
  chown root:"$DIGILOG_USER" "$key" "$crt" "$ca"; chmod 0640 "$key"; chmod 0644 "$crt" "$ca"
  # Trust the CA on this server so curl/browsers on the box do not warn; the
  # broker's auth hook verifies against the file path, not the system store.
  if [ -d /usr/local/share/ca-certificates ]; then cp "$ca" /usr/local/share/ca-certificates/digilog-rootCA.crt; update-ca-certificates >/dev/null 2>&1 || true; fi
  log "Generated HTTPS certs (SAN includes $lan); rootCA.pem = $ca"
}

# The runtime env file the API service loads (EnvironmentFile=). Written once.
digilog_ensure_env() {
  if [ -f "$ENV_FILE" ]; then log "Reusing $ENV_FILE (secrets preserved)"; return; fi
  local lan; lan="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -n "$lan" ] || lan=127.0.0.1
  local db_pw; db_pw="$(secret 18)"
  umask 027
  cat > "$ENV_FILE" <<EOF
DATABASE_URL=postgresql://digilog:$db_pw@localhost:$PG_PORT/digilog_db?schema=public
JWT_SECRET=$(secret 48)
VERIFICATION_TOKEN_SECRET=$(secret 48)
OFFLINE_REPLAY_SECRET=$(secret 48)
AUDIT_CHAIN_KEY=$(secret 48)
AUDIT_CHAIN_KEYED_FROM=0
JWT_EXPIRES_IN=1h
NODE_ENV=production
PORT=$API_PORT
API_HTTPS=true
TLS_KEY_PATH=$CERT_DIR/server.key
TLS_CERT_PATH=$CERT_DIR/server.crt
SERVE_WEB=true
WEB_DIST_DIR=$OPT/runtime/web/dist
UPLOAD_DIR=$DATA/uploads
MAINTENANCE_CRONTAB_PATH=$OPT/runtime/queue/crontab.txt
ALLOWED_ORIGINS=https://localhost:$API_PORT,https://${lan}:$API_PORT,https://localhost,capacitor://localhost,http://localhost
EOF
  chown root:"$DIGILOG_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"
  log "Wrote $ENV_FILE (secrets generated)"
}

pg_running() { "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; }
pg_start_direct() { as_digilog "$PG_BIN/pg_ctl" -D "$DATA/db" -l "$LOGDIR/postgres-provision.log" -w start >/dev/null; }
pg_stop_direct()  { as_digilog "$PG_BIN/pg_ctl" -D "$DATA/db" -m fast stop >/dev/null 2>&1 || true; }
psql_super() { local db="$1"; shift; PGPASSWORD="$PG_SUPER_PW" "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -qtA "$@"; }

# migrate deploy + seed with ONLY the bundled node (no npx on a customer box).
# The seed's superadmin upsert never overwrites an existing password, so on
# upgrade a throwaway INITIAL_ADMIN_PASSWORD is safe.
digilog_apply_schema() {
  local admin_pw="$1"
  local url; url="$(env_get DATABASE_URL)"; [ -n "$url" ] || die "DATABASE_URL missing from $ENV_FILE"
  ( cd "$API_DIR" && DATABASE_URL="$url" as_digilog env DATABASE_URL="$url" "$NODE" "$OPT/runtime/node_modules/prisma/build/index.js" migrate deploy ) || die "prisma migrate deploy failed"
  ( cd "$API_DIR" && as_digilog env DATABASE_URL="$url" INITIAL_ADMIN_PASSWORD="$admin_pw" "$NODE" "$API_DIR/prisma/seed.mjs" ) || die "seed failed"
}

# Fresh cluster: initdb (scram, UTF8), private port, localhost only, app role +
# database, the two extensions the baseline migration needs, then the schema.
digilog_provision_db_fresh() {
  local admin_pw="$1"
  [ -f "$DATA/db/PG_VERSION" ] && { log "DB cluster already initialised at $DATA/db - skipping initdb"; return; }
  local db_url db_pw pwfile; db_url="$(env_get DATABASE_URL)"
  db_pw="$(printf '%s' "$db_url" | sed -E 's#^postgresql://[^:]+:([^@]+)@.*#\1#')"
  PG_SUPER_PW="$(secret 18)"
  pwfile="$(mktemp)"; printf '%s' "$PG_SUPER_PW" > "$pwfile"; chown "$DIGILOG_USER" "$pwfile"
  log "initdb (fresh cluster on :$PG_PORT)"
  as_digilog "$PG_BIN/initdb" -D "$DATA/db" -U postgres --auth=scram-sha-256 --pwfile="$pwfile" -E UTF8 >/dev/null || { rm -f "$pwfile"; die "initdb failed"; }
  rm -f "$pwfile"
  printf '\n# --- DigiLog installer overrides ---\nport = %s\nlisten_addresses = '"'"'localhost'"'"'\n' "$PG_PORT" >> "$DATA/db/postgresql.conf"
  pg_start_direct
  log "create role + database + extensions"
  psql_super postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='digilog') THEN CREATE ROLE digilog LOGIN PASSWORD '$db_pw'; END IF; END \$\$;"
  if [ -z "$(psql_super postgres -c "SELECT 1 FROM pg_database WHERE datname='digilog_db';")" ]; then psql_super postgres -c "CREATE DATABASE digilog_db OWNER digilog;"; fi
  psql_super digilog_db -f "$API_DIR/prisma/sql/extensions.sql" >/dev/null
  digilog_apply_schema "$admin_pw"
  local roles; roles="$(psql_super digilog_db -c 'SELECT count(*) FROM roles;')"
  pg_stop_direct
  log "Provisioned digilog_db on :$PG_PORT (roles=$roles); systemd takes over the cluster from here"
}

# Upgrade: the cluster is systemd's. Back up BEFORE any schema change, then
# forward-only migrate deploy + reseed (never touches an existing superadmin).
digilog_upgrade_db() {
  local version="$1"
  systemctl start digilog-db.service
  for _ in $(seq 1 30); do pg_running && break; sleep 1; done
  pg_running || die "digilog-db did not accept connections; no schema change applied"
  local url; url="$(env_get DATABASE_URL)"
  local pw; pw="$(printf '%s' "$url" | sed -E 's#^postgresql://[^:]+:([^@]+)@.*#\1#')"
  local out="$DATA/backups/pre-upgrade-v$version-$(date +%Y%m%d-%H%M%S).sql"
  log "pg_dump digilog_db -> $out"
  PGPASSWORD="$pw" as_digilog env PGPASSWORD="$pw" "$PG_BIN/pg_dump" -h 127.0.0.1 -p "$PG_PORT" -U digilog -d digilog_db -f "$out" || die "pre-upgrade backup failed; NO schema change applied"
  [ -s "$out" ] || die "pre-upgrade backup is empty; NO schema change applied"
  digilog_apply_schema "upgrade-$(secret 8)"
}

# EMQX: env keys (appended only if absent), config rendered from the SAME
# templates the Windows installer uses, data under /var/lib/digilog/emqx.
digilog_provision_emqx() {
  local tpl="$OPT/emqx-templates"
  [ -f "$tpl/emqx.conf.template" ] && [ -f "$tpl/acl.conf" ] || die "EMQX templates missing from $tpl"
  env_ensure MQTT_BROKER_URL "mqtt://127.0.0.1:$MQTT_PORT" >/dev/null
  env_ensure MQTT_CLIENT_ID digilog-ingest-bridge >/dev/null
  env_ensure MQTT_USERNAME digilog-bridge >/dev/null
  env_ensure MQTT_PASSWORD "$(secret 24)" >/dev/null
  local cookie dashpw; cookie="$(env_ensure EMQX_NODE_COOKIE "$(secret 24)")"
  dashpw="$(env_ensure EMQX_DASHBOARD_PASSWORD "$(secret 12)")"
  local conf="$OPT/emqx/etc/emqx.conf" acl="$OPT/emqx/etc/acl.conf"
  [ -f "$conf" ] && [ ! -f "$conf.orig" ] && cp "$conf" "$conf.orig"
  [ -f "$acl" ]  && [ ! -f "$acl.orig" ]  && cp "$acl"  "$acl.orig"
  sed -e "s|@@NODE_COOKIE@@|$cookie|g" \
      -e "s|@@DATA_DIR@@|$DATA/emqx|g" \
      -e "s|@@DASHBOARD_PORT@@|$DASHBOARD_PORT|g" \
      -e "s|@@MQTT_PORT@@|$MQTT_PORT|g" \
      -e "s|@@MQTTS_PORT@@|$MQTTS_PORT|g" \
      -e "s|@@CERT_FILE@@|$CERT_DIR/server.crt|g" \
      -e "s|@@KEY_FILE@@|$CERT_DIR/server.key|g" \
      -e "s|@@CA_FILE@@|$CERT_DIR/rootCA.pem|g" \
      -e "s|@@HOOK_URL@@|https://127.0.0.1:$API_PORT/api/ingest/v1/mqtt-auth|g" \
      -e "s|@@ACL_FILE@@|$acl|g" \
      "$tpl/emqx.conf.template" > "$conf"
  if grep -qE '@@[A-Z_]+@@' "$conf"; then die "unrendered EMQX template token: $(grep -oE '@@[A-Z_]+@@' "$conf" | sort -u | tr '\n' ' ')"; fi
  cp "$tpl/acl.conf" "$acl"
  chown "$DIGILOG_USER:$DIGILOG_USER" "$conf" "$acl"
  install -d -m 0750 -o "$DIGILOG_USER" -g "$DIGILOG_USER" "$DATA/emqx"
  log "Rendered $conf and $acl"
}

# After digilog-emqx is up: the dashboard admin password (best effort).
digilog_emqx_postboot() {
  local dashpw; dashpw="$(env_get EMQX_DASHBOARD_PASSWORD)"
  local up=0
  for _ in $(seq 1 60); do if as_digilog "$EMQX_CTL" status 2>/dev/null | grep -q 'is started'; then up=1; break; fi; sleep 1; done
  [ "$up" = 1 ] || { warn "EMQX did not report started within 60s (see $OPT/emqx/log)"; return; }
  if as_digilog "$EMQX_CTL" admins passwd admin "$dashpw" >/dev/null 2>&1; then log "EMQX dashboard admin password set (EMQX_DASHBOARD_PASSWORD in $ENV_FILE)"
  else warn "could not set the EMQX dashboard password; run: $EMQX_CTL admins passwd admin <EMQX_DASHBOARD_PASSWORD>"; fi
}

digilog_wait_healthy() {
  for _ in $(seq 1 45); do
    if curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$API_PORT/api/health" 2>/dev/null | grep -q '^200$'; then return 0; fi
    sleep 1
  done
  return 1
}
