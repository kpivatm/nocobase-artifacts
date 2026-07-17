import type {
  Bundle,
  CollectionSnapshot,
  DesktopRouteSnapshot,
  DiffEntry,
  DiffEntryType,
  DiffResult,
  FieldSnapshot,
  FlowNodeSnapshot,
  RoleResourceSnapshot,
  RoleSnapshot,
  UISchemaSnapshot,
  WorkflowSnapshot,
} from './types';

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffItems<T>(
  sourceItems: T[],
  targetItems: T[],
  getKey: (item: T) => string,
  type: DiffEntryType,
  getWarnings?: (src: T, tgt: T) => string[],
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const sourceMap = new Map<string, T>(sourceItems.map((i) => [getKey(i), i]));
  const targetMap = new Map<string, T>(targetItems.map((i) => [getKey(i), i]));

  for (const [key, src] of sourceMap) {
    const tgt = targetMap.get(key);
    if (!tgt) {
      entries.push({ action: 'add', type, key, source: src });
    } else if (!deepEqual(src, tgt)) {
      const warnings = getWarnings ? getWarnings(src, tgt) : [];
      const entry: DiffEntry = { action: 'update', type, key, source: src, target: tgt };
      if (warnings.length) entry.warnings = warnings;
      entries.push(entry);
    }
  }

  for (const [key, tgt] of targetMap) {
    if (!sourceMap.has(key)) {
      entries.push({ action: 'delete', type, key, target: tgt });
    }
  }

  return entries;
}

// ─── Field type-change warning ────────────────────────────────────────────────

function fieldWarnings(src: FieldSnapshot, tgt: FieldSnapshot): string[] {
  if (src.type !== tgt.type) {
    return [
      `Field type change detected on "${src.collectionName}.${src.name}": ` +
        `${tgt.type} → ${src.type}. ` +
        'Manual migration required — apply will skip this update to prevent data loss.',
    ];
  }
  return [];
}

// ─── Key functions ────────────────────────────────────────────────────────────

const collectionKey = (c: CollectionSnapshot): string => c.name;
const fieldKey = (f: FieldSnapshot): string => `${f.collectionName}.${f.name}`;
const workflowKey = (w: WorkflowSnapshot): string => w.key;
const flowNodeKey = (n: FlowNodeSnapshot): string => `${n.workflowKey}.${n.key}`;
const roleKey = (r: RoleSnapshot): string => r.name;
const roleResourceKey = (r: RoleResourceSnapshot): string => `${r.roleName}.${r.name}`;
const uiSchemaKey = (s: UISchemaSnapshot): string => s['x-uid'];
const desktopRouteKey = (r: DesktopRouteSnapshot): string => r.uid;

// ─── Main diff ────────────────────────────────────────────────────────────────

export function diffBundles(source: Bundle, target: Bundle): DiffResult {
  const entries: DiffEntry[] = [
    ...diffItems(source.collections, target.collections, collectionKey, 'collection'),
    ...diffItems(source.fields, target.fields, fieldKey, 'field', fieldWarnings),
  ];

  // Stage 2 domains — only diff when present in source bundle
  if (source.workflows !== undefined) {
    const srcWorkflows = source.workflows;
    const tgtWorkflows = target.workflows ?? [];
    entries.push(...diffItems(srcWorkflows, tgtWorkflows, workflowKey, 'workflow'));

    // Diff individual flow nodes (across all workflows)
    const srcNodes = srcWorkflows.flatMap((w) => w.nodes);
    const tgtNodes = (tgtWorkflows).flatMap((w) => w.nodes);
    entries.push(...diffItems(srcNodes, tgtNodes, flowNodeKey, 'flow_node'));
  }

  if (source.roles !== undefined) {
    entries.push(...diffItems(source.roles, target.roles ?? [], roleKey, 'role'));
  }

  if (source.rolesResources !== undefined) {
    entries.push(...diffItems(
      source.rolesResources,
      target.rolesResources ?? [],
      roleResourceKey,
      'roles_resource',
    ));
  }

  if (source.uiSchemas !== undefined) {
    entries.push(...diffItems(source.uiSchemas, target.uiSchemas ?? [], uiSchemaKey, 'ui_schema'));
  }

  if (source.desktopRoutes !== undefined) {
    entries.push(...diffItems(
      source.desktopRoutes,
      target.desktopRoutes ?? [],
      desktopRouteKey,
      'desktop_route',
    ));
  }

  return { entries };
}
