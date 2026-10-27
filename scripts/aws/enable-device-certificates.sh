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
# --apply:
#   1. backs up digilog.env, emqx.conf and api_key.bootstrap;
#   2. creates the device CA in /etc/digilog/certs if absent (never replaces one)
#      and adds DEVICE_CA_CERT_PATH / DEVICE_CA_KEY_PATH / TLS_CA_PATH;
#   3. re-renders the EMQX config from the repo template — SSL listener verifies
#      client certificates against the device CA (never requires one), the auth
#      hook receives cert_subject — and provisions the EMQX REST API key the
#      API uses to drop a session (owed since 2026-10-12);
#   4. restarts digilog-api, then digilog-emqx;
#   5. proves nothing broke for clients WITHOUT a certificate: /api/health 200
#      over TLS with no client certificate, MQTTS handshake with none, the
#      ingest bridge reconnected through the auth hook.
#   Any failed check restores the backups and restarts both services.
#
# No profile requires a certificate yet after this; that is switched in the app
# (Configuration → Instrument Attributes → profile → Require device certificate).
set -euo pipefail

APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
APP="${APP:-/opt/digilog/app}"
# The API listens on 443 on this box: the lib renders the hook URL from it.
export DIGILOG_API_PORT=443
# shellcheck disable=SC1091
. "$APP/scripts/linux/digilog-lib.sh"
EMQX_HOME="$OPT/emqx"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

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
  [ -f "$EMQX_HOME/etc/emqx.conf" ] && cp "$EMQX_HOME/etc/emqx.conf" "$W/opt/emqx/etc/emqx.conf"
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
  sed -e "s|$W/cfg|$CFG|g" -e "s|$W/opt|$OPT|g" -e "s|$W/data|$DATA|g" "$W/opt/emqx/etc/emqx.conf" > "$W/rendered.conf"
  echo "=== emqx.conf: current → rendered"
  diff -u "$EMQX_HOME/etc/emqx.conf" "$W/rendered.conf" | sed -E 's/(cookie|password|secret)( *= *).*/\1\2<hidden>/I' || true
  echo "=== rendered SSL listener"
  ssl_block "$W/rendered.conf"
  echo "DRY RUN — nothing changed. Re-run with --apply."
  exit 0
fi

B="${WORK_ROOT:-/root}/device-certs-backup-$STAMP"; mkdir -m 700 "$B"
cp -p "$ENV_FILE" "$B/digilog.env"
cp -p "$EMQX_HOME/etc/emqx.conf" "$B/emqx.conf"
[ -f "$EMQX_HOME/etc/api_key.bootstrap" ] && cp -p "$EMQX_HOME/etc/api_key.bootstrap" "$B/api_key.bootstrap"
echo "backup: $B"

rollback() {
  echo "ROLLING BACK: $1" >&2
  cp -p "$B/digilog.env" "$ENV_FILE"
  cp -p "$B/emqx.conf" "$EMQX_HOME/etc/emqx.conf"
  if [ -f "$B/api_key.bootstrap" ]; then cp -p "$B/api_key.bootstrap" "$EMQX_HOME/etc/api_key.bootstrap"
  else rm -f "$EMQX_HOME/etc/api_key.bootstrap"; fi
  systemctl restart digilog-api digilog-emqx
  die "$1 — previous configuration restored (the device CA files stay; unused without the env lines)"
}

digilog_ensure_device_ca
digilog_provision_emqx
ssl_block "$EMQX_HOME/etc/emqx.conf" | grep -q 'verify = verify_peer' || rollback "rendered SSL listener does not verify peers"

health() { curl -s --cacert "$CERT_DIR/rootCA.pem" -o /dev/null -w '%{http_code}' https://127.0.0.1/api/health || true; }

systemctl restart digilog-api
code=""; for _ in $(seq 1 45); do code="$(health)"; [ "$code" = 200 ] && break; sleep 2; done
[ "$code" = 200 ] || rollback "API health $code after restart"
echo "API health 200 over TLS with NO client certificate"

systemctl restart digilog-emqx
up=0; for _ in $(seq 1 45); do
  if "$EMQX_HOME/bin/emqx" ctl listeners 2>/dev/null | grep -A4 '^ssl:default' | grep -q 'running *: *true'; then up=1; break; fi
  sleep 2
done
[ "$up" -eq 1 ] || rollback "EMQX ssl listener not running"

# MQTTS handshake with NO client certificate must still complete.
openssl s_client -connect 127.0.0.1:8883 -CAfile "$CERT_DIR/rootCA.pem" </dev/null 2>/dev/null \
  | grep -q 'Verify return code: 0 (ok)' || rollback "MQTTS handshake without a client certificate failed"
echo "MQTTS handshake OK with NO client certificate"

# The ingest bridge authenticates through the hook: connected = hook healthy.
bridge="$(env_get MQTT_CLIENT_ID)"; bridge="${bridge:-digilog-ingest-bridge}"
ok_bridge=0; for _ in $(seq 1 30); do
  if "$EMQX_HOME/bin/emqx" ctl clients show "$bridge" 2>/dev/null | grep -q 'connected=true'; then ok_bridge=1; break; fi
  sleep 2
done
[ "$ok_bridge" -eq 1 ] || rollback "ingest bridge did not reconnect through the auth hook"
echo "ingest bridge reconnected through the auth hook"

echo "DONE. Device certificates available; no profile requires one yet."
echo "Rollback if ever needed: cp -p $B/digilog.env $ENV_FILE && cp -p $B/emqx.conf $EMQX_HOME/etc/emqx.conf && systemctl restart digilog-api digilog-emqx"
