/**
 * Heuristic extractor tests: golden fixture transcripts → expected candidates (types, importance,
 * evidence spans) and expected discards. Both pass and fail fixtures, no LLM, no network.
 */

import { describe, expect, test } from 'bun:test';
import { ExtractionResultSchema, type ExtractedMemory } from '@onememory-ai/core';

import { failureSignatureHash } from '../enrichment/failure';
import {
  chatterSession,
  decisionSession,
  failureNoiseVariants,
  goldenSession,
  makeInput,
  noiseSession,
  sessionlessInputs,
  testFailureSession,
  toolFailureSession,
} from '../testing/transcripts';

import { createHeuristicExtractor } from './extractor';

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
      prompt_version: 'heuristic-v2',
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

describe('heuristic extractor — M3b decision capture', () => {
  test('captures the alternative, the rationale and the rejected option', async () => {
    const result = await extractor.extract(decisionSession());
    const decisions = result.memories.filter((memory) => memory.type === 'decision');
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.subtype).toBe('decision.choice');
    expect(decision.content).toBe(
      'Decision: Drizzle over Prisma — because Drizzle generates plain SQL migrations — also rejected: Kysely',
    );
    expect(decision.decision_payload).toEqual({
      decision: 'Drizzle',
      alternatives: [
        { option: 'Prisma' },
        { option: 'Kysely', why_rejected: 'the team already knows Drizzle' },
      ],
      rationale: 'Drizzle generates plain SQL migrations',
    });
    expect(decision.entities).toContain('Drizzle');
    expect(decision.evidence).toHaveLength(1);
  });

  test('a decision without alternatives or rationale still records an (empty) payload', async () => {
    const result = await extractor.extract(goldenSession());
    const decision = result.memories.find((memory) => memory.type === 'decision')!;
    expect(decision.subtype).toBe('decision.statement');
    expect(decision.decision_payload).toEqual({
      decision: 'use PostgreSQL with pgvector as the only database dialect',
      alternatives: [],
    });
  });

  test('an explicit decision statement keeps the user wording and gains the payload', async () => {
    const result = await extractor.extract([
      makeInput('explicit.remember', {
        kind: 'explicit.remember',
        content: 'We decided to keep PGlite as the embedded profile because it needs no daemon.',
        type: 'decision',
      }),
    ]);
    const decision = result.memories[0]!;
    expect(decision.content).toBe('We decided to keep PGlite as the embedded profile because it needs no daemon.');
    expect(decision.decision_payload).toEqual({
      decision: 'keep PGlite as the embedded profile',
      alternatives: [],
      rationale: 'it needs no daemon',
    });
  });

  test('chatter that only sounds like a decision produces no decision candidate', async () => {
    const result = await extractor.extract(chatterSession());
    expect(result.memories.filter((memory) => memory.type === 'decision')).toEqual([]);
    expect(result.memories.filter((memory) => memory.type === 'failure')).toEqual([]);
    // The one candidate the chatter session legitimately yields is the stated preference; it must
    // not have grown a decision payload, and nothing anywhere carries a failure signature.
    expect(result.memories.map((memory) => memory.type)).toEqual(['preference']);
    for (const memory of result.memories) {
      expect(memory.decision_payload).toBeUndefined();
      expect(memory.failure_signature).toBeUndefined();
    }
  });
});

describe('heuristic extractor — M3b failure signatures', () => {
  test('a resolved error carries a normalized class and a reproducible digest', async () => {
    const result = await extractor.extract(goldenSession());
    const failures = result.memories.filter((memory) => memory.type === 'failure');
    expect(failures).toHaveLength(1);
    const signature = failures[0]!.failure_signature!;
    expect(signature.type).toBe('MODULE_NOT_FOUND');
    expect(signature.origin).toBe('error');
    expect(signature.error_origin).toBe('build');
    expect(signature.hash).toBe(failureSignatureHash(signature.type, signature.normalized_message));
    expect(signature.normalized_message).toContain('cannot find module');
    // The content stays the human-readable statement, now prefixed with the class.
    expect(failures[0]!.content).toStartWith('Failure: MODULE_NOT_FOUND — Cannot find module');
    expect(failures[0]!.content).toContain('resolved by: `bun test`');
  });

  test('a failing test run resolved by a green one becomes a failure memory', async () => {
    const result = await extractor.extract(testFailureSession());
    const failures = result.memories.filter((memory) => memory.type === 'failure');
    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    expect(failure.subtype).toBe('failure.resolved');
    expect(failure.failure_signature).toEqual({
      type: 'TEST_FAILURE',
      hash: failureSignatureHash('TEST_FAILURE', 'bun: saves rows | reads rows'),
      normalized_message: 'bun: saves rows | reads rows',
      origin: 'test',
      tool: 'bun',
    });
    expect(failure.content).toBe(
      'Failure: TEST_FAILURE — 2 failed: saves rows, reads rows — resolved by: tests passing',
    );
    expect(failure.evidence).toHaveLength(2);
  });

  test('an unresolved failing test run stays session-scoped (never a durable failure)', async () => {
    const inputs = testFailureSession().slice(0, 1);
    const result = await extractor.extract(inputs);
    expect(result.memories.filter((memory) => memory.type === 'failure')).toEqual([]);
    const note = result.working.find((candidate) => candidate.kind === 'current_error');
    expect(note?.content).toContain('saves rows');
  });

  test('the same failure with different paths, timings and colour codes hashes identically', async () => {
    const [plain, noisy] = failureNoiseVariants();
    const first = (await extractor.extract(plain)).memories.find((memory) => memory.type === 'failure')!;
    const second = (await extractor.extract(noisy)).memories.find((memory) => memory.type === 'failure')!;
    expect(first.failure_signature!.hash).toBe(second.failure_signature!.hash);
    expect(first.failure_signature!.normalized_message).toBe(second.failure_signature!.normalized_message);
    // …while the durable content keeps the concrete message the transcript carried.
    expect(first.content).toContain('src/store.ts');
    expect(second.content).toContain('/Users/dev/proj/packages/storage/src/store.ts');
  });

  test('a failing command is fingerprinted as a command failure with its tool', async () => {
    const result = await extractor.extract([
      makeInput(
        'terminal.output',
        { kind: 'terminal.output', command: 'bunx tsc --noEmit', exit_code: 2, output_digest: 'error TS2345: bad argument' },
        { offsetSeconds: 0 },
      ),
      makeInput(
        'terminal.output',
        { kind: 'terminal.output', command: 'bunx tsc --noEmit', exit_code: 0, output_digest: 'no errors' },
        { offsetSeconds: 10 },
      ),
    ]);
    const failure = result.memories.find((memory) => memory.type === 'failure')!;
    // `event.text` for a terminal output is `$ <command> → exit <code> <output digest>`, lowercased
    // and noise-normalized by the signature (the command itself keeps its case in the content).
    const normalized = '$ bunx tsc --noemit → exit <n> error ts2345: bad argument';
    expect(failure.failure_signature).toEqual({
      type: 'TYPECHECK_ERROR',
      hash: failureSignatureHash('TYPECHECK_ERROR', normalized),
      normalized_message: normalized,
      origin: 'command',
      tool: 'bunx',
      command: 'bunx tsc',
    });
    expect(failure.content).toContain('`bunx tsc --noEmit` failed');
    expect(failure.content).toContain('resolved by: `bunx tsc --noEmit`');
  });
});

