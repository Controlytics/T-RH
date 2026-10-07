#!/usr/bin/env bash
# scripts/aws/deploy-on-ubuntu.sh — one-command deploy for the AWS Ubuntu
# instance. Pull, build, migrate, restart, verify. The Linux port of the retired
# scripts/deploy-on-instance.ps1 (Windows instance, terminated 2026-09-18).
#
# Runs ON the server as root (/opt/digilog/app). Invoked from a laptop by
# deploy-to-aws.bat over SSM (AWS-RunShellScript):
#     /opt/digilog/app/scripts/aws/deploy-on-ubuntu.sh --branch data-layer
#
# Why this exists: `git pull` updates SOURCE, but the service runs COMPILED
# output (apps/api/dist, apps/web/dist). Skipping a build step silently serves
# stale code with nothing in the logs to explain it. Every step reports, and any
# failure stops the deploy BEFORE the service is restarted, so a broken build
# leaves the previous working version running.
#
#   --branch <name>   REQUIRED. No default: the Windows script once defaulted to
#                     a branch that had become a frozen backup, and a bare
#                     double-click deployed month-old code and printed "Done."
#   --force           rebuild even when already up to date
#   --skip-install    skip npm ci even if the lockfile changed
set -uo pipefail

APP=/opt/digilog/app
SERVICE=digilog-api.service
ENV_FILE=/etc/digilog/digilog.env
export PATH="/opt/digilog/node/bin:$PATH"
# The repo moved to Controlytics/T-RH on 2026-10-06. GitHub refuses one deploy
# key on two repos, and id_ed25519 is still registered on the old one, so the
# live box carries a second key for the new repo. IdentitiesOnly: ssh must not
# offer the old key first — GitHub would accept it and then refuse the repo.
# A freshly provisioned box has only id_ed25519, registered on T-RH directly.
DEPLOY_KEY=/root/.ssh/id_ed25519
[ -f /root/.ssh/id_ed25519_trh ] && DEPLOY_KEY=/root/.ssh/id_ed25519_trh
export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

BRANCH=""; FORCE=0; SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$BRANCH" ] || { echo "FATAL: --branch <name> is required" >&2; exit 2; }

# Load KEY=VALUE lines the way systemd's EnvironmentFile= does: one line, one
# variable, no shell parsing. `. file` would treat the `&` in the RDS URL as a
# background operator and leave DATABASE_URL unset.
load_env() {
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in ''|'#'*) continue ;; esac
    export "$line"
  done < "$1"
}

step=0
Step() { step=$((step+1)); printf '\n[%d] %s\n' "$step" "$*"; }
Ok()   { printf '    OK   %s\n' "$*"; }
Info() { printf '    ..   %s\n' "$*"; }
service_stopped=0
Die() {
  printf '\n  DEPLOY FAILED: %s\n' "$*" >&2
  if [ "$service_stopped" = 1 ]; then
    # The old build is still on disk and still works. Do not leave the app down.
    printf '  Restarting the service on the PREVIOUS build...\n' >&2
    systemctl start "$SERVICE" && printf '  Service restarted.\n' >&2 || printf '  COULD NOT RESTART - the app is DOWN. Start it manually: systemctl start %s\n' "$SERVICE" >&2
  else
    printf '  The service was NOT restarted - the previous version is still running.\n' >&2
  fi
  exit 1
}

printf '\n  =============================================\n   compliance-core deploy   branch: %s\n  =============================================\n' "$BRANCH"
cd "$APP" || Die "$APP missing"

# ---------------------------------------------------------------- 1. pull
Step "Fetching $BRANCH"
before=$(git rev-parse HEAD)
# Explicit refspec: `git fetch --depth 1 origin <branch>` writes FETCH_HEAD but
# does NOT create origin/<branch>, so the reset below died on the first deploy
# of any NEW branch (the 2026-08-01 fix, carried over).
git fetch --quiet --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" || Die "git fetch failed. Is the deploy key still registered on GitHub?"
git reset --quiet --hard "origin/$BRANCH" || Die "git reset failed."
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ] && [ "$FORCE" = 0 ]; then
  Ok "Already up to date at ${after:0:7} - nothing to deploy. Use --force to rebuild anyway."
  exit 0
fi
Ok "${before:0:7} -> ${after:0:7}"
Info "$(git log -1 --format=%s)"

