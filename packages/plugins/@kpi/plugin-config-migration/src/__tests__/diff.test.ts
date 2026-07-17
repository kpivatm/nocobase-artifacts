import { diffBundles } from '../server/diff';
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

describe('diffBundles — Stage 1: collections & fields', () => {
  it('returns empty diff for identical bundles (idempotency)', () => {
    const bundle = makeBundle({
      collections: [{ name: 'posts', title: 'Posts' }],
      fields: [{ collectionName: 'posts', name: 'title', type: 'string' }],
    });
    const result = diffBundles(bundle, bundle);
    expect(result.entries).toHaveLength(0);
  });

  it('detects added collection when source has it but target does not', () => {
    const source = makeBundle({ collections: [{ name: 'posts', title: 'Posts' }] });
    const target = makeBundle({ collections: [] });
    const result = diffBundles(source, target);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ action: 'add', type: 'collection', key: 'posts' });
  });

  it('detects deleted collection when target has it but source does not', () => {
    const source = makeBundle({ collections: [] });
    const target = makeBundle({ collections: [{ name: 'legacy', title: 'Legacy' }] });
    const result = diffBundles(source, target);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ action: 'delete', type: 'collection', key: 'legacy' });
  });

  it('detects updated collection when title changed', () => {
    const source = makeBundle({ collections: [{ name: 'posts', title: 'Posts v2' }] });
    const target = makeBundle({ collections: [{ name: 'posts', title: 'Posts v1' }] });
    const result = diffBundles(source, target);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ action: 'update', type: 'collection', key: 'posts' });
  });

  it('detects added field', () => {
    const source = makeBundle({
      collections: [{ name: 'posts' }],
      fields: [{ collectionName: 'posts', name: 'status', type: 'string' }],
    });
    const target = makeBundle({ collections: [{ name: 'posts' }], fields: [] });
    const result = diffBundles(source, target);
    const fieldEntries = result.entries.filter((e) => e.type === 'field');
    expect(fieldEntries).toHaveLength(1);
    expect(fieldEntries[0]).toMatchObject({ action: 'add', key: 'posts.status' });
  });

  it('attaches warning when field type changes', () => {
    const source = makeBundle({ fields: [{ collectionName: 'posts', name: 'count', type: 'integer' }] });
    const target = makeBundle({ fields: [{ collectionName: 'posts', name: 'count', type: 'string' }] });
    const result = diffBundles(source, target);
    const updated = result.entries.filter((e) => e.action === 'update' && e.type === 'field');
    expect(updated).toHaveLength(1);
    expect(updated[0].warnings?.[0]).toMatch(/type change/i);
  });

  it('is idempotent: diff of equal complex bundles is empty', () => {
    const bundle = makeBundle({
      collections: [{ name: 'kpi_catalog', title: 'KPI Catalog', hidden: false }],
      fields: [
        { collectionName: 'kpi_catalog', name: 'id', type: 'snowflakeId', primaryKey: true },
        { collectionName: 'kpi_catalog', name: 'name', type: 'string', allowNull: false },
      ],
    });
    expect(diffBundles(bundle, bundle).entries).toHaveLength(0);
  });

  it('uses natural keys not numeric IDs for comparison', () => {
    const source = makeBundle({
      fields: [{ collectionName: 'posts', name: 'title', type: 'string' }],
    });
    const cleanTarget = makeBundle({
      fields: [{ collectionName: 'posts', name: 'title', type: 'string' }],
    });
    expect(diffBundles(source, cleanTarget).entries).toHaveLength(0);
  });
});

