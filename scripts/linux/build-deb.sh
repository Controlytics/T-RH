#!/usr/bin/env bash
# Build the Ubuntu/Debian installer: digilog_<version>_amd64.deb
#
# The Linux counterpart of scripts/build-installer.ps1. Runs on a Linux build
# host (the GitHub Actions ubuntu-22.04 runner in .github/workflows/build-deb.yml,
# or any Ubuntu 22.04+ box with node, npm, dpkg-deb, curl, xz, bzip2, file and
# the PostgreSQL build deps: build-essential, libssl-dev, zlib1g-dev). The
# INTERNET IS NEEDED HERE, ONCE, for npm and the three vendor downloads; the
# customer machine installs and runs the result with none.
#
# Ubuntu 22.04 and later (the runner's release is the proven floor): Node's
# official linux-x64 build (glibc >= 2.28) and EMQX's ubuntu20.04 tarball
# (bundled Erlang) are self-contained; PostgreSQL is BUILT HERE from the
# official source (2026-11-18) with only libc, libssl3 and zlib as outside
# dependencies — present on every Ubuntu from 22.04 — and NO ICU or readline,
# whose versions differ between releases (the "works on 22.04, dies on 24.04"
# trap). A guard below refuses any other dependency. Prisma ships engines for
# both openssl 1.1 and 3.0 hosts (schema.prisma binaryTargets).
#
# Why not a prebuilt portable PostgreSQL: the zonky bundle used until
# 2026-11-18 ships only initdb / pg_ctl / postgres — no psql, pg_dump or
# pg_isready, which the install scripts, the database unit and the nightly
# backup call — and its extensions sit under share/postgresql/, where the old
# check never looked. Every build-deb run failed on that check (33 of 33).
#
# Layout inside the package (mirrors the Windows installer, see
# tasks/EXE-PACKAGING-PLAN.md §3):
#   /opt/digilog/node/bin/node           portable Node
#   /opt/digilog/runtime/{api,web,queue,node_modules}
#   /opt/digilog/pgsql/{bin,lib,share}   PostgreSQL built from source here (relocatable)
#   /opt/digilog/emqx/                   EMQX 5.3.2 (config rendered at install)
#   /opt/digilog/emqx-templates/         scripts/emqx/* (ONE source with Windows)
#   /opt/digilog/scripts/                digilog-lib.sh, digilog-backup.sh
#   /lib/systemd/system/digilog-*.service|timer
#   /var/lib/digilog, /etc/digilog, /var/log/digilog  are created by postinst
#
# Usage: scripts/linux/build-deb.sh [--version X.Y.Z] [--out DIR] [--skip-npm-ci]
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.20.0}"
PG_VERSION="${PG_VERSION:-18.6}"               # the official PostgreSQL source release, built below
# The prefix IS the install path (PostgreSQL is relocatable, but its compiled-in
# paths then need no relocation at all). No ICU / readline: see the header. The
# schema needs only ltree + pgcrypto (prisma/sql/extensions.sql); pgcrypto needs
# OpenSSL. Changing a flag changes PG_BUILD_ID, so a cached build is not reused.
PG_CONFIGURE=(--prefix=/opt/digilog/pgsql --without-icu --without-readline --with-ssl=openssl)
PG_BUILD_ID="$PG_VERSION-$(printf '%s ' "${PG_CONFIGURE[@]}" | sha256sum | cut -c1-12)"
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
  # The ONE version source is the root package.json (Windows packaging design
  # 2026-11-19, D5); apps/api/package.json's 0.1.0 is a workspace package's own.
  APP_VERSION="$(node -p "require('$REPO/package.json').version")"
fi
# dpkg versions may not carry a leading 'v'
APP_VERSION="${APP_VERSION#v}"

step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "FATAL: '$1' not found on PATH" >&2; exit 1; }; }
for t in node npm dpkg-deb curl tar xz bzip2 sha256sum gcc make ldd file; do need "$t"; done
case "$(node -v)" in v${NODE_VERSION%%.*}.*) ;; *) echo "FATAL: build must run on Node ${NODE_VERSION%%.*}.x (native modules are compiled for its ABI); found $(node -v)" >&2; exit 1 ;; esac

