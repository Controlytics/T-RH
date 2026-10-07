#!/usr/bin/env bash
# scripts/aws/provision-ubuntu.sh — ONE-TIME provisioning of the AWS Ubuntu
# instance (2026-09-18; replaced the Windows Server 2025 instance). Runs as root
# ON the instance, sent from the laptop over SSM (AWS-RunShellScript). Idempotent:
# every step checks before it acts, so a failed run is fixed by re-running.
#
# Layout mirrors the .deb installer (docs/deployment-methods/method-c-ubuntu-deb.md)
# so the two runbooks agree, except that the PROGRAM is a git clone that
# scripts/aws/deploy-on-ubuntu.sh rebuilds in place, and the DATABASE is RDS:
#   /opt/digilog/app            git clone, built in place (the Windows C:\app\compliance-core)
#   /opt/digilog/node           portable Node (official linux-x64 tarball)
#   /opt/digilog/emqx           EMQX 5.3.2 (same version the installers bundle)
#   /opt/digilog/emqx-templates -> /opt/digilog/app/scripts/emqx (ONE template set)
#   /etc/digilog/digilog.env    secrets + settings; TLS certs under /etc/digilog/certs
#   /var/lib/digilog/{uploads,emqx}   the only places the app writes
#
# Two phases, because the repo is private and the deploy key must be registered
# on GitHub by a person between them:
#   keygen   packages + a fresh ed25519 deploy key; prints the PUBLIC half.
#   install  clone, node, emqx, certs, env (from SSM Parameter Store), deps,
#            build, systemd units. Starts the BROKER; leaves the API STOPPED —
#            the database is still the Windows box's until the cutover.
#
# Inputs (env): BRANCH (data-layer), PUBLIC_IP (goes into the cert SAN),
# ENV_PARAM (the SecureString holding digilog.env), AWS_REGION.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PHASE="${1:-}"
REPO_SSH="${REPO_SSH:-git@github.com:Controlytics/T-RH.git}"   # Controlytics/T-RH since 2026-10-06; the live server was cloned from sivamunnangi1211/TRH_GGP and needs `git remote set-url` + a deploy key on the new repo
BRANCH="${BRANCH:-data-layer}"
PUBLIC_IP="${PUBLIC_IP:-13.204.15.17}"
ENV_PARAM="${ENV_PARAM:-/compliance-core/ubuntu/digilog.env}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
NODE_VERSION="${NODE_VERSION:-24.20.0}"
EMQX_VERSION="${EMQX_VERSION:-5.3.2}"
EMQX_DISTRO="${EMQX_DISTRO:-ubuntu22.04}"

OPT=/opt/digilog
APP=$OPT/app
CFG=/etc/digilog
KEY=/root/.ssh/id_ed25519
export GIT_SSH_COMMAND="ssh -i $KEY -o StrictHostKeyChecking=accept-new"

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    OK   %s\n' "$*"; }
die()  { printf '\nFATAL: %s\n' "$*" >&2; exit 1; }

phase_keygen() {
  log "Packages"
  apt-get update -qq
  apt-get install -y -qq git curl xz-utils openssl ca-certificates build-essential python3 unzip >/dev/null
  ok "git curl xz openssl build-essential python3"
  # Ubuntu 24.04 ships no `awscli` apt package; the official v2 bundle is the
  # supported route. Needed only to read the env file from Parameter Store.
  if ! command -v aws >/dev/null 2>&1; then
    tmp=$(mktemp -d)
    curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o "$tmp/awscli.zip"
    unzip -q "$tmp/awscli.zip" -d "$tmp"
    "$tmp/aws/install" --update >/dev/null
    rm -rf "$tmp"
  fi
  ok "$(aws --version 2>&1 | cut -d' ' -f1)"

  log "Deploy key"
  install -d -m 0700 /root/.ssh
  if [ ! -f "$KEY" ]; then
    ssh-keygen -t ed25519 -N '' -C "cc-ec2-ubuntu-$(date +%Y%m%d)" -f "$KEY" -q
    ok "generated $KEY"
  else
    ok "reusing $KEY"
  fi
  ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
  sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts
  printf '\nDEPLOY_KEY_PUBLIC: %s\n' "$(cat "$KEY.pub")"
  printf 'Add it at GitHub -> repo -> Settings -> Deploy keys (read-only), then run: %s install\n' "$0"
}

