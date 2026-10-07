/**
 * Context construction seams: injected storage and the injected engine (the daemon path —
 * ADR-0010 amendment 2026-10-04). The daemon must share ONE storage + engine pair with the REST
 * surface, so the seam is identity-checked here (no second engine, no second database) and the
 * cache-invalidation route is proven to land on the injected engine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createRetrievalEngine, type RetrievalEngine } from '@onememory-ai/retrieval';

import { createOnememoryMcpContext } from './context';
import { openMcpTestWorld, type McpTestWorld } from './testing';

let world: McpTestWorld;

beforeEach(async () => {
  world = await openMcpTestWorld();
});

afterEach(async () => {
  await world.close();
});

describe('createOnememoryMcpContext — the daemon sharing seam', () => {
  test('an injected engine is adopted as-is: one cache domain, invalidation reaches it', async () => {
    const shared: RetrievalEngine = createRetrievalEngine(world.storage, {});
    const invalidated: Array<string | undefined> = [];
    const spied: RetrievalEngine = {
      ...shared,
      invalidateCache: (projectId?: string): void => {
        invalidated.push(projectId);
        shared.invalidateCache(projectId);
      },
    };

    const context = await createOnememoryMcpContext({
      storage: world.storage,
      engine: spied,
      projectId: world.ids.projectId,
    });

    expect(context.storage).toBe(world.storage);
    expect(context.engine).toBe(spied);

    context.invalidateSearchCache(world.ids.projectId);
    context.invalidateSearchCache();
    expect(invalidated).toEqual([world.ids.projectId, undefined]);
  });

  test('engine injection without storage injection fails closed (never two databases)', async () => {
    const engine = createRetrievalEngine(world.storage, {});
    await expect(createOnememoryMcpContext({ engine })).rejects.toThrow(
      /engine injection requires storage injection/,
    );
  });

  test('storage injection without an engine still builds a fresh engine over that storage', async () => {
    const context = await createOnememoryMcpContext({
      storage: world.storage,
      projectId: world.ids.projectId,
    });
    expect(context.storage).toBe(world.storage);
    expect(context.engine).toBeDefined();
    expect(context.engine).not.toBe(world.context.engine);
  });
});

describe('resolveProjectId — the cwd→project lookup (M17)', () => {
  test('a workspace hint inside a registered root resolves to that project when nothing is configured', async () => {
    const hinted = await openMcpTestWorld({
      config: { projectId: null },
      env: { CLAUDE_PROJECT_DIR: '/dev/mcp-fixture/src/some-file.ts' },
    });
    try {
      expect(await hinted.context.resolveProjectId()).toBe(hinted.ids.projectId);
      // An explicit input still wins over every fallback.
      expect(await hinted.context.resolveProjectId('00000000-0000-7000-8000-000000000001')).toBe(
        '00000000-0000-7000-8000-000000000001',
      );
    } finally {
      await hinted.close();
    }
  });

  test('a hint outside every registered root stays honestly unconfigured', async () => {
    const hinted = await openMcpTestWorld({
      config: { projectId: null },
      env: { CLAUDE_PROJECT_DIR: '/somewhere/else-entirely' },
    });
    try {
      expect(await hinted.context.resolveProjectId()).toBeUndefined();
    } finally {
      await hinted.close();
    }
  });
});
