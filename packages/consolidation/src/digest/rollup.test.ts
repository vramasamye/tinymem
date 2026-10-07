/**
 * The rollup builder's tests — the packing core mirrors M2's token-budget packer suite
 * (packages/retrieval/src/packing.test.ts): a seeded PROPERTY test over random fixtures × random
 * budgets asserting the hard invariants, plus deterministic unit cases for the one-liner
 * semantics, the section allowances, and the durable-memory shaping.
 *
 *   1. used ≤ budget, ALWAYS (by construction — each packed line reserves its joining newline)
 *   2. whole-line packing only: every packed section line is a source's FULL one-liner (never a
 *      mid-sentence cut), and every emitted section header has at least one line under it
 *   3. token accounting: used === estimateTokens(text)
 *   4. the renderable entries mirror the packed sections one-to-one (decision_01 → decisions[0])
 *   5. `truncated` is honest: it is set exactly when a line (or the description) was dropped
 */

import { describe, expect, test } from 'bun:test';

import { estimateTokens } from '@onememory-ai/core';

import { memoryFixture } from '../testing';
import {
  buildProjectDigest,
  clampAtWordBoundary,
  decisionLineOf,
  digestMemoryOf,
  failureLineOf,
  procedureLineOf,
  type DigestDecisionInput,
  type DigestFailureInput,
  type DigestProcedureInput,
} from './rollup';

const NOW = '2026-10-05T12:00:00.000Z';

/** `memoryFixture` carries no title/content_summary overrides — patch them on (plain records). */
function memoryWith(overrides: {
  content: string;
  type: 'decision' | 'failure' | 'procedural';
  title?: string;
  summary?: string;
}) {
  const memory = memoryFixture({ type: overrides.type, content: overrides.content });
  return {
    ...memory,
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    ...(overrides.summary === undefined ? {} : { content_summary: overrides.summary }),
  };
}

function decisionOf(overrides: { content: string; summary?: string; rationale?: string | null }): DigestDecisionInput {
  return {
    memory: memoryWith({ type: 'decision', content: overrides.content, ...(overrides.summary === undefined ? {} : { summary: overrides.summary }) }),
    decided_at: NOW,
    rationale: overrides.rationale ?? null,
  };
}

function failureOf(overrides: {
  content: string;
  problem: string;
  solution?: string | null;
  status?: string;
}): DigestFailureInput {
  return {
    memory: memoryFixture({ type: 'failure', content: overrides.content }),
    problem: overrides.problem,
    solution: overrides.solution ?? null,
    failure_status: overrides.status ?? 'open',
    occurrence_count: 2,
  };
}

function procedureOf(overrides: { content: string; title?: string; summary?: string }): DigestProcedureInput {
  return memoryWith({
    type: 'procedural',
    content: overrides.content,
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
  });
}

// ---------------------------------------------------------------------------
// One-liner semantics (the session-context contract, retrieval.md §2)
// ---------------------------------------------------------------------------

describe('one-liner shaping', () => {
  test('a decision is `summary — rationale`, falling back title → content', () => {
    expect(decisionLineOf(decisionOf({ content: 'Use PostgreSQL.', summary: 'Use PostgreSQL as the primary database.', rationale: 'Operational maturity' }))).toBe(
      'Use PostgreSQL as the primary database. — Operational maturity',
    );
    expect(decisionLineOf(decisionOf({ content: 'Use PostgreSQL.', rationale: 'Operational maturity' }))).toBe(
      'Use PostgreSQL. — Operational maturity',
    );
    expect(decisionLineOf(decisionOf({ content: 'Use PostgreSQL.', summary: 'Use PostgreSQL.', rationale: null }))).toBe(
      'Use PostgreSQL.',
    );
  });

  test('a failure is `problem → solution`, or `problem (status)` while unsolved, clamped at word boundaries', () => {
    expect(failureLineOf(failureOf({ content: 'x', problem: 'OOM on deploy', solution: 'Raise the memory limit' }))).toBe(
      'OOM on deploy → Raise the memory limit',
    );
    expect(failureLineOf(failureOf({ content: 'x', problem: 'OOM on deploy', solution: null, status: 'open' }))).toBe(
      'OOM on deploy (open)',
    );
    const longProblem = 'word '.repeat(40).trim();
    const line = failureLineOf(failureOf({ content: 'x', problem: longProblem, solution: 'fix' }));
    expect(line.length).toBeLessThanOrEqual(120 + 120);
    expect(line).toContain('…'); // the problem half clamped at a word boundary — never a mid-word cut
    expect(line.endsWith(' → fix')).toBe(true);
  });

  test('a procedure is `title ?? summary ?? clamped content`', () => {
    expect(procedureLineOf(procedureOf({ content: 'long content', title: 'Deploy' }))).toBe('Deploy');
    expect(procedureLineOf(procedureOf({ content: 'long content', summary: 'Deploy the service' }))).toBe('Deploy the service');
    const long = 'word '.repeat(60).trim();
    const fromContent = procedureLineOf(procedureOf({ content: long }));
    expect(fromContent.endsWith('…')).toBe(true);
    expect(fromContent.length).toBeLessThanOrEqual(121);
  });

  test('clampAtWordBoundary mirrors retrieval’s word-boundary cut', () => {
    expect(clampAtWordBoundary('short', 20)).toBe('short');
    expect(clampAtWordBoundary('one two three four', 7)).toBe('one two…');
    // No space in the back half: a hard boundary beat a mid-word cut at the halfway marker.
    expect(clampAtWordBoundary('abcdefghijklmnop', 8)).toBe('abcdefgh…');
  });
});

