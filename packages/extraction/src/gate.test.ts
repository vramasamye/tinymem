/**
 * Future-value gate tests: the pollution guard (risk R6). A candidate without a rationale, without
 * evidence, or below the importance/confidence floor is discarded — not stored.
 */

import { describe, expect, test } from 'bun:test';
import type { ExtractedMemory, ExtractionResult } from '@onememory-ai/core';

import { createFutureValueGate } from './gate';

const evidence = [
  { source_id: '01900000-0000-7000-8000-000000000001', kind: 'event' as const, locator: 'event:1', excerpt: 'x' },
];

function candidate(overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
  return {
    type: 'episodic',
    content: 'A sufficiently long observation.',
    importance: 0.6,
    confidence: 0.6,
    entities: [],
    evidence,
    future_value_rationale: 'worth remembering',
    ...overrides,
  };
}

function resultOf(memories: ExtractedMemory[], working: ExtractionResult['working'] = []): ExtractionResult {
  return {
    memories,
    working,
    extraction_meta: { method: 'heuristic', prompt_version: 'test' },
  };
}

describe('createFutureValueGate', () => {
  const gate = createFutureValueGate();

  test('keeps a justified candidate and explains each discard', () => {
    expect(gate.evaluate(candidate()).keep).toBe(true);
    expect(gate.evaluate(candidate({ future_value_rationale: undefined })).reason).toContain(
      'no future_value_rationale',
    );
    expect(gate.evaluate(candidate({ evidence: [] })).reason).toContain('no evidence span');
    expect(gate.evaluate(candidate({ importance: 0.1 })).reason).toContain('below floor');
    expect(
      gate.evaluate(candidate({ type: 'semantic_candidate', subtype: 'semantic.version', confidence: 0.2 })).reason,
    ).toContain('semantic candidate confidence');
    expect(gate.evaluate(candidate({ content: 'short' })).reason).toContain('too short');
  });

  test('applies the thresholds and reports the discard count', () => {
    const applied = gate.apply(
      resultOf([
        candidate({ content: 'Kept because it is important.' }),
        candidate({ content: 'Dropped for low importance.', importance: 0.1 }),
      ]),
    );
    expect(applied.result.memories).toHaveLength(1);
    expect(applied.discarded).toBe(1);
  });

  test('merges duplicates of the same statement and unions their evidence', () => {
    const second = {
      source_id: '01900000-0000-7000-8000-000000000002',
      kind: 'event' as const,
      locator: 'event:2',
      excerpt: 'y',
    };
    const applied = gate.apply(
      resultOf([
        candidate({ content: 'Use PostgreSQL for storage.', importance: 0.6, evidence }),
        candidate({
          content: 'use postgresql for storage',
          importance: 0.8,
          confidence: 0.9,
          evidence: [evidence[0]!, second],
        }),
      ]),
    );
    expect(applied.result.memories).toHaveLength(1);
    expect(applied.result.memories[0]!.importance).toBe(0.8);
    expect(applied.result.memories[0]!.evidence).toHaveLength(2);
  });

  test('caps memories after sorting by importance', () => {
    const small = createFutureValueGate({ thresholds: { max_memories: 2 } });
    const applied = small.apply(
      resultOf([
        candidate({ content: 'First candidate content.', importance: 0.5 }),
        candidate({ content: 'Second candidate content.', importance: 0.9 }),
        candidate({ content: 'Third candidate content.', importance: 0.7 }),
      ]),
    );
    expect(applied.result.memories.map((memory) => memory.content)).toEqual([
      'Second candidate content.',
      'Third candidate content.',
    ]);
    expect(applied.discarded).toBe(1);
  });

  test('de-duplicates and caps working candidates', () => {
    const small = createFutureValueGate({ thresholds: { max_working: 1 } });
    const applied = small.apply(
      resultOf(
        [],
        [
          { kind: 'current_error', content: 'boom', session_id: 's1' },
          { kind: 'current_error', content: 'boom', session_id: 's1' },
          { kind: 'open_question', content: 'why?', session_id: 's1' },
        ],
      ),
    );
    expect(applied.result.working).toHaveLength(1);
    expect(applied.discarded).toBe(1);
  });
});
