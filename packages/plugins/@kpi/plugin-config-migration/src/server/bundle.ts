import type { Database } from '@nocobase/database';
import type {
  Bundle,
  CollectionSnapshot,
  DesktopRouteSnapshot,
  FieldSnapshot,
  FlowNodeSnapshot,
  RoleResourceActionSnapshot,
  RoleResourceSnapshot,
  RoleSnapshot,
  UISchemaSnapshot,
  WorkflowSnapshot,
} from './types';

const PLUGIN_VERSION = '0.2.0';

const EXCLUDE_FIELD_KEYS = new Set(['id', 'key', 'collectionKey', 'reverseKey', 'parentKey']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toJSON(row: unknown): Record<string, unknown> {
  if (row && typeof (row as Record<string, unknown>).toJSON === 'function') {
    return (row as { toJSON(): Record<string, unknown> }).toJSON();
  }
  return row as Record<string, unknown>;
}

function hasRepo(db: Database, name: string): boolean {
  try {
    db.getRepository(name);
    return true;
  } catch {
    return false;
  }
}

async function safeFindAll(db: Database, repoName: string, opts: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  if (!hasRepo(db, repoName)) return [];
  try {
    const rows = await db.getRepository(repoName).find({ sort: ['id'], ...opts });
    return rows.map(toJSON);
  } catch {
    return [];
  }
}

// ─── Stage 1: Collections & Fields ───────────────────────────────────────────

function sanitizeField(raw: Record<string, unknown>): FieldSnapshot {
  const sanitized: FieldSnapshot = {
    collectionName: raw.collectionName as string,
    name: raw.name as string,
    type: raw.type as string,
  };
  const copyKeys = [
    'interface', 'description', 'primaryKey', 'allowNull', 'unique',
    'defaultValue', 'uiSchema', 'target', 'foreignKey', 'targetKey',
    'sourceKey', 'through', 'otherKey', 'sortBy', 'onDelete',
    'dataIndex', 'createOnly',
  ];
  for (const k of copyKeys) {
    if (k in raw && raw[k] !== undefined) {
      sanitized[k] = raw[k];
    }
  }
  for (const k of EXCLUDE_FIELD_KEYS) {
    delete sanitized[k];
  }
  return sanitized;
}

function sanitizeCollection(raw: Record<string, unknown>): CollectionSnapshot {
  const c: CollectionSnapshot = { name: raw.name as string };
  if (raw.title !== undefined) c.title = raw.title as string;
  if ('description' in raw) c.description = (raw.description ?? null) as string | null;
  if ('hidden' in raw) c.hidden = (raw.hidden ?? false) as boolean;
  return c;
}

// ─── Stage 2: Workflows ───────────────────────────────────────────────────────

function sanitizeNode(raw: Record<string, unknown>, workflowKey: string, nodeKeyById: Map<number, string>): FlowNodeSnapshot {
  const upstreamId = raw.upstreamId as number | null;
  return {
    key: raw.key as string,
    workflowKey,
    type: raw.type as string,
    title: (raw.title ?? null) as string | null,
    config: (raw.config ?? {}) as Record<string, unknown>,
    branchIndex: (raw.branchIndex ?? null) as number | null,
    upstreamKey: upstreamId != null ? (nodeKeyById.get(upstreamId) ?? null) : null,
  };
}

async function exportWorkflows(db: Database): Promise<WorkflowSnapshot[]> {
  const rawWorkflows = await safeFindAll(db, 'workflows');
  const rawNodes = await safeFindAll(db, 'flow_nodes');

  const nodesByWorkflowId = new Map<number, Record<string, unknown>[]>();
  const nodeKeyById = new Map<number, string>();

  for (const node of rawNodes) {
    const wfId = node.workflowId as number;
    if (!nodesByWorkflowId.has(wfId)) nodesByWorkflowId.set(wfId, []);
    nodesByWorkflowId.get(wfId)!.push(node);
    if (node.id != null && node.key != null) {
      nodeKeyById.set(node.id as number, node.key as string);
    }
  }

  return rawWorkflows.map((wf) => {
    const wfId = wf.id as number;
    const wfKey = wf.key as string;
    const rawNodeList = nodesByWorkflowId.get(wfId) ?? [];

    // Topological sort: roots first (BFS), then children in order
    const byId = new Map(rawNodeList.map((n) => [n.id as number, n]));
    const ordered: Record<string, unknown>[] = [];
    const queue = rawNodeList.filter((n) => n.upstreamId == null);
    const visited = new Set<number>();
    while (queue.length) {
      const node = queue.shift()!;
      const nid = node.id as number;
      if (visited.has(nid)) continue;
      visited.add(nid);
      ordered.push(node);
      for (const child of rawNodeList) {
        if (child.upstreamId === nid) queue.push(child);
      }
    }
    // Nodes not reachable from any root (orphaned) — append at end
    for (const node of rawNodeList) {
      if (!visited.has(node.id as number)) ordered.push(node);
    }

    const nodes: FlowNodeSnapshot[] = ordered.map((n) => sanitizeNode(n, wfKey, nodeKeyById));

    return {
      key: wfKey,
      title: wf.title as string,
      type: wf.type as string,
      triggerType: wf.triggerType as string | undefined,
      config: (wf.config ?? {}) as Record<string, unknown>,
      enabled: Boolean(wf.enabled),
      description: (wf.description ?? null) as string | null,
      nodes,
    };
  });
}

// ─── Stage 2: ACL ─────────────────────────────────────────────────────────────

function sanitizeRole(raw: Record<string, unknown>): RoleSnapshot {
  return {
    name: raw.name as string,
    title: raw.title as string | undefined,
    description: (raw.description ?? null) as string | null,
    strategy: (raw.strategy ?? null) as Record<string, unknown> | null,
    default: Boolean(raw.default),
    allowConfigure: Boolean(raw.allowConfigure),
  };
}

function sanitizeRoleResource(raw: Record<string, unknown>, roleName: string): RoleResourceSnapshot {
  const rawActions = (raw.actions ?? []) as Record<string, unknown>[];
  const actions: RoleResourceActionSnapshot[] = rawActions.map((a) => ({
    name: a.name as string,
    fields: (a.fields ?? []) as string[],
  }));
  return {
    roleName,
    name: raw.name as string,
    usingActionsConfig: Boolean(raw.usingActionsConfig),
    actions,
  };
}

async function exportACL(db: Database): Promise<{ roles: RoleSnapshot[]; rolesResources: RoleResourceSnapshot[] }> {
  const rawRoles = await safeFindAll(db, 'roles');
  const rawResources = await safeFindAll(db, 'rolesResources', { appends: ['actions'] });

  const roles = rawRoles.map(sanitizeRole);
  const rolesResources = rawResources.map((r) =>
    sanitizeRoleResource(r, r.roleName as string),
  );

  return { roles, rolesResources };
}

// ─── Stage 2: UI Blueprints ───────────────────────────────────────────────────

const EXCLUDE_SCHEMA_KEYS = new Set(['createdAt', 'updatedAt', 'id']);

function sanitizeUISchema(raw: Record<string, unknown>): UISchemaSnapshot {
  const uid = (raw['x-uid'] ?? raw.uid ?? raw.name) as string;
  return {
    'x-uid': uid,
    name: raw.name as string | undefined,
    schema: (raw.schema ?? {}) as Record<string, unknown>,
    serverHooks: (raw.serverHooks ?? []) as unknown[],
  };
}

function sanitizeRoute(raw: Record<string, unknown>): DesktopRouteSnapshot {
  // uid field in desktopRoutes is the stable string natural key
  const uid = (raw.uid ?? raw.key ?? String(raw.id)) as string;
  const route: DesktopRouteSnapshot = { uid };
  const copyKeys = [
    'title', 'type', 'icon', 'menuSchemaUid', 'schemaUid',
    'parentUid', 'sort', 'path',
  ];
  for (const k of copyKeys) {
    if (k in raw && raw[k] !== undefined) {
      route[k] = raw[k];
    }
  }
  for (const k of EXCLUDE_SCHEMA_KEYS) {
    delete route[k];
  }
  return route;
}

async function exportUIBlueprints(db: Database): Promise<{
  uiSchemas: UISchemaSnapshot[];
  desktopRoutes: DesktopRouteSnapshot[];
}> {
  const rawSchemas = await safeFindAll(db, 'uiSchemas');
  const rawRoutes = await safeFindAll(db, 'desktopRoutes', { sort: ['sort', 'id'] });

  return {
    uiSchemas: rawSchemas.map(sanitizeUISchema),
    desktopRoutes: rawRoutes.map(sanitizeRoute),
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function exportBundle(db: Database): Promise<Bundle> {
  const collectionsRepo = db.getRepository('collections');
  const fieldsRepo = db.getRepository('fields');

  const [rawCollections, rawFields] = await Promise.all([
    collectionsRepo.find({ sort: ['name'] }),
    fieldsRepo.find({ sort: ['collectionName', 'name'] }),
  ]);

  const collections: CollectionSnapshot[] = rawCollections.map((c: unknown) =>
    sanitizeCollection(toJSON(c)),
  );
  const fields: FieldSnapshot[] = rawFields.map((f: unknown) => {
    const raw = toJSON(f);
    if ('id' in raw) delete raw.id;
    return sanitizeField(raw);
  });

  const [workflows, { roles, rolesResources }, { uiSchemas, desktopRoutes }] = await Promise.all([
    exportWorkflows(db),
    exportACL(db),
    exportUIBlueprints(db),
  ]);

  return {
    version: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    collections,
    fields,
    workflows,
    roles,
    rolesResources,
    uiSchemas,
    desktopRoutes,
  };
}
