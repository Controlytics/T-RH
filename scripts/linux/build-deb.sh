#!/usr/bin/env bash
# Build the Ubuntu/Debian installer: digilog_<version>_amd64.deb
#
# The Linux counterpart of scripts/build-installer.ps1. Runs on a Linux build
# host (the GitHub Actions ubuntu-22.04 runner in .github/workflows/build-deb.yml,
# or any Ubuntu 20.04+ box with node, npm, dpkg-deb, curl, unzip, xz). The
# INTERNET IS NEEDED HERE, ONCE, for npm and the three vendor downloads; the
# customer machine installs and runs the result with none.
#
# "Any Ubuntu version": every binary in the package is self-contained and built
# against an OLD glibc — Node's official linux-x64 build (glibc >= 2.28), the
# zonky portable PostgreSQL (its own lib/), EMQX's ubuntu20.04 tarball (bundled
# Erlang) — and the build runs on the oldest supported runner. Nothing links
# against the host's libssl/libicu, which is what breaks "works on 22.04, dies
# on 24.04" packages. Prisma ships engines for both openssl 1.1 and 3.0 hosts
# (schema.prisma binaryTargets).
#
# Layout inside the package (mirrors the Windows installer, see
# tasks/EXE-PACKAGING-PLAN.md §3):
#   /opt/digilog/node/bin/node           portable Node
#   /opt/digilog/runtime/{api,web,queue,node_modules}
#   /opt/digilog/pgsql/{bin,lib,share}   portable PostgreSQL
#   /opt/digilog/emqx/                   EMQX 5.3.2 (config rendered at install)
#   /opt/digilog/emqx-templates/         scripts/emqx/* (ONE source with Windows)
#   /opt/digilog/scripts/                digilog-lib.sh, digilog-backup.sh
#   /lib/systemd/system/digilog-*.service|timer
#   /var/lib/digilog, /etc/digilog, /var/log/digilog  are created by postinst
#
# Usage: scripts/linux/build-deb.sh [--version X.Y.Z] [--out DIR] [--skip-npm-ci]
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.20.0}"
PG_VERSION="${PG_VERSION:-18.6.0}"            # io.zonky.test.postgres:embedded-postgres-binaries-linux-amd64
EMQX_VERSION="${EMQX_VERSION:-5.3.2}"          # the last version with a Windows build; keep both installers on one broker version
EMQX_DISTRO="${EMQX_DISTRO:-ubuntu20.04}"      # oldest supported build = widest glibc compatibility
APP_VERSION=""
OUT_DIR=""
SKIP_NPM_CI=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) APP_VERSION="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --skip-npm-ci) SKIP_NPM_CI=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/dist-linux}"
STAGE="$OUT_DIR/pkgroot"
CLEAN="$OUT_DIR/cleanroom"
DL="$OUT_DIR/downloads"
if [ -z "$APP_VERSION" ]; then
  APP_VERSION="$(node -p "require('$REPO/apps/api/package.json').version")"
fi
# dpkg versions may not carry a leading 'v'
APP_VERSION="${APP_VERSION#v}"

step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "FATAL: '$1' not found on PATH" >&2; exit 1; }; }
for t in node npm dpkg-deb curl unzip tar xz; do need "$t"; done
case "$(node -v)" in v${NODE_VERSION%%.*}.*) ;; *) echo "FATAL: build must run on Node ${NODE_VERSION%%.*}.x (native modules are compiled for its ABI); found $(node -v)" >&2; exit 1 ;; esac

rm -rf "$STAGE" "$CLEAN"
mkdir -p "$STAGE" "$CLEAN" "$DL"

# ── 1. Build the application ────────────────────────────────────────────────
cd "$REPO"
if [ "$SKIP_NPM_CI" = 0 ]; then step "npm ci (workspace)"; npm ci --no-audit --no-fund; fi
step "Build @digilog/shared + @digilog/queue"; npm run build -w @digilog/shared; npm run build -w @digilog/queue
step "Compile backend (tsc)"; npx tsc -p apps/api/tsconfig.json
step "Precompile DB seed (esbuild -> prisma/seed.mjs)"
npx esbuild apps/api/prisma/seed.ts --bundle --platform=node --format=esm --packages=external --outfile=apps/api/prisma/seed.mjs
step "Build web UI (vite build)"; npm run build -w @digilog/web

