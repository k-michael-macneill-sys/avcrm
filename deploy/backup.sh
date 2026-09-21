#!/bin/sh
#
# A nightly dump, verified, copied offsite, and kept for a fortnight.
#
# Run by the `backup` service in docker-compose.yml. A dump sitting on the
# same machine as the database is not a backup — it survives a bad migration,
# not a dead disk — so set BACKUP_OFFSITE_CMD and send it somewhere else.

set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
EVERY_SECONDS="${BACKUP_EVERY_SECONDS:-86400}"
DIR=/backups

# The command that takes a copy off this machine. It is given the backup's
# path as its one argument, and anything that can be written as a shell line
# works:
#
#   BACKUP_OFFSITE_CMD='rclone copy "$1" remote:avcrm-backups/'
#   BACKUP_OFFSITE_CMD='aws s3 cp "$1" s3://avcrm-backups/'
#   BACKUP_OFFSITE_CMD='scp "$1" backups@elsewhere:/srv/avcrm/'
#
# Left empty, the only copy of everything is on this machine, and the log
# below says so on every run rather than letting that pass quietly.
OFFSITE="${BACKUP_OFFSITE_CMD:-}"

export PGPASSWORD="${POSTGRES_PASSWORD}"
USER="${POSTGRES_USER:-avcrm}"
DB="${POSTGRES_DB:-avcrm}"

mkdir -p "$DIR"

log() { echo "$(date -u +%FT%TZ) $*"; }
fail() { echo "$(date -u +%FT%TZ) $*" >&2; }

while true; do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  FILE="$DIR/${DB}-${STAMP}.sql.gz"
  OFFSITE_OK=0

  # Written to a temporary name first: a dump interrupted halfway through
  # must not be left looking like a good one.
  if pg_dump -h postgres -U "$USER" -d "$DB" --no-owner | gzip -9 > "${FILE}.part"; then
    # pg_dump's exit status covers pg_dump. It says nothing about whether the
    # bytes that reached the disk are a readable archive, and a backup nobody
    # can decompress is discovered at the worst possible moment.
    if gzip -t "${FILE}.part" 2>/dev/null; then
      mv "${FILE}.part" "$FILE"
      log "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"

      if [ -n "$OFFSITE" ]; then
        # Deliberately not `set -e`-fatal: a network blip tonight must not
        # stop the container and take every future backup with it.
        if sh -c "$OFFSITE" _ "$FILE"; then
          OFFSITE_OK=1
          log "offsite ok: $FILE"
        else
          fail "OFFSITE COPY FAILED for $FILE — this machine holds the only copy"
        fi
      else
        log "no BACKUP_OFFSITE_CMD set — the only copy of this dump is on this machine"
      fi
    else
      rm -f "${FILE}.part"
      fail "BACKUP FAILED: the dump did not survive verification, not kept"
    fi
  else
    rm -f "${FILE}.part"
    fail "BACKUP FAILED: pg_dump did not complete"
  fi

  # Pruning is the one step that destroys something, so it only runs when
  # tonight's copy is somewhere else — or when there is no offsite configured
  # at all, which is an operator who has accepted a single copy and still
  # needs the disk not to fill up.
  if [ -z "$OFFSITE" ] || [ "$OFFSITE_OK" -eq 1 ]; then
    find "$DIR" -name "${DB}-*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
  else
    fail "keeping old backups: nothing left this machine tonight"
  fi

  sleep "$EVERY_SECONDS"
done
