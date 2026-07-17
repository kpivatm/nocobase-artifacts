import { exportBundle } from '../server/bundle';

function makeRepo(rows: Record<string, unknown>[]) {
  return {
    find: jest.fn().mockResolvedValue(rows.map((r) => ({ toJSON: () => r }))),
  };
}

function makeMockDb(overrides: Record<string, Record<string, unknown>[]> = {}) {
  const defaults: Record<string, Record<string, unknown>[]> = {
    collections: [],
    fields: [],
    workflows: [],
    flow_nodes: [],
    roles: [],
    rolesResources: [],
    uiSchemas: [],
    desktopRoutes: [],
  };
  const data = { ...defaults, ...overrides };
  return {
    getRepository: jest.fn((name: string) => makeRepo(data[name] ?? [])),
  };
}

// ─── Stage 1 ──────────────────────────────────────────────────────────────────

describe('exportBundle — Stage 1: collections & fields', () => {
  it('produces a bundle with correct structure', async () => {
    const db = makeMockDb({
      collections: [{ name: 'posts', title: 'Posts', key: 'abc123', description: null, hidden: false }],
      fields: [{ collectionName: 'posts', name: 'title', type: 'string', key: 'xyz', id: 42 }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.version).toBeDefined();
    expect(bundle.exportedAt).toBeDefined();
    expect(bundle.collections).toHaveLength(1);
    expect(bundle.fields).toHaveLength(1);
  });

  it('strips auto-increment ID and key from fields', async () => {
    const db = makeMockDb({
      fields: [{ collectionName: 'posts', name: 'title', type: 'string', id: 123, key: 'abc' }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect((bundle.fields[0] as Record<string, unknown>).id).toBeUndefined();
    expect((bundle.fields[0] as Record<string, unknown>).key).toBeUndefined();
  });

  it('uses name as natural key for collections', async () => {
    const db = makeMockDb({
      collections: [{ name: 'kpi_catalog', title: 'KPI', key: 'ignore_this', id: 5 }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);
    const col = bundle.collections[0];

    expect(col.name).toBe('kpi_catalog');
    expect((col as unknown as Record<string, unknown>).id).toBeUndefined();
  });
});

// ─── Stage 2 ──────────────────────────────────────────────────────────────────

describe('exportBundle — Stage 2: workflows', () => {
  it('exports workflows with nodes in topological order (root first)', async () => {
    const db = makeMockDb({
      workflows: [{ id: 10, key: 'wf-1', title: 'Notify', type: 'schedule', enabled: true }],
      flow_nodes: [
        { id: 20, key: 'child', workflowId: 10, type: 'condition', upstreamId: 21 },
        { id: 21, key: 'root', workflowId: 10, type: 'notification', upstreamId: null },
      ],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.workflows).toHaveLength(1);
    const nodes = bundle.workflows![0].nodes;
    expect(nodes).toHaveLength(2);
    // Root (upstreamKey=null) must come before child
    expect(nodes[0].upstreamKey).toBeNull();
    expect(nodes[1].upstreamKey).toBe('root');
  });

  it('uses workflow.key as natural key', async () => {
    const db = makeMockDb({
      workflows: [{ id: 5, key: 'wf-stable-key', title: 'T', type: 'schedule', enabled: false }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.workflows![0].key).toBe('wf-stable-key');
  });
});

describe('exportBundle — Stage 2: ACL', () => {
  it('exports roles with name as natural key', async () => {
    const db = makeMockDb({
      roles: [{ name: 'manager', title: 'Manager', id: 3 }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.roles).toHaveLength(1);
    expect(bundle.roles![0].name).toBe('manager');
  });

  it('exports role resources with roleName.name composite key', async () => {
    const db = makeMockDb({
      rolesResources: [{
        roleName: 'manager', name: 'kpi_catalog', usingActionsConfig: true, actions: [],
      }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.rolesResources).toHaveLength(1);
    expect(bundle.rolesResources![0].roleName).toBe('manager');
    expect(bundle.rolesResources![0].name).toBe('kpi_catalog');
  });
});

describe('exportBundle — Stage 2: UI blueprints', () => {
  it('exports ui schemas with x-uid as natural key', async () => {
    const db = makeMockDb({
      uiSchemas: [{ 'x-uid': 'uid-abc', name: 'schema-1', schema: {}, serverHooks: [] }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.uiSchemas).toHaveLength(1);
    expect(bundle.uiSchemas![0]['x-uid']).toBe('uid-abc');
  });

  it('exports desktop routes with uid as natural key', async () => {
    const db = makeMockDb({
      desktopRoutes: [{ uid: 'route-home', title: 'Home', type: 'page', sort: 1, id: 99 }],
    });

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.desktopRoutes).toHaveLength(1);
    expect(bundle.desktopRoutes![0].uid).toBe('route-home');
  });

  it('gracefully returns empty arrays when ui collections absent', async () => {
    // Mock db where getRepository throws for ui collections
    const db = {
      getRepository: jest.fn((name: string) => {
        if (name === 'uiSchemas' || name === 'desktopRoutes') {
          throw new Error('collection not found');
        }
        return makeRepo([]);
      }),
    };

    const bundle = await exportBundle(db as unknown as import('@nocobase/database').Database);

    expect(bundle.uiSchemas).toHaveLength(0);
    expect(bundle.desktopRoutes).toHaveLength(0);
  });
});
