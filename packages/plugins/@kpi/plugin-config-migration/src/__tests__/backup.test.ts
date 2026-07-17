import { createBackup, restoreBackup } from '../server/backup';

function makeApp(overrides: {
  pluginAvailable?: boolean;
  createResult?: Record<string, unknown>;
  createThrows?: string;
  restoreThrows?: string;
} = {}) {
  const { pluginAvailable = true, createResult, createThrows, restoreThrows } = overrides;

  const createAction = jest.fn(async (ctx: Record<string, unknown>, next: () => Promise<void>) => {
    if (createThrows) throw new Error(createThrows);
    (ctx as Record<string, unknown>).body = createResult ?? { name: 'backup-2026-07-18.zip', createdAt: '2026-07-18T00:00:00.000Z' };
    await next();
  });

  const restoreAction = jest.fn(async (_ctx: Record<string, unknown>, next: () => Promise<void>) => {
    if (restoreThrows) throw new Error(restoreThrows);
    await next();
  });

  return {
    createAction,
    restoreAction,
    app: {
      getPlugin: jest.fn().mockReturnValue(pluginAvailable ? {} : null),
      resourceManager: {
        getAction: jest.fn((resource: string, action: string) => {
          if (resource === 'backupFiles' && action === 'create') return createAction;
          if (resource === 'backupFiles' && action === 'restore') return restoreAction;
          return undefined;
        }),
      },
    },
  };
}

describe('createBackup', () => {
  it('returns available=false when backup-restore plugin is not installed', async () => {
    const { app } = makeApp({ pluginAvailable: false });
    const result = await createBackup(app as Parameters<typeof createBackup>[0]);
    expect(result.available).toBe(false);
    expect(result.filename).toBeUndefined();
  });

  it('returns backup info when plugin is available', async () => {
    const { app } = makeApp();
    const result = await createBackup(app as Parameters<typeof createBackup>[0]);
    expect(result.available).toBe(true);
    expect(result.filename).toBe('backup-2026-07-18.zip');
    expect(result.createdAt).toBeDefined();
  });

  it('throws when backup creation fails', async () => {
    const { app } = makeApp({ createThrows: 'disk full' });
    await expect(createBackup(app as Parameters<typeof createBackup>[0])).rejects.toThrow('Backup creation failed: disk full');
  });
});

describe('restoreBackup', () => {
  it('returns success=false when plugin is not installed', async () => {
    const { app } = makeApp({ pluginAvailable: false });
    const result = await restoreBackup(app as Parameters<typeof createBackup>[0], 'backup.zip');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not installed');
  });

  it('returns success=true on successful restore', async () => {
    const { app } = makeApp();
    const result = await restoreBackup(app as Parameters<typeof createBackup>[0], 'backup-2026-07-18.zip');
    expect(result.success).toBe(true);
    expect(result.filename).toBe('backup-2026-07-18.zip');
    expect(result.restoredAt).toBeDefined();
  });

  it('returns success=false with error message when restore throws', async () => {
    const { app } = makeApp({ restoreThrows: 'corrupt backup' });
    const result = await restoreBackup(app as Parameters<typeof createBackup>[0], 'bad.zip');
    expect(result.success).toBe(false);
    expect(result.error).toContain('corrupt backup');
  });
});
