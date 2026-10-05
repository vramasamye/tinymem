/**
 * The derivation builders: representative choice, evidence union, corroboration scores, the
 * derived temporals, the templated offline merge, and the optional LLM merge through the model
 * router — including the zero-network fallback path (AGENTS.md rule 4).
 */

import { describe, expect, test } from 'bun:test';

import type { EvidenceSpan } from '@onememory/core';

import {
  DERIVATION_LLM_PROMPT_VERSION,
  DERIVATION_TEMPLATE_VERSION,
  buildDerivedMemory,
  derivedScores,
  derivedTemporals,
  mergeClusterContent,
  mergeSourceOf,
  representativeSource,
  templatedMerge,
  unionEvidence,
} from './derive';
import { FakeRouter, memoryFixture } from './testing';

const SOURCE_ID = '00000000-0000-7000-8003-000000000001';

function span(sourceId: string, locator: string, excerpt = 'x'): EvidenceSpan {
  return { source_id: sourceId, kind: 'message', locator, excerpt };
}

function clusterFixture(overrides: Array<Partial<Parameters<typeof memoryFixture>[0]>>) {
  return overrides.map((override) =>
    mergeSourceOf(
      memoryFixture({
        project_id: '00000000-0000-7000-8002-000000000001',
        source_id: SOURCE_ID,
        ...override,
      }),
    ),
  );
}

describe('mergeSourceOf', () => {
  test('projects a MemoryRecord onto the derivation source view', () => {
    const memory = memoryFixture({
      observed_at: '2026-05-02T00:00:00.000Z',
      confidence: 0.8,
      importance: 0.5,
      source_id: SOURCE_ID,
      evidence: [span(SOURCE_ID, 'session.jsonl:1')],
    });
    const source = mergeSourceOf(memory);
    expect(source).toEqual({
      id: memory.id,
      content: memory.content,
      observed_at: memory.observed_at,
      valid_from: memory.valid_from,
      confidence: 0.8,
      importance: 0.5,
      source_id: SOURCE_ID,
      evidence: memory.provenance.evidence,
    });
  });
});

describe('representativeSource', () => {
  test('picks the member with the highest total cosine to the cluster', () => {
    const sources = clusterFixture([
      { content: 'ran bun test', observed_at: '2026-01-01T00:00:00.000Z' },
      { content: 'bun test executed', observed_at: '2026-02-01T00:00:00.000Z' },
      { content: 'tests via bun test', observed_at: '2026-03-01T00:00:00.000Z' },
    ]);
    const cosineSum = new Map([
      [sources[0]!.id, 1.4],
      [sources[1]!.id, 1.9],
      [sources[2]!.id, 1.6],
    ]);
    expect(representativeSource(sources, cosineSum).id).toBe(sources[1]!.id);
  });

  test('breaks cosine ties by recency, then confidence, then id (deterministic)', () => {
    const older = clusterFixture([{ content: 'a', observed_at: '2026-01-01T00:00:00.000Z', confidence: 0.9 }])[0]!;
    const newer = clusterFixture([{ content: 'b', observed_at: '2026-02-01T00:00:00.000Z', confidence: 0.5 }])[0]!;
    const same = clusterFixture([{ content: 'c', observed_at: '2026-02-01T00:00:00.000Z', confidence: 0.5 }])[0]!;
    const tie = new Map([
      [older.id, 1.5],
      [newer.id, 1.5],
    ]);
    expect(representativeSource([older, newer], tie).id).toBe(newer.id);
    // Same recency and confidence: the smaller id wins deterministically (newer was minted first).
    expect(representativeSource([newer, same], new Map([[newer.id, 1.5], [same.id, 1.5]])).id).toBe(newer.id);
    // A higher confidence beats a same-recency tie.
    const confident = clusterFixture([{ content: 'd', observed_at: '2026-02-01T00:00:00.000Z', confidence: 0.95 }])[0]!;
    expect(representativeSource([newer, confident], new Map([[newer.id, 1.5], [confident.id, 1.5]])).id).toBe(
      confident.id,
    );
  });
});

