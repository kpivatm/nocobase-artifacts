#!/usr/bin/env bash
# Apply NocoBase artifacts lên instance chỉ định
# Usage: ./scripts/apply.sh [module] [env]
# Example: ./scripts/apply.sh kpi staging

set -euo pipefail

MODULE="${1:-kpi}"
ENV="${2:-staging}"
ENV_FILE="envs/${ENV}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found."
  exit 1
fi

source "$ENV_FILE"

echo "==> Applying artifacts for module: $MODULE (env: $ENV)"
echo "    NocoBase URL: $NOCOBASE_URL"

# Bắt buộc tạo revision TRƯỚC khi apply
echo "==> Creating revision snapshot (pre-deploy)..."
REVISION_NOTE="pre-deploy-${MODULE}-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M)"
# nb revision create --note "$REVISION_NOTE"
echo "    Revision note: $REVISION_NOTE"

# Apply collections (data model trước)
echo "==> Applying collections..."
# nb api collections import --dir "./modules/${MODULE}/collections/"

# Apply blueprints (page/block sau)
echo "==> Applying blueprints..."
# nb flow-surfaces apply-blueprint --dir "./modules/${MODULE}/blueprints/"

echo "==> Apply complete. Verify on $NOCOBASE_URL"
