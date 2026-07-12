#!/usr/bin/env bash
# Export NocoBase artifacts từ instance chỉ định
# Usage: ./scripts/export.sh [module] [env]
# Example: ./scripts/export.sh kpi dev

set -euo pipefail

MODULE="${1:-kpi}"
ENV="${2:-dev}"
ENV_FILE="envs/${ENV}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy envs/${ENV}.env.example and fill in values."
  exit 1
fi

source "$ENV_FILE"

echo "==> Exporting artifacts for module: $MODULE (env: $ENV)"
echo "    NocoBase URL: $NOCOBASE_URL"

# Export collections (data model)
echo "==> Exporting collections..."
# nb api collections export --output "./modules/${MODULE}/collections/"

# Export page blueprints
echo "==> Exporting blueprints..."
# nb flow-surfaces export-blueprint --output "./modules/${MODULE}/blueprints/"

echo "==> Export complete. Review changes before committing."
echo "    git diff modules/${MODULE}/"
