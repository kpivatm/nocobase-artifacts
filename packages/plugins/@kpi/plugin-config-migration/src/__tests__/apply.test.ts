import { applyBundle } from '../server/apply';
import type { Bundle } from '../server/types';

function makeBundle(partial: Partial<Bundle> = {}): Bundle {
  return {
    version: '0.2.0',
    exportedAt: '2026-07-18T00:00:00.000Z',
    collections: [],
    fields: [],
    ...partial,
  };
}

function makeMockDb(overrides: {
  collectionsFind?: unknown[];
  fieldsFind?: unknown[];
  workflowsFind?: unknown[];
  flowNodesFind?: unknown[];
  rolesFind?: unknown[];
  rolesResourcesFind?: unknown[];
  uiSchemasFind?: unknown[];
  desktopRoutesFind?: unknown[];
  createFn?: jest.Mock;
  updateFn?: jest.Mock;
  rollbackFn?: jest.Mock;
  commitFn?: jest.Mock;
  txObject?: Record<string, jest.Mock>;
} = {}) {
  const rollbackFn = overrides.rollbackFn ?? jest.fn();
  const commitFn = overrides.commitFn ?? jest.fn();
  const createFn = overrides.createFn ?? jest.fn().mockResolvedValue({ id: 1 });
  const updateFn = overrides.updateFn ?? jest.fn().mockResolvedValue({});
  const txObject = overrides.txObject ?? { commit: commitFn, rollback: rollbackFn };

  const makeRepo = (rows: unknown[] = []) => ({
    find: jest.fn().mockResolvedValue(rows.map((r) => ({ toJSON: () => r }))),
    create: createFn,
    update: updateFn,
  });

  const repoMap: Record<string, unknown[]> = {
    collections: overrides.collectionsFind ?? [],
    fields: overrides.fieldsFind ?? [],
    workflows: overrides.workflowsFind ?? [],
    flow_nodes: overrides.flowNodesFind ?? [],
    roles: overrides.rolesFind ?? [],
    rolesResources: overrides.rolesResourcesFind ?? [],
    uiSchemas: overrides.uiSchemasFind ?? [],
    desktopRoutes: overrides.desktopRoutesFind ?? [],
  };

  return {
    rollbackFn,
    commitFn,
    createFn,
    updateFn,
    txObject,
    db: {
      sequelize: {
        transaction: jest.fn().mockResolvedValue(txObject),
      },
      getRepository: jest.fn((name: string) => makeRepo(repoMap[name] ?? [])),
    } as unknown as import('@nocobase/database').Database,
  };
}

// ─── Stage 1 tests (preserved) ───────────────────────────────────────────────