# ── 2. Clean-room production node_modules ───────────────────────────────────
# Never `npm ci --omit=dev` against the live checkout (it wipes dev deps). Copy
# the manifests into a clean tree and install there. bcrypt fetches its
# prebuilt linux-x64 binary here; Prisma downloads the engines named in
# schema.prisma binaryTargets at `generate`.
step "Clean-room npm ci --omit=dev"
mkdir -p "$CLEAN/apps/api" "$CLEAN/apps/web" "$CLEAN/packages/shared" "$CLEAN/packages/queue"
cp package.json package-lock.json "$CLEAN/"
cp apps/api/package.json "$CLEAN/apps/api/"
cp apps/web/package.json "$CLEAN/apps/web/"
cp packages/shared/package.json "$CLEAN/packages/shared/"
cp packages/queue/package.json "$CLEAN/packages/queue/"
cp -r apps/api/prisma "$CLEAN/apps/api/prisma"
( cd "$CLEAN" && npm ci --omit=dev --no-audit --no-fund && npx prisma generate --schema apps/api/prisma/schema.prisma )
test -f "$CLEAN/node_modules/.prisma/client/index.js" || { echo "FATAL: generated Prisma client missing in the clean room" >&2; exit 1; }
ls "$CLEAN"/node_modules/.prisma/client/*.node >/dev/null 2>&1 || { echo "FATAL: no Prisma query engine (.node) in the clean room" >&2; exit 1; }

# ── 3. Vendor downloads (cached in $DL) ─────────────────────────────────────
fetch() { local url="$1" out="$2"; if [ ! -s "$out" ]; then step "download $(basename "$out")"; curl -fsSL --retry 3 -o "$out" "$url"; fi; }
NODE_TAR="$DL/node-v$NODE_VERSION-linux-x64.tar.xz"
PG_JAR="$DL/embedded-postgres-binaries-linux-amd64-$PG_VERSION.jar"
EMQX_TAR="$DL/emqx-$EMQX_VERSION-$EMQX_DISTRO-amd64.tar.gz"
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_TAR"
fetch "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/$PG_VERSION/embedded-postgres-binaries-linux-amd64-$PG_VERSION.jar" "$PG_JAR"
fetch "https://www.emqx.com/en/downloads/broker/$EMQX_VERSION/emqx-$EMQX_VERSION-$EMQX_DISTRO-amd64.tar.gz" "$EMQX_TAR"

# ── 4. Stage /opt/digilog ───────────────────────────────────────────────────
OPT="$STAGE/opt/digilog"
mkdir -p "$OPT/node/bin" "$OPT/runtime/api" "$OPT/runtime/web" "$OPT/runtime/queue" "$OPT/pgsql" "$OPT/emqx" "$OPT/scripts" "$OPT/emqx-templates"

step "Stage node"
tar -xJf "$NODE_TAR" -C "$OUT_DIR" "node-v$NODE_VERSION-linux-x64/bin/node"
mv "$OUT_DIR/node-v$NODE_VERSION-linux-x64/bin/node" "$OPT/node/bin/node"; rm -rf "$OUT_DIR/node-v$NODE_VERSION-linux-x64"

step "Stage runtime"
cp -r apps/api/dist "$OPT/runtime/api/dist"
cp -r apps/api/prisma "$OPT/runtime/api/prisma"
cp apps/api/package.json "$OPT/runtime/api/package.json"
cp -r apps/web/dist "$OPT/runtime/web/dist"
cp packages/queue/crontab.txt "$OPT/runtime/queue/crontab.txt"
# node_modules WITHOUT the workspace symlinks, which are then re-created as real
# folders from the built dist (the Windows junction problem, same shape).
mkdir -p "$OPT/runtime/node_modules"
( cd "$CLEAN/node_modules" && tar --exclude='./@digilog' -cf - . ) | ( cd "$OPT/runtime/node_modules" && tar -xf - )
for w in shared queue; do
  mkdir -p "$OPT/runtime/node_modules/@digilog/$w"
  cp -r "packages/$w/dist" "$OPT/runtime/node_modules/@digilog/$w/dist"
  cp "packages/$w/package.json" "$OPT/runtime/node_modules/@digilog/$w/package.json"
done

step "Stage pgsql (zonky portable PostgreSQL $PG_VERSION)"
unzip -p "$PG_JAR" postgres-linux-x86_64.txz | tar -xJ -C "$OPT/pgsql"
test -x "$OPT/pgsql/bin/initdb" || { echo "FATAL: pgsql/bin/initdb missing after extract" >&2; exit 1; }
test -f "$OPT/pgsql/share/extension/ltree.control" || { echo "FATAL: ltree extension not in the portable PostgreSQL (needed by the baseline migration)" >&2; exit 1; }
test -f "$OPT/pgsql/share/extension/pgcrypto.control" || { echo "FATAL: pgcrypto extension not in the portable PostgreSQL" >&2; exit 1; }

step "Stage emqx ($EMQX_VERSION $EMQX_DISTRO)"
tar -xzf "$EMQX_TAR" -C "$OPT/emqx"
# some tarballs nest a single top folder; flatten if so
if [ ! -x "$OPT/emqx/bin/emqx" ]; then inner="$(find "$OPT/emqx" -maxdepth 2 -type f -name emqx -path '*/bin/emqx' | head -1)"; [ -n "$inner" ] || { echo "FATAL: bin/emqx not found in $EMQX_TAR" >&2; exit 1; }; top="$(dirname "$(dirname "$inner")")"; mv "$top"/* "$OPT/emqx/"; rmdir "$top"; fi
rm -rf "$OPT/emqx/data" "$OPT/emqx/log"      # the customer's broker starts empty under /var/lib/digilog/emqx
cp scripts/emqx/emqx.conf.template scripts/emqx/acl.conf "$OPT/emqx-templates/"

