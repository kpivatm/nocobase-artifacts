import type { Database } from '@nocobase/database';
import type { Transaction } from 'sequelize';
import { diffBundles } from './diff';
import { exportBundle } from './bundle';
import { createBackup } from './backup';
import type {
  ApplyResult,
  ApplyResultEntry,
  BackupInfo,
  Bundle,
  DiffEntry,
  FlowNodeSnapshot,
  MigrationConfig,
  MigrationRule,
  UISchemaSnapshot,
  WorkflowSnapshot,
} from './types';

// ─── Redaction-aware config helpers ──────────────────────────────────────────
// Export redacts known-sensitive keys with this sentinel. Apply must never write
// the sentinel back to the DB: on add, drop redacted keys; on update, preserve
// the target's existing value for any key whose source value is the sentinel.

const REDACTED_SENTINEL = '[REDACTED]';

function hasRedactedValues(v: unknown): boolean {
  if (v === REDACTED_SENTINEL) return true;
  if (Array.isArray(v)) return v.some(hasRedactedValues);
  if (v !== null && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some(hasRedactedValues);
  }
  return false;
}

function stripRedactedFromConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === REDACTED_SENTINEL) continue;
    if (Array.isArray(v)) {
      result[k] = v.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? stripRedactedFromConfig(item as Record<string, unknown>)
          : item,
      );
    } else if (v !== null && typeof v === 'object') {
      result[k] = stripRedactedFromConfig(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function mergePreservingRedacted(
  sourceConfig: Record<string, unknown>,
  targetConfig: Record<string, unknown>,
): Record<string, unknown> {
  // For update: where source has [REDACTED] (scalar or array containing it),
  // keep the target's existing value so real credentials are never overwritten.
  const result = { ...targetConfig };
  for (const [k, sv] of Object.entries(sourceConfig)) {
    if (sv === REDACTED_SENTINEL) {
      // Keep result[k] from target
      continue;
    }
    if (Array.isArray(sv)) {
      // If source array contains any [REDACTED] at any depth, keep target array
      result[k] = hasRedactedValues(sv) ? (result[k] ?? sv) : sv;
    } else if (sv !== null && typeof sv === 'object') {
      const tv = result[k];
      if (tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
        result[k] = mergePreservingRedacted(sv as Record<string, unknown>, tv as Record<string, unknown>);
      } else {
        result[k] = stripRedactedFromConfig(sv as Record<string, unknown>);
      }
    } else {
      result[k] = sv;
    }
  }
  return result;
}

// ─── Rule helpers ─────────────────────────────────────────────────────────────

function parentDomainKey(entry: DiffEntry): string | null {
  // field key = "collectionName.fieldName" → parent = collection name
  // flow_node key = "workflowKey.nodeKey" → parent = workflow key
  // roles_resource key = "roleName.resourceName" → parent = role name
  if (entry.type === 'field' || entry.type === 'flow_node' || entry.type === 'roles_resource') {
    const dot = entry.key.indexOf('.');
    if (dot >= 0) return entry.key.slice(0, dot);
  }
  return null;
}

function getRule(config: MigrationConfig, entry: DiffEntry): MigrationRule {
  // Try exact key first, then fall back to parent domain so that
  // rules: { orders: 'skip' } also skips every orders.* field entry.
  if (config.rules) {
    if (config.rules[entry.key] !== undefined) return config.rules[entry.key];
    const parent = parentDomainKey(entry);
    if (parent !== null && config.rules[parent] !== undefined) return config.rules[parent];
  }
  return config.defaultRule ?? 'insert-or-update';
}

// ─── Dependency order for apply ───────────────────────────────────────────────

const TYPE_ORDER: Record<string, number> = {
  collection: 0,
  field: 1,
  workflow: 2,
  flow_node: 3,
  role: 4,
  roles_resource: 5,
  ui_schema: 6,
  desktop_route: 7,
};

function topoSortRouteAdds(routes: DiffEntry[]): DiffEntry[] {
  const byUid = new Map(routes.map(e => [e.key, e]));
  const result: DiffEntry[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // cycle guard

  function visit(e: DiffEntry): void {
    if (visited.has(e.key) || visiting.has(e.key)) return;
    visiting.add(e.key);
    const src = e.source as Record<string, unknown> | undefined;
    const parentUid = src?.parentUid as string | undefined;
    if (parentUid && byUid.has(parentUid)) visit(byUid.get(parentUid)!);
    visiting.delete(e.key);
    visited.add(e.key);
    result.push(e);
  }

  for (const e of routes) visit(e);
  return result;
}

function orderEntries(entries: DiffEntry[]): DiffEntry[] {
  // Step 1: global sort — add/update in forward type order, deletes in reverse
  const sorted = [...entries].sort((a, b) => {
    const aOrder = TYPE_ORDER[a.type] ?? 99;
    const bOrder = TYPE_ORDER[b.type] ?? 99;
    if (a.action === 'delete' && b.action === 'delete') return bOrder - aOrder;
    if (a.action === 'delete') return 1;
    if (b.action === 'delete') return -1;
    return aOrder - bOrder;
  });

  // Step 2: within desktop_route add/update entries, sort parents before children
  const routeAddIdxs: number[] = [];
  sorted.forEach((e, i) => {
    if (e.type === 'desktop_route' && e.action !== 'delete') routeAddIdxs.push(i);
  });
  if (routeAddIdxs.length > 0) {
    const routeAdds = routeAddIdxs.map(i => sorted[i]);
    const topoRoutes = topoSortRouteAdds(routeAdds);
    routeAddIdxs.forEach((idx, i) => { sorted[idx] = topoRoutes[i]; });
  }

  return sorted;
}

// ─── Workflow node application (topological) ─────────────────────────────────

async function applyWorkflowNodes(
  db: Database,
  workflowId: number,
  nodes: FlowNodeSnapshot[],
  txOpt: Record<string, unknown>,
  existingKeyToId: Map<string, number> = new Map(),
): Promise<void> {
  const flowNodesRepo = db.getRepository('flow_nodes');
  const keyToNewId = new Map<string, number>(existingKeyToId);

  // nodes are already in topo order from export (roots first)
  for (const node of nodes) {
    const upstreamId = node.upstreamKey != null ? (keyToNewId.get(node.upstreamKey) ?? null) : null;
    const created = await flowNodesRepo.create({
      values: {
        key: node.key,
        workflowId,
        type: node.type,
        title: node.title ?? null,
        config: stripRedactedFromConfig(node.config ?? {}),
        branchIndex: node.branchIndex ?? null,
        upstreamId,
      },
      ...txOpt,
    });
    const newId = (created as Record<string, unknown>).id as number;
    keyToNewId.set(node.key, newId);
  }
}

async function applyWorkflowAdd(
  db: Database,
  wf: WorkflowSnapshot,
  txOpt: Record<string, unknown>,
): Promise<void> {
  const workflowsRepo = db.getRepository('workflows');
  const created = await workflowsRepo.create({
    values: {
      key: wf.key,
      title: wf.title,
      type: wf.type,
      triggerType: wf.triggerType,
      config: stripRedactedFromConfig(wf.config ?? {}),
      enabled: wf.enabled,
      description: wf.description ?? null,
    },
    ...txOpt,
  });
  const newId = (created as Record<string, unknown>).id as number;
  if (wf.nodes.length > 0) {
    await applyWorkflowNodes(db, newId, wf.nodes, txOpt);
  }
}

async function applyWorkflowUpdate(
  db: Database,
  wf: WorkflowSnapshot,
  txOpt: Record<string, unknown>,
): Promise<void> {
  const workflowsRepo = db.getRepository('workflows');
  // Read raw config from DB — entry.target.config is already redacted by exportBundle
  // and would re-introduce [REDACTED] into the merge base, defeating the protection.
  const existingRows = await workflowsRepo.find({ filter: { key: wf.key }, ...txOpt });
  const rawTargetConfig = existingRows.length > 0
    ? ((existingRows[0] as unknown as Record<string, unknown>).config ?? {}) as Record<string, unknown>
    : {};
  await workflowsRepo.update({
    filter: { key: wf.key },
    values: {
      title: wf.title,
      type: wf.type,
      triggerType: wf.triggerType,
      config: mergePreservingRedacted(wf.config ?? {}, rawTargetConfig),
      enabled: wf.enabled,
      description: wf.description ?? null,
    },
    ...txOpt,
  });
}

// ─── Stage 3: full workflow-graph node add ────────────────────────────────────
// Add a node to an existing workflow by first loading the existing graph
// so that upstreamKey → upstreamId can be resolved correctly.

async function addNodeToExistingWorkflow(
  db: Database,
  src: FlowNodeSnapshot,
  txOpt: Record<string, unknown>,
): Promise<{ status: 'ok' | 'skipped'; warning?: string }> {
  const flowNodesRepo = db.getRepository('flow_nodes');
  // Include txOpt so reads see the current transaction state (uncommitted siblings)
  const wfRows = await db.getRepository('workflows').find({ filter: { key: src.workflowKey }, ...txOpt });
  if (wfRows.length === 0) {
    return { status: 'skipped', warning: `Parent workflow "${src.workflowKey}" not found` };
  }
  const wfId = (wfRows[0] as unknown as Record<string, unknown>).id as number;

  // Build key→id map from existing nodes in this workflow
  const existingNodes = await flowNodesRepo.find({ filter: { workflowId: wfId }, ...txOpt });
  const existingKeyToId = new Map<string, number>();
  for (const n of existingNodes) {
    const row = (n as unknown as Record<string, unknown>);
    if (row.key != null && row.id != null) {
      existingKeyToId.set(row.key as string, row.id as number);
    }
  }

  const upstreamId = src.upstreamKey != null ? (existingKeyToId.get(src.upstreamKey) ?? null) : null;
  const created = await flowNodesRepo.create({
    values: {
      key: src.key,
      workflowId: wfId,
      type: src.type,
      title: src.title ?? null,
      config: stripRedactedFromConfig(src.config ?? {}),
      branchIndex: src.branchIndex ?? null,
      upstreamId,
    },
    ...txOpt,
  });
  existingKeyToId.set(src.key, (created as Record<string, unknown>).id as number);
  return { status: 'ok' };
}

// ─── Stage 3: UiSchema apply via UiSchemaRepository ──────────────────────────

interface UiSchemaRepository {
  insert(data: Record<string, unknown>, options?: Record<string, unknown>): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(opts: Record<string, unknown>): Promise<unknown>;
}

async function applyUISchema(
  db: Database,
  entry: DiffEntry,
  rule: MigrationRule,
  txOpt: Record<string, unknown>,
): Promise<{ status: 'ok' | 'skipped'; warning?: string }> {
  const src = entry.source as UISchemaSnapshot;

  // UiSchemaRepository rebuilds the uiSchemaTreePath table on insert.
  // Plain repo.create() does not, which causes schemas to fail rendering.
  let repo: UiSchemaRepository;
  try {
    repo = db.getRepository('uiSchemas') as unknown as UiSchemaRepository;
    if (typeof repo.insert !== 'function') {
      throw new Error('not a UiSchemaRepository');
    }
  } catch {
    return {
      status: 'skipped',
      warning: `ui_schema "${src['x-uid']}" skipped: UiSchemaRepository not available (plugin-ui-schema-storage may not be loaded)`,
    };
  }

  if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
    const schemaData: Record<string, unknown> = {
      'x-uid': src['x-uid'],
      name: src.name,
      ...(src.schema ?? {}),
    };
    await repo.insert(schemaData, txOpt);
    return { status: 'ok' };
  }

  if (entry.action === 'update' && rule === 'insert-or-update') {
    await repo.update({
      filter: { 'x-uid': src['x-uid'] },
      values: { schema: src.schema ?? {} },
      ...txOpt,
    });
    return { status: 'ok' };
  }

  return { status: 'skipped' };
}

// ─── Per-entry apply ──────────────────────────────────────────────────────────

async function applyEntry(
  db: Database,
  entry: DiffEntry,
  rule: MigrationRule,
  dryRun: boolean,
  transaction: Transaction | null,
): Promise<{ status: 'ok' | 'skipped'; warning?: string }> {
  if (rule === 'skip') return { status: 'skipped' };
  if (dryRun) return { status: 'ok' };

  const txOpt = transaction ? { transaction } : {};

  // Field type-change: skip update to prevent data loss
  if (entry.type === 'field' && entry.action === 'update' && entry.warnings?.length) {
    return {
      status: 'skipped',
      warning: entry.warnings[0],
    };
  }

  // Stage 3: support deletions for flow_nodes (reverse topo order handled by orderEntries)
  if (entry.action === 'delete') {
    if (entry.type === 'flow_node') {
      const tgt = entry.target as FlowNodeSnapshot;
      const wfRows = await db.getRepository('workflows').find({ filter: { key: tgt.workflowKey }, ...txOpt });
      const wfId = wfRows.length > 0 ? (wfRows[0] as unknown as Record<string, unknown>).id as number : null;
      if (wfId == null) return { status: 'skipped', warning: `Parent workflow "${tgt.workflowKey}" not found for delete` };
      await db.getRepository('flow_nodes').destroy({
        filter: { key: tgt.key, workflowId: wfId },
        ...txOpt,
      });
      return { status: 'ok' };
    }
    // All other delete types skipped to avoid accidental data loss
    return { status: 'skipped' };
  }

  if (entry.type === 'collection') {
    const repo = db.getRepository('collections');
    const colSrc = entry.source as Record<string, any>;
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: colSrc, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({ filter: { name: colSrc.name }, values: colSrc, ...txOpt });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'field') {
    const repo = db.getRepository('fields');
    const src = entry.source as Record<string, any>;
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: src, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({
        filter: { collectionName: src.collectionName, name: src.name },
        values: src,
        ...txOpt,
      });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'workflow') {
    const src = entry.source as WorkflowSnapshot;
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await applyWorkflowAdd(db, src, txOpt);
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await applyWorkflowUpdate(db, src, txOpt);
    }
    return { status: 'ok' };
  }

  if (entry.type === 'flow_node') {
    const src = entry.source as FlowNodeSnapshot;
    const repo = db.getRepository('flow_nodes');

    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      // Stage 3: add node to existing workflow with full graph context
      return addNodeToExistingWorkflow(db, src, txOpt);
    }

    if (entry.action === 'update' && rule === 'insert-or-update') {
      // Resolve workflowId to make filter globally unique (key alone is not guaranteed unique)
      const wfRows = await db.getRepository('workflows').find({ filter: { key: src.workflowKey }, ...txOpt });
      const wfId = wfRows.length > 0 ? (wfRows[0] as unknown as Record<string, unknown>).id as number : null;
      if (wfId == null) return { status: 'skipped', warning: `Parent workflow "${src.workflowKey}" not found` };
      // Read raw config from DB — entry.target.config is already redacted by exportBundle
      // and cannot be used as the merge base (real secret would remain [REDACTED] after merge).
      const existingNodes = await repo.find({ filter: { key: src.key, workflowId: wfId }, ...txOpt });
      const rawNodeConfig = existingNodes.length > 0
        ? ((existingNodes[0] as unknown as Record<string, unknown>).config ?? {}) as Record<string, unknown>
        : {};
      await repo.update({
        filter: { key: src.key, workflowId: wfId },
        values: {
          type: src.type,
          title: src.title ?? null,
          config: mergePreservingRedacted(src.config ?? {}, rawNodeConfig),
          branchIndex: src.branchIndex ?? null,
        },
        ...txOpt,
      });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'role') {
    const src = entry.source as Record<string, any>;
    const repo = db.getRepository('roles');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: src, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({ filter: { name: src.name }, values: src, ...txOpt });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'roles_resource') {
    const src = entry.source as Record<string, any>;
    const repo = db.getRepository('rolesResources');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: src, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({
        filter: { roleName: src.roleName, name: src.name },
        values: src,
        ...txOpt,
      });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'ui_schema') {
    return applyUISchema(db, entry, rule, txOpt);
  }

  if (entry.type === 'desktop_route') {
    const src = entry.source as Record<string, any>;
    const repo = db.getRepository('desktopRoutes');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: src, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({ filter: { uid: src.uid }, values: src, ...txOpt });
    }
    return { status: 'ok' };
  }

  return { status: 'skipped' };
}

