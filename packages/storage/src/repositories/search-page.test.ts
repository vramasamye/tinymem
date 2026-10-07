/**
 * `listMemoryPage` — keyset pagination over `(observed_at DESC, id DESC)`.
 *
 * Pinned: walking every page returns each row exactly once in order; rows sharing an
 * `observed_at` are split across pages by the id tiebreak; rows that differ only below the
 * millisecond (timestamptz keeps microseconds) are neither skipped nor repeated; the filter
 * (project, status) applies to every page; the last page reports no next cursor.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MEMORY_STATUSES } from '@onememory/core';

import { createServerDb } from '../drivers/server';
import type { OnememoryStorage } from '../drivers/types';
import {
  openEmbeddedStorage,
  seedProjectAndSource,
  type FixtureContext,
  type StorageHandle,
} from '../integration/harness';
import { ensureLocalUser } from './projects';
import { listMemoryPage, planFilter, type CandidateFilter, type MemoryPageCursor } from './search';

const TYPES = ['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference'] as const;

async function seed(storage: OnememoryStorage, ctx: FixtureContext, content: string, observedAt: string) {
  const write = await storage.store.insertMemory({
    type: 'episodic',
    content,
    importance: 0.5,
    confidence: 0.7,
    observed_at: observedAt,
    project_id: ctx.projectId,
    source_id: ctx.sourceId,
    evidence: [{ source_id: ctx.sourceId, kind: 'message', locator: `s.jsonl:${content}`, excerpt: content }],
    extraction: { method: 'heuristic', prompt_version: 'page-test-v1' },
  });
  return write.memory.id;
}

async function walk(storage: OnememoryStorage, filter: CandidateFilter, pageSize: number) {
  const pages: string[][] = [];
  let after: MemoryPageCursor | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await listMemoryPage(
      storage.client,
      { types: TYPES, pageSize, ...(after === undefined ? {} : { after }) },
      filter,
    );
    pages.push(page.memories.map((memory) => memory.id));
    if (page.next === null) return pages;
    after = page.next;
  }
  throw new Error('pagination did not terminate');
}

async function scenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'memory-page');
  const other = await seedProjectAndSource(storage, 'memory-page-other');

  // Three rows share one observed_at (id tiebreak); two more sit in the same millisecond but
  // differ by microseconds; two are plainly ordered.
  const tied = [
    await seed(storage, ctx, 'tie a', '2026-03-02T09:00:00.000Z'),
    await seed(storage, ctx, 'tie b', '2026-03-02T09:00:00.000Z'),
    await seed(storage, ctx, 'tie c', '2026-03-02T09:00:00.000Z'),
  ];
  const microLow = await seed(storage, ctx, 'micro low', '2026-03-03T09:00:00.000Z');
  const microHigh = await seed(storage, ctx, 'micro high', '2026-03-03T09:00:00.000Z');
  await storage.client.query(
    `UPDATE memories SET observed_at = observed_at + interval '1 microsecond' WHERE id = $1::uuid`,
    [microLow],
  );
  await storage.client.query(
    `UPDATE memories SET observed_at = observed_at + interval '2 microseconds' WHERE id = $1::uuid`,
    [microHigh],
  );
  const oldest = await seed(storage, ctx, 'oldest', '2026-03-01T09:00:00.000Z');
  const newest = await seed(storage, ctx, 'newest', '2026-03-04T09:00:00.000Z');
  await seed(storage, other, 'other project', '2026-03-05T09:00:00.000Z');

  const filter: CandidateFilter = {
    statuses: MEMORY_STATUSES,
    window: { kind: 'overlap', from: null, until: null },
    projectId: ctx.projectId,
  };
  const expected = [newest, microHigh, microLow, ...[...tied].sort().reverse(), oldest];

  for (const pageSize of [1, 2, 3, 7, 50]) {
    const pages = await walk(storage, filter, pageSize);
    expect(pages.flat()).toEqual(expected);
    for (const page of pages.slice(0, -1)) expect(page).toHaveLength(pageSize);
  }

  // Exactly-full last page: no phantom empty page follows.
  expect((await walk(storage, filter, 7)).length).toBe(1);

  // The status filter rides every page.
  await storage.store.updateMemoryStatus(newest, 'archived', { actor: 'user:test' });
  const active = await walk(storage, { ...filter, statuses: ['active'] }, 2);
  expect(active.flat()).toEqual(expected.slice(1));
}

/**
 * The M17 scope union: a project-scoped query admits the project's rows PLUS the caller's
 * user-level rows (project_id IS NULL AND user_id = caller) — and nothing else. Other projects'
 * rows and unowned global rows stay out.
 */
