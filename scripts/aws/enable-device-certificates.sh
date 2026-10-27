#!/usr/bin/env bash
# Enable DEVICE CERTIFICATES on the AWS box (2026-10-27).
# Spec: docs/superpowers/specs/2026-10-27-device-certificates-design.md
#
# Run AFTER the code that carries the feature is deployed (deploy-on-ubuntu.sh).
# Until this runs the feature is inert: no device CA, no client-certificate
# request on 443, EMQX's SSL listener unchanged.
#
#   sudo bash /opt/digilog/app/scripts/aws/enable-device-certificates.sh           # dry run — changes nothing
#   sudo bash /opt/digilog/app/scripts/aws/enable-device-certificates.sh --apply
#
# BEFORE --apply (gates, not automated): log in to the app from every browser
# and device class in use (a phone too); confirm a real HTTPS device and a real
# MQTTS device still deliver afterwards; the dry run prints how many clients are
# on 8883 now — one that presents a client certificate from ANOTHER CA would be
# refused at the handshake once the listener verifies against the device CA.
#
# --apply:
#   1. backs up digilog.env, emqx.conf, acl.conf and api_key.bootstrap;
#   2. creates the device CA in /etc/digilog/certs if absent (never replaces one)
#      and adds DEVICE_CA_CERT_PATH / DEVICE_CA_KEY_PATH / TLS_CA_PATH;
#   3. re-renders the EMQX config from the repo template — SSL listener verifies
#      client certificates against the device CA (never requires one), the auth
#      hook receives cert_subject — and provisions the EMQX REST API key the
#      API uses to drop a session (owed since 2026-10-12);
#   4. restarts digilog-api, then digilog-emqx;
#   5. proves nothing broke for clients WITHOUT a certificate: /api/health 200
#      over TLS with no client certificate, MQTTS handshake with none, the
#      ingest bridge reconnected through the auth hook — and that the EMQX REST
#      API key is accepted (without it every session kick is a silent no-op).
#   ANY failure after the backups — a failed check, or the lib dying mid-render —
#   restores every backed-up file (and restarts both services if they had been
#   restarted). The device CA files stay; without the env lines nothing uses them.
#
# No profile requires a certificate yet after this; that is switched in the app
# (Configuration → Instrument Attributes → profile → Require device certificate).
set -euo pipefail

APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
APP="${APP:-/opt/digilog/app}"
# The API listens on 443 on this box: the lib renders the hook URL from it, so
# it must be exported BEFORE the lib is sourced.
export DIGILOG_API_PORT=443
# shellcheck disable=SC1091
. "$APP/scripts/linux/digilog-lib.sh"
EMQX_HOME="$OPT/emqx"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONF="$EMQX_HOME/etc/emqx.conf"
ACL="$EMQX_HOME/etc/acl.conf"
KEYF="$EMQX_HOME/etc/api_key.bootstrap"

[ -f "$ENV_FILE" ] || die "$ENV_FILE missing"
[ -f "$APP/apps/api/dist/modules/instruments/device-ca.js" ] \
  || die "the deployed build has no device-certificate support — deploy first"
grep -q '@@SSL_VERIFY@@' "$APP/scripts/emqx/emqx.conf.template" \
  || die "the repo's EMQX template has no @@SSL_VERIFY@@ — deploy first"

ssl_block() { sed -n '/^listeners.ssl.default {/,/^}/p' "$1"; }

if [ "$APPLY" -ne 1 ]; then
  # Render everything into a throwaway copy and show what WOULD change.
  W="$(mktemp -d "${WORK_ROOT:-/root}/device-certs-dryrun-XXXXXX")"; chmod 700 "$W"
  trap 'rm -rf "$W"' EXIT
  cp -a "$CFG" "$W/cfg"
  mkdir -p "$W/opt/emqx/etc"
  ln -s "$APP/scripts/emqx" "$W/opt/emqx-templates"
  [ -f "$CONF" ] && cp "$CONF" "$W/opt/emqx/etc/emqx.conf"
  (
    export DIGILOG_CFG="$W/cfg" DIGILOG_OPT="$W/opt" DIGILOG_DATA="$W/data"
    # shellcheck disable=SC1091
    . "$APP/scripts/linux/digilog-lib.sh"
    chown() { :; }; install() { :; }
    digilog_ensure_device_ca
    digilog_provision_emqx
  ) >/dev/null
  echo "=== device CA"
  if [ -s "$CERT_DIR/device-ca.pem" ]; then echo "exists: $CERT_DIR/device-ca.pem (reused)"
  else echo "would be CREATED: $CERT_DIR/device-ca.pem + device-ca.key"
       openssl x509 -in "$W/cfg/certs/device-ca.pem" -noout -subject -dates -ext basicConstraints,keyUsage; fi
  echo "=== env lines that would be ADDED (values of secrets hidden)"
  diff <(grep -oE '^[A-Z_]+=' "$ENV_FILE" | sort) <(grep -oE '^[A-Z_]+=' "$W/cfg/digilog.env" | sort) | sed -n 's/^> /+ /p' || true
  # The throwaway copy rendered its own paths; map them back so the diff shows
  # only what --apply would really change.
  for f in emqx.conf acl.conf; do
    [ -f "$W/opt/emqx/etc/$f" ] || continue
    sed -e "s|$W/cfg|$CFG|g" -e "s|$W/opt|$OPT|g" -e "s|$W/data|$DATA|g" "$W/opt/emqx/etc/$f" > "$W/rendered-$f"
    echo "=== $f: current → rendered"
    if [ -f "$EMQX_HOME/etc/$f" ]; then
      diff -u "$EMQX_HOME/etc/$f" "$W/rendered-$f" | sed -E 's/(cookie|password|secret)( *= *).*/\1\2<hidden>/I' || true
    else
      echo "(no current $f — it would be created)"
    fi
  done
  echo "=== rendered SSL listener"
  ssl_block "$W/rendered-emqx.conf"
  echo "=== clients on the SSL listener (8883) right now"
  if [ -x "$EMQX_HOME/bin/emqx" ]; then
    "$EMQX_HOME/bin/emqx" ctl listeners 2>/dev/null | grep -A5 '^ssl:default' | grep -E 'current_conn' || echo "(could not read)"
  else
    echo "(no emqx binary at $EMQX_HOME/bin/emqx)"
  fi
  echo "DRY RUN — nothing changed. Re-run with --apply."
  exit 0
