export interface FieldSnapshot {
  collectionName: string;
  name: string;
  type: string;
  interface?: string;
  description?: string | null;
  primaryKey?: boolean;
  allowNull?: boolean;
  unique?: boolean;
  defaultValue?: any;
  uiSchema?: Record<string, any>;
  [key: string]: any;
}

export interface CollectionSnapshot {
  name: string;
  title?: string;
  description?: string | null;
  hidden?: boolean;
  [key: string]: any;
}

export interface Bundle {
  version: string;
  exportedAt: string;
  collections: CollectionSnapshot[];
  fields: FieldSnapshot[];
}

export interface DiffEntry {
  action: 'add' | 'update' | 'delete';
  type: 'collection' | 'field';
  key: string;
  source?: any;
  target?: any;
}

export interface DiffResult {
  entries: DiffEntry[];
}

export type MigrationRule = 'insert' | 'insert-or-update' | 'skip';

export interface MigrationConfig {
  rules?: Record<string, MigrationRule>;
  defaultRule?: MigrationRule;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  dryRun: boolean;
  entries: Array<{ key: string; action: string; status: 'ok' | 'skipped' | 'error'; error?: string }>;
}
