import type { Database } from '@nocobase/database';
import { exportBundle } from './bundle';
import { applyBundle } from './apply';
import type { BackupInfo, RollbackResult, Bundle } from './types';

/**
 * Create a config backup by exporting the current bundle via the plugin's own
 * export mechanism.  No Backup Manager / pg_dump dependency.
 *
 * Returns the full bundle so callers can pass it directly to restoreFromBundle().
 */
export async function createBackup(db: Database): Promise<BackupInfo & { bundle: Bundle }> {
  const bundle = await exportBundle(db);
  return {
    available: true,
    filename: `config-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    createdAt: new Date().toISOString(),
    bundle,
  };
}

/**
 * Restore config by re-applying a previously exported bundle.
 * This is the inverse of applyBundle: it writes the old state back over the current one.
 */
export async function restoreFromBundle(
  db: Database,
  bundle: Bundle,
): Promise<RollbackResult> {
  const result = await applyBundle(db, bundle, {}, false, false);
  const firstError = result.entries.find((e) => e.status === 'error');
  return {
    success: !firstError,
    filename: bundle.exportedAt ?? 'unknown',
    restoredAt: new Date().toISOString(),
    ...(firstError ? { error: firstError.error } : {}),
  };
}