// ─── Version compatibility check ─────────────────────────────────────────────

function checkVersionCompat(source: Bundle, targetNocobaseVersion: string | undefined): string | null {
  if (!source.nocobaseVersion || !targetNocobaseVersion) return null;
  const srcMajor = parseInt(source.nocobaseVersion.split('.')[0], 10);
  const tgtMajor = parseInt(targetNocobaseVersion.split('.')[0], 10);
  if (!isNaN(srcMajor) && !isNaN(tgtMajor) && srcMajor !== tgtMajor) {
    return `Version mismatch: bundle exported from NocoBase ${source.nocobaseVersion}, target is ${targetNocobaseVersion}. Major version difference may cause schema incompatibility.`;
  }
  return null;
}

// ─── Main apply ───────────────────────────────────────────────────────────────

export async function applyBundle(
  db: Database,
  source: Bundle,
  config: MigrationConfig = {},
  dryRun = false,
  doBackup = true,
): Promise<ApplyResult> {
  const target = await exportBundle(db);

  // Stage 3: version compatibility warning (non-blocking)
  const versionWarning = checkVersionCompat(source, target.nocobaseVersion);

  const { entries } = diffBundles(source, target);
  const ordered = orderEntries(entries);

  const resultEntries: ApplyResultEntry[] = [];
  let applied = 0;
  let skipped = 0;

  // Stage 3: pre-apply config backup (plugin-self, no pg_dump)
  let backupInfo: BackupInfo | undefined;
  if (!dryRun && doBackup) {
    backupInfo = await createBackup(db);
  }

  const resultWarnings: string[] = [];
  if (versionWarning) resultWarnings.push(versionWarning);

  const transaction = dryRun ? null : await db.sequelize.transaction();

  try {
    for (const entry of ordered) {
      const rule = getRule(config, entry);

      try {
        const { status, warning } = await applyEntry(db, entry, rule, dryRun, transaction);
        const resultEntry: ApplyResultEntry = { key: entry.key, action: entry.action, status };
        if (warning) resultEntry.warning = warning;
        resultEntries.push(resultEntry);
        if (status === 'ok') applied++;
        else skipped++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        resultEntries.push({ key: entry.key, action: entry.action, status: 'error', error: message });
        if (transaction) await transaction.rollback();
        throw new Error(`Apply failed at ${entry.key}: ${message}`);
      }
    }

    if (transaction) await transaction.commit();
  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch { /* already rolled back */ }
    }
    throw err;
  }

  const result: ApplyResult = { applied, skipped, dryRun, entries: resultEntries };
  if (backupInfo !== undefined) result.backup = backupInfo;
  if (resultWarnings.length > 0) result.warnings = resultWarnings;
  return result;
}
