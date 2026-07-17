import { applyBundle } from '../server/apply';
import type { Bundle } from '../server/types';

function makeBundle(partial: Partial<Bundle> = {}): Bundle {
  return {
    version: '0.1.0',
    exportedAt: '2026-07-18T00:00:00.000Z',
    collections: [],
    fields: [],
    ...partial,
  };
}

function makeMockDb(overrides: {
  collectionsFind?: any[];
  fieldsFind?: any[];
  createFn?: jest.Mock;
  updateFn?: jest.Mock;
  rollbackFn?: jest.Mock;
  commitFn?: jest.Mock;
} = {}) {
  const rollbackFn = overrides.rollbackFn ?? jest.fn();
  const commitFn = overrides.commitFn ?? jest.fn();
  const createFn = overrides.createFn ?? jest.fn().mockResolvedValue({});
  const updateFn = overrides.updateFn ?? jest.fn().mockResolvedValue({});

  const makeRepo = (rows: any[] = []) => ({
    find: jest.fn().mockResolvedValue(rows.map((r) => ({ toJSON: () => r }))),
    create: createFn,
    update: updateFn,
  });

  return {
    rollbackFn,
    commitFn,
    createFn,
    updateFn,
    db: {
      sequelize: {
        transaction: jest.fn().mockResolvedValue({ commit: commitFn, rollback: rollbackFn }),
      },
      getRepository: jest.fn((name: string) => {
        if (name === 'collections') return makeRepo(overrides.collectionsFind ?? []);
        if (name === 'fields') return makeRepo(overrides.fieldsFind ?? []);
        return makeRepo([]);
      }),
    } as any,
  };
}

describe('applyBundle', () => {
  it('dryRun returns ok without writing to DB', async () => {
    const { db } = makeMockDb({ collectionsFind: [], fieldsFind: [] });

    const source = makeBundle({
      collections: [{ name: 'new_collection', title: 'New' }],
    });

    const result = await applyBundle(db, source, {}, true);

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBeGreaterThanOrEqual(0);
    // transaction should NOT be started in dryRun
    expect(db.sequelize.transaction).not.toHaveBeenCalled();
  });

  it('applies add diff when target is empty', async () => {
    const { db, createFn, commitFn } = makeMockDb({ collectionsFind: [], fieldsFind: [] });

    const source = makeBundle({
      collections: [{ name: 'posts', title: 'Posts' }],
    });

    const result = await applyBundle(db, source, {}, false);

    expect(createFn).toHaveBeenCalled();
    expect(commitFn).toHaveBeenCalled();
    expect(result.applied).toBeGreaterThan(0);
    expect(result.dryRun).toBe(false);
  });

  it('rolls back transaction when apply fails', async () => {
    const rollbackFn = jest.fn();
    const commitFn = jest.fn();
    const createFn = jest.fn().mockRejectedValue(new Error('DB write error'));

    const { db } = makeMockDb({
      collectionsFind: [],
      fieldsFind: [],
      createFn,
      rollbackFn,
      commitFn,
    });

    const source = makeBundle({
      collections: [{ name: 'fail_col', title: 'Fail' }],
    });

    await expect(applyBundle(db, source, {}, false)).rejects.toThrow('DB write error');
    expect(rollbackFn).toHaveBeenCalled();
    expect(commitFn).not.toHaveBeenCalled();
  });

  it('skips collections with rule=skip', async () => {
    const { db, createFn, commitFn } = makeMockDb({ collectionsFind: [], fieldsFind: [] });

    const source = makeBundle({
      collections: [{ name: 'business_data', title: 'Business Data' }],
    });

    const result = await applyBundle(db, source, { rules: { business_data: 'skip' } }, false);

    expect(createFn).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
    expect(commitFn).toHaveBeenCalled();
  });

  it('is idempotent: applying same diff twice gives same final state', async () => {
    // Simulate target already has the collection (same as source)
    const col = { name: 'posts', title: 'Posts' };
    const { db, createFn } = makeMockDb({
      collectionsFind: [col],
      fieldsFind: [],
    });

    const source = makeBundle({ collections: [col] });

    const result = await applyBundle(db, source, {}, false);

    // No diff entries → nothing to apply
    expect(createFn).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
