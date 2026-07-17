import { diffBundles } from '../server/diff';
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

describe('diffBundles', () => {
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

  it('detects updated field', () => {
    const field = { collectionName: 'posts', name: 'title', type: 'string' };
    const source = makeBundle({ fields: [{ ...field, allowNull: false }] });
    const target = makeBundle({ fields: [{ ...field, allowNull: true }] });
    const result = diffBundles(source, target);
    const fieldEntries = result.entries.filter((e) => e.type === 'field');
    expect(fieldEntries).toHaveLength(1);
    expect(fieldEntries[0]).toMatchObject({ action: 'update', key: 'posts.title' });
  });

  it('detects deleted field', () => {
    const source = makeBundle({ fields: [] });
    const target = makeBundle({ fields: [{ collectionName: 'posts', name: 'deprecated', type: 'string' }] });
    const result = diffBundles(source, target);
    const fieldEntries = result.entries.filter((e) => e.type === 'field');
    expect(fieldEntries).toHaveLength(1);
    expect(fieldEntries[0]).toMatchObject({ action: 'delete', key: 'posts.deprecated' });
  });

  it('is idempotent: diff of equal complex bundles is empty', () => {
    const bundle = makeBundle({
      collections: [{ name: 'kpi_catalog', title: 'KPI Catalog', hidden: false }],
      fields: [
        { collectionName: 'kpi_catalog', name: 'id', type: 'snowflakeId', primaryKey: true },
        { collectionName: 'kpi_catalog', name: 'name', type: 'string', allowNull: false },
        { collectionName: 'kpi_catalog', name: 'weight', type: 'float' },
      ],
    });
    expect(diffBundles(bundle, bundle).entries).toHaveLength(0);
  });

  it('uses natural keys (name) not numeric IDs for comparison', () => {
    const source = makeBundle({
      collections: [{ name: 'posts' }],
      fields: [{ collectionName: 'posts', name: 'title', type: 'string' }],
    });
    // Same logical content but with extra id field (simulating raw DB leak)
    const target = makeBundle({
      collections: [{ name: 'posts' }],
      fields: [{ collectionName: 'posts', name: 'title', type: 'string', id: 999 }],
    });
    // diff detects the leaked `id` field as a change (source lacks it)
    // This verifies the bundle export MUST strip such keys before comparison
    const cleanTarget = makeBundle({
      collections: [{ name: 'posts' }],
      fields: [{ collectionName: 'posts', name: 'title', type: 'string' }],
    });
    expect(diffBundles(source, cleanTarget).entries).toHaveLength(0);
  });
});
