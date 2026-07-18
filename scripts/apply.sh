#!/usr/bin/env bash
# DEPRECATED — Stage 4 (KPI-38): thay thế bởi CI pipeline dùng plugin-config-migration CLI.
# Dùng: GitHub Actions → Deploy to Staging → Run workflow
# Hoặc: node packages/plugins/@kpi/plugin-config-migration/bin/config-migration.js apply --source bundle.json
# Script này giữ lại chỉ để tham khảo; sẽ xóa sau khi pipeline mới ổn định.
#
# Apply NocoBase artifacts lên instance chỉ định.
# Usage: ./scripts/apply.sh [module] [env] [--yes]
# Example: ./scripts/apply.sh kpi staging
# CI: set CI=true or pass --yes to skip interactive prompt; set env vars directly instead of .env file.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="${1:-kpi}"
ENV="${2:-staging}"
YES_FLAG="${3:-}"

# CI-compatible env loading: .env file is optional; fall back to environment variables
ENV_FILE="$REPO_ROOT/envs/${ENV}.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  # In CI the env file is gitignored; vars must come from the environment (GitHub Actions secrets, etc.)
  if [[ -z "${NOCOBASE_URL:-}" || -z "${NOCOBASE_EMAIL:-}" || -z "${NOCOBASE_PASSWORD:-}" ]]; then
    echo "ERROR: $ENV_FILE not found and NOCOBASE_URL / NOCOBASE_EMAIL / NOCOBASE_PASSWORD not set."
    echo "  Local: copy envs/${ENV}.env.example → envs/${ENV}.env and fill in values."
    echo "  CI: set these as environment variables / secrets."
    exit 1
  fi
fi

MODULE_DIR="$REPO_ROOT/modules/$MODULE"
echo "=== Apply artifacts: module=$MODULE env=$ENV ==="
echo "    NocoBase: $NOCOBASE_URL"
echo ""

# Skip confirmation when CI=true or --yes flag passed
if [[ "${CI:-}" != "true" && "$YES_FLAG" != "--yes" ]]; then
  read -r -p "Tiếp tục apply lên env '$ENV'? [y/N] " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
fi

# Configure nb CLI session in CI (no persisted session in fresh runner)
if [[ "${CI:-}" == "true" ]]; then
  echo "[nb] Setting up CLI session for CI..."
  NB_ENV_NAME="${ENV}-ci"
  nb env init "$NB_ENV_NAME" --url "$NOCOBASE_URL" --yes 2>/dev/null || true
  nb env auth "$NB_ENV_NAME" --auth-type basic \
    --username "${NOCOBASE_EMAIL}" --password "${NOCOBASE_PASSWORD}" 2>&1 \
    | grep -E "Authenticated|Error|failed" || true
  nb env use "$NB_ENV_NAME" 2>/dev/null || true
fi

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

  # Step 4 — Workflows (enabled only, preserving node chain)
  echo ""
  echo "[4/5] Applying workflows (enabled, import with nodes)..."
  echo "  ⚠ Skip on existing instance where workflows already exist."

  # Write node-import helper script to a temp file to avoid shell quoting issues
  TMPSCRIPT=$(mktemp /tmp/wf_import_XXXXXX.js)
  cat > "$TMPSCRIPT" << 'JSEOF'
const fs = require('fs');
const { execSync } = require('child_process');

const wfFile = process.argv[2];
const wfData = JSON.parse(fs.readFileSync(wfFile)).data;
const nodes = wfData.nodes || [];

// Create workflow record (disabled — enable manually after verification)
const wfBody = {
  title: wfData.title,
  type: wfData.type,
  triggerType: wfData.triggerType,
  config: wfData.config,
  enabled: false
};
const bodyFile = fs.mkdtempSync('/tmp/wf') + '/body.json';
fs.writeFileSync(bodyFile, JSON.stringify(wfBody));

let createOut;
try {
  createOut = execSync(
    `nb api resource create --resource workflows --body-file "${bodyFile}" -j`,
    { encoding: 'utf8' }
  );
} catch (e) {
  console.error('  ✗ Failed to create workflow: ' + e.message);
  process.exit(1);
}
fs.unlinkSync(bodyFile);

const newWfId = JSON.parse(createOut).data.id;
console.log(`  ✓ Created workflow id=${newWfId}: ${wfData.title}`);

if (!nodes.length) {
  console.log('    (no nodes)');
  process.exit(0);
}

// Topological sort: process nodes in order where each node's upstream is already processed.
// Handles linear chains AND condition branches (nodes with branchIndex, multiple children of one upstream).
const byId = {};
nodes.forEach(n => { byId[n.id] = n; });
const idMap = {};  // old id → new id

// BFS from roots (upstreamId === null); each processed node enqueues its children
const queue = nodes.filter(n => n.upstreamId === null);
const visited = new Set();
const ordered = [];
while (queue.length) {
  const node = queue.shift();
  if (visited.has(node.id)) continue;
  visited.add(node.id);
  ordered.push(node);
  // Children = all nodes whose upstreamId === this node's id (covers both main chain + branches)
  nodes.filter(n => n.upstreamId === node.id).forEach(child => queue.push(child));
}

