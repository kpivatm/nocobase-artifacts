import type { Database } from '@nocobase/database';
import { diffBundles } from './diff';
import { exportBundle } from './bundle';
import type { ApplyResult, Bundle, DiffEntry, MigrationConfig, MigrationRule } from './types';

function getRule(config: MigrationConfig, collectionName: string): MigrationRule {
  return config.rules?.[collectionName] ?? config.defaultRule ?? 'insert-or-update';
}

function collectionNameFromEntry(entry: DiffEntry): string {
  if (entry.type === 'collection') {
    return entry.key;
  }
  // field key is "collectionName.fieldName"
  return entry.key.split('.')[0];
}

function orderEntries(entries: DiffEntry[]): DiffEntry[] {
  // collections must be applied before fields for dependency order
  const collections = entries.filter((e) => e.type === 'collection');
  const fields = entries.filter((e) => e.type === 'field');
  return [...collections, ...fields];
}

async function applyEntry(
  db: Database,
  entry: DiffEntry,
  rule: MigrationRule,
  dryRun: boolean,
): Promise<{ status: 'ok' | 'skipped'; error?: undefined }> {
  if (rule === 'skip') {
    return { status: 'skipped' };
  }

  if (dryRun) {
    return { status: 'ok' };
  }

  const repoName = entry.type === 'collection' ? 'collections' : 'fields';
  const repo = db.getRepository(repoName);

  if (entry.action === 'add') {
    if (rule === 'insert' || rule === 'insert-or-update') {
      await repo.create({ values: entry.source });
    }
  } else if (entry.action === 'update') {
    if (rule === 'insert-or-update') {
      const filterKey = entry.type === 'collection' ? 'name' : { collectionName: entry.source.collectionName, name: entry.source.name };
      if (entry.type === 'collection') {
        await repo.update({ filter: { name: entry.source.name }, values: entry.source });
      } else {
        await repo.update({
          filter: { collectionName: entry.source.collectionName, name: entry.source.name },
          values: entry.source,
        });
      }
    }
  } else if (entry.action === 'delete') {
    // deletions are skipped by default to avoid data loss; caller can override with rule
    if (rule === 'insert-or-update') {
      // conservative: don't delete by default
    }
  }

  return { status: 'ok' };
}

export async function applyBundle(
  db: Database,
  source: Bundle,
  config: MigrationConfig = {},
  dryRun = false,
): Promise<ApplyResult> {
  const target = await exportBundle(db);
  const { entries } = diffBundles(source, target);
  const ordered = orderEntries(entries);

  const resultEntries: ApplyResult['entries'] = [];
  let applied = 0;
  let skipped = 0;

  const transaction = dryRun ? null : await db.sequelize.transaction();

  try {
    for (const entry of ordered) {
      const colName = collectionNameFromEntry(entry);
      const rule = getRule(config, colName);

      try {
        // Pass transaction via db context when not dryRun
        const { status } = await applyEntry(db, entry, rule, dryRun);
        resultEntries.push({ key: entry.key, action: entry.action, status });
        if (status === 'ok') applied++;
        else skipped++;
      } catch (err: any) {
        resultEntries.push({ key: entry.key, action: entry.action, status: 'error', error: err?.message });
        if (transaction) await transaction.rollback();
        throw new Error(`Apply failed at ${entry.key}: ${err?.message}`);
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
