#!/usr/bin/env bash
# Nightly pg_dump of digilog_db into /var/lib/digilog/backups (run by
# digilog-backup.timer as the digilog user). Linux counterpart of
# scripts/backup-db.ps1: same file naming, same 14-day rotation, same
# LAST-BACKUP-STATUS.txt so an IQ check has one file to read. Copying dumps
# off-box and test-restoring them are site procedures this script does not do.
set -uo pipefail
DATA=/var/lib/digilog; CFG=/etc/digilog; LOGDIR=/var/log/digilog
PG_BIN=/opt/digilog/pgsql/bin
export LD_LIBRARY_PATH=/opt/digilog/pgsql/lib
RETAIN_DAYS="${DIGILOG_BACKUP_RETAIN_DAYS:-14}"
BACKUPS="$DATA/backups"; STATUS="$BACKUPS/LAST-BACKUP-STATUS.txt"; LOG="$LOGDIR/backup.log"
mkdir -p "$BACKUPS"

finish() { # ok|FAIL, message, file, bytes
  printf '%s %s %s file=%s bytes=%s\n' "$(date -Is)" "$1" "$2" "$3" "$4" | tee -a "$LOG" > "$STATUS"
  [ "$1" = OK ] && exit 0 || exit 1
}

URL="$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=//p' "$CFG/digilog.env" | head -1 | tr -d '\r')"
[ -n "$URL" ] || finish FAIL "DATABASE_URL not found in $CFG/digilog.env" '(none)' 0
PW="$(printf '%s' "$URL" | sed -E 's#^postgresql://[^:]+:([^@]+)@.*#\1#')"
PORT="$(printf '%s' "$URL" | sed -E 's#^postgresql://[^@]+@[^:]+:([0-9]+)/.*#\1#')"
OUT="$BACKUPS/nightly-$(date +%Y%m%d-%H%M%S).sql"

if PGPASSWORD="$PW" "$PG_BIN/pg_dump" -h 127.0.0.1 -p "${PORT:-5433}" -U digilog -d digilog_db -f "$OUT" && [ -s "$OUT" ]; then
  find "$BACKUPS" -name 'nightly-*.sql' -type f -mtime +"$RETAIN_DAYS" -delete
  finish OK "backup complete" "$OUT" "$(stat -c %s "$OUT")"
else
  rm -f "$OUT"
  finish FAIL "pg_dump failed" "$OUT" 0
fi
