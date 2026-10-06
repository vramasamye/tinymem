/**
 * The skill promotion gate at the storage boundary (M15 follow-up 1 — "skill promotion-gating in
 * CI"): the invariants ADR-0009 leans on but nothing asserted directly.
 *
 * ADR-0009 rule 2 makes promotion a HUMAN decision (`auto_promote_skills = false`): generation may
 * only ever create candidates, and the `candidate → verified` flip must leave an audit row on the
 * same append-only `memory_events` trail every memory transition uses. Those two guarantees are
 * enforced in this repository — the only package with SQL — so they are pinned here, where a
 * regression would actually land.
 *
 * What is pinned:
 * - a fresh install never auto-promotes: `insertSkill` defaults to `candidate` and REFUSES an
 *   explicit later-stage status, and the `created` audit row records the candidate status;
 * - promotion writes exactly ONE `status_changed` audit row, attributed to the reviewer, carrying
 *   `from`/`to`/`note` and the caller's details, readable back through `listMemoryEvents` (the
 *   skill's id rides `memory_id` — the table is FK-less by design);
 * - an illegal edge is refused by the transition machine BEFORE any SQL runs, leaving no audit row.
 *
 * Runs on BOTH deployment profiles (ADR-0002 matrix): embedded PGlite always; the real Postgres
 * server when `ONEMEMORY_PG_URL` is set (the same skip discipline as `digest.test.ts`, so
 * `bun test` stays fully offline by default).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { InvalidSkillTransitionError, type NewSkill } from '@onememory/core';

import { createServerDb } from '../drivers/server';
import type { OnememoryStorage } from '../drivers/types';
import {
  openEmbeddedStorage,
  seedProjectAndSource,
  uniqueId,
  type FixtureContext,
  type StorageHandle,
} from '../integration/harness';
import { getSkill, insertSkill, updateSkillStatus } from './skills';

const ACTOR = 'user:reviewer-1';

/** One candidate the generation pass would insert (a real `NewSkill`, never a promoted row). */
function candidateFixture(ctx: FixtureContext, overrides: Partial<NewSkill> = {}): NewSkill {
  const name = `cloud-run-deploy-oom-${uniqueId().slice(0, 8)}`;
  return {
    project_id: ctx.projectId,
    name,
    description: 'Cloud Run deploys fail with OOM — raise the container memory limit.',
    version: '1.0.0',
    source: { failure_ids: [uniqueId(), uniqueId()] },
    verification: {
      evidence: [
        {
          source_id: ctx.sourceId,
          kind: 'event',
          locator: 'session.jsonl:412',
          excerpt: 'deploy passed after the memory bump',
        },
      ],
      verified_at: '2026-03-06T10:00:00.000Z',
    },
    path: `skills/${name}/SKILL.md`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — a fresh install never auto-promotes
// ---------------------------------------------------------------------------

async function scenarioFreshInstallOnlyCreatesCandidates(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'skill-gate');
  const inserted = await insertSkill(storage.client, candidateFixture(ctx), { actor: 'system:generation' });

  // The default is `candidate` — generation cannot land a serving row.
  expect(inserted.status).toBe('candidate');

  // The `created` audit row exists and records the candidate status + the generating actor.
  const audit = await storage.store.listMemoryEvents(inserted.id);
  expect(audit).toHaveLength(1);
  expect(audit[0]!.action).toBe('created');
  expect(audit[0]!.actor).toBe('system:generation');
  expect(audit[0]!.details['status']).toBe('candidate');
  expect(audit[0]!.details['kind']).toBe('skill');

  // An explicit later-stage status is REFUSED outright: only the review flow may promote.
  for (const status of ['verified', 'promoted', 'deprecated'] as const) {
    await expect(
      insertSkill(storage.client, candidateFixture(ctx, { status }), { actor: 'system:generation' }),
    ).rejects.toThrow(/refuses a non-candidate status/);
  }

  // The refusals wrote nothing — one skill, one audit row.
  const candidates = await storage.skills.listSkills({ scope: { project_id: ctx.projectId } });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.status).toBe('candidate');
}

// ---------------------------------------------------------------------------
// Scenario 2 — promotion leaves exactly one reviewer-attributed audit row
// ---------------------------------------------------------------------------

