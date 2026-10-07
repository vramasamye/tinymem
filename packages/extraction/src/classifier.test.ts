/**
 * Classifier tests: type/subtype assignment, the semantic-candidate rule, and working-vs-durable
 * routing.
 */

import { describe, expect, test } from 'bun:test';
import type { ExtractedMemory } from '@onememory-ai/core';

import { createHeuristicClassifier, EXPLICIT_SEMANTIC_SUBTYPE } from './classifier';

const classifier = createHeuristicClassifier();

function candidate(overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
  return {
    type: 'episodic',
    content: 'Some observation about the project.',
    importance: 0.6,
    confidence: 0.6,
    entities: [],
    evidence: [{ source_id: '01900000-0000-7000-8000-000000000001', kind: 'event', locator: 'event:1', excerpt: 'x' }],
    future_value_rationale: 'because',
    ...overrides,
  };
}

describe('classify', () => {
  test('a semantic candidate becomes an episodic observation awaiting consolidation', () => {
    const classified = classifier.classify(candidate({ type: 'semantic_candidate' }));
    expect(classified).toEqual({
      type: 'semantic_candidate',
      subtype: 'semantic.candidate',
      durable_type: 'episodic',
      awaiting_consolidation: true,
    });
  });

  test('an explicit user statement may become semantic directly', () => {
    const classified = classifier.classify(
      candidate({ type: 'semantic_candidate', subtype: EXPLICIT_SEMANTIC_SUBTYPE }),
    );
    expect(classified.durable_type).toBe('semantic');
    expect(classified.awaiting_consolidation).toBe(false);
  });

  test('durable types pass through unchanged', () => {
    for (const type of ['decision', 'failure', 'preference', 'procedural', 'episodic'] as const) {
      const classified = classifier.classify(candidate({ type }));
      expect(classified.durable_type).toBe(type);
      expect(classified.awaiting_consolidation).toBe(false);
    }
  });

  test('infers a subtype when the extractor did not supply one', () => {
    expect(classifier.classify(candidate({ type: 'decision', content: 'Decision: X over Y' })).subtype).toBe(
      'decision.choice',
    );
    expect(classifier.classify(candidate({ type: 'decision', content: 'Decision: keep it simple' })).subtype).toBe(
      'decision.statement',
    );
    expect(classifier.classify(candidate({ type: 'preference' })).subtype).toBe('preference.statement');
    expect(classifier.classify(candidate({ type: 'failure' })).subtype).toBe('failure.observed');
    expect(classifier.classify(candidate({ type: 'procedural' })).subtype).toBe('procedural.sequence');
    expect(
      classifier.classify(candidate({ type: 'procedural', content: 'Recurring command: `bun test`' })).subtype,
    ).toBe('procedural.command');
    expect(classifier.classify(candidate({ type: 'episodic' })).subtype).toBe('episodic.observation');
  });

  test('keeps an explicit subtype from the extractor', () => {
    expect(classifier.classify(candidate({ type: 'failure', subtype: 'failure.oom' })).subtype).toBe(
      'failure.oom',
    );
  });

  test('a leaked `semantic` type is coerced to a candidate (defence in depth)', () => {
    const leaked = { ...candidate(), type: 'semantic' } as unknown as ExtractedMemory;
    const classified = classifier.classify(leaked);
    expect(classified.type).toBe('semantic_candidate');
    expect(classified.durable_type).toBe('episodic');
  });
});

describe('working routing', () => {
  test('maps signals to working kinds and requires a session', () => {
    expect(classifier.routeWorking({ signal: 'unresolved_error', content: 'boom', session_id: 's1' })).toEqual({
      kind: 'current_error',
      content: 'boom',
      session_id: 's1',
    });
    expect(classifier.routeWorking({ signal: 'edited_file', content: 'Editing a.ts', session_id: 's1' })?.kind).toBe(
      'current_file',
    );
    expect(classifier.routeWorking({ signal: 'stated_task', content: 'do it', session_id: 's1' })?.kind).toBe('task');
    expect(classifier.routeWorking({ signal: 'stated_hypothesis', content: 'maybe', session_id: 's1' })?.kind).toBe(
      'hypothesis',
    );
    expect(classifier.routeWorking({ signal: 'open_question', content: 'why?', session_id: 's1' })?.kind).toBe(
      'open_question',
    );
    expect(classifier.routeWorking({ signal: 'temp_decision', content: 'for now', session_id: 's1' })?.kind).toBe(
      'temp_decision',
    );
    expect(classifier.routeWorking({ signal: 'unresolved_error', content: 'boom' })).toBeNull();
    expect(classifier.routeWorking({ signal: 'unresolved_error', content: '   ', session_id: 's1' })).toBeNull();
  });

  test('truncates over-long working content to the schema bound', () => {
    const routed = classifier.routeWorking({
      signal: 'open_question',
      content: 'x'.repeat(500),
      session_id: 's1',
    });
    expect(routed?.content.length).toBe(299);
  });

  test('normalizeWorking repairs or rejects extractor output', () => {
    expect(
      classifier.normalizeWorking({ kind: 'current_error', content: '  a   b  ', session_id: 's1' }),
    ).toEqual({ kind: 'current_error', content: 'a b', session_id: 's1' });
    expect(classifier.normalizeWorking({ kind: 'current_error', content: 'x', session_id: '' })).toBeNull();
    expect(classifier.normalizeWorking({ kind: 'current_error', content: '', session_id: 's1' })).toBeNull();
    const invalidKind = { kind: 'nope', content: 'x', session_id: 's1' } as never;
    expect(classifier.normalizeWorking(invalidKind)).toBeNull();
  });
});
