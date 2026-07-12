#!/usr/bin/env bash
# Apply NocoBase artifacts lên instance chỉ định.
# Usage: ./scripts/apply.sh [module] [env]
# Example: ./scripts/apply.sh kpi staging

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="${1:-kpi}"
ENV="${2:-staging}"
ENV_FILE="$REPO_ROOT/envs/${ENV}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy envs/${ENV}.env.example → envs/${ENV}.env and fill in values."
  exit 1
fi

source "$ENV_FILE"

MODULE_DIR="$REPO_ROOT/modules/$MODULE"
echo "=== Apply artifacts: module=$MODULE env=$ENV ==="
echo "    NocoBase: $NOCOBASE_URL"
echo ""
read -p "Tiếp tục apply lên env '$ENV'? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }

# Tạo revision TRƯỚC khi apply (rollback point)
echo "[0] Creating revision snapshot (pre-deploy)..."
REVISION_NOTE="pre-deploy-${MODULE}-$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
nb revision create --note "$REVISION_NOTE" 2>/dev/null && echo "  ✓ Revision: $REVISION_NOTE" \
  || echo "  ⚠ Revision create failed (non-fatal, continuing)"

if [[ "$MODULE" == "kpi" ]]; then

  # Step 1 — Verify plugins
  echo ""
  echo "[1/5] Checking required plugins..."
  for P in plugin-flow-engine plugin-workflow plugin-acl plugin-action-export plugin-action-import plugin-auth; do
    nb plugin list 2>/dev/null | grep -q "$P" \
      && echo "  ✓ @nocobase/$P" \
      || echo "  ⚠ @nocobase/$P NOT FOUND — run: nb plugin enable @nocobase/$P"
  done

  # Step 2 — Collections (order matters)
  echo ""
  echo "[2/5] Applying collections (data model)..."
  nb api data-modeling collections apply --body-file "$MODULE_DIR/collections/kpi_groups.collection.json" \
    && echo "  ✓ kpi_groups"
  nb api data-modeling collections apply --body-file "$MODULE_DIR/collections/kpi_catalog.collection.json" \
    && echo "  ✓ kpi_catalog"
  nb api data-modeling collections apply --body-file "$MODULE_DIR/collections/kpi_change_history.collection.json" \
    && echo "  ✓ kpi_change_history"
  nb api data-modeling collections apply --body-file "$MODULE_DIR/collections/kpi_proposals.collection.json" \
    && echo "  ✓ kpi_proposals"

  # Step 3 — Page blueprints
  echo ""
  echo "[3/5] Applying page blueprints..."
  nb api flow-surfaces apply-blueprint --mode replace \
    --body-file "$MODULE_DIR/blueprints/kpi_dmc_page.blueprint.json" \
    && echo "  ✓ kpi_dmc_page (Danh mục KPI)"

  # Step 4 — Workflows (enabled only, fresh instance)
  echo ""
  echo "[4/5] Applying workflows (enabled, fresh instance only)..."
  echo "  ⚠ Skip on existing instance where workflows already exist."
  for WF_FILE in "$MODULE_DIR/workflows/"*.enabled.json; do
    [[ -f "$WF_FILE" ]] || continue
    TITLE=$(node -e "const d=JSON.parse(require('fs').readFileSync('$WF_FILE'));console.log(d.data?.title||'?')" 2>/dev/null || echo "?")
    echo "  → $TITLE"
    node -e "
      const fs=require('fs'), w=JSON.parse(fs.readFileSync('$WF_FILE')).data;
      process.stdout.write(JSON.stringify({title:w.title,type:w.type,triggerType:w.triggerType,config:w.config,enabled:false}));
    " | nb api resource create --resource workflows --body-stdin 2>/dev/null \
      && echo "    ✓ Created (disabled — enable manually after verification)" \
      || echo "    ⚠ Skipped (may already exist)"
  done

  # Step 5 — ACL (manual)
  echo ""
  echo "[5/5] ACL roles..."
  echo "  Custom roles: sysadmin, manager, leader, specialist"
  echo "  → Configure via NocoBase UI (Settings > Access Control) using acl/role-*-resources.json as reference."

else
  echo "ERROR: Unknown module '$MODULE'. Add apply logic for it in scripts/apply.sh."
  exit 1
fi

echo ""
echo "=== Apply complete ==="
echo "Verify: $NOCOBASE_URL/admin"
echo "Rollback: bash scripts/rollback.sh $REVISION_NOTE"
