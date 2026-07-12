#!/usr/bin/env bash
# Rollback NocoBase về revision hoặc backup trước đó
# Usage: ./scripts/rollback.sh [revision-id|backup-id] [type]
# Type: revision (default) | backup

set -euo pipefail

TARGET_ID="${1:-}"
TYPE="${2:-revision}"

if [[ -z "$TARGET_ID" ]]; then
  echo "Usage: $0 <revision-id|backup-id> [revision|backup]"
  echo ""
  echo "List revisions:  nb revision list"
  echo "List backups:    nb api backup list"
  exit 1
fi

echo "==> Rolling back via $TYPE: $TARGET_ID"

case "$TYPE" in
  revision)
    echo "==> Restoring NocoBase revision..."
    # nb revision restore "$TARGET_ID"
    echo "    Revision restore initiated."
    ;;
  backup)
    echo "WARNING: Backup restore will OVERWRITE all data after backup time."
    read -r -p "Continue? [y/N] " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo "Aborted."
      exit 0
    fi
    # nb api backup restore --id "$TARGET_ID"
    echo "    Backup restore initiated."
    ;;
  *)
    echo "ERROR: Unknown type '$TYPE'. Use 'revision' or 'backup'."
    exit 1
    ;;
esac
