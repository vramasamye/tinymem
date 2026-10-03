/**
 * Session-context assembly against the fixture world (real embedded PGlite): budget respected,
 * digest + decisions + failures + procedures + preferences present, line-level packing.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { buildSessionContext } from './session-context';
import { seedWorld, WORLD_NOW, type WorldHandle } from './test-world';

let world: WorldHandle;

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world.close();
});

describe('buildSessionContext (retrieval.md §2)', () => {
  test('assembles digest + decisions + failures + procedures + preferences under the default 750 budget', async () => {
    const context = await buildSessionContext(world.storage, world.ids.projectId, {
      now: () => new Date(WORLD_NOW),
    });
    expect(context.used).toBeLessThanOrEqual(750);
    expect(context.sections.map((section) => section.kind)).toEqual([
      'digest', 'decisions', 'failures', 'procedures', 'preferences',
    ]);
    expect(context.text).toContain('Invoice REST API in TypeScript');
    expect(context.text).toContain('Use PostgreSQL as the primary database');
    expect(context.text).toContain('Cloud Run deploys fail with OOM');
    expect(context.text).toContain('Deploy to Cloud Run');
    expect(context.text).toContain('Prefer tabs');
    // Section accounting: tokens sum to used; text is the sections joined.
    expect(context.used).toBe(context.sections.reduce((sum, section) => sum + section.tokens, 0));
    expect(context.warnings).toEqual([]); // digest present in the fixture
  });

  test('a small budget is respected; whole lines dropped, never mid-sentence', async () => {
    const context = await buildSessionContext(world.storage, world.ids.projectId, {
      budget: 60,
      now: () => new Date(WORLD_NOW),
    });
    expect(context.used).toBeLessThanOrEqual(60);
    expect(context.text.length).toBeGreaterThan(0);
    // Sections are separated by one blank line; every content line is whole.
    for (const section of context.sections) {
      for (const line of section.text.split('\n')) {
        expect(line.trim().length).toBeGreaterThan(0);
        expect(line.endsWith(' ')).toBe(false);
      }
    }
    expect(context.text).toBe(context.sections.map((section) => section.text).join('\n\n'));
  });

  test('accepted decisions only (payload-verified) — the accepted decision, not the disputed claim', async () => {
    const context = await buildSessionContext(world.storage, world.ids.projectId, {
      now: () => new Date(WORLD_NOW),
    });
    const decisions = context.sections.find((section) => section.kind === 'decisions');
    expect(decisions?.text).toContain('Use PostgreSQL as the primary database');
    expect(decisions?.text).not.toContain('SQLite');
  });

  test('known failures carry problem → solution one-liners', async () => {
    const context = await buildSessionContext(world.storage, world.ids.projectId, {
      now: () => new Date(WORLD_NOW),
    });
    const failures = context.sections.find((section) => section.kind === 'failures');
    expect(failures?.text).toContain('OOM');
    expect(failures?.text).toContain('Raise the container memory limit to 1GiB');
  });

  test('warns honestly when the digest rollup is not yet built', async () => {
    const context = await buildSessionContext(world.storage, world.ids.otherProjectId, {
      now: () => new Date(WORLD_NOW),
    });
    expect(context.warnings.some((warning) => warning.includes('project digest not yet built'))).toBe(true);
    // Without the rollup the digest section degrades to the project header only.
    const digest = context.sections.find((section) => section.kind === 'digest');
    expect(digest?.text.split('\n').every((line) => /^(project|description): /.test(line))).toBe(true);
  });

  test('cross-package contract: OnememoryStorage structurally satisfies SessionContextDeps', async () => {
    // The deps shape is { store, client } — exactly what OnememoryStorage exposes.
    const context = await buildSessionContext(
      { store: world.storage.store, client: world.storage.client },
      world.ids.projectId,
      { now: () => new Date(WORLD_NOW) },
    );
    expect(context.project_id).toBe(world.ids.projectId);
    expect(context.used).toBeGreaterThan(0);
  });
});