describe('unionEvidence', () => {
  test('unions the evidence spans of every source, first occurrence wins, duplicates collapse', () => {
    const sources = clusterFixture([
      { evidence: [span(SOURCE_ID, 'session.jsonl:1', 'a'), span(SOURCE_ID, 'session.jsonl:2', 'b')] },
      { evidence: [span(SOURCE_ID, 'session.jsonl:1', 'a'), span(SOURCE_ID, 'session.jsonl:3', 'c')] },
      { evidence: [span(SOURCE_ID, 'session.jsonl:2', 'b')] },
    ]);
    expect(unionEvidence(sources)).toEqual([
      span(SOURCE_ID, 'session.jsonl:1', 'a'),
      span(SOURCE_ID, 'session.jsonl:2', 'b'),
      span(SOURCE_ID, 'session.jsonl:3', 'c'),
    ]);
  });

  test('caps the union at the configured span budget', () => {
    const sources = clusterFixture(
      Array.from({ length: 5 }, (_, index) => ({
        evidence: [span(SOURCE_ID, `session.jsonl:${index * 2}`), span(SOURCE_ID, `session.jsonl:${index * 2 + 1}`)],
      })),
    );
    expect(unionEvidence(sources, 4)).toHaveLength(4);
    expect(unionEvidence(sources, 4)).toEqual(sources.flatMap((s) => s.evidence).slice(0, 4));
  });
});

