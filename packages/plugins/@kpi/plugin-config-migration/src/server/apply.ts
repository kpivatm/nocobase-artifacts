import type { Database } from '@nocobase/database';
import type { Transaction } from 'sequelize';
import { diffBundles } from './diff';
import { exportBundle } from './bundle';
import type {
  ApplyResult,
  ApplyResultEntry,
  Bundle,
  DiffEntry,
  FlowNodeSnapshot,
  MigrationConfig,
  MigrationRule,
  WorkflowSnapshot,
} from './types';

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
): Promise<void> {
  const flowNodesRepo = db.getRepository('flow_nodes');
  const keyToNewId = new Map<string, number>();

  // nodes are already in topo order from export (roots first)
  for (const node of nodes) {
    const upstreamId = node.upstreamKey != null ? (keyToNewId.get(node.upstreamKey) ?? null) : null;
    const created = await flowNodesRepo.create({
      values: {
        key: node.key,
        workflowId,
        type: node.type,
        title: node.title ?? null,
        config: node.config ?? {},
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
      config: wf.config ?? {},
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
  await workflowsRepo.update({
    filter: { key: wf.key },
    values: {
      title: wf.title,
      type: wf.type,
      triggerType: wf.triggerType,
      config: wf.config ?? {},
      enabled: wf.enabled,
      description: wf.description ?? null,
    },
    ...txOpt,
  });
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

  if (entry.action === 'delete') {
    // Deletions are skipped by default to avoid data loss
    return { status: 'skipped' };
  }

  if (entry.type === 'collection') {
    const repo = db.getRepository('collections');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: entry.source, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({ filter: { name: (entry.source as Record<string, unknown>).name }, values: entry.source, ...txOpt });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'field') {
    const repo = db.getRepository('fields');
    const src = entry.source as Record<string, unknown>;
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
    // Individual flow_node entries represent nodes added/updated in existing workflows.
    // New workflows carry their own nodes via applyWorkflowAdd → applyWorkflowNodes.
    const src = entry.source as FlowNodeSnapshot;
    const repo = db.getRepository('flow_nodes');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      // Adding a node to an existing workflow requires the full graph context to resolve
      // upstreamId correctly. Creating with upstreamId=null produces an orphan node.
      // Deferred to Stage 3 (workflow diff + full graph rebuild); skip to avoid data corruption.
      return {
        status: 'skipped',
        warning: `flow_node "${src.key}" in "${src.workflowKey}" skipped: adding nodes to existing workflows requires full graph context (Stage 3)`,
      };
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      // Resolve workflowId to make filter globally unique (key alone is not guaranteed unique)
      const wfRows = await db.getRepository('workflows').find({ filter: { key: src.workflowKey } });
      const wfId = wfRows.length > 0 ? (wfRows[0] as unknown as Record<string, unknown>).id as number : null;
      if (wfId == null) return { status: 'skipped', warning: `Parent workflow "${src.workflowKey}" not found` };
      await repo.update({
        filter: { key: src.key, workflowId: wfId },
        values: {
          type: src.type,
          title: src.title ?? null,
          config: src.config ?? {},
          branchIndex: src.branchIndex ?? null,
        },
        ...txOpt,
      });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'role') {
    const src = entry.source as Record<string, unknown>;
    const repo = db.getRepository('roles');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: src, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({ filter: { name: src.name }, values: src, ...txOpt });
    }
    return { status: 'ok' };
  }

  if (entry.type === 'roles_resource') {
    const src = entry.source as Record<string, unknown>;
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
    // uiSchemas use UiSchemaRepository (insert/insertAdjacent) which rebuilds the
    // uiSchemaTreePath table. Generic repo.create() does not build the tree, so
    // round-trip apply would produce schemas that fail to render in the UI.
    // Apply is deferred to Stage 3; export and diff are fully supported.
    return {
      status: 'skipped',
      warning: `ui_schema "${entry.key}" apply deferred to Stage 3 (requires UiSchemaRepository for tree-path rebuild)`,
    };
  }

  if (entry.type === 'desktop_route') {
    const src = entry.source as Record<string, unknown>;
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

// ─── Main apply ───────────────────────────────────────────────────────────────

export async function applyBundle(
  db: Database,
  source: Bundle,
  config: MigrationConfig = {},
  dryRun = false,
): Promise<ApplyResult> {
  const target = await exportBundle(db);
  const { entries } = diffBundles(source, target);
  const ordered = orderEntries(entries);

  const resultEntries: ApplyResultEntry[] = [];
  let applied = 0;
  let skipped = 0;

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

  return { applied, skipped, dryRun, entries: resultEntries };
}