phase_install() {
  [ -f "$KEY" ] || die "no deploy key at $KEY — run the keygen phase first"

  log "Clone $BRANCH"
  if [ ! -d "$APP/.git" ]; then
    install -d -m 0755 "$OPT"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_SSH" "$APP" || die "git clone failed — is the deploy key registered on GitHub?"
    ok "cloned $(git -C "$APP" rev-parse --short HEAD)"
  else
    git -C "$APP" fetch --quiet --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" || die "git fetch failed"
    git -C "$APP" reset --quiet --hard "origin/$BRANCH"
    ok "at $(git -C "$APP" rev-parse --short HEAD)"
  fi

  log "Node $NODE_VERSION"
  if [ ! -x "$OPT/node/bin/node" ] || [ "$("$OPT/node/bin/node" -v)" != "v$NODE_VERSION" ]; then
    tmp=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$tmp"
    rm -rf "$OPT/node"; mv "$tmp/node-v$NODE_VERSION-linux-x64" "$OPT/node"; rmdir "$tmp"
  fi
  for b in node npm npx; do ln -sfn "$OPT/node/bin/$b" "/usr/local/bin/$b"; done
  export PATH="$OPT/node/bin:$PATH"
  ok "$(node -v) npm $(npm -v)"

  log "EMQX $EMQX_VERSION ($EMQX_DISTRO)"
  if [ ! -x "$OPT/emqx/bin/emqx" ]; then
    install -d "$OPT/emqx"
    curl -fsSL "https://www.emqx.com/en/downloads/broker/$EMQX_VERSION/emqx-$EMQX_VERSION-$EMQX_DISTRO-amd64.tar.gz" | tar -xz -C "$OPT/emqx"
  fi
  ln -sfn "$APP/scripts/emqx" "$OPT/emqx-templates"
  ok "$OPT/emqx (templates -> $APP/scripts/emqx)"

  log "User, directories, certificates"
  export DIGILOG_API_PORT=443 DIGILOG_EXTRA_SAN_IP="$PUBLIC_IP"
  # shellcheck disable=SC1091
  . "$APP/scripts/linux/digilog-lib.sh"
  digilog_ensure_user_dirs
  digilog_ensure_certs
  ok "digilog user; certs in $CFG/certs (SAN includes $PUBLIC_IP)"

  log "Environment file"
  if [ ! -f "$CFG/digilog.env" ]; then
    umask 027
    aws ssm get-parameter --region "$AWS_REGION" --name "$ENV_PARAM" --with-decryption \
      --query Parameter.Value --output text > "$CFG/digilog.env" || die "could not read $ENV_PARAM from SSM Parameter Store"
    chown root:digilog "$CFG/digilog.env"; chmod 0640 "$CFG/digilog.env"
    ok "written from $ENV_PARAM"
  else
    ok "reusing $CFG/digilog.env"
  fi
  grep -q '^AUDIT_CHAIN_KEY=' "$CFG/digilog.env" || die "digilog.env has no AUDIT_CHAIN_KEY — refusing to continue"
  # 32-byte key for encrypting instrument tokens at rest (none exist on RDS yet).
  env_ensure INSTRUMENT_TOKEN_KEY "$(openssl rand -hex 32)" >/dev/null
  digilog_provision_emqx
  ok "broker config rendered; MQTT_* keys present"

  log "Dependencies"
  cd "$APP"
  npm ci --no-audit --no-fund --loglevel=error
  (cd apps/api && npx prisma generate >/dev/null)
  (cd apps/api && node -e "require('bcrypt')") || die "bcrypt native module did not load"
  ok "npm ci + prisma client + bcrypt"

  log "Build"
  npm run build -w @digilog/shared >/dev/null && ok "shared"
  npm run build -w @digilog/queue  >/dev/null && ok "queue"
  (cd apps/web && npx vite build >/dev/null) && [ -f apps/web/dist/index.html ] && ok "web"
  npx tsc -p apps/api/tsconfig.json && [ -f apps/api/dist/app.js ] && ok "api"
  # tsc writes dist/ as 750/640 under root, and the service user cannot read it:
  # Node then reports "Cannot find module .../dist/app.js" (the 2026-09-18 cutover
  # failure). Readable-by-all is correct here: the tree holds no secret.
  chmod -R a+rX "$APP" "$OPT/node"
  ok "readable by the digilog user"

  log "Services"
  install -m 0644 "$APP/scripts/linux/systemd/digilog-emqx.service" /etc/systemd/system/digilog-emqx.service
  install -m 0644 "$APP/scripts/aws/digilog-api.service"            /etc/systemd/system/digilog-api.service
  systemctl daemon-reload
  systemctl enable --now digilog-emqx.service >/dev/null 2>&1
  systemctl enable digilog-api.service >/dev/null 2>&1
  digilog_emqx_postboot
  ok "digilog-emqx $(systemctl is-active digilog-emqx.service); digilog-api enabled, NOT started (cutover starts it)"

  printf '\nPROVISIONED %s at %s\n' "$BRANCH" "$(git -C "$APP" rev-parse --short HEAD)"
}

case "$PHASE" in
  keygen)  phase_keygen ;;
  install) phase_install ;;
  *) die "usage: $0 keygen|install" ;;
esac