# ---------------------------------------------------------------- 2. deps
Step "Dependencies"
lock_changed=0
if [ "$FORCE" = 1 ] || git diff --name-only "$before" "$after" 2>/dev/null | grep -q 'package-lock\.json'; then lock_changed=1; fi
if [ "$SKIP_INSTALL" = 1 ]; then
  Info "skipped (--skip-install)"
elif [ "$lock_changed" = 1 ]; then
  # npm ci replaces node_modules under the running process; stop it first so a
  # request cannot land on a half-installed tree. Die() restarts it on failure.
  Info "package-lock.json changed - stopping $SERVICE"
  systemctl stop "$SERVICE"; service_stopped=1
  Info "running npm ci (a few minutes)..."
  npm ci --no-audit --no-fund --loglevel=error || Die "npm ci failed."
  (cd apps/api && npx prisma generate >/dev/null) || Die "prisma generate failed."
  (cd apps/api && node -e "require('bcrypt')") || Die "bcrypt native module did not load after npm ci."
  Ok "dependencies + prisma client"
else
  Ok "lockfile unchanged - skipping npm ci"
fi
# The Prisma client is generated from schema.prisma, not from the lockfile. A
# schema change with no dependency change (2026-09-29: the 09-22 and 09-25
# migrations) otherwise leaves a stale client, and the API fails to compile
# against the fields the migration just added.
if [ "$lock_changed" = 0 ] || [ "$SKIP_INSTALL" = 1 ]; then
  if [ "$FORCE" = 1 ] || git diff --name-only "$before" "$after" 2>/dev/null | grep -q '^apps/api/prisma/schema\.prisma$'; then
    (cd apps/api && npx prisma generate >/dev/null) || Die "prisma generate failed."
    Ok "prisma client regenerated (schema changed)"
  fi
fi

# ---------------------------------------------------------------- 3. migrations
Step "Database migrations"
load_env "$ENV_FILE"
export DOTENV_CONFIG_PATH="$ENV_FILE"
(cd apps/api && npx prisma migrate deploy 2>&1 | tail -n 3) || true
(cd apps/api && npx prisma migrate status >/dev/null 2>&1) || Die "prisma migrate deploy left pending or failed migrations. Service NOT restarted."
Ok "schema up to date"

# ---------------------------------------------------------------- 4. build
Step "Building"
npm run build -w @digilog/shared >/dev/null || Die "@digilog/shared build failed."; Ok "shared"
npm run build -w @digilog/queue  >/dev/null || Die "@digilog/queue build failed.";  Ok "queue"
(cd apps/web && npx vite build 2>&1 | tail -n 2) || true
[ -f apps/web/dist/index.html ] || Die "web build produced no dist/index.html."; Ok "web SPA"
npx tsc -p apps/api/tsconfig.json || Die "API TypeScript compile failed."
[ -f apps/api/dist/app.js ] || Die "API build produced no dist/app.js."; Ok "API"
# tsc writes dist/ as 750/640 under root, and the service user cannot read it:
# Node then reports "Cannot find module .../dist/app.js" (the 2026-09-18 cutover
# failure). Readable-by-all is correct here: the tree holds no secret.
chmod -R a+rX "$APP"
Ok "readable by the digilog user"

# ---------------------------------------------------------------- 5. restart
Step "Restarting $SERVICE"
if [ "$service_stopped" = 1 ]; then systemctl start "$SERVICE"; service_stopped=0; else systemctl restart "$SERVICE"; fi
sleep 5
systemctl is-active --quiet "$SERVICE" || Die "$SERVICE is not active after restart. See: journalctl -u $SERVICE -n 50"
Ok "$SERVICE running"

# ---------------------------------------------------------------- 6. verify
Step "Verifying"
code=""
for _ in $(seq 1 30); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:${PORT:-443}/api/health" 2>/dev/null)
  [ "$code" = 200 ] && break
  sleep 1
done
[ "$code" = 200 ] || Die "/api/health returned '$code' after restart. See: journalctl -u $SERVICE -n 50"
Ok "GET /api/health -> 200"

printf '\n  =============================================\n   DEPLOYED   %s\n  =============================================\n   https://13.204.15.17\n\n   Verify the audit chain after any schema change:\n     log in, then GET /api/audit/verify-chain -> intact:true\n\n' "${after:0:7}"
