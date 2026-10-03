/**
 * Heuristic extractor tests: golden fixture transcripts → expected candidates (types, importance,
 * evidence spans) and expected discards. Both pass and fail fixtures, no LLM, no network.
 */

import { describe, expect, test } from 'bun:test';
import { ExtractionResultSchema, type ExtractedMemory } from '@onememory/core';

import { createHeuristicExtractor } from './extractor';
import { goldenSession, makeInput, noiseSession, sessionlessInputs } from '../testing/transcripts';

const extractor = createHeuristicExtractor();

function contents(memories: ExtractedMemory[], predicate: (memory: ExtractedMemory) => boolean) {
  return memories.filter(predicate).map((memory) => memory.content);
}

describe('heuristic extractor — golden session', () => {
  test('emits a schema-valid ExtractionResult', async () => {
    const result = await extractor.extract(goldenSession());
    expect(() => ExtractionResultSchema.parse(result)).not.toThrow();
    expect(result.extraction_meta).toEqual({
      method: 'heuristic',
      prompt_version: 'heuristic-v1',
    });
    expect(result.memories.length).toBeGreaterThan(0);
  });

  test('never emits `semantic` — only `semantic_candidate`', async () => {
    const result = await extractor.extract(goldenSession());
    for (const memory of result.memories) {
      expect(memory.type).not.toBe('semantic');
    }
    expect(result.memories.some((memory) => memory.type === 'semantic_candidate')).toBe(true);
  });

  test('every candidate carries importance > 0, a rationale, and bounded evidence', async () => {
    const result = await extractor.extract(goldenSession());
    for (const memory of result.memories) {
      expect(memory.importance).toBeGreaterThan(0);
      expect(memory.importance).toBeLessThanOrEqual(1);
      expect(memory.confidence).toBeGreaterThan(0);
      expect(memory.future_value_rationale?.length ?? 0).toBeGreaterThan(0);
      expect(memory.evidence.length).toBeGreaterThanOrEqual(1);
      for (const span of memory.evidence) {
        expect(span.source_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(span.locator.startsWith('event:') || span.locator.startsWith('commit:')).toBe(true);
        expect(span.excerpt.length).toBeLessThanOrEqual(200);
      }
      expect(memory.content.length).toBeLessThanOrEqual(500);
    }
  });

  test('recognizes the decision, the two preferences, the resolved failure, the version, the sequence and the stack mention', async () => {
    const result = await extractor.extract(goldenSession());
    const decisions = contents(result.memories, (memory) => memory.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain('PostgreSQL');
    expect(decisions[0]).toContain('pgvector');

    const preferences = contents(result.memories, (memory) => memory.type === 'preference');
    expect(preferences).toHaveLength(2);
    expect(preferences.join(' | ')).toContain('bun test over jest');
    expect(preferences.join(' | ')).toContain('bun install before bun test');

    const failures = result.memories.filter((memory) => memory.type === 'failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.content).toContain('Cannot find module');
    expect(failures[0]!.content).toContain('resolved by: `bun test`');
    expect(failures[0]!.subtype).toBe('failure.resolved');
    expect(failures[0]!.evidence).toHaveLength(2);

    const versions = result.memories.filter((memory) => memory.subtype === 'semantic.version');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.content).toBe('Version: Node 22');

    const sequences = contents(result.memories, (memory) => memory.subtype === 'procedural.sequence');
    expect(sequences).toHaveLength(1);
    expect(sequences[0]).toContain('bun install → bun test');

    const commands = contents(result.memories, (memory) => memory.subtype === 'procedural.command');
    expect(commands).toEqual(['Recurring command: `bunx tsc` (used 2 times)']);

    const stack = contents(result.memories, (memory) => memory.subtype === 'episodic.stack');
    expect(stack).toHaveLength(1);
    expect(stack[0]).toContain('Uses Drizzle');
    expect(stack[0]).toContain('commit a1b2c3d4');
  });

  test('routes session-scoped context to working memory instead of durable memory', async () => {
    const result = await extractor.extract(goldenSession());
    const kinds = result.working.map((candidate) => candidate.kind).sort();
    expect(kinds).toEqual(['current_error', 'current_file', 'hypothesis', 'open_question']);
    for (const candidate of result.working) {
      expect(candidate.session_id).toBe('sess-m3-golden');
      expect(candidate.content.length).toBeLessThanOrEqual(300);
    }
    const currentError = result.working.find((candidate) => candidate.kind === 'current_error');
    expect(currentError?.content).toContain('ECONNREFUSED');
    // An unresolved error must not become a durable failure memory.
    expect(
      result.memories.some((memory) => memory.type === 'failure' && memory.content.includes('ECONNREFUSED')),
    ).toBe(false);
  });
});

describe('heuristic extractor — noise session', () => {
  test('discards small talk, noise preferences, and denied commands', async () => {
    const result = await extractor.extract(noiseSession());
    expect(result.memories).toEqual([]);
    expect(result.working).toEqual([]);
    expect(() => ExtractionResultSchema.parse(result)).not.toThrow();
  });
});

describe('heuristic extractor — explicit intent and session-less input', () => {
  test('an explicit semantic remember becomes a semantic_candidate marked as an explicit statement', async () => {
    const inputs = [
      makeInput('explicit.remember', {
        kind: 'explicit.remember',
        content: 'The main database is PostgreSQL with the pgvector extension.',
        tags: ['storage'],
      }),
    ];
    const result = await extractor.extract(inputs);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.type).toBe('semantic_candidate');
    expect(result.memories[0]!.subtype).toBe('semantic.explicit');
    expect(result.memories[0]!.importance).toBeCloseTo(0.9, 5);
    expect(result.memories[0]!.confidence).toBeCloseTo(0.95, 5);
    expect(result.memories[0]!.entities).toContain('PostgreSQL');
  });

  test('an explicit remember may declare a durable type directly', async () => {
    const inputs = [
      makeInput('explicit.remember', {
        kind: 'explicit.remember',
        content: 'We decided to keep PGlite as the embedded profile.',
        type: 'decision',
        importance: 0.95,
      }),
    ];
    const result = await extractor.extract(inputs);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.type).toBe('decision');
  });

  test('events without a session id produce no working candidates', async () => {
    const result = await extractor.extract(sessionlessInputs());
    expect(result.working).toEqual([]);
  });

  test('an empty batch is a valid, empty result', async () => {
    const result = await extractor.extract([]);
    expect(result.memories).toEqual([]);
    expect(result.working).toEqual([]);
    expect(result.extraction_meta.method).toBe('heuristic');
  });
});

describe('heuristic extractor — gate thresholds', () => {
  test('a stricter importance floor discards lower-value candidates', async () => {
    const strict = createHeuristicExtractor({ thresholds: { min_importance: 0.7 } });
    const result = await strict.extract(goldenSession());
    for (const memory of result.memories) {
      expect(memory.importance).toBeGreaterThanOrEqual(0.7);
    }
    // Only the decision (0.8) and the failure (0.75) clear a 0.7 floor.
    expect(result.memories.map((memory) => memory.type).sort()).toEqual(['decision', 'failure']);
  });
});
