import { describe, expect, test } from 'bun:test';

import { parseApplyPatch } from './apply-patch';

describe('parseApplyPatch (verified directive set: Add/Delete/Update File, Move to)', () => {
  test('parses each directive kind', () => {
    const changes = parseApplyPatch(
      [
        '*** Begin Patch',
        '*** Update File: packages/storage/src/store.ts',
        '@@',
        ' context',
        '-removed',
        '+added',
        '*** Add File: packages/storage/README.md',
        '+# storage',
        '*** Delete File: packages/storage/src/old.ts',
        '*** End Patch',
      ].join('\n'),
    )!;
    expect(changes).toEqual([
      { path: 'packages/storage/src/store.ts', change: 'modified' },
      { path: 'packages/storage/README.md', change: 'created' },
      { path: 'packages/storage/src/old.ts', change: 'deleted' },
    ]);
  });

  test('Move to marks a rename and carries old_path', () => {
    const changes = parseApplyPatch(
      [
        '*** Begin Patch',
        '*** Update File: src/old-name.ts',
        '*** Move to: src/new-name.ts',
        '@@',
        '+export {}',
        '*** End Patch',
      ].join('\n'),
    )!;
    expect(changes).toEqual([{ path: 'src/new-name.ts', change: 'renamed', old_path: 'src/old-name.ts' }]);
  });

  test('directive paths with spaces and unicode survive', () => {
    const changes = parseApplyPatch(
      '*** Begin Patch\n*** Update File: docs/my notes é.md\n*** End Patch',
    )!;
    expect(changes[0]!.path).toBe('docs/my notes é.md');
  });

  test('non-patch text yields null (dropped, never coerced)', () => {
    expect(parseApplyPatch('just some text\n*** not a patch')).toBeNull();
    expect(parseApplyPatch('')).toBeNull();
  });

  test('directives without a Begin marker are NOT a patch (no partial parsing of stray text)', () => {
    // Only a payload carrying the verified begin marker is treated as an apply_patch body;
    // anything else is counted as unparseable rather than mined for directive-like lines.
    expect(parseApplyPatch('*** Update File: a.ts\n+export {}\n')).toBeNull();
  });

  test('a Begin marker with no directives yields an empty list, not a crash', () => {
    expect(parseApplyPatch('*** Begin Patch\n*** End Patch')).toEqual([]);
  });
});
