// ─── Stage 1: Collections & Fields ───────────────────────────────────────────

export interface FieldSnapshot {
  collectionName: string;
  name: string;
  type: string;
  interface?: string;
  description?: string | null;
  primaryKey?: boolean;
  allowNull?: boolean;
  unique?: boolean;
  defaultValue?: unknown;
  uiSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CollectionSnapshot {
  name: string;
  title?: string;
  description?: string | null;
  hidden?: boolean;
}

// ─── Stage 2: Workflows ───────────────────────────────────────────────────────

export interface FlowNodeSnapshot {
  key: string;
  workflowKey: string;
  type: string;
  title?: string | null;
  config?: Record<string, unknown>;
  branchIndex?: number | null;
  upstreamKey?: string | null; // natural-key ref to upstream node (null = root)
}

export interface WorkflowSnapshot {
  key: string;
  title: string;
  type: string;
  triggerType?: string;
  config?: Record<string, unknown>;
  enabled: boolean;
  description?: string | null;
  nodes: FlowNodeSnapshot[];
}

// ─── Stage 2: ACL ─────────────────────────────────────────────────────────────

export interface RoleResourceActionSnapshot {
  name: string;
  fields?: string[];
}

export interface RoleResourceSnapshot {
  roleName: string;
  name: string; // resource / collection name
  usingActionsConfig?: boolean;
  actions?: RoleResourceActionSnapshot[];
}

export interface RoleSnapshot {
  name: string;
  title?: string;
  description?: string | null;
  strategy?: Record<string, unknown> | null;
  default?: boolean;
  allowConfigure?: boolean;
}

// ─── Stage 2: UI Blueprints ───────────────────────────────────────────────────

// NOTE: x-uid values are generated per-instance. Applying across a fresh
// installation will treat non-matching x-uid values as new additions.
// This is expected behaviour for the same running instance migrated across
// environments; cross-instance schema merging requires a separate uid-map step.
export interface UISchemaSnapshot {
  'x-uid': string;
  name?: string;
  schema?: Record<string, unknown>;
  serverHooks?: unknown[];
}

export interface DesktopRouteSnapshot {
  uid: string; // stable natural key (string uid, not auto-increment rowid)
  title?: string;
  type?: string;
  icon?: string | null;
  menuSchemaUid?: string | null;
  schemaUid?: string | null;
  parentUid?: string | null;
  sort?: number;
  path?: string | null;
  [key: string]: unknown;
}

// ─── Bundle (all domains) ─────────────────────────────────────────────────────

export interface Bundle {
  version: string;
  exportedAt: string;
  nocobaseVersion?: string; // Stage 3: version included for compatibility check
  // Stage 3: set when any workflow/node config field was redacted on export
  hasRedactedFields?: boolean;
  // Stage 1
  collections: CollectionSnapshot[];
  fields: FieldSnapshot[];
  // Stage 2 (optional so bundles from Stage 1 remain valid)
  workflows?: WorkflowSnapshot[];
  roles?: RoleSnapshot[];
  rolesResources?: RoleResourceSnapshot[];
  uiSchemas?: UISchemaSnapshot[];
  desktopRoutes?: DesktopRouteSnapshot[];
}

// ─── Stage 3: Backup / Rollback ──────────────────────────────────────────────

export interface BackupInfo {
  available: boolean;
  filename?: string;
  createdAt?: string;
}

export interface RollbackResult {
  success: boolean;
  filename: string;
  restoredAt: string;
  error?: string;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

export type DiffEntryType =
  | 'collection'
  | 'field'
  | 'workflow'
  | 'flow_node'
  | 'role'
  | 'roles_resource'
  | 'ui_schema'
  | 'desktop_route';

export interface DiffEntry {
  action: 'add' | 'update' | 'delete';
  type: DiffEntryType;
  key: string;
  source?: unknown;
  target?: unknown;
  warnings?: string[];
}

export interface DiffResult {
  entries: DiffEntry[];
}

// ─── Migration config ─────────────────────────────────────────────────────────

export type MigrationRule = 'insert' | 'insert-or-update' | 'skip';

export interface MigrationConfig {
  rules?: Record<string, MigrationRule>;
  defaultRule?: MigrationRule;
}

// ─── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyResultEntry {
  key: string;
  action: string;
  status: 'ok' | 'skipped' | 'error';
  error?: string;
  warning?: string;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  dryRun: boolean;
  entries: ApplyResultEntry[];
  backup?: BackupInfo; // Stage 3: backup info if backup was performed
  warnings?: string[]; // non-entry-level warnings (e.g. version mismatch)
}