describe('heuristic extractor — M3c tool-result failures', () => {
  test('a failing tool result resolved by the same tool becomes a failure with its tool', async () => {
    const result = await extractor.extract(toolFailureSession());
    const failures = result.memories.filter((memory) => memory.type === 'failure');
    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    expect(failure.subtype).toBe('failure.resolved');
    expect(failure.failure_signature).toEqual({
      type: 'TOOL_ERROR',
      hash: failureSignatureHash('TOOL_ERROR', 'string to replace not found in file <path>'),
      normalized_message: 'string to replace not found in file <path>',
      origin: 'tool',
      tool: 'Edit',
    });
    expect(failure.content).toBe(
      'Failure: TOOL_ERROR — Edit failed: String to replace not found in file src/store.ts — resolved by: `Edit` succeeded',
    );
    expect(failure.evidence).toHaveLength(2);
    expect(result.working).toEqual([]);
  });

  test('a different tool succeeding does not resolve the failure (unambiguous pairing)', async () => {
    const result = await extractor.extract([
      makeInput(
        'conversation.tool_result',
        {
          kind: 'conversation.tool_result',
          call_id: 'c1',
          ok: false,
          tool: 'Edit',
          output_digest: 'string to replace not found in file',
          error: { message: 'String to replace not found in file src/store.ts' },
        },
        { offsetSeconds: 0 },
      ),
      makeInput(
        'conversation.tool_result',
        {
          kind: 'conversation.tool_result',
          call_id: 'c2',
          ok: true,
          tool: 'Write',
          output_digest: 'wrote src/store.ts',
        },
        { offsetSeconds: 10 },
      ),
    ]);
    expect(result.memories.filter((memory) => memory.type === 'failure')).toEqual([]);
    const note = result.working.find((candidate) => candidate.kind === 'current_error');
    expect(note?.content).toContain('Edit failed');
  });

  test('successful tool results alone produce no failure candidate', async () => {
    const result = await extractor.extract([
      makeInput(
        'conversation.tool_result',
        {
          kind: 'conversation.tool_result',
          call_id: 'c1',
          ok: true,
          tool: 'Edit',
          output_digest: 'edited src/store.ts',
        },
        { offsetSeconds: 0 },
      ),
    ]);
    expect(result.memories).toEqual([]);
    expect(result.working).toEqual([]);
  });

  test('the same tool failure with different paths keeps one signature', async () => {
    const run = (path: string) =>
      extractor.extract([
        makeInput(
          'conversation.tool_result',
          {
            kind: 'conversation.tool_result',
            call_id: 'c1',
            ok: false,
            tool: 'Edit',
            output_digest: 'string to replace not found in file',
            error: { message: `String to replace not found in file ${path}` },
          },
          { offsetSeconds: 0 },
        ),
        makeInput(
          'conversation.tool_result',
          {
            kind: 'conversation.tool_result',
            call_id: 'c2',
            ok: true,
            tool: 'Edit',
            output_digest: 'edited',
          },
          { offsetSeconds: 10 },
        ),
      ]);
    const plain = (await run('src/store.ts')).memories.find((memory) => memory.type === 'failure')!;
    const deep = (await run('/Users/dev/proj/packages/storage/src/store.ts')).memories.find(
      (memory) => memory.type === 'failure',
    )!;
    expect(plain.failure_signature!.hash).toBe(deep.failure_signature!.hash);
    expect(plain.content).toContain('src/store.ts');
    expect(deep.content).toContain('/Users/dev/proj/packages/storage/src/store.ts');
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