async function scenarioPromotionIsAudited(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'skill-promote');
  const candidate = await insertSkill(storage.client, candidateFixture(ctx), { actor: 'system:generation' });

  const promoted = await updateSkillStatus(storage.client, candidate.id, 'verified', {
    actor: ACTOR,
    note: 'recurring twice, fix verified',
    details: { written_path: `/tmp/project/skills/${candidate.name}/SKILL.md`, markdown_bytes: 1234 },
    at: '2026-03-06T11:00:00.000Z',
  });

  expect(promoted.status).toBe('verified');
  expect(promoted.updated_at).toBe('2026-03-06T11:00:00.000Z');

  // Exactly one `status_changed` row joined the trail — appended, never rewriting `created`.
  const audit = await storage.store.listMemoryEvents(candidate.id);
  expect(audit).toHaveLength(2);
  expect(audit.map((row) => row.action)).toEqual(['created', 'status_changed']);

  const flip = audit[1]!;
  expect(flip.actor).toBe(ACTOR); // the reviewer, not a system actor
  expect(flip.details['from']).toBe('candidate');
  expect(flip.details['to']).toBe('verified');
  expect(flip.details['note']).toBe('recurring twice, fix verified');
  expect(flip.details['written_path']).toBe(`/tmp/project/skills/${candidate.name}/SKILL.md`);
  expect(flip.details['markdown_bytes']).toBe(1234);
  expect(flip.details['kind']).toBe('skill');
  expect(flip.at).toBe('2026-03-06T11:00:00.000Z');

  // The row itself moved, and the flip is not re-runnable: the edge no longer exists.
  expect((await getSkill(storage.client, candidate.id))!.status).toBe('verified');
  await expect(updateSkillStatus(storage.client, candidate.id, 'verified', { actor: ACTOR })).rejects.toThrow(
    InvalidSkillTransitionError,
  );
  // …and the refused retry appended nothing.
  expect(await storage.store.listMemoryEvents(candidate.id)).toHaveLength(2);
}

// ---------------------------------------------------------------------------
// Scenario 3 — illegal edges are refused before any SQL
// ---------------------------------------------------------------------------

async function scenarioIllegalEdgesWriteNothing(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'skill-illegal');
  const candidate = await insertSkill(storage.client, candidateFixture(ctx), { actor: 'system:generation' });

  // candidate → promoted skips the human verification gate entirely (ADR-0009 rule 4).
  await expect(
    updateSkillStatus(storage.client, candidate.id, 'promoted', { actor: ACTOR }),
  ).rejects.toThrow(InvalidSkillTransitionError);

  // An unknown skill id is an honest not-found, not a silent success.
  await expect(updateSkillStatus(storage.client, uniqueId(), 'verified', { actor: ACTOR })).rejects.toThrow(
    /not found/i,
  );

  // Neither refusal touched the trail or the row.
  expect(await storage.store.listMemoryEvents(candidate.id)).toHaveLength(1);
  expect((await getSkill(storage.client, candidate.id))!.status).toBe('candidate');
}

/** Scenario 4 — the candidate's legal edges are exactly verified | deprecated. */
async function scenarioCandidateEdgesAreExact(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'skill-edges');

  // `verified` is the promotion edge (scenario 2 covers its audit contract).
  const promotable = await insertSkill(storage.client, candidateFixture(ctx), { actor: 'system:generation' });
  expect((await updateSkillStatus(storage.client, promotable.id, 'verified', { actor: ACTOR })).status).toBe(
    'verified',
  );

  // `deprecated` is the other legal edge, and it is terminal.
  const deprecated = await insertSkill(storage.client, candidateFixture(ctx), { actor: 'system:generation' });
  expect(
    (await updateSkillStatus(storage.client, deprecated.id, 'deprecated', { actor: ACTOR, note: 'superseded' }))
      .status,
  ).toBe('deprecated');
  for (const to of ['candidate', 'verified', 'promoted'] as const) {
    await expect(updateSkillStatus(storage.client, deprecated.id, to, { actor: ACTOR })).rejects.toThrow(
      InvalidSkillTransitionError,
    );
  }
}

const SCENARIOS: Array<[title: string, scenario: (storage: OnememoryStorage) => Promise<void>]> = [
  ['a fresh install only ever creates candidates — insertSkill refuses a later stage', scenarioFreshInstallOnlyCreatesCandidates],
  ['promotion appends exactly one reviewer-attributed status_changed row', scenarioPromotionIsAudited],
  ['illegal edges are refused by the transition machine and write nothing', scenarioIllegalEdgesWriteNothing],
  ['the candidate edges are exactly verified | deprecated, and deprecated is terminal', scenarioCandidateEdgesAreExact],
];

function runSkillGateScenarios(
  suiteName: string,
  open: () => Promise<StorageHandle>,
  options?: { enabled?: boolean },
): void {
  const describeFn = options?.enabled === false ? describe.skip : describe;
  describeFn(suiteName, () => {
    for (const [title, scenario] of SCENARIOS) {
      test(title, async () => {
        const handle = await open();
        try {
          await scenario(handle.storage);
        } finally {
          await handle.close();
        }
      });
    }
  });
}

runSkillGateScenarios('skill promotion gate (embedded / PGlite)', () => openEmbeddedStorage());

const connectionUrl = process.env.ONEMEMORY_PG_URL;

describe.skipIf(!connectionUrl)('skill promotion gate (postgres server)', () => {
  let storage: OnememoryStorage | null = null;

  beforeAll(async () => {
    storage = await createServerDb(connectionUrl!);
  });
  afterAll(async () => {
    await storage?.close();
  });

  runSkillGateScenarios('scenarios', async (): Promise<StorageHandle> => {
    if (!storage) throw new Error('server suite opened before beforeAll completed');
    return { storage, dataDir: null, close: () => Promise.resolve() };
  });
});
