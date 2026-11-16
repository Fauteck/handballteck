#!/bin/sh
# Tägliche Sicherung der SQLite-Datenbank auf dem VPS (Cron, siehe README.md).
# sqlite3 ".backup" liest im laufenden Betrieb einen stimmigen Stand, auch mit
# WAL — kein Stoppen des Containers nötig. Behalten werden 14 Tage.
set -eu

BASIS=/opt/handballteck
ZIEL="$BASIS/backup"
DB="$BASIS/data/handballteck.db"
DATEI="$ZIEL/handballteck-$(date +%F).db"

mkdir -p "$ZIEL"
sqlite3 "$DB" ".backup '$DATEI'"
ergebnis=$(sqlite3 "$DATEI" "PRAGMA integrity_check;")
if [ "$ergebnis" != "ok" ]; then
  echo "Sicherung $DATEI ist beschädigt: $ergebnis" >&2
  exit 1
fi
gzip -f "$DATEI"
find "$ZIEL" -name 'handballteck-*.db.gz' -mtime +14 -delete