// ---------------------------------------------------------------------------
// The property test (seeded, deterministic — mirrors M2's packing suite)
// ---------------------------------------------------------------------------

/** mulberry32 — the seeded PRNG the retrieval packer tests use (local twin, test-only). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SENTENCES = [
  'The deploy script pushes the container to the registry.',
  'Migrations run before the service starts.',
  'Tests must pass before any deploy proceeds.',
  'The invoice API caches responses in Redis for five minutes.',
  'PostgreSQL connection limits were raised last quarter.',
  'Node version 22 is required for the build pipeline.',
  'The OOM failure was traced to unbounded batch sizes.',
  'Preferences say tabs over spaces everywhere.',
  'Cloud Run gives the service a public HTTPS endpoint.',
  'The digest describes a TypeScript REST service.',
];

function randomSentence(random: () => number): string {
  return SENTENCES[Math.floor(random() * SENTENCES.length)]!;
}

describe('the digest property test (seeded, deterministic)', () => {
  test('random fixtures × random budgets satisfy every hard invariant', () => {
    const random = mulberry32(20261005);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const budget = 4 + Math.floor(random() * 900);
      const decisions: DigestDecisionInput[] = [];
      for (let i = 0, count = Math.floor(random() * 6); i < count; i += 1) {
        decisions.push(
          decisionOf({
            content: `${randomSentence(random)} ${randomSentence(random)}`,
            ...(random() < 0.7 ? { summary: randomSentence(random) } : {}),
            ...(random() < 0.6 ? { rationale: randomSentence(random) } : {}),
          }),
        );
      }
      const failures: DigestFailureInput[] = [];
      for (let i = 0, count = Math.floor(random() * 5); i < count; i += 1) {
        failures.push(
          failureOf({
            content: randomSentence(random),
            problem: `${randomSentence(random)} ${randomSentence(random)}`,
            ...(random() < 0.7 ? { solution: randomSentence(random) } : { status: 'open' }),
          }),
        );
      }
      const procedures: DigestProcedureInput[] = [];
      for (let i = 0, count = Math.floor(random() * 4); i < count; i += 1) {
        procedures.push(procedureOf({ content: randomSentence(random), ...(random() < 0.5 ? { title: randomSentence(random) } : {}) }));
      }
      const description = random() < 0.5 ? randomSentence(random) : null;

      const candidate = buildProjectDigest({
        project_id: '00000000-0000-7000-8000-000000000001',
        project_name: 'property-project',
        ...(description === null ? {} : { description }),
        decisions,
        failures,
        procedures,
        budget,
        now_iso: NOW,
      });

      // 1 + 3. The budget ceiling, with exact accounting of the assembled text.
      expect(candidate.used).toBeLessThanOrEqual(budget);
      expect(candidate.used).toBe(estimateTokens(candidate.text));
      expect(candidate.budget).toBe(budget);

      // 2. Whole-line packing: every packed section line is a source's FULL one-liner, and every
      //    emitted section header carries at least one line under it.
      const decisionLines = new Set(decisions.map(decisionLineOf));
      const failureLines = new Set(failures.map(failureLineOf));
      const procedureLines = new Set(procedures.map(procedureLineOf));
      for (const line of candidate.sections.decisions) expect(decisionLines.has(line)).toBe(true);
      for (const line of candidate.sections.failures) expect(failureLines.has(line)).toBe(true);
      for (const line of candidate.sections.procedures) expect(procedureLines.has(line)).toBe(true);
      const lines = candidate.text.split('\n');
      for (const title of ['top decisions:', 'known failures:', 'procedures:']) {
        const at = lines.indexOf(title);
        if (at >= 0) {
          expect(lines[at + 1]).toBeDefined();
          expect(lines[at + 1]!.startsWith('- ')).toBe(true);
        }
      }

      // 4. The renderable entries mirror the packed sections one-to-one.
      const entryValues = Object.values(candidate.entries);
      expect(entryValues).toEqual([
        ...candidate.sections.decisions,
        ...candidate.sections.failures,
        ...candidate.sections.procedures,
      ]);
      for (const key of Object.keys(candidate.entries)) {
        expect(key).toMatch(/^(decision|failure|procedure)_\d{2}$/);
      }
      expect(candidate.entries.decision_01 ?? undefined).toBe(candidate.sections.decisions[0] ?? undefined);
      expect(candidate.entries.failure_01 ?? undefined).toBe(candidate.sections.failures[0] ?? undefined);
      expect(candidate.entries.procedure_01 ?? undefined).toBe(candidate.sections.procedures[0] ?? undefined);

      // 2b. Cited sources are exactly the packed lines' sources (never a dropped line's).
      expect(candidate.source_ids.length).toBe(entryValues.length);

      // 5. `truncated` is honest: set exactly when a source line or the description was dropped.
      const packedEverything =
        candidate.sections.decisions.length === decisions.length &&
        candidate.sections.failures.length === failures.length &&
        candidate.sections.procedures.length === procedures.length &&
        (description === null || candidate.text.includes('description:'));
      expect(candidate.truncated).toBe(!packedEverything);

      // Determinism: same inputs, byte-identical text.
      const again = buildProjectDigest({
        project_id: '00000000-0000-7000-8000-000000000001',
        project_name: 'property-project',
        ...(description === null ? {} : { description }),
        decisions,
        failures,
        procedures,
        budget,
        now_iso: NOW,
      });
      expect(again.content_hash).toBe(candidate.content_hash);
      expect(again.text).toBe(candidate.text);
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic builder cases
// ---------------------------------------------------------------------------

describe('buildProjectDigest (deterministic cases)', () => {
  const inputs = {
    project_id: '00000000-0000-7000-8000-000000000002',
    project_name: 'acme-api',
    description: 'Invoice API for Acme',
    decisions: [
      decisionOf({ content: 'Use PostgreSQL as the primary database.', summary: 'Use PostgreSQL as the primary database.', rationale: 'Operational maturity' }),
    ],
    failures: [failureOf({ content: 'Cloud Run deploys fail with OOM.', problem: 'Cloud Run deploys fail with OOM', solution: 'Raise the container memory limit' })],
    procedures: [procedureOf({ content: 'Deploy to Cloud Run with the service account.', title: 'Deploy to Cloud Run' })],
  };

  test('the default budget (750 — the memory_project_context tool budget) holds with room', () => {
    const candidate = buildProjectDigest({ ...inputs, now_iso: NOW });
    expect(candidate.used).toBeLessThanOrEqual(750);
    expect(candidate.text).toContain('project: acme-api');
    expect(candidate.text).toContain('description: Invoice API for Acme');
    expect(candidate.text).toContain('top decisions:');
    expect(candidate.text).toContain('- Use PostgreSQL as the primary database. — Operational maturity');
    expect(candidate.text).toContain('known failures:');
    expect(candidate.text).toContain('- Cloud Run deploys fail with OOM → Raise the container memory limit');
    expect(candidate.text).toContain('procedures:');
    expect(candidate.text).toContain('- Deploy to Cloud Run');
    expect(candidate.truncated).toBe(false);
    expect(candidate.sources).toEqual({ decisions: 1, failures: 1, procedures: 1 });
  });

  test('unused section allowance carries forward (the roll-forward discipline)', () => {
    // No decisions: their whole allowance rolls into failures — a failure line that does NOT fit
    // the bare 30% share fits with the carried allowance.
    const longProblem = 'problem '.repeat(20).trim(); // well above the bare share of 60 tokens
    const candidate = buildProjectDigest({
      project_id: inputs.project_id,
      project_name: 'carry-app',
      decisions: [],
      failures: [failureOf({ content: 'x', problem: longProblem, solution: 'cap the batch size' })],
      procedures: [],
      budget: 200,
      now_iso: NOW,
    });
    expect(candidate.sections.failures).toHaveLength(1);
    expect(candidate.used).toBeLessThanOrEqual(200);
  });

  test('a section that fits its header but no line emits nothing (no dangling header)', () => {
    const candidate = buildProjectDigest({
      project_id: inputs.project_id,
      project_name: 'tight-app',
      decisions: [decisionOf({ content: `${'decision '.repeat(60)}`, summary: `${'summary '.repeat(60)}` })],
      failures: [],
      procedures: [],
      budget: 80,
      now_iso: NOW,
    });
    expect(candidate.text).not.toContain('top decisions:');
    expect(candidate.truncated).toBe(true);
    expect(candidate.used).toBeLessThanOrEqual(80);
  });

  test('degenerate budgets still hold used ≤ budget (the identity line clamps)', () => {
    for (const budget of [1, 2, 3, 4, 5, 8]) {
      const candidate = buildProjectDigest({ ...inputs, budget, now_iso: NOW });
      expect(candidate.used).toBeLessThanOrEqual(budget);
      expect(candidate.text.length).toBeGreaterThan(0);
    }
    const one = buildProjectDigest({ ...inputs, budget: 1, now_iso: NOW });
    expect(estimateTokens(one.text)).toBeLessThanOrEqual(1);
  });

  test('a project with no digest sources yields a header-only candidate (the pass skips it)', () => {
    const candidate = buildProjectDigest({
      project_id: inputs.project_id,
      project_name: 'empty-app',
      decisions: [],
      failures: [],
      procedures: [],
      now_iso: NOW,
    });
    expect(candidate.text).toContain('project: empty-app');
    expect(candidate.sections).toEqual({ decisions: [], failures: [], procedures: [] });
    expect(candidate.entries).toEqual({});
    expect(candidate.source_ids).toEqual([]);
    expect(candidate.evidence).toEqual([]);
    expect(candidate.observed_at).toBe(NOW);
    expect(candidate.valid_from).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// The durable-memory shaping
// ---------------------------------------------------------------------------

describe('digestMemoryOf', () => {
  test('shapes the semantic / project_context NewMemory with provenance and budget accounting', () => {
    const candidate = buildProjectDigest({
      project_id: '00000000-0000-7000-8000-000000000003',
      project_name: 'shaping-app',
      decisions: [decisionOf({ content: 'Adopt conventional commits.', summary: 'Adopt conventional commits.' })],
      failures: [],
      procedures: [],
      now_iso: NOW,
    });
    const memory = digestMemoryOf(candidate, {
      source_id: '00000000-0000-7000-8001-000000000002',
      observed_at: '2026-10-05T13:00:00.000Z',
    });
    expect(memory.type).toBe('semantic');
    expect(memory.subtype).toBe('project_context');
    expect(memory.tags).toEqual(['project_digest', 'project_context']);
    expect(memory.content).toBe(candidate.text);
    expect(memory.token_estimate).toBe(candidate.used);
    expect(memory.observed_at).toBe('2026-10-05T13:00:00.000Z');
    expect(memory.valid_from).toBe(candidate.valid_from);
    expect(memory.project_id).toBe(candidate.project_id);
    expect(memory.source_id).toBe('00000000-0000-7000-8001-000000000002');
    expect(memory.evidence.length).toBeGreaterThan(0);
    expect(memory.extraction).toEqual({
      method: 'heuristic',
      prompt_version: 'consolidation/project-digest-1',
      adapter: 'consolidation',
    });
  });

  test('refuses to shape a digest that carries no evidence (the provenance invariant)', () => {
    const candidate = buildProjectDigest({
      project_id: '00000000-0000-7000-8000-000000000004',
      project_name: 'no-evidence-app',
      decisions: [],
      failures: [],
      procedures: [],
      now_iso: NOW,
    });
    expect(() =>
      digestMemoryOf(candidate, { source_id: '00000000-0000-7000-8001-000000000003', observed_at: NOW }),
    ).toThrow(/no evidence spans/);
  });
});