async function scenarioProjectOrUserScope(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'scope-union');
  const other = await seedProjectAndSource(storage, 'scope-union-other');
  const user = await ensureLocalUser(storage.client);

  const projectRow = await seed(storage, ctx, 'project fact', '2026-03-02T09:00:00.000Z');
  const userLevel = (
    await storage.store.insertMemory({
      type: 'preference',
      content: 'the user-level preference answers from any project',
      importance: 0.6,
      confidence: 0.8,
      observed_at: '2026-03-02T09:00:00.000Z',
      user_id: user.id,
      source_id: ctx.sourceId,
      evidence: [{ source_id: ctx.sourceId, kind: 'message', locator: 's.jsonl:user', excerpt: 'user-level' }],
      extraction: { method: 'heuristic', prompt_version: 'scope-v1' },
    })
  ).memory.id;
  const otherProjectRow = await seed(storage, other, 'other project fact', '2026-03-02T09:00:00.000Z');
  const globalRow = await seed(storage, ctx, 'global fact', '2026-03-02T09:00:00.000Z');
  await storage.client.query(`UPDATE memories SET project_id = NULL, user_id = NULL WHERE id = $1::uuid`, [globalRow]);

  const filter: CandidateFilter = {
    statuses: MEMORY_STATUSES,
    window: { kind: 'overlap', from: null, until: null },
    projectOrUser: { projectId: ctx.projectId, userId: user.id },
  };
  const ids = (await walk(storage, filter, 50)).flat().sort();
  expect(ids).toEqual([projectRow, userLevel].sort());
  expect(ids).not.toContain(otherProjectRow);
  expect(ids).not.toContain(globalRow);

  // The pure project scope (no union) stays exactly the project's rows.
  const projectOnly = (
    await walk(storage, { ...filter, projectOrUser: undefined, projectId: ctx.projectId }, 50)
  ).flat();
  expect(projectOnly.sort()).toEqual([projectRow].sort());

  // The two scope modes are mutually exclusive — an ambiguous filter fails closed.
  expect(() =>
    planFilter({ ...filter, projectId: ctx.projectId }, 1),
  ).toThrow(/mutually exclusive/);
}

function run(name: string, open: () => Promise<StorageHandle>): void {
  describe(name, () => {
    test('keyset pages cover every row exactly once, ties and sub-millisecond rows included', async () => {
      const handle = await open();
      try {
        await scenario(handle.storage);
      } finally {
        await handle.close();
      }
    }, 30_000);

    test('the project-or-user scope union admits the project plus the user level, nothing else', async () => {
      const handle = await open();
      try {
        await scenarioProjectOrUserScope(handle.storage);
      } finally {
        await handle.close();
      }
    }, 30_000);
  });
}

run('listMemoryPage (embedded / PGlite)', () => openEmbeddedStorage());

const connectionUrl = process.env.ONEMEMORY_PG_URL;

describe.skipIf(!connectionUrl)('listMemoryPage (postgres server)', () => {
  let storage: OnememoryStorage | null = null;
  beforeAll(async () => {
    storage = await createServerDb(connectionUrl!);
  });
  afterAll(async () => {
    await storage?.close();
  });
  run('scenarios', async (): Promise<StorageHandle> => {
    if (!storage) throw new Error('server suite opened before beforeAll completed');
    return { storage, dataDir: null, close: () => Promise.resolve() };
  });
});
