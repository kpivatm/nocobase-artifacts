import type { Database } from '@nocobase/database';
import type { Bundle, CollectionSnapshot, FieldSnapshot } from './types';

const PLUGIN_VERSION = '0.1.0';

const EXCLUDE_FIELD_KEYS = new Set(['id', 'key', 'collectionKey', 'reverseKey', 'parentKey']);

function sanitizeField(raw: any): FieldSnapshot {
  const sanitized: FieldSnapshot = {
    collectionName: raw.collectionName,
    name: raw.name,
    type: raw.type,
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
  // Strip auto-increment integer IDs (numeric database-assigned keys)
  for (const k of EXCLUDE_FIELD_KEYS) {
    delete sanitized[k];
  }
  return sanitized;
}

function sanitizeCollection(raw: any): CollectionSnapshot {
  const c: CollectionSnapshot = { name: raw.name };
  if (raw.title !== undefined) c.title = raw.title;
  if ('description' in raw) c.description = raw.description ?? null;
  if ('hidden' in raw) c.hidden = raw.hidden ?? false;
  return c;
}

export async function exportBundle(db: Database): Promise<Bundle> {
  const collectionsRepo = db.getRepository('collections');
  const fieldsRepo = db.getRepository('fields');

  const [rawCollections, rawFields] = await Promise.all([
    collectionsRepo.find({ sort: ['name'] }),
    fieldsRepo.find({ sort: ['collectionName', 'name'] }),
  ]);

  const collections: CollectionSnapshot[] = rawCollections.map((c: any) =>
    sanitizeCollection(c.toJSON ? c.toJSON() : c),
  );

  const fields: FieldSnapshot[] = rawFields.map((f: any) =>
    sanitizeField(f.toJSON ? f.toJSON() : f),
  );

  // Verify no auto-increment numeric IDs leaked into natural-key bundle
  for (const f of fields) {
    if ('id' in f) {
      delete (f as any).id;
    }
  }

  return {
    version: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    collections,
    fields,
  };
}