fi

B="${WORK_ROOT:-/root}/device-certs-backup-$STAMP"; ( umask 077; mkdir "$B" )
cp -p "$ENV_FILE" "$B/digilog.env"
cp -p "$CONF" "$B/emqx.conf"
[ -f "$ACL" ] && cp -p "$ACL" "$B/acl.conf"
[ -f "$KEYF" ] && cp -p "$KEYF" "$B/api_key.bootstrap"
echo "backup: $B"

restore_files() {
  cp -p "$B/digilog.env" "$ENV_FILE"
  cp -p "$B/emqx.conf" "$CONF"
  if [ -f "$B/acl.conf" ]; then cp -p "$B/acl.conf" "$ACL"; fi
  if [ -f "$B/api_key.bootstrap" ]; then cp -p "$B/api_key.bootstrap" "$KEYF"; else rm -f "$KEYF"; fi
}

# From here ANY non-zero exit restores the backups: a failed check below, and
# equally the lib's own `die` (an `exit`, which no ERR trap sees) half-way
# through a render that has already appended env lines.
ROLLBACK_ARMED=1
RESTARTED=0
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$ROLLBACK_ARMED" = 1 ]; then
    ROLLBACK_ARMED=0
    echo "ROLLING BACK (exit $rc): restoring $B" >&2
    restore_files
    if [ "$RESTARTED" = 1 ]; then systemctl restart digilog-api digilog-emqx || true; fi
    echo "previous configuration restored (the device CA files stay; unused without the env lines)" >&2
  fi
}
trap on_exit EXIT
fail() { echo "FAILED: $1" >&2; exit 1; }

digilog_ensure_device_ca
digilog_provision_emqx
ssl_block "$CONF" | grep -q 'verify = verify_peer' || fail "rendered SSL listener does not verify peers"

health() { curl -s --cacert "$CERT_DIR/rootCA.pem" -o /dev/null -w '%{http_code}' https://127.0.0.1/api/health || true; }

RESTARTED=1
systemctl restart digilog-api
code=""; for _ in $(seq 1 45); do code="$(health)"; [ "$code" = 200 ] && break; sleep 2; done
[ "$code" = 200 ] || fail "API health $code after restart"
echo "API health 200 over TLS with NO client certificate"

systemctl restart digilog-emqx
up=0; for _ in $(seq 1 45); do
  if "$EMQX_HOME/bin/emqx" ctl listeners 2>/dev/null | grep -A4 '^ssl:default' | grep -q 'running *: *true'; then up=1; break; fi
  sleep 2
done
[ "$up" -eq 1 ] || fail "EMQX ssl listener not running"

# MQTTS handshake with NO client certificate must still complete. The output is
# captured first: `openssl … | grep -q` under pipefail can fail on SIGPIPE when
# grep exits at its first match while openssl is still writing.
tls_out="$(openssl s_client -connect 127.0.0.1:8883 -CAfile "$CERT_DIR/rootCA.pem" </dev/null 2>/dev/null || true)"
case "$tls_out" in
  *"Verify return code: 0 (ok)"*) echo "MQTTS handshake OK with NO client certificate" ;;
  *) fail "MQTTS handshake without a client certificate failed" ;;
esac

# The ingest bridge authenticates through the hook: connected = hook healthy.
bridge="$(env_get MQTT_CLIENT_ID)"; bridge="${bridge:-digilog-ingest-bridge}"
ok_bridge=0; for _ in $(seq 1 30); do
  clients="$("$EMQX_HOME/bin/emqx" ctl clients show "$bridge" 2>/dev/null || true)"
  case "$clients" in *connected=true*) ok_bridge=1; break ;; esac
  sleep 2
done
[ "$ok_bridge" -eq 1 ] || fail "ingest bridge did not reconnect through the auth hook"
echo "ingest bridge reconnected through the auth hook"

# The REST API key the API kicks sessions with. Without it every kick in this
# feature is a silent no-op, and an issue / revoke / profile switch takes
# effect on MQTT only at the device's next reconnect.
api_url="$(env_get EMQX_API_URL)"; api_url="${api_url:-http://127.0.0.1:$DASHBOARD_PORT}"
api_key="$(env_get EMQX_API_KEY)"; api_secret="$(env_get EMQX_API_SECRET)"
api_code=""; for _ in $(seq 1 15); do
  api_code="$(curl -s -o /dev/null -w '%{http_code}' -u "$api_key:$api_secret" "$api_url/api/v5/clients?limit=1" || true)"
  [ "$api_code" = 200 ] && break; sleep 2
done
[ "$api_code" = 200 ] || fail "the EMQX REST API key is not accepted ($api_code) — session kicks would silently do nothing"
echo "EMQX REST API key accepted"

ROLLBACK_ARMED=0
echo "DONE. Device certificates available; no profile requires one yet."
echo "Rollback if ever needed: cp -p $B/digilog.env $ENV_FILE && cp -p $B/emqx.conf $CONF && cp -p $B/acl.conf $ACL && systemctl restart digilog-api digilog-emqx"