for (const current of ordered) {
  const nodeBody = {
    key: current.key,   // preserve key so jobsMapByNodeKey references in sibling configs stay valid
    type: current.type,
    title: current.title,
    config: current.config,
    branchIndex: current.branchIndex,
    upstreamId: current.upstreamId != null ? idMap[current.upstreamId] : null
  };
  const nBodyFile = fs.mkdtempSync('/tmp/nd') + '/node.json';
  fs.writeFileSync(nBodyFile, JSON.stringify(nodeBody));
  try {
    const nodeOut = execSync(
      `nb api resource create --resource "workflows/${newWfId}/nodes" --body-file "${nBodyFile}" -j`,
      { encoding: 'utf8' }
    );
    const newNodeId = JSON.parse(nodeOut).data.id;
    idMap[current.id] = newNodeId;
    console.log(`    ✓ Node ${current.type}: ${current.title || '(untitled)'}`);
  } catch (e) {
    console.error(`    ✗ Node ${current.type} failed: ` + e.message);
  }
  fs.unlinkSync(nBodyFile);
}
JSEOF

  for WF_FILE in "$MODULE_DIR/workflows/"*.enabled.json; do
    [[ -f "$WF_FILE" ]] || continue
    node "$TMPSCRIPT" "$WF_FILE" 2>&1 || echo "    ⚠ Skipped (may already exist)"
  done
  rm -f "$TMPSCRIPT"

  # Step 5 — ACL roles and permissions
  echo ""
  echo "[5/5] Applying ACL roles and permissions..."
  KPI_ROLES="sysadmin manager leader specialist"
  KPI_COLLS="kpi_groups kpi_catalog kpi_change_history kpi_proposals"

  # Ensure roles exist
  for ROLE in $KPI_ROLES; do
    ROLE_FILE="$MODULE_DIR/acl/roles-with-permissions.json"
    if [[ -f "$ROLE_FILE" ]]; then
      ROLE_TITLE=$(node -e "
        const d=JSON.parse(require('fs').readFileSync('$ROLE_FILE'));
        const r=(d.data||[]).find(r=>r.name==='$ROLE');
        console.log(r?r.title:'');
      " 2>/dev/null || echo "")
      BODY="{\"name\":\"$ROLE\",\"title\":\"${ROLE_TITLE:-$ROLE}\"}"
      RBODY=$(mktemp /tmp/role_XXXXXX.json)
      echo "$BODY" > "$RBODY"
      nb api resource create --resource roles --body-file "$RBODY" -j >/dev/null 2>&1 \
        && echo "  ✓ Role created: $ROLE" \
        || echo "  ✓ Role exists: $ROLE (skipped)"
      rm -f "$RBODY"
    fi
  done

  # Apply per-collection permissions with action grants
  for ROLE in $KPI_ROLES; do
    for COLL in $KPI_COLLS; do
      RES_FILE="$MODULE_DIR/acl/resources/role-${ROLE}-${COLL}.json"
      [[ -f "$RES_FILE" ]] || { echo "  ⚠ Missing: $RES_FILE"; continue; }

      TMPNODE=$(mktemp /tmp/aclbody_XXXXXX.js)
      cat > "$TMPNODE" << 'ACLEOF'
const fs = require('fs');
const { execSync } = require('child_process');
const resFile = process.argv[2];
const role = process.argv[3];
const coll = process.argv[4];

const d = JSON.parse(fs.readFileSync(resFile)).data;
const actions = (d.actions || []).map(a => ({
  name: a.name,
  fields: a.fields || [],
  scopeId: undefined   // scopeId is env-specific, omit for portability
}));

const body = {
  name: coll,
  usingActionsConfig: d.usingActionsConfig !== false,
  actions
};
const bf = fs.mkdtempSync('/tmp/acl') + '/body.json';
fs.writeFileSync(bf, JSON.stringify(body));

try {
  // Try create first, fall back to update if already exists
  execSync(
    `nb api acl roles data-source-resources create --role-name "${role}" --data-source-key main --body-file "${bf}" -j`,
    { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
  );
  console.log(`  ✓ ACL ${role}/${coll}`);
} catch {
  try {
    execSync(
      `nb api acl roles data-source-resources update --role-name "${role}" --name "${coll}" --data-source-key main --body-file "${bf}" -j`,
      { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
    );
    console.log(`  ✓ ACL updated ${role}/${coll}`);
  } catch (e2) {
    console.error(`  ⚠ ACL ${role}/${coll} skipped: ` + e2.message.slice(0,120));
  }
}
fs.unlinkSync(bf);
ACLEOF
      node "$TMPNODE" "$RES_FILE" "$ROLE" "$COLL" 2>&1
      rm -f "$TMPNODE"
    done
  done

else
  echo "ERROR: Unknown module '$MODULE'. Add apply logic for it in scripts/apply.sh."
  exit 1
fi

echo ""
echo "=== Apply complete ==="
echo "Verify: $NOCOBASE_URL/admin"
echo "Next: enable workflows via NocoBase UI after verifying each one."
echo "Rollback: nb revision restore $REVISION_NOTE"
