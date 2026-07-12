#!/usr/bin/env bash
# Export NocoBase artifacts từ instance chỉ định về repo này.
# Usage: ./scripts/export.sh [module] [env]
# Example: ./scripts/export.sh kpi dev

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="${1:-kpi}"
ENV="${2:-dev}"
ENV_FILE="$REPO_ROOT/envs/${ENV}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy envs/${ENV}.env.example → envs/${ENV}.env and fill in values."
  exit 1
fi

source "$ENV_FILE"

MODULE_DIR="$REPO_ROOT/modules/$MODULE"
echo "=== Export artifacts: module=$MODULE env=$ENV ==="
echo "    NocoBase: $NOCOBASE_URL"
echo "    Output:   $MODULE_DIR"
echo ""

# Ensure output directories exist
mkdir -p "$MODULE_DIR/collections" "$MODULE_DIR/blueprints" "$MODULE_DIR/js-blocks" \
         "$MODULE_DIR/workflows" "$MODULE_DIR/acl"

if [[ "$MODULE" == "kpi" ]]; then

  # 1. Collections
  echo "[1/4] Exporting collections..."
  nb api data-modeling collections get --filter-by-tk kpi_groups --appends fields -j \
    > "$MODULE_DIR/collections/kpi_groups.collection.json" && echo "  ✓ kpi_groups"
  nb api data-modeling collections get --filter-by-tk kpi_catalog --appends fields -j \
    > "$MODULE_DIR/collections/kpi_catalog.collection.json" && echo "  ✓ kpi_catalog"
  nb api data-modeling collections get --filter-by-tk kpi_change_history --appends fields -j \
    > "$MODULE_DIR/collections/kpi_change_history.collection.json" && echo "  ✓ kpi_change_history"
  nb api data-modeling collections get --filter-by-tk kpi_proposals --appends fields -j \
    > "$MODULE_DIR/collections/kpi_proposals.collection.json" && echo "  ✓ kpi_proposals"

  # 2. Page blueprints
  echo "[2/4] Exporting blueprints..."
  nb api flow-surfaces export-blueprint --target '{"routeId":374933304508416}' -j \
    > "$MODULE_DIR/blueprints/kpi_dmc_page.blueprint.json" && echo "  ✓ kpi_dmc_page (Danh mục KPI)"

  # Extract JS block source from blueprint for diff-friendly review
  node -e "
    const fs = require('fs');
    const bp = JSON.parse(fs.readFileSync('$MODULE_DIR/blueprints/kpi_dmc_page.blueprint.json'));
    const code = bp.data?.document?.tabs?.[0]?.blocks?.[0]?.settings?.code;
    if (code) { fs.writeFileSync('$MODULE_DIR/js-blocks/kpi-catalog.block.js', code); }
  " && echo "  ✓ kpi-catalog.block.js (extracted from blueprint)"

  # 3. Workflows
  echo "[3/4] Exporting workflows..."
  nb api resource list --resource workflows -j > "$MODULE_DIR/workflows/all-workflows.json"
  WF_IDS=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$MODULE_DIR/workflows/all-workflows.json'));
    (d.data||[]).forEach(w => console.log(w.id));
  " 2>/dev/null)
  for WF_ID in $WF_IDS; do
    WF_JSON=$(nb api resource get --resource workflows --filter-by-tk "$WF_ID" --appends nodes -j 2>/dev/null)
    FNAME=$(echo "$WF_JSON" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        const w=JSON.parse(d).data;
        // Use KPI-WFxx prefix (before ':') + numeric ID for stable unique names
        const prefix=(w.title||'').split(':')[0].trim()
          .replace(/[^a-zA-Z0-9]/g,'-').replace(/-+/g,'-').toLowerCase();
        const status=w.enabled?'enabled':'disabled';
        console.log(prefix+'-'+w.id+'.'+status+'.json');
      });" 2>/dev/null || echo "workflow-${WF_ID}.json")
    echo "$WF_JSON" > "$MODULE_DIR/workflows/$FNAME"
    echo "  ✓ $FNAME"
  done

  # 3b. Workflow filenames: {kpi-key}-{workflow-id}.{status}.json for stable, unique names
  # (already handled above in the loop)

  # 4. ACL roles — export with full action grants per collection
  echo "[4/4] Exporting ACL..."
  # roles.json: only the 4 KPI-specific roles (filter out core NocoBase roles)
  KPI_ROLES="sysadmin manager leader specialist"
  KPI_COLLS="kpi_groups kpi_catalog kpi_change_history kpi_proposals"

  nb api resource list --resource roles -j | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const kpiRoles=['sysadmin','manager','leader','specialist'];
      const all=JSON.parse(d);
      all.data=(all.data||[]).filter(r=>kpiRoles.includes(r.name));
      console.log(JSON.stringify(all,null,2));
    });" > "$MODULE_DIR/acl/roles.json" && echo "  ✓ roles.json (KPI roles only)"

  nb api acl roles list -j > "$MODULE_DIR/acl/roles-with-permissions.json" && echo "  ✓ roles-with-permissions.json"

  # Per-role legacy resource list (reference only)
  for ROLE in $KPI_ROLES; do
    nb api resource list --resource "roles/${ROLE}/resources" -j \
      > "$MODULE_DIR/acl/role-${ROLE}-resources.json" 2>/dev/null \
      && echo "  ✓ role-${ROLE}-resources.json" || true
  done

  # Per-role per-collection with full action grants (used by apply.sh)
  mkdir -p "$MODULE_DIR/acl/resources"
  for ROLE in $KPI_ROLES; do
    for COLL in $KPI_COLLS; do
      OUT="$MODULE_DIR/acl/resources/role-${ROLE}-${COLL}.json"
      nb api acl roles data-source-resources get \
        --role-name "$ROLE" --name "$COLL" --data-source-key main --appends actions -j \
        > "$OUT" 2>/dev/null \
        && echo "  ✓ resources/role-${ROLE}-${COLL}.json" \
        || echo "  ⚠ resources/role-${ROLE}-${COLL}.json (no data)"
    done
  done

else
  echo "ERROR: Unknown module '$MODULE'. Add export logic for it in scripts/export.sh."
  exit 1
fi

echo ""
echo "=== Export complete ==="
echo "Review diff then commit:"
echo "  cd $REPO_ROOT"
echo "  git add modules/$MODULE/"
echo "  git commit -m 'chore($MODULE): export artifacts from $ENV env'"
