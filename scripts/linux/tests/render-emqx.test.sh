#!/usr/bin/env bash
# Device certificates (2026-10-27): the device CA and the EMQX render, through
# the REAL digilog-lib.sh functions, against a throwaway layout.
#
#   bash scripts/linux/tests/render-emqx.test.sh      → exit 0 = pass
#
# Checks, in the rendered emqx.conf's SSL listener only (the hook's own
# `verify = verify_peer` sits elsewhere in the file):
#   * device CA present → verify = verify_peer, cacertfile = device-ca.pem
#   * device CA absent  → verify = verify_none (exactly the old behaviour)
#   * the hook body forwards cert_subject; the hook URL carries the API port
#   * no @@TOKEN@@ left
# and that digilog_ensure_device_ca makes a CA once, reuses it, refuses a half
# one, and writes the env lines.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# Git Bash on Windows rewrites a leading "/CN=" into a path; Linux ignores this.
export MSYS2_ARG_CONV_EXCL='/CN='
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

layout() { # <name> -> prints the layout dir
  local d="$T/$1"
  mkdir -p "$d/opt/emqx/etc" "$d/cfg/certs" "$d/data"
  cp -r "$ROOT/scripts/emqx" "$d/opt/emqx-templates"
  touch "$d/cfg/certs/server.crt" "$d/cfg/certs/server.key" "$d/cfg/certs/rootCA.pem"
  : > "$d/cfg/digilog.env"
  echo "$d"
}

run_lib() { # <layout> <function>
  ( chown() { :; }; install() { :; }
    export DIGILOG_OPT="$1/opt" DIGILOG_CFG="$1/cfg" DIGILOG_DATA="$1/data" DIGILOG_API_PORT=443
    # shellcheck source=../digilog-lib.sh
    . "$ROOT/scripts/linux/digilog-lib.sh"
    "$2" ) >/dev/null
}

ssl_block() { sed -n '/^listeners.ssl.default {/,/^}/p' "$1"; }

# --- device CA ---------------------------------------------------------------
D="$(layout ca)"
run_lib "$D" digilog_ensure_device_ca
CA="$D/cfg/certs/device-ca.pem"
[ -s "$CA" ] && [ -s "$D/cfg/certs/device-ca.key" ] || fail "device CA not created"
openssl x509 -in "$CA" -noout -subject | grep -q 'CN *= *DigiLog Device CA' || fail "device CA subject"
openssl x509 -in "$CA" -noout -ext basicConstraints | grep -q 'CA:TRUE' || fail "device CA is not a CA"
openssl x509 -in "$CA" -noout -ext keyUsage | grep -q 'Certificate Sign' || fail "device CA keyUsage"
FP1="$(openssl x509 -in "$CA" -noout -fingerprint -sha256)"
run_lib "$D" digilog_ensure_device_ca
[ "$FP1" = "$(openssl x509 -in "$CA" -noout -fingerprint -sha256)" ] || fail "device CA was replaced on a second run"
grep -q "^DEVICE_CA_CERT_PATH=$D/cfg/certs/device-ca.pem$" "$D/cfg/digilog.env" || fail "DEVICE_CA_CERT_PATH not written"
grep -q "^DEVICE_CA_KEY_PATH=$D/cfg/certs/device-ca.key$" "$D/cfg/digilog.env" || fail "DEVICE_CA_KEY_PATH not written"
grep -q "^TLS_CA_PATH=$D/cfg/certs/rootCA.pem$" "$D/cfg/digilog.env" || fail "TLS_CA_PATH not written"
[ "$(grep -c '^DEVICE_CA_CERT_PATH=' "$D/cfg/digilog.env")" = 1 ] || fail "env line duplicated on a second run"
H="$(layout half)"
touch "$H/cfg/certs/device-ca.key"
if run_lib "$H" digilog_ensure_device_ca 2>/dev/null; then fail "half a device CA was not refused"; fi

# --- EMQX render, device CA present --------------------------------------------
W="$(layout with)"
echo "DEVICE-CA" > "$W/cfg/certs/device-ca.pem"   # non-empty: the lib tests -s
run_lib "$W" digilog_provision_emqx
C="$W/opt/emqx/etc/emqx.conf"
! grep -qE '@@[A-Z_]+@@' "$C" || fail "unrendered token (with)"
ssl_block "$C" | grep -q 'verify = verify_peer' || fail "SSL listener does not verify peers when the device CA exists"
ssl_block "$C" | grep -q "cacertfile = \"$W/cfg/certs/device-ca.pem\"" || fail "SSL listener cacertfile is not the device CA"
ssl_block "$C" | grep -q 'fail_if_no_peer_cert = false' || fail "devices without a certificate must still connect"
grep -q 'cert_subject = "${cert_subject}"' "$C" || fail "hook body does not forward cert_subject"
grep -q 'url = "https://127.0.0.1:443/api/ingest/v1/mqtt-auth"' "$C" || fail "hook URL does not carry the API port"

# --- EMQX render, no device CA: exactly the old listener -------------------------
O="$(layout without)"
run_lib "$O" digilog_provision_emqx
C="$O/opt/emqx/etc/emqx.conf"
! grep -qE '@@[A-Z_]+@@' "$C" || fail "unrendered token (without)"
ssl_block "$C" | grep -q 'verify = verify_none' || fail "SSL listener verifies peers without a device CA"
ssl_block "$C" | grep -q "cacertfile = \"$O/cfg/certs/rootCA.pem\"" || fail "SSL listener cacertfile without a device CA"

echo "PASS: render-emqx (device CA create/reuse/refuse, env lines, SSL listener with and without, hook body)"