rm -rf "$STAGE" "$CLEAN"
mkdir -p "$STAGE" "$CLEAN" "$DL"

# ── 1. Build the application ────────────────────────────────────────────────
cd "$REPO"
if [ "$SKIP_NPM_CI" = 0 ]; then step "npm ci (workspace)"; npm ci --no-audit --no-fund; fi
# The workspace's Prisma client must be generated before tsc: no package has a
# postinstall hook, so after `npm ci` the client is the empty stub and every
# Prisma type is missing. Every build-deb run failed here until 2026-10-12.
step "Generate Prisma client (workspace)"; ( cd apps/api && npx prisma generate )
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
# The root postinstall (patch-package) applies patches/ — without them here it finds no
# patch, exits 0, and the package ships graphile-worker unpatched (audit 2026-11-07 S2-H1).
cp -r patches "$CLEAN/patches"
( cd "$CLEAN" && npm ci --omit=dev --no-audit --no-fund && npx prisma generate --schema apps/api/prisma/schema.prisma )
test -f "$CLEAN/node_modules/.prisma/client/index.js" || { echo "FATAL: generated Prisma client missing in the clean room" >&2; exit 1; }
ls "$CLEAN"/node_modules/.prisma/client/*.node >/dev/null 2>&1 || { echo "FATAL: no Prisma query engine (.node) in the clean room" >&2; exit 1; }
grep -qF "compliance-core patch (patches/graphile-worker+0.16.6.patch" "$CLEAN/node_modules/graphile-worker/dist/runner.js" || { echo "FATAL: the graphile-worker patch (patches/) is not applied in the clean room - the runner would exit the API on a database drop" >&2; exit 1; }

# ── 3. Vendor downloads (cached in $DL) ─────────────────────────────────────
fetch() { local url="$1" out="$2"; if [ ! -s "$out" ]; then step "download $(basename "$out")"; curl -fsSL --retry 3 -o "$out" "$url"; fi; }
NODE_TAR="$DL/node-v$NODE_VERSION-linux-x64.tar.xz"
PG_SRC_TAR="$DL/postgresql-$PG_VERSION.tar.bz2"
EMQX_TAR="$DL/emqx-$EMQX_VERSION-$EMQX_DISTRO-amd64.tar.gz"
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_TAR"
fetch "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2" "$PG_SRC_TAR"
fetch "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2.sha256" "$PG_SRC_TAR.sha256"
fetch "https://www.emqx.com/en/downloads/broker/$EMQX_VERSION/emqx-$EMQX_VERSION-$EMQX_DISTRO-amd64.tar.gz" "$EMQX_TAR"
# The source is verified against the checksum the PostgreSQL project publishes beside it.
( cd "$DL" && sha256sum -c "postgresql-$PG_VERSION.tar.bz2.sha256" ) || { echo "FATAL: postgresql-$PG_VERSION.tar.bz2 does not match its published SHA-256" >&2; exit 1; }

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
# What /api/health and System Health report (apps/api/src/lib/release-info.ts reads
# <runtime>/release.json by default — no env key, which a .deb upgrade would never
# add to an existing digilog.env). build = the CI run number when there is one.
RELEASE_VERSION="$APP_VERSION" RELEASE_BUILD="${GITHUB_RUN_NUMBER:-}" \
RELEASE_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)" RELEASE_OUT="$OPT/runtime/release.json" \
node -e '
  const e = process.env;
  const build = /^\d+$/.test(e.RELEASE_BUILD || "") ? Number(e.RELEASE_BUILD) : null;
  const info = { product: "T&RH Monitoring", version: e.RELEASE_VERSION, build, commit: e.RELEASE_COMMIT || null, date: new Date().toISOString() };
  require("node:fs").writeFileSync(e.RELEASE_OUT, JSON.stringify(info, null, 2) + "\n");
  console.log("release.json: " + JSON.stringify(info));
'
# node_modules WITHOUT the workspace symlinks, which are then re-created as real
# folders from the built dist (the Windows junction problem, same shape).
mkdir -p "$OPT/runtime/node_modules"
( cd "$CLEAN/node_modules" && tar --exclude='./@digilog' -cf - . ) | ( cd "$OPT/runtime/node_modules" && tar -xf - )
for w in shared queue; do
  mkdir -p "$OPT/runtime/node_modules/@digilog/$w"
  cp -r "packages/$w/dist" "$OPT/runtime/node_modules/@digilog/$w/dist"
  cp "packages/$w/package.json" "$OPT/runtime/node_modules/@digilog/$w/package.json"
done

# Built once per PG_BUILD_ID and kept in $DL (the workflow caches $DL — its key
# does not name the PostgreSQL build, so a new PG_BUILD_ID simply builds again
# beside the old one until the key is bumped), then copied in.
PG_BUILT="$DL/pgsql-$PG_BUILD_ID"
if [ ! -x "$PG_BUILT/bin/postgres" ]; then
  # The GitHub ubuntu-22.04 image carries these; say so plainly on a host that does not.
  for h in openssl/ssl.h zlib.h; do
    printf '#include <%s>\n' "$h" | gcc -E -x c - >/dev/null 2>&1 \
      || { echo "FATAL: <$h> not found - install the PostgreSQL build deps: build-essential libssl-dev zlib1g-dev" >&2; exit 1; }
  done
  step "Build PostgreSQL $PG_VERSION from source (${PG_CONFIGURE[*]})"
  PG_SRC="$OUT_DIR/pg-src"; PG_DEST="$OUT_DIR/pg-install"
  rm -rf "$PG_SRC" "$PG_DEST" "$PG_BUILT"; mkdir -p "$PG_SRC"
  tar -xjf "$PG_SRC_TAR" -C "$PG_SRC"
  (
    cd "$PG_SRC/postgresql-$PG_VERSION"
    ./configure "${PG_CONFIGURE[@]}" >/dev/null
    make -s -j"$(nproc)"
    make -s -C contrib/ltree -j"$(nproc)"
    make -s -C contrib/pgcrypto -j"$(nproc)"
    # install-strip: the binaries without debug symbols. Into a DESTDIR — the
    # build host is never written outside $OUT_DIR.
    make -s install-strip DESTDIR="$PG_DEST"
    make -s -C contrib/ltree install-strip DESTDIR="$PG_DEST"
    make -s -C contrib/pgcrypto install-strip DESTDIR="$PG_DEST"
  ) || { echo "FATAL: building PostgreSQL $PG_VERSION failed (build deps: gcc, make, libssl-dev, zlib1g-dev)" >&2; exit 1; }
  mv "$PG_DEST/opt/digilog/pgsql" "$PG_BUILT"
  rm -rf "$PG_SRC" "$PG_DEST"
fi
step "Stage pgsql (PostgreSQL $PG_VERSION, built from source)"
cp -a "$PG_BUILT/." "$OPT/pgsql/"
# Nothing on the customer machine compiles against it: drop the headers and static libraries.
rm -rf "$OPT/pgsql/include"; find "$OPT/pgsql/lib" -maxdepth 1 -name '*.a' -delete

# Every PostgreSQL program the Linux scripts call — the list is read FROM the
# scripts, so a new call cannot ship without its binary (the zonky bundle had
# no psql / pg_dump / pg_isready and nothing noticed).
PG_TOOLS="$(grep -ohE 'PG_BIN/[a-z_]+|pgsql/bin/[a-z_]+' scripts/linux/*.sh scripts/linux/systemd/* scripts/linux/debian/* | sed -E 's#.*/##' | sort -u)"
[ -n "$PG_TOOLS" ] || { echo "FATAL: found no PostgreSQL program calls in scripts/linux (the guard's own pattern is broken)" >&2; exit 1; }
for t in $PG_TOOLS; do test -x "$OPT/pgsql/bin/$t" || { echo "FATAL: pgsql/bin/$t is called by scripts/linux but was not built" >&2; exit 1; }; done
echo "PostgreSQL programs the scripts call, all present: $(echo $PG_TOOLS)"

