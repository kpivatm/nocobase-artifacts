import type { BackupInfo, RollbackResult } from './types';

// Application type is typed loosely to avoid hard dependency on @nocobase/server internals.
type NocoBaseApp = {
  getPlugin: (name: string) => unknown;
  resourceManager: {
    getAction: (resource: string, action: string) => ((ctx: unknown, next: () => Promise<void>) => Promise<void>) | undefined;
  };
};

interface BackupFileRecord {
  name: string;
  createdAt?: string;
}

interface BackupCreateContext {
  body: BackupFileRecord | null;
  status: number;
}

interface BackupRestoreContext {
  action: { params: { filterByTk: string } };
  body: unknown;
  status: number;
}

const BACKUP_RESTORE_PLUGIN = '@nocobase/plugin-backup-restore';

function isBackupRestoreAvailable(app: NocoBaseApp): boolean {
  try {
    const plugin = app.getPlugin(BACKUP_RESTORE_PLUGIN);
    return plugin != null;
  } catch {
    return false;
  }
}

/**
 * Create a full backup via the Backup Manager plugin.
 * Returns { available: false } when the plugin is not installed.
 */
export async function createBackup(app: NocoBaseApp): Promise<BackupInfo> {
  if (!isBackupRestoreAvailable(app)) {
    return { available: false };
  }

  const createAction = app.resourceManager.getAction('backupFiles', 'create');
  if (!createAction) {
    return { available: false };
  }

  const ctx: BackupCreateContext = { body: null, status: 200 };

  try {
    await createAction(ctx, async () => {});
    if (ctx.body && ctx.body.name) {
      return {
        available: true,
        filename: ctx.body.name,
        createdAt: ctx.body.createdAt ?? new Date().toISOString(),
      };
    }
    return { available: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Backup creation failed: ${message}`);
  }
}

/**
 * Restore from a previously created backup.
 * The filename must be a value returned by a prior createBackup() call.
 */
export async function restoreBackup(app: NocoBaseApp, filename: string): Promise<RollbackResult> {
  if (!isBackupRestoreAvailable(app)) {
    return {
      success: false,
      filename,
      restoredAt: new Date().toISOString(),
      error: 'Backup Manager plugin (@nocobase/plugin-backup-restore) is not installed',
    };
  }

  const restoreAction = app.resourceManager.getAction('backupFiles', 'restore');
  if (!restoreAction) {
    return {
      success: false,
      filename,
      restoredAt: new Date().toISOString(),
      error: 'backupFiles:restore action not found',
    };
  }

  const ctx: BackupRestoreContext = {
    action: { params: { filterByTk: filename } },
    body: null,
    status: 200,
  };

  try {
    await restoreAction(ctx, async () => {});
    return {
      success: true,
      filename,
      restoredAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      filename,
      restoredAt: new Date().toISOString(),
      error: `Restore failed: ${message}`,
    };
  }
}
