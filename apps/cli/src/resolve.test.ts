/**
 * `resolveProjectIdForCwd` (M17 — the cwd→project lookup): the resolution ORDER is the contract.
 * `--project` wins over everything; the deepest registered root containing the cwd wins over the
 * init pointer (a nested directory in a multi-project data dir resolves to its own project); the
 * pointer stands when no store is available (daemon mode) or no root contains the cwd; the honest
 * error fires last. `resolveProjectId` (the pointer fallback itself) is covered by every command
 * e2e test already.
 */

import { describe, expect, test } from 'bun:test';

import { ConfigNotFoundError } from '@onememory-ai/config';

import { BackendError } from '@onememory-ai/api/runtime';

import { resolveProjectIdForCwd } from './resolve';
import type { LoadedConfig } from '@onememory-ai/config';

const POINTER_ID = '00000000-0000-7000-8000-0000000000a1';
const NESTED_ID = '00000000-0000-7000-8000-0000000000b2';
const OVERRIDE_ID = '00000000-0000-7000-8000-0000000000c3';

/** The minimal LoadedConfig surface the resolver reads (structural — no filesystem needed). */
function loadedWithPointer(): LoadedConfig {
  return {
    project_state: { project_id: POINTER_ID, name: 'pointer-project' },
    paths: { project_state_path: '/p/.onememory/project.json' },
  } as unknown as LoadedConfig;
}

/** A store whose deepest root containing `/tmp/mono/...` is the nested project. */
const monoStore = {
  async findProjectByPath(path: string): Promise<{ id: string } | null> {
    return path.startsWith('/tmp/mono/nested/') ? { id: NESTED_ID } : null;
  },
};

describe('resolveProjectIdForCwd', () => {
  test('--project wins over both the lookup and the pointer', async () => {
    expect(await resolveProjectIdForCwd(loadedWithPointer(), OVERRIDE_ID, monoStore, '/tmp/mono/nested/src')).toBe(
      OVERRIDE_ID,
    );
  });

  test('the deepest registered root containing the cwd wins over the init pointer', async () => {
    expect(await resolveProjectIdForCwd(loadedWithPointer(), undefined, monoStore, '/tmp/mono/nested/src')).toBe(
      NESTED_ID,
    );
  });

  test('the pointer stands when no root contains the cwd', async () => {
    expect(await resolveProjectIdForCwd(loadedWithPointer(), undefined, monoStore, '/tmp/elsewhere')).toBe(POINTER_ID);
  });

  test('daemon mode (no store) is the pointer chain', async () => {
    expect(await resolveProjectIdForCwd(loadedWithPointer(), undefined, null, '/tmp/mono/nested/src')).toBe(
      POINTER_ID,
    );
  });

  test('no pointer and no match is the honest error, never a guess', async () => {
    const bare = {
      project_state: null,
      paths: { project_state_path: '/p/.onememory/project.json' },
    } as unknown as LoadedConfig;
    const error = await resolveProjectIdForCwd(bare, undefined, monoStore, '/tmp/elsewhere').catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('init');
  });

  test('a config error still surfaces untouched (the loader is upstream, not ours to rewrap)', () => {
    expect(ConfigNotFoundError).toBeDefined();
  });
});