step "Stage scripts + systemd units"
cp scripts/linux/digilog-lib.sh scripts/linux/digilog-backup.sh "$OPT/scripts/"
chmod 0755 "$OPT/scripts/"*.sh
mkdir -p "$STAGE/lib/systemd/system"
cp scripts/linux/systemd/*.service scripts/linux/systemd/*.timer "$STAGE/lib/systemd/system/"
mkdir -p "$STAGE/usr/share/doc/digilog"
cp docs/deployment-methods/method-c-ubuntu-deb.md "$STAGE/usr/share/doc/digilog/README.md"

# ── 5. DEBIAN control + maintainer scripts ─────────────────────────────────
step "DEBIAN metadata"
mkdir -p "$STAGE/DEBIAN"
INSTALLED_KB="$(du -sk "$STAGE" | cut -f1)"
sed -e "s/@@VERSION@@/$APP_VERSION/" -e "s/@@INSTALLED_SIZE@@/$INSTALLED_KB/" scripts/linux/debian/control.template > "$STAGE/DEBIAN/control"
for s in postinst prerm postrm; do cp "scripts/linux/debian/$s" "$STAGE/DEBIAN/$s"; chmod 0755 "$STAGE/DEBIAN/$s"; done
# /etc/digilog is owned by postinst (secrets, certs) - nothing there is a conffile.

# ── 6. Build ────────────────────────────────────────────────────────────────
DEB="$OUT_DIR/digilog_${APP_VERSION}_amd64.deb"
step "dpkg-deb --build -> $DEB"
dpkg-deb --build --root-owner-group "$STAGE" "$DEB"
dpkg-deb --info "$DEB" | sed -n '1,20p'
printf '\nBuilt %s (%s)\n' "$DEB" "$(du -h "$DEB" | cut -f1)"
