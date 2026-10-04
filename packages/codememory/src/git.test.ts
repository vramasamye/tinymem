import { describe, expect, test } from 'bun:test';

import { parseIndex, parsePaths, parseRenames } from './git';
import { RepositoryPathSchema, RepositorySnapshotSchema } from './schema';

describe('safe Git wire parsing', () => {
  const sha1 = 'a'.repeat(40);
  const sha256 = 'b'.repeat(64);

  test('index records preserve spaces, tabs, newlines, Unicode, and both object formats', () => {
    expect(parseIndex(`100644 ${sha1} 0\tspace name.ts\0`)).toEqual([
      { path: 'space name.ts', blob_sha: sha1, mode: '100644', stage: 0 },
    ]);
    expect(parseIndex(`100755 ${sha256} 2\todd\tname\n😀.ts\0`)[0]?.path).toBe('odd\tname\n😀.ts');
    expect(parsePaths('one\ttwo\n.ts\0')).toEqual(['one\ttwo\n.ts']);
  });

  test('NUL rename fields distinguish rename and copy from ordinary modifications', () => {
    expect(parseRenames('M\0normal.ts\0R090\0old\tname.ts\0new\nname.ts\0C100\0a.ts\0b.ts\0')).toEqual([
      { previous_path: 'old\tname.ts', path: 'new\nname.ts' },
    ]);
  });

  test('malformed records and unsafe paths fail closed', () => {
    for (const output of [`100644 ${sha1} 0\tfile.ts`, `100644 nohash 0\tfile.ts\0`, `100644 ${sha1} 0\t../file.ts\0`]) {
      expect(() => parseIndex(output)).toThrow();
    }
    for (const output of ['R100\0only-old.ts\0', 'wat\0path.ts\0', 'M\0/absolute.ts\0']) {
      expect(() => parseRenames(output)).toThrow();
    }
    for (const path of ['../file', 'src/../file', '/absolute', 'C:/file', 'src\\file', 'src//file', './file']) {
      expect(RepositoryPathSchema.safeParse(path).success).toBe(false);
    }
  });

  test('snapshot boundaries reject duplicate and mismatched fingerprint entries', () => {
    const snapshot = {
      version: 1, root_path: '/tmp/code-memory', mode: 'content', head_commit: null,
      hash_algorithm: 'sha256', exclusion_globs: [], captured_at: '2026-10-04T00:00:00.000Z',
      files: [{ path: 'file.ts', tier: 'worktree', blob_sha: sha256, hash_algorithm: 'sha256', mode: '100644' }],
      skipped: [], warnings: [],
    };
    expect(RepositorySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(RepositorySnapshotSchema.safeParse({ ...snapshot, files: [...snapshot.files, ...snapshot.files] }).success).toBe(false);
    expect(RepositorySnapshotSchema.safeParse({ ...snapshot, mode: 'git' }).success).toBe(false);
    expect(RepositorySnapshotSchema.safeParse({ ...snapshot, files: [{ ...snapshot.files[0], tier: 'committed' }] }).success).toBe(false);
  });
});