# The extensions the baseline migration needs, where THIS server looks for them.
# pg_config may answer relocated (from where it runs: inside the stage) or as
# compiled (the install path, /opt/digilog/pgsql/...): map the latter into the stage.
pg_staged() {
  local p; p="$(LD_LIBRARY_PATH="$OPT/pgsql/lib" "$OPT/pgsql/bin/pg_config" "$1")"
  case "$p" in "$STAGE"/*) printf '%s' "$p" ;; *) printf '%s%s' "$STAGE" "$p" ;; esac
}
PG_SHAREDIR="$(pg_staged --sharedir)"
PG_PKGLIBDIR="$(pg_staged --pkglibdir)"
for e in ltree pgcrypto; do
  test -f "$PG_SHAREDIR/extension/$e.control" || { echo "FATAL: $e.control not in $PG_SHAREDIR/extension (needed by the baseline migration)" >&2; exit 1; }
  test -f "$PG_PKGLIBDIR/$e.so" || { echo "FATAL: $e.so not in $PG_PKGLIBDIR" >&2; exit 1; }
done

# Every ELF resolves, and needs nothing beyond what every Ubuntu from 22.04 has.
# A library resolved INSIDE pgsql/lib is PostgreSQL's own (libpq, libpgtypes,
# libecpg); anything else must be one of the base libraries below.
# LD_LIBRARY_PATH stands in for the rpath (/opt/digilog/pgsql/lib), which does
# not exist on the build host. (mawk is Ubuntu's awk: no \s, so [ \t].)
PG_ALLOWED='^(linux-vdso\.so\.1|libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|ld-linux-x86-64\.so\.2|libssl\.so\.3|libcrypto\.so\.3|libz\.so\.1)$'
pg_bad=""; pg_outside=""
while IFS= read -r f; do
  file -b "$f" | grep -q '^ELF' || continue
  deps="$(LD_LIBRARY_PATH="$OPT/pgsql/lib" ldd "$f" 2>&1)" || true
  if printf '%s\n' "$deps" | grep -q 'not found'; then pg_bad="$pg_bad $(basename "$f"):unresolved"; fi
  # "name => /path (addr)" lines: judge by where it resolved.
  while read -r name path; do
    case "$path" in "$OPT/pgsql/lib/"*) continue ;; esac
    printf '%s\n' "$name" | grep -qE "$PG_ALLOWED" || pg_bad="$pg_bad $(basename "$f"):$name"
    pg_outside="$pg_outside $name"
  done < <(printf '%s\n' "$deps" | awk '/=>/ && $3 != "not" {print $1, $3}')
done < <(find "$OPT/pgsql/bin" "$OPT/pgsql/lib" -type f)
[ -z "$pg_bad" ] || { echo "FATAL: PostgreSQL needs libraries outside the allowed base set:$pg_bad" >&2; exit 1; }
echo "PostgreSQL links outside itself only to:$(printf '%s\n' $pg_outside | sort -u | tr '\n' ' ')"

step "Stage emqx ($EMQX_VERSION $EMQX_DISTRO)"
tar -xzf "$EMQX_TAR" -C "$OPT/emqx"
# some tarballs nest a single top folder; flatten if so
if [ ! -x "$OPT/emqx/bin/emqx" ]; then inner="$(find "$OPT/emqx" -maxdepth 2 -type f -name emqx -path '*/bin/emqx' | head -1)"; [ -n "$inner" ] || { echo "FATAL: bin/emqx not found in $EMQX_TAR" >&2; exit 1; }; top="$(dirname "$(dirname "$inner")")"; mv "$top"/* "$OPT/emqx/"; rmdir "$top"; fi
rm -rf "$OPT/emqx/data" "$OPT/emqx/log"      # the customer's broker starts empty under /var/lib/digilog/emqx
cp scripts/emqx/emqx.conf.template scripts/emqx/acl.conf scripts/emqx/api_key.bootstrap.template "$OPT/emqx-templates/"

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