describe('diffBundles — Stage 2: workflows', () => {
  it('detects added workflow', () => {
    const source = makeBundle({
      workflows: [{ key: 'wf-1', title: 'Notify', type: 'schedule', enabled: true, nodes: [] }],
    });
    const target = makeBundle({ workflows: [] });
    const result = diffBundles(source, target);
    const wfEntries = result.entries.filter((e) => e.type === 'workflow');
    expect(wfEntries).toHaveLength(1);
    expect(wfEntries[0]).toMatchObject({ action: 'add', key: 'wf-1' });
  });

  it('detects workflow enabled-state change', () => {
    const wf = { key: 'wf-1', title: 'Notify', type: 'schedule', enabled: false, nodes: [] };
    const source = makeBundle({ workflows: [{ ...wf, enabled: true }] });
    const target = makeBundle({ workflows: [{ ...wf, enabled: false }] });
    const result = diffBundles(source, target);
    const updated = result.entries.filter((e) => e.type === 'workflow' && e.action === 'update');
    expect(updated).toHaveLength(1);
  });

  it('detects added flow node', () => {
    const source = makeBundle({
      workflows: [{
        key: 'wf-1', title: 'T', type: 'schedule', enabled: true,
        nodes: [{ key: 'node-a', workflowKey: 'wf-1', type: 'notification', upstreamKey: null }],
      }],
    });
    const target = makeBundle({
      workflows: [{ key: 'wf-1', title: 'T', type: 'schedule', enabled: true, nodes: [] }],
    });
    const result = diffBundles(source, target);
    const nodeEntries = result.entries.filter((e) => e.type === 'flow_node');
    expect(nodeEntries).toHaveLength(1);
    expect(nodeEntries[0]).toMatchObject({ action: 'add', key: 'wf-1.node-a' });
  });

  it('is idempotent for workflows', () => {
    const bundle = makeBundle({
      workflows: [{
        key: 'wf-1', title: 'T', type: 'schedule', enabled: true,
        nodes: [{ key: 'n1', workflowKey: 'wf-1', type: 'notification', upstreamKey: null }],
      }],
    });
    expect(diffBundles(bundle, bundle).entries).toHaveLength(0);
  });
});

describe('diffBundles — Stage 2: ACL', () => {
  it('detects added role', () => {
    const source = makeBundle({ roles: [{ name: 'manager', title: 'Manager' }] });
    const target = makeBundle({ roles: [] });
    const result = diffBundles(source, target);
    const roleEntries = result.entries.filter((e) => e.type === 'role');
    expect(roleEntries).toHaveLength(1);
    expect(roleEntries[0]).toMatchObject({ action: 'add', key: 'manager' });
  });

  it('detects updated role resource', () => {
    const res = { roleName: 'manager', name: 'kpi_catalog', usingActionsConfig: true, actions: [] };
    const source = makeBundle({
      rolesResources: [{ ...res, usingActionsConfig: true }],
    });
    const target = makeBundle({
      rolesResources: [{ ...res, usingActionsConfig: false }],
    });
    const result = diffBundles(source, target);
    const resEntries = result.entries.filter((e) => e.type === 'roles_resource');
    expect(resEntries).toHaveLength(1);
    expect(resEntries[0]).toMatchObject({ action: 'update', key: 'manager.kpi_catalog' });
  });
});

describe('diffBundles — Stage 2: UI blueprints', () => {
  it('detects added ui schema', () => {
    const source = makeBundle({ uiSchemas: [{ 'x-uid': 'uid-abc', name: 'schema-1', schema: {} }] });
    const target = makeBundle({ uiSchemas: [] });
    const result = diffBundles(source, target);
    const entries = result.entries.filter((e) => e.type === 'ui_schema');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'add', key: 'uid-abc' });
  });

  it('detects added desktop route', () => {
    const source = makeBundle({ desktopRoutes: [{ uid: 'route-1', title: 'KPI Page', type: 'page' }] });
    const target = makeBundle({ desktopRoutes: [] });
    const result = diffBundles(source, target);
    const entries = result.entries.filter((e) => e.type === 'desktop_route');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'add', key: 'route-1' });
  });

  it('is idempotent for ui blueprints', () => {
    const bundle = makeBundle({
      uiSchemas: [{ 'x-uid': 'uid-1', schema: { type: 'void' } }],
      desktopRoutes: [{ uid: 'r1', title: 'Home', type: 'page' }],
    });
    expect(diffBundles(bundle, bundle).entries).toHaveLength(0);
  });
});