describe('applyBundle — Stage 1: collections & fields', () => {
  it('dryRun returns ok without writing to DB', async () => {
    const { db } = makeMockDb();

    const source = makeBundle({
      collections: [{ name: 'new_collection', title: 'New' }],
    });

    const result = await applyBundle(db, source, {}, true);

    expect(result.dryRun).toBe(true);
    expect(db.sequelize.transaction).not.toHaveBeenCalled();
  });

  it('applies add diff when target is empty', async () => {
    const { db, createFn, commitFn, txObject } = makeMockDb();

    const source = makeBundle({
      collections: [{ name: 'posts', title: 'Posts' }],
    });

    const result = await applyBundle(db, source, {}, false);

    expect(createFn).toHaveBeenCalled();
    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ transaction: txObject }));
    expect(commitFn).toHaveBeenCalled();
    expect(result.applied).toBeGreaterThan(0);
    expect(result.dryRun).toBe(false);
  });

  it('rolls back transaction when apply fails (single entry)', async () => {
    const rollbackFn = jest.fn();
    const commitFn = jest.fn();
    const createFn = jest.fn().mockRejectedValue(new Error('DB write error'));

    const { db } = makeMockDb({ createFn, rollbackFn, commitFn });

    const source = makeBundle({
      collections: [{ name: 'fail_col', title: 'Fail' }],
    });

    await expect(applyBundle(db, source, {}, false)).rejects.toThrow('DB write error');
    expect(rollbackFn).toHaveBeenCalled();
    expect(commitFn).not.toHaveBeenCalled();
  });

  it('rolls back all entries when second entry fails (partial-failure guard)', async () => {
    const rollbackFn = jest.fn();
    const commitFn = jest.fn();
    let callCount = 0;
    const createFn = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount >= 2) return Promise.reject(new Error('second entry failed'));
      return Promise.resolve({ id: 1 });
    });

    const { db, txObject } = makeMockDb({ createFn, rollbackFn, commitFn });

    const source = makeBundle({
      collections: [
        { name: 'col_a', title: 'A' },
        { name: 'col_b', title: 'B' },
      ],
    });

    await expect(applyBundle(db, source, {}, false)).rejects.toThrow('second entry failed');
    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ transaction: txObject }));
    expect(rollbackFn).toHaveBeenCalled();
    expect(commitFn).not.toHaveBeenCalled();
  });

  it('skips collections with rule=skip', async () => {
    const { db, createFn, commitFn } = makeMockDb();

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
    const col = { name: 'posts', title: 'Posts' };
    const { db, createFn } = makeMockDb({ collectionsFind: [col] });

    const source = makeBundle({ collections: [col] });

    const result = await applyBundle(db, source, {}, false);

    expect(createFn).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ─── Stage 2: field type-change protection ────────────────────────────────────

describe('applyBundle — field type-change protection', () => {
  it('skips field update when type changes and records a warning', async () => {
    const field = { collectionName: 'posts', name: 'count', type: 'string' };
    const { db, updateFn } = makeMockDb({ fieldsFind: [{ ...field, type: 'integer' }] });

    const source = makeBundle({ fields: [field] }); // source has type=string, target has integer

    const result = await applyBundle(db, source, {}, false);

    // update must be skipped, not applied
    expect(updateFn).not.toHaveBeenCalled();
    const entry = result.entries.find((e) => e.key === 'posts.count');
    expect(entry?.status).toBe('skipped');
    expect(entry?.warning).toMatch(/type change/i);
  });
});

// ─── Stage 2: workflows ───────────────────────────────────────────────────────

describe('applyBundle — workflows', () => {
  it('applies add workflow and commits', async () => {
    const { db, createFn, commitFn, txObject } = makeMockDb({ workflowsFind: [] });

    const source = makeBundle({
      workflows: [{
        key: 'wf-notify', title: 'Notify', type: 'schedule', enabled: true, nodes: [],
      }],
    });

    const result = await applyBundle(db, source, {}, false);

    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ transaction: txObject }));
    expect(commitFn).toHaveBeenCalled();
    expect(result.applied).toBeGreaterThan(0);
  });

  it('applies workflow with nodes (topological order)', async () => {
    const { db, createFn, commitFn } = makeMockDb({ workflowsFind: [] });

    const source = makeBundle({
      workflows: [{
        key: 'wf-1', title: 'T', type: 'schedule', enabled: true,
        nodes: [
          { key: 'root', workflowKey: 'wf-1', type: 'notification', upstreamKey: null },
          { key: 'child', workflowKey: 'wf-1', type: 'condition', upstreamKey: 'root' },
        ],
      }],
    });

    await applyBundle(db, source, {}, false);

    // workflow + 2 nodes = at least 3 create calls
    expect(createFn.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(commitFn).toHaveBeenCalled();
  });

  it('skips workflow with rule=skip', async () => {
    const { db, createFn } = makeMockDb({ workflowsFind: [] });

    const source = makeBundle({
      workflows: [{ key: 'wf-internal', title: 'Internal', type: 'schedule', enabled: false, nodes: [] }],
    });

    const result = await applyBundle(db, source, { rules: { 'wf-internal': 'skip' } }, false);

    const wfEntry = result.entries.find((e) => e.key === 'wf-internal');
    expect(wfEntry?.status).toBe('skipped');
    expect(createFn).not.toHaveBeenCalled();
  });
});

