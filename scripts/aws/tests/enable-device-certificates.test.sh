#!/usr/bin/env bash
# scripts/aws/enable-device-certificates.sh --apply, against a throwaway box
# layout with systemctl / curl / sleep / chown / install / emqx stubbed and
# openssl's s_client faked (everything else is the real openssl):
#
#   bash scripts/aws/tests/enable-device-certificates.test.sh   → exit 0 = pass
#
#   A. success: env lines added, SSL listener verifies peers, acl.conf backed up;
#   B. the lib DIES mid-render (after env lines were appended): every file is
#      restored, nothing was restarted;
#   C. the EMQX API key is refused AFTER the restarts: every file is restored
#      and both services restarted again.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export MSYS2_ARG_CONV_EXCL='/CN='
REAL_OPENSSL="$(command -v openssl)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$T/bin"
cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
EOF
cat > "$T/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$T/bin/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$T/bin/install" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-d" ]; then for last in "$@"; do :; done; mkdir -p "$last"; fi
exit 0
EOF
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  */api/v5/*) if [ "${STUB_API_KEY_REFUSED:-0}" = 1 ]; then printf 401; else printf 200; fi ;;
  *) printf 200 ;;
esac
EOF
cat > "$T/bin/openssl" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "s_client" ]; then echo "Verify return code: 0 (ok)"; exit 0; fi
exec "$REAL_OPENSSL" "\$@"
EOF
chmod +x "$T/bin/"*

layout() { # <name> [bogus-token] -> prints the layout dir
  local d="$T/$1"
  mkdir -p "$d/app/apps/api/dist/modules/instruments" "$d/opt/emqx/etc" "$d/opt/emqx/bin" "$d/cfg/certs" "$d/work" "$d/data"
  cp -r "$ROOT/scripts" "$d/app/scripts"
  if [ "${2:-}" = bogus ]; then echo '## @@BOGUS_TOKEN@@' >> "$d/app/scripts/emqx/emqx.conf.template"; fi
  ln -s "$d/app/scripts/emqx" "$d/opt/emqx-templates" 2>/dev/null || cp -r "$d/app/scripts/emqx" "$d/opt/emqx-templates"
  touch "$d/app/apps/api/dist/modules/instruments/device-ca.js"
  for f in server.crt server.key rootCA.pem; do echo x > "$d/cfg/certs/$f"; done
  printf 'MQTT_BROKER_URL=mqtt://127.0.0.1:1883\nMQTT_CLIENT_ID=digilog-ingest-bridge\nMQTT_USERNAME=digilog-bridge\nMQTT_PASSWORD=pw\nEMQX_NODE_COOKIE=c1\nEMQX_DASHBOARD_PASSWORD=d\nEMQX_API_KEY=k\nEMQX_API_SECRET=s\nEMQX_API_URL=http://127.0.0.1:18083\n' > "$d/cfg/digilog.env"
  echo "## the CURRENT emqx.conf" > "$d/opt/emqx/etc/emqx.conf"
  echo "## HAND EDIT on the box" > "$d/opt/emqx/etc/acl.conf"
  cat > "$d/opt/emqx/bin/emqx" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "ctl listeners") printf 'ssl:default\n  listen_on : 0.0.0.0:8883\n  running : true\n' ;;
  "ctl clients show"*) echo "Client(digilog-ingest-bridge, connected=true)" ;;
esac
EOF
  chmod +x "$d/opt/emqx/bin/emqx"
  md5sum "$d/cfg/digilog.env" "$d/opt/emqx/etc/emqx.conf" "$d/opt/emqx/etc/acl.conf" > "$d/before.md5"
  echo "$d"
}

run_apply() { # <layout> -> exit code
  local d="$1"; shift
  set +e
  ( export PATH="$T/bin:$PATH" STUB_LOG="$d/systemctl.log" APP="$d/app" DIGILOG_CFG="$d/cfg" \
      DIGILOG_OPT="$d/opt" DIGILOG_DATA="$d/data" WORK_ROOT="$d/work" "$@"
    bash "$ROOT/scripts/aws/enable-device-certificates.sh" --apply ) > "$d/out.log" 2>&1
  local rc=$?
  set -e
  return $rc
}

# --- A. success ---------------------------------------------------------------
A="$(layout ok)"
run_apply "$A" || { cat "$A/out.log" >&2; fail "A: --apply failed"; }
grep -q '^DEVICE_CA_CERT_PATH=' "$A/cfg/digilog.env" || fail "A: env line not added"
sed -n '/^listeners.ssl.default {/,/^}/p' "$A/opt/emqx/etc/emqx.conf" | grep -q 'verify = verify_peer' || fail "A: listener does not verify peers"
grep -q 'HAND EDIT' "$A"/work/device-certs-backup-*/acl.conf || fail "A: acl.conf was not backed up"
grep -q 'systemctl restart digilog-api' "$A/systemctl.log" || fail "A: API not restarted"

# --- B. the lib dies mid-render ------------------------------------------------
Bd="$(layout dies bogus)"
if run_apply "$Bd"; then fail "B: --apply succeeded with an unrenderable template"; fi
md5sum -c --quiet "$Bd/before.md5" || { cat "$Bd/out.log" >&2; fail "B: files not restored"; }
grep -q 'ROLLING BACK' "$Bd/out.log" || fail "B: no rollback message"
[ ! -s "$Bd/systemctl.log" ] || fail "B: services were restarted although nothing had been"

# --- C. EMQX REST API key refused after the restarts ---------------------------
C="$(layout keyrefused)"
if run_apply "$C" STUB_API_KEY_REFUSED=1; then fail "C: --apply succeeded with a refused API key"; fi
md5sum -c --quiet "$C/before.md5" || { cat "$C/out.log" >&2; fail "C: files not restored"; }
grep -q 'API key is not accepted' "$C/out.log" || fail "C: wrong failure"
[ "$(grep -c 'systemctl restart digilog-api digilog-emqx' "$C/systemctl.log")" = 1 ] || fail "C: services not restarted on rollback"

echo "PASS: enable-device-certificates (success; lib death mid-render restores; refused API key restores + restarts)"
