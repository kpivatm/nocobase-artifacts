import type { Bundle, CollectionSnapshot, DiffEntry, DiffResult, FieldSnapshot } from './types';

function collectionKey(c: CollectionSnapshot): string {
  return c.name;
}

function fieldKey(f: FieldSnapshot): string {
  return `${f.collectionName}.${f.name}`;
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffItems<T>(
  sourceItems: T[],
  targetItems: T[],
  getKey: (item: T) => string,
  type: 'collection' | 'field',
): DiffEntry[] {
  const entries: DiffEntry[] = [];

  const sourceMap = new Map<string, T>(sourceItems.map((i) => [getKey(i), i]));
  const targetMap = new Map<string, T>(targetItems.map((i) => [getKey(i), i]));

  for (const [key, src] of sourceMap) {
    const tgt = targetMap.get(key);
    if (!tgt) {
      entries.push({ action: 'add', type, key, source: src });
    } else if (!deepEqual(src, tgt)) {
      entries.push({ action: 'update', type, key, source: src, target: tgt });
    }
  }

  for (const [key, tgt] of targetMap) {
    if (!sourceMap.has(key)) {
      entries.push({ action: 'delete', type, key, target: tgt });
    }
  }

  return entries;
}

export function diffBundles(source: Bundle, target: Bundle): DiffResult {
  const collectionEntries = diffItems(
    source.collections,
    target.collections,
    collectionKey,
    'collection',
  );

  const fieldEntries = diffItems(
    source.fields,
    target.fields,
    fieldKey,
    'field',
  );

  return { entries: [...collectionEntries, ...fieldEntries] };
}