// ─── Stage 2: ACL ─────────────────────────────────────────────────────────────

describe('applyBundle — ACL', () => {
  it('applies added role', async () => {
    const { db, createFn, commitFn } = makeMockDb({ rolesFind: [] });

    const source = makeBundle({
      roles: [{ name: 'manager', title: 'Manager' }],
    });

    const result = await applyBundle(db, source, {}, false);

    expect(createFn).toHaveBeenCalled();
    expect(commitFn).toHaveBeenCalled();
    const entry = result.entries.find((e) => e.key === 'manager');
    expect(entry?.status).toBe('ok');
  });

  it('applies added role resource', async () => {
    const { db, createFn } = makeMockDb({ rolesResourcesFind: [] });

    const source = makeBundle({
      rolesResources: [{
        roleName: 'manager',
        name: 'kpi_catalog',
        usingActionsConfig: true,
        actions: [{ name: 'create', fields: [] }, { name: 'view', fields: [] }],
      }],
    });

    await applyBundle(db, source, {}, false);
    expect(createFn).toHaveBeenCalled();
  });
});

// ─── Stage 2: UI blueprints ───────────────────────────────────────────────────

describe('applyBundle — UI blueprints', () => {
  it('applies added ui schema', async () => {
    const { db, createFn } = makeMockDb({ uiSchemasFind: [] });

    const source = makeBundle({
      uiSchemas: [{ 'x-uid': 'uid-abc', name: 'schema-1', schema: { type: 'void' } }],
    });

    const result = await applyBundle(db, source, {}, false);

    expect(createFn).toHaveBeenCalled();
    const entry = result.entries.find((e) => e.key === 'uid-abc');
    expect(entry?.status).toBe('ok');
  });

  it('applies added desktop route', async () => {
    const { db, createFn } = makeMockDb({ desktopRoutesFind: [] });

    const source = makeBundle({
      desktopRoutes: [{ uid: 'route-1', title: 'KPI Page', type: 'page' }],
    });

    const result = await applyBundle(db, source, {}, false);

    expect(createFn).toHaveBeenCalled();
    const entry = result.entries.find((e) => e.key === 'route-1');
    expect(entry?.status).toBe('ok');
  });

  it('is idempotent for ui blueprints', async () => {
    // source bundle must match what the export would produce (including serverHooks: [])
    const schema = { 'x-uid': 'uid-1', name: 's1', schema: { type: 'void' }, serverHooks: [] as unknown[] };
    const route = { uid: 'r1', title: 'Home', type: 'page' };
    const { db, createFn } = makeMockDb({
      uiSchemasFind: [{ ...schema, id: 1 }],
      desktopRoutesFind: [{ ...route, id: 1 }],
    });

    const source = makeBundle({ uiSchemas: [schema], desktopRoutes: [route] });
    const result = await applyBundle(db, source, {}, false);

    expect(createFn).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });
});

// ─── Dependency ordering ─────────────────────────────────────────────────────

describe('applyBundle — dependency ordering', () => {
  it('applies collections before fields in a mixed diff', async () => {
    const { db, createFn } = makeMockDb();

    const source = makeBundle({
      collections: [{ name: 'orders', title: 'Orders' }],
      fields: [{ collectionName: 'orders', name: 'total', type: 'integer' }],
    });

    await applyBundle(db, source, {}, false);

    // Both calls should use the transaction
    const calls = createFn.mock.calls as unknown[][];
    // First call should be for a collection, second for a field (dependency order)
    expect(calls.length).toBe(2);
    const firstValues = (calls[0][0] as Record<string, unknown>).values as Record<string, unknown>;
    // collection has 'name' but not 'collectionName'
    expect(firstValues.name).toBe('orders');
    expect(firstValues.collectionName).toBeUndefined();
  });
});
