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

function getRule(config: MigrationConfig, key: string): MigrationRule {
  return config.rules?.[key] ?? config.defaultRule ?? 'insert-or-update';
}

function domainKeyFromEntry(entry: DiffEntry): string {
  // For rules lookup: use the entry key (natural key) as the config key
  return entry.key;
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

function orderEntries(entries: DiffEntry[]): DiffEntry[] {
  // For add/update: forward dependency order (collections before fields, etc.)
  // For delete: reverse order (desktop_route before ui_schema, etc.)
  return [...entries].sort((a, b) => {
    const aOrder = TYPE_ORDER[a.type] ?? 99;
    const bOrder = TYPE_ORDER[b.type] ?? 99;
    if (a.action === 'delete' && b.action === 'delete') {
      return bOrder - aOrder; // reverse for deletes
    }
    if (a.action === 'delete') return 1;
    if (b.action === 'delete') return -1;
    return aOrder - bOrder;
  });
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
    // Individual flow_node add/update (handles nodes added to existing workflows)
    const src = entry.source as FlowNodeSnapshot;
    const repo = db.getRepository('flow_nodes');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      // Find parent workflow id by key
      const wfRows = await db.getRepository('workflows').find({ filter: { key: src.workflowKey } });
      const wfId = wfRows.length > 0 ? (wfRows[0] as unknown as Record<string, unknown>).id as number : null;
      if (wfId == null) return { status: 'skipped', warning: `Parent workflow "${src.workflowKey}" not found` };
      await repo.create({
        values: {
          key: src.key,
          workflowId: wfId,
          type: src.type,
          title: src.title ?? null,
          config: src.config ?? {},
          branchIndex: src.branchIndex ?? null,
          // upstreamId must be resolved separately; new isolated node has no upstream
          upstreamId: null,
        },
        ...txOpt,
      });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({
        filter: { key: src.key },
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
    const src = entry.source as Record<string, unknown>;
    const repo = db.getRepository('uiSchemas');
    if (entry.action === 'add' && (rule === 'insert' || rule === 'insert-or-update')) {
      await repo.create({ values: src, ...txOpt });
    } else if (entry.action === 'update' && rule === 'insert-or-update') {
      await repo.update({ filter: { 'x-uid': src['x-uid'] }, values: src, ...txOpt });
    }
    return { status: 'ok' };
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
      const ruleKey = domainKeyFromEntry(entry);
      const rule = getRule(config, ruleKey);

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
