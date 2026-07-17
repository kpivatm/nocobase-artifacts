import { exportBundle } from '../server/bundle';

function makeMockDb(collections: any[], fields: any[]) {
  const makeRepo = (rows: any[]) => ({
    find: jest.fn().mockResolvedValue(rows.map((r) => ({ toJSON: () => r }))),
  });
  return {
    getRepository: jest.fn((name: string) => {
      if (name === 'collections') return makeRepo(collections);
      if (name === 'fields') return makeRepo(fields);
      return makeRepo([]);
    }),
  } as any;
}

describe('exportBundle', () => {
  it('produces a bundle with correct structure', async () => {
    const db = makeMockDb(
      [{ name: 'posts', title: 'Posts', key: 'abc123', description: null, hidden: false }],
      [{ collectionName: 'posts', name: 'title', type: 'string', key: 'xyz', id: 42 }],
    );

    const bundle = await exportBundle(db);

    expect(bundle.version).toBeDefined();
    expect(bundle.exportedAt).toBeDefined();
    expect(bundle.collections).toHaveLength(1);
    expect(bundle.fields).toHaveLength(1);
  });

  it('strips auto-increment ID from fields (no numeric id in bundle)', async () => {
    const db = makeMockDb(
      [],
      [{ collectionName: 'posts', name: 'title', type: 'string', id: 123, key: 'abc' }],
    );

    const bundle = await exportBundle(db);

    expect((bundle.fields[0] as any).id).toBeUndefined();
    expect((bundle.fields[0] as any).key).toBeUndefined();
  });

  it('uses name as natural key for collections', async () => {
    const db = makeMockDb(
      [{ name: 'kpi_catalog', title: 'KPI', key: 'ignore_this', id: 5 }],
      [],
    );

    const bundle = await exportBundle(db);
    const col = bundle.collections[0];

    expect(col.name).toBe('kpi_catalog');
    expect((col as any).id).toBeUndefined();
  });

  it('uses collectionName+name as natural key for fields', async () => {
    const db = makeMockDb(
      [],
      [{ collectionName: 'kpi_catalog', name: 'weight', type: 'float', reverseKey: 'ignore' }],
    );

    const bundle = await exportBundle(db);
    const f = bundle.fields[0];

    expect(f.collectionName).toBe('kpi_catalog');
    expect(f.name).toBe('weight');
    expect((f as any).reverseKey).toBeUndefined();
  });
});