describe('derivedScores / derivedTemporals', () => {
  test('corroboration raises confidence and importance, capped at 0.95', () => {
    const sources = clusterFixture([
      { confidence: 0.6, importance: 0.5 },
      { confidence: 0.7, importance: 0.6 },
      { confidence: 0.5, importance: 0.4 },
    ]);
    expect(derivedScores(sources)).toEqual({ confidence: 0.8, importance: 0.65 });
    const high = clusterFixture([
      { confidence: 0.9, importance: 0.95 },
      { confidence: 0.9, importance: 0.9 },
      { confidence: 0.9, importance: 0.9 },
    ]);
    expect(derivedScores(high)).toEqual({ confidence: 0.95, importance: 0.95 });
  });

  test('the derived fact is observed at the newest member and valid since the oldest', () => {
    const sources = clusterFixture([
      { observed_at: '2026-01-01T00:00:00.000Z', valid_from: '2025-12-01T00:00:00.000Z' },
      { observed_at: '2026-03-01T00:00:00.000Z', valid_from: '2026-02-01T00:00:00.000Z' },
      { observed_at: '2026-02-01T00:00:00.000Z', valid_from: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(derivedTemporals(sources)).toEqual({
      observed_at: '2026-03-01T00:00:00.000Z',
      valid_from: '2025-12-01T00:00:00.000Z',
    });
  });
});

describe('templatedMerge — the offline merge (zero network)', () => {
  test('uses the representative content verbatim with template provenance', () => {
    const sources = clusterFixture([
      { content: 'bun test executed before every commit' },
      { content: 'ran bun test after each fix' },
      { content: 'tests were run with bun test' },
    ]);
    const representative = sources[0]!;
    const merged = templatedMerge(sources, representative);
    expect(merged.content).toBe('bun test executed before every commit');
    expect(merged.method).toBe('heuristic');
    expect(merged.prompt_version).toBe(DERIVATION_TEMPLATE_VERSION);
  });
});

describe('mergeClusterContent — the optional LLM tier', () => {
  const sources = clusterFixture([
    { content: 'bun test executed before every commit', observed_at: '2026-01-01T00:00:00.000Z' },
    { content: 'ran bun test after each fix', observed_at: '2026-02-01T00:00:00.000Z' },
    { content: 'tests were run with bun test', observed_at: '2026-03-01T00:00:00.000Z' },
  ]);
  const representative = sources[0]!;

  test('an unconfigured router runs the template without any model call', async () => {
    const router = new FakeRouter();
    const merged = await mergeClusterContent({ sources, representative, entityName: 'bun', router });
    expect(merged.method).toBe('heuristic');
    expect(merged.content).toBe(representative.content);
    expect(router.requests).toHaveLength(0);
  });

  test('a configured router produces the LLM merge with router provenance', async () => {
    const router = new FakeRouter({
      configured: ['consolidate'],
      outputs: { consolidate: { content: 'Tests run with bun test before commits.', title: 'bun test workflow' } },
    });
    const merged = await mergeClusterContent({ sources, representative, entityName: 'bun', router });
    expect(merged.method).toBe('llm');
    expect(merged.model).toBe('fake-model');
    expect(merged.prompt_version).toBe(DERIVATION_LLM_PROMPT_VERSION);
    expect(merged.content).toBe('Tests run with bun test before commits.');
    expect(merged.title).toBe('bun test workflow');
    expect(router.requests).toHaveLength(1);
    expect(router.requests[0]!.operation).toBe('consolidate');
    expect(router.requests[0]!.prompt).toContain('bun test');
  });

  test('a failing router falls back to the template (recorded, never silent)', async () => {
    const router = new FakeRouter({ configured: ['consolidate'], failAll: true });
    const merged = await mergeClusterContent({ sources, representative, entityName: 'bun', router });
    expect(merged.method).toBe('heuristic');
    expect(merged.content).toBe(representative.content);
    expect(merged.fallback_reason).toBeDefined();
  });

  test('schema-invalid LLM output falls back to the template', async () => {
    const router = new FakeRouter({ configured: ['consolidate'], outputs: { consolidate: { content: '' } } });
    const merged = await mergeClusterContent({ sources, representative, entityName: 'bun', router });
    expect(merged.method).toBe('heuristic');
    expect(merged.fallback_reason).toBeDefined();
  });

  test('no router at all runs the template', async () => {
    const merged = await mergeClusterContent({ sources, representative, entityName: 'bun' });
    expect(merged.method).toBe('heuristic');
    expect(merged.content).toBe(representative.content);
  });
});

describe('buildDerivedMemory', () => {
  test('assembles the semantic NewMemory with union provenance and consolidation tags', () => {
    const sources = clusterFixture([
      {
        content: 'bun test executed before every commit',
        observed_at: '2026-01-01T00:00:00.000Z',
        confidence: 0.6,
        importance: 0.5,
        evidence: [span(SOURCE_ID, 'session.jsonl:1', 'bun test')],
      },
      {
        content: 'ran bun test after each fix',
        observed_at: '2026-02-01T00:00:00.000Z',
        confidence: 0.7,
        importance: 0.6,
        evidence: [span(SOURCE_ID, 'session.jsonl:2', 'fix')],
      },
      {
        content: 'tests were run with bun test',
        observed_at: '2026-03-01T00:00:00.000Z',
        confidence: 0.5,
        importance: 0.4,
        evidence: [span(SOURCE_ID, 'session.jsonl:3', 'tests')],
      },
    ]);
    const merged = templatedMerge(sources, sources[0]!);
    const derived = buildDerivedMemory({
      scope: { project_id: '00000000-0000-7000-8002-000000000001' },
      sources,
      representative: sources[0]!,
      merged,
    });
    expect(derived.type).toBe('semantic');
    expect(derived.subtype).toBe('semantic.derived');
    expect(derived.content).toBe('bun test executed before every commit');
    expect(derived.observed_at).toBe('2026-03-01T00:00:00.000Z');
    expect(derived.valid_from).toBe('2026-01-01T00:00:00.000Z');
    expect(derived.source_id).toBe(SOURCE_ID);
    expect(derived.evidence).toHaveLength(3);
    expect(derived.importance).toBe(0.65);
    expect(derived.confidence).toBe(0.8);
    expect(derived.tags).toEqual(['consolidated']);
    expect(derived.extraction).toEqual({
      method: 'heuristic',
      prompt_version: DERIVATION_TEMPLATE_VERSION,
      adapter: 'consolidation',
    });
    expect(derived.token_estimate).toBe(Math.ceil('bun test executed before every commit'.length / 4));
  });
});
