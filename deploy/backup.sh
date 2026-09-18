#!/bin/sh
#
# A nightly dump, kept for a fortnight.
#
# Run by the `backup` service in docker-compose.yml. A dump sitting on the
# same machine as the database is not a backup — it survives a bad migration,
# not a dead disk — so push it somewhere else. The hook for that is at the
# bottom and is deliberately left for you to fill in, because where it goes is
# a decision about who holds your customers' data.

set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
EVERY_SECONDS="${BACKUP_EVERY_SECONDS:-86400}"
DIR=/backups

export PGPASSWORD="${POSTGRES_PASSWORD}"
USER="${POSTGRES_USER:-avcrm}"
DB="${POSTGRES_DB:-avcrm}"

mkdir -p "$DIR"

while true; do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  FILE="$DIR/${DB}-${STAMP}.sql.gz"

  # Written to a temporary name first: a dump interrupted halfway through
  # must not be left looking like a good one.
  if pg_dump -h postgres -U "$USER" -d "$DB" --no-owner \
    | gzip -9 > "${FILE}.part"; then
    mv "${FILE}.part" "$FILE"
    echo "$(date -u +%FT%TZ) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"

    # --- offsite ---------------------------------------------------------
    # Whatever you use, it goes here. For example, with rclone configured:
    #   rclone copy "$FILE" remote:avcrm-backups/
    # Until something fills this in, the only copy is on this machine.
    # ---------------------------------------------------------------------
  else
    rm -f "${FILE}.part"
    echo "$(date -u +%FT%TZ) BACKUP FAILED" >&2
  fi

  find "$DIR" -name "${DB}-*.sql.gz" -mtime "+${KEEP_DAYS}" -delete

  sleep "$EVERY_SECONDS"
done
