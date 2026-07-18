#!/usr/bin/env bash
# Apply NocoBase artifacts to a designated instance.
# Usage: ./scripts/apply.sh [module] [env] [--yes]
# Example: ./scripts/apply.sh kpi staging
#          ./scripts/apply.sh shared staging
#          ./scripts/apply.sh crm production
# CI: set CI=true or pass --yes to skip prompt; set env vars instead of .env file.

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
if [[ ! -d "$MODULE_DIR" ]]; then
  echo "ERROR: Module directory not found: $MODULE_DIR"
  echo "  Available modules: $(ls "$REPO_ROOT/modules/" 2>/dev/null | tr '\n' ' ' || echo '(none)')"
  exit 1
fi

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

# --- Step 0: Pre-deploy revision snapshot ---
echo "[0] Creating revision snapshot (pre-deploy)..."
REVISION_NOTE="pre-deploy-${MODULE}-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
nb revision create --note "$REVISION_NOTE" 2>/dev/null \
  && echo "  ✓ Revision: $REVISION_NOTE" \
  || echo "  ⚠ Revision create failed (non-fatal, continuing)"

# --- Step 1: Plugin check (from manifest.json) ---
echo ""
echo "[1/5] Checking required plugins..."
MANIFEST="$MODULE_DIR/manifest.json"
if [[ -f "$MANIFEST" ]]; then
  PLUGIN_LIST=$(node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST'));
    (m.plugins || []).forEach(p => console.log(p));
  " 2>/dev/null || echo "")
  if [[ -n "$PLUGIN_LIST" ]]; then
    while IFS= read -r P; do
      [[ -z "$P" ]] && continue
      nb plugin list 2>/dev/null | grep -q "$P" \
        && echo "  ✓ $P" \
        || echo "  ⚠ $P NOT FOUND — run: nb plugin enable $P"
    done <<< "$PLUGIN_LIST"
  else
    echo "  (manifest.json has no plugins array — skipping)"
  fi
else
  echo "  (no manifest.json — skipping plugin check)"
fi

# Helper: strip {data: ...} API-response wrapper if present, write unwrapped JSON to OUTPUT path
unwrap_json() {
  local INPUT="$1" OUTPUT="$2"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$INPUT'));
    const body = (d && d.data !== undefined) ? d.data : d;
    require('fs').writeFileSync('$OUTPUT', JSON.stringify(body));
  "
}

# --- Step 2: Collections ---
echo ""
echo "[2/5] Applying collections (data model)..."
COLL_DIR="$MODULE_DIR/collections"
if [[ -d "$COLL_DIR" ]]; then
  COUNT=0
  for COLL_FILE in "$COLL_DIR"/*.collection.json; do
    [[ -f "$COLL_FILE" ]] || continue
    COLL_NAME=$(basename "$COLL_FILE" .collection.json)
    TMPBODY=$(mktemp /tmp/coll_XXXXXX.json)
    unwrap_json "$COLL_FILE" "$TMPBODY"
    nb api data-modeling collections apply --body-file "$TMPBODY" \
      && echo "  ✓ $COLL_NAME" || echo "  ✗ $COLL_NAME (failed)"
    rm -f "$TMPBODY"
    COUNT=$((COUNT + 1))
  done
  [[ "$COUNT" -eq 0 ]] && echo "  (no *.collection.json files found)"
else
  echo "  (no collections/ directory)"
fi

# --- Step 3: Page blueprints ---
echo ""
echo "[3/5] Applying page blueprints..."
BP_DIR="$MODULE_DIR/blueprints"
if [[ -d "$BP_DIR" ]]; then
  COUNT=0
  for BP_FILE in "$BP_DIR"/*.blueprint.json; do
    [[ -f "$BP_FILE" ]] || continue
    BP_NAME=$(basename "$BP_FILE" .blueprint.json)
    nb api flow-surfaces apply-blueprint --mode replace --body-file "$BP_FILE" \
      && echo "  ✓ $BP_NAME" || echo "  ✗ $BP_NAME (failed)"
    COUNT=$((COUNT + 1))
  done
  [[ "$COUNT" -eq 0 ]] && echo "  (no *.blueprint.json files found)"
else
  echo "  (no blueprints/ directory)"
fi

# --- Step 4: Workflows ---
echo ""
echo "[4/5] Applying workflows (enabled, import with nodes)..."
WF_DIR="$MODULE_DIR/workflows"

TMPSCRIPT=$(mktemp /tmp/wf_import_XXXXXX.js)
cat > "$TMPSCRIPT" << 'JSEOF'
const fs = require('fs');
const { execSync } = require('child_process');

const wfFile = process.argv[2];
const raw = JSON.parse(fs.readFileSync(wfFile));
// Support both bare workflow objects and {data: ...} API-response wrapper
const wfData = (raw && raw.data !== undefined) ? raw.data : raw;
const nodes = wfData.nodes || [];

// Create workflow (disabled — enable manually after verification)
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

// BFS from roots — handles linear chains and condition branches
const idMap = {};
const queue = nodes.filter(n => n.upstreamId === null);
const visited = new Set();
const ordered = [];
while (queue.length) {
  const node = queue.shift();
  if (visited.has(node.id)) continue;
  visited.add(node.id);
  ordered.push(node);
  nodes.filter(n => n.upstreamId === node.id).forEach(child => queue.push(child));
}

for (const current of ordered) {
  const nodeBody = {
    key: current.key,   // preserve key so jobsMapByNodeKey refs in sibling configs stay valid
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
    idMap[current.id] = JSON.parse(nodeOut).data.id;
    console.log(`    ✓ Node ${current.type}: ${current.title || '(untitled)'}`);
  } catch (e) {
    console.error(`    ✗ Node ${current.type} failed: ` + e.message);
  }
  fs.unlinkSync(nBodyFile);
}
JSEOF

if [[ -d "$WF_DIR" ]]; then
  COUNT=0
  for WF_FILE in "$WF_DIR"/*.enabled.json; do
    [[ -f "$WF_FILE" ]] || continue
    node "$TMPSCRIPT" "$WF_FILE" 2>&1 || echo "    ⚠ Skipped (may already exist)"
    COUNT=$((COUNT + 1))
  done
  [[ "$COUNT" -eq 0 ]] && echo "  (no *.enabled.json workflow files found)"
else
  echo "  (no workflows/ directory)"
fi
rm -f "$TMPSCRIPT"

# --- Step 5: ACL roles and permissions ---
echo ""
echo "[5/5] Applying ACL roles and permissions..."
ACL_DIR="$MODULE_DIR/acl"

if [[ ! -d "$ACL_DIR" ]]; then
  echo "  (no acl/ directory)"
else
  ROLE_FILE="$ACL_DIR/roles-with-permissions.json"

  if [[ -f "$ROLE_FILE" ]]; then
    # Create/upsert all roles found in the file
    ROLE_LINES=$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$ROLE_FILE'));
      (d.data || []).forEach(r => console.log(r.name + '|' + (r.title || r.name)));
    " 2>/dev/null || echo "")

    while IFS= read -r LINE; do
      [[ -z "$LINE" ]] && continue
      ROLE_NAME="${LINE%%|*}"
      ROLE_TITLE="${LINE#*|}"
      RBODY=$(mktemp /tmp/role_XXXXXX.json)
      printf '{"name":"%s","title":"%s"}' "$ROLE_NAME" "$ROLE_TITLE" > "$RBODY"
      nb api resource create --resource roles --body-file "$RBODY" -j >/dev/null 2>&1 \
        && echo "  ✓ Role created: $ROLE_NAME" \
        || echo "  ✓ Role exists: $ROLE_NAME (skipped)"
      rm -f "$RBODY"
    done <<< "$ROLE_LINES"
  else
    echo "  ⚠ No acl/roles-with-permissions.json — skipping role creation"
  fi

  # Apply per-collection permissions for each role
  RESOURCES_DIR="$ACL_DIR/resources"
  if [[ -d "$RESOURCES_DIR" ]]; then
    TMPNODE=$(mktemp /tmp/aclbody_XXXXXX.js)
    cat > "$TMPNODE" << 'ACLEOF'
const fs = require('fs');
const { execSync } = require('child_process');
const resFile = process.argv[2];
const role = process.argv[3];
const coll = process.argv[4];

const raw = JSON.parse(fs.readFileSync(resFile));
const d = (raw && raw.data !== undefined) ? raw.data : raw;
const actions = (d.actions || []).map(a => ({
  name: a.name,
  fields: a.fields || [],
  scopeId: undefined   // scopeId is env-specific; omit for portability
}));

const body = {
  name: coll,
  usingActionsConfig: d.usingActionsConfig !== false,
  actions
};
const bf = fs.mkdtempSync('/tmp/acl') + '/body.json';
fs.writeFileSync(bf, JSON.stringify(body));

try {
  execSync(
    `nb api acl roles data-source-resources create --role-name "${role}" --data-source-key main --body-file "${bf}" -j`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  console.log(`  ✓ ACL ${role}/${coll}`);
} catch {
  try {
    execSync(
      `nb api acl roles data-source-resources update --role-name "${role}" --name "${coll}" --data-source-key main --body-file "${bf}" -j`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log(`  ✓ ACL updated ${role}/${coll}`);
  } catch (e2) {
    console.error(`  ⚠ ACL ${role}/${coll} skipped: ` + e2.message.slice(0, 120));
  }
}
fs.unlinkSync(bf);
ACLEOF

    # Discover role names from roles-with-permissions.json to parse filenames unambiguously.
    # Convention: acl/resources/role-{ROLE}-{COLLECTION}.json
    # Iterating by known role name avoids ambiguity when both role and collection use underscores.
    KNOWN_ROLES=""
    if [[ -f "$ROLE_FILE" ]]; then
      KNOWN_ROLES=$(node -e "
        const d = JSON.parse(require('fs').readFileSync('$ROLE_FILE'));
        (d.data || []).forEach(r => console.log(r.name));
      " 2>/dev/null || echo "")
    fi

    if [[ -z "$KNOWN_ROLES" ]]; then
      echo "  ⚠ No known roles — cannot apply resource permissions"
    else
      while IFS= read -r ROLE_NAME; do
        [[ -z "$ROLE_NAME" ]] && continue
        for RES_FILE in "$RESOURCES_DIR/role-${ROLE_NAME}-"*.json; do
          [[ -f "$RES_FILE" ]] || continue
          BASENAME=$(basename "$RES_FILE" .json)
          COLL_NAME="${BASENAME#role-${ROLE_NAME}-}"
          node "$TMPNODE" "$RES_FILE" "$ROLE_NAME" "$COLL_NAME" 2>&1
        done
      done <<< "$KNOWN_ROLES"
    fi

    rm -f "$TMPNODE"
  else
    echo "  (no acl/resources/ directory)"
  fi
fi

echo ""
echo "=== Apply complete ==="
echo "Verify: $NOCOBASE_URL/admin"
echo "Next: enable workflows via NocoBase UI after verifying each one."
echo "Rollback: nb revision restore $REVISION_NOTE"
