/**
 * The LLM conflict tier (memory-model.md §9, ADR-0006): the router's `conflict` operation
 * adjudicates pairs the attribute-template heuristic cannot even form a candidate for
 * ("PostgreSQL with pgvector as the only database dialect" vs "MySQL for the primary
 * datastore" — different templates, same question, incompatible answers).
 *
 * The tier is opt-in and fail-closed: no `conflict` route → the template heuristic is the whole
 * detector (offline behavior byte-identical); a provider failure or an invalid verdict clears the
 * pair (never a contradiction on no evidence) and is recorded, never silent.
 */

import { describe, expect, test } from 'bun:test';

import { buildConflictPrompt, createConflictDetector, createLlmConflictDetector } from './conflict';
import { contradictsHeuristically } from './contradiction';
import { FakeRouter, memoryFixture } from './testing';

const PROJECT = '00000000-0000-7000-8002-000000000001';

const postgres = memoryFixture({
  type: 'decision',
  content: 'Decision: use PostgreSQL with pgvector as the only database dialect',
  project_id: PROJECT,
  observed_at: '2026-01-10T00:00:00.000Z',
});
const mysql = memoryFixture({
  type: 'decision',
  content: 'Decision: use MySQL for the primary datastore',
  project_id: PROJECT,
  observed_at: '2026-06-10T00:00:00.000Z',
});
const bunTest = memoryFixture({
  type: 'decision',
  content: 'Decision: run the suite with bun test',
  project_id: PROJECT,
  observed_at: '2026-03-01T00:00:00.000Z',
});
const bunTestRestated = memoryFixture({
  type: 'decision',
  content: 'Decision: the suite runs on bun test',
  project_id: PROJECT,
  observed_at: '2026-03-02T00:00:00.000Z',
});

describe('buildConflictPrompt', () => {
  test('carries both statements and orders them deterministically regardless of argument order', () => {
    const forward = buildConflictPrompt(postgres, mysql);
    const backward = buildConflictPrompt(mysql, postgres);
    expect(forward).toBe(backward);
    expect(forward).toContain(postgres.content);
    expect(forward).toContain(mysql.content);
  });
});

describe('createLlmConflictDetector', () => {
  test('the tier flags the cross-phrasing pair the template heuristic cannot form a candidate for', async () => {
    // The gap this tier exists to close: same question, incompatible answers, different templates.
    expect(contradictsHeuristically(postgres, mysql)).toBeFalse();

    const router = new FakeRouter({
      configured: ['conflict'],
      respond: (request) => ({ contradicts: /mysql/i.test(request.prompt) }),
    });
    const detector = createLlmConflictDetector(router);

    expect(await detector(postgres, mysql)).toBeTrue();
    expect(await detector(postgres, bunTestRestated)).toBeFalse();
  });

  test('the same pair is adjudicated once — the verdict is memoized per detector', async () => {
    const router = new FakeRouter({ configured: ['conflict'], respond: () => ({ contradicts: true }) });
    const detector = createLlmConflictDetector(router);

    await detector(postgres, mysql);
    await detector(mysql, postgres);
    expect(router.requests).toHaveLength(1);
  });

  test('a provider failure clears the pair and records a warning — never a contradiction on no evidence', async () => {
    const warnings: string[] = [];
    const router = new FakeRouter({ configured: ['conflict'], failAll: true });
    const detector = createLlmConflictDetector(router, { warnings });

    expect(await detector(postgres, mysql)).toBeFalse();
    expect(warnings.some((warning) => warning.includes('conflict adjudication failed'))).toBeTrue();
  });

  test('an invalid verdict clears the pair and records a warning', async () => {
    const warnings: string[] = [];
    const router = new FakeRouter({ configured: ['conflict'], respond: () => ({ verdict: 'maybe' }) });
    const detector = createLlmConflictDetector(router, { warnings });

    expect(await detector(postgres, mysql)).toBeFalse();
    expect(warnings.some((warning) => warning.includes('invalid-output'))).toBeTrue();
  });
});

describe('createConflictDetector (the composite the passes share)', () => {
  test('a same-template pair is decided by the deterministic heuristic — the model is never called', async () => {
    const router = new FakeRouter({ configured: ['conflict'], respond: () => ({ contradicts: true }) });
    const detector = createConflictDetector(router);
    const node20 = memoryFixture({
      type: 'semantic',
      content: 'Version: Node 20',
      project_id: PROJECT,
      observed_at: '2026-01-10T00:00:00.000Z',
    });
    const node22 = memoryFixture({
      type: 'semantic',
      content: 'Version: Node 22',
      project_id: PROJECT,
      observed_at: '2026-06-10T00:00:00.000Z',
    });

    expect(await detector(node20, node22)).toBeTrue();
    expect(router.requests).toHaveLength(0);
  });

  test('a different-template pair reaches the model — the cross-phrasing case', async () => {
    const router = new FakeRouter({ configured: ['conflict'], respond: () => ({ contradicts: true }) });
    const detector = createConflictDetector(router);

    expect(await detector(postgres, mysql)).toBeTrue();
    expect(router.requests).toHaveLength(1);
  });

  test('different scopes are not a conflict and cost no model call', async () => {
    const router = new FakeRouter({ configured: ['conflict'], respond: () => ({ contradicts: true }) });
    const detector = createConflictDetector(router);
    const otherProject = memoryFixture({
      type: 'decision',
      content: 'Decision: use MySQL for the primary datastore',
      project_id: '00000000-0000-7000-8002-0000000000ff',
    });

    expect(await detector(postgres, otherProject)).toBeFalse();
    expect(router.requests).toHaveLength(0);
  });

  test('disjoint validity windows are not a conflict and cost no model call', async () => {
    const router = new FakeRouter({ configured: ['conflict'], respond: () => ({ contradicts: true }) });
    const detector = createConflictDetector(router);
    const closed = memoryFixture({
      type: 'decision',
      content: 'Decision: use MySQL for the primary datastore',
      project_id: PROJECT,
      observed_at: '2025-01-01T00:00:00.000Z',
      valid_from: '2025-01-01T00:00:00.000Z',
      valid_until: '2025-06-01T00:00:00.000Z',
    });

    expect(await detector(postgres, closed)).toBeFalse();
    expect(router.requests).toHaveLength(0);
  });
});
