/**
 * Adapter conformance for Pi (backlog M5.4 / M8 acceptance 5, mission 9): the SAME canonical
 * session as the other runtimes, rendered into Pi's native extension payloads and translated by
 * `translatePiEvent` — then run through the REAL engine alongside every other runtime.
 *
 * What is asserted:
 * - the same events (kind + the payload fields the memory model depends on) as Claude for every
 *   canonical fact — including the failed command's exit code (Pi parses it from the bash
 *   tool_result's `structuredContent.exit_code`, so it CONFORMS with Claude/Codex where Cursor
 *   reports null);
 * - the same `memory.upsert` result, the same working memory, the same `memory.search` ranking,
 *   and the same `memory_get` payload as Claude;
 * - the explicit.remember clause strips the trailing period (Pi's `remember.ts` is the sibling
 *   duplicate of Claude's extractor), so Pi matches Claude/Cursor exactly — the trailing-period
 *   divergence is Codex-only;
 * - no unmapped canonical payloads (the full session is covered; drops are empty).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OnememoryEvent } from '@onememory-ai/core';

import { CONFORMANCE_QUERY, runAllPipelines, type PipelineResult } from './pipeline';
import { SCENARIO, nativePayloads, translateScenario, type ScenarioContext } from './scenario';

const roots: string[] = [];
let ctx: ScenarioContext;
let results: Record<string, PipelineResult>;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'onemem-conformance-pi-root-'));
  roots.push(root);
  ctx = { root, projectId: '01900000-0000-7000-8000-0000000000f2' };
  results = await runAllPipelines(ctx);
}, 180_000);

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Strip a trailing sentence terminator — the Claude/Cursor/Pi remember-clause normalization. */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, '').trim();
}

/** The event fields the memory model depends on (everything else is runtime-native wording). */
function projectPayload(event: OnememoryEvent): Record<string, unknown> {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case 'session.start':
    case 'session.end':
      return { cwd: payload['cwd'] };
    case 'conversation.message':
      return { role: payload['role'], content: payload['content'] };
    case 'explicit.remember':
      return { content: stripTrailingPunctuation(String(payload['content'] ?? '')) };
    case 'terminal.output':
      return { command: payload['command'] };
    case 'file.changed':
      return { path: payload['path'], change: payload['change'] };
    case 'error.raised':
      return { origin: payload['origin'], message: payload['message'] };
    default:
      return payload;
  }
}

function projectEvents(runtime: Parameters<typeof translateScenario>[0]): string[] {
  return translateScenario(runtime, ctx).events.map(({ fact, event }) =>
    JSON.stringify([fact, event.kind, projectPayload(event)]),
  );
}

// ---------------------------------------------------------------------------
// 1. Event-level conformance
// ---------------------------------------------------------------------------

describe('pi conformance — events', () => {
  test('every canonical fact produces the same events as Claude', () => {
    const pi = projectEvents('pi');
    expect(pi.length).toBeGreaterThanOrEqual(11);
    expect(pi).toEqual(projectEvents('claude-code'));
  });

  test('the full session is covered: every canonical fact, nothing silently dropped', () => {
    const facts = [...new Set(translateScenario('pi', ctx).events.map(({ fact }) => fact))];
    expect(facts).toEqual([
      'session-start',
      'user-question',
      'assistant-1',
      'success-1',
      'file-edit',
      'failure',
      'remember',
      'assistant-2',
      'success-2',
      'session-end',
    ]);
    expect(results['pi']?.drops).toEqual([]);
  });

  test('Pi reports the failed command\'s exit code (CONFORMS with Claude/Codex; Cursor is the outlier)', () => {
    const failureExitCodes = (runtime: Parameters<typeof translateScenario>[0]): unknown[] =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'failure' && event.kind === 'terminal.output')
        .map(({ event }) => (event.payload as { exit_code: unknown }).exit_code);
    expect(failureExitCodes('pi')).toEqual([1]);
    expect(failureExitCodes('pi')).toEqual(failureExitCodes('claude-code'));
    expect(failureExitCodes('pi')).toEqual(failureExitCodes('codex'));
    expect(failureExitCodes('pi')).not.toEqual(failureExitCodes('cursor'));
  });

  test('the file-edit line deltas match the Claude baseline exactly', () => {
    const editDeltas = (runtime: Parameters<typeof translateScenario>[0]): unknown =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'file-edit' && event.kind === 'file.changed')
        .map(({ event }) => {
          const payload = event.payload as { lines_removed?: unknown; lines_added?: unknown };
          return [payload.lines_removed, payload.lines_added];
        });
    expect(editDeltas('pi')).toEqual([[2, 3]]);
    expect(editDeltas('pi')).toEqual(editDeltas('claude-code'));
  });

  test('DOCUMENTED DIVERGENCE: line-count fields legitimately differ per channel (pinned landscape)', () => {
    // pipeline.ts deliberately keeps line-count fields out of the strict projection ("what
    // legitimately differs per channel"). This pins the ACTUAL landscape so it cannot grow
    // silently:
    // - Claude counts a trailing newline as a split boundary → 2/3;
    // - Cursor strips one trailing newline → the git-true 1/2;
    // - Codex's apply_patch channel carries no line counts at all;
    // - Pi and OpenCode match the Claude baseline (their edits[]/old-new strings are the same
    //   literal-replacement channel Claude's Edit tool reports).
    const editDeltas = (runtime: Parameters<typeof translateScenario>[0]): unknown[] =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'file-edit' && event.kind === 'file.changed')
        .map(({ event }) => {
          const payload = event.payload as { lines_removed?: unknown; lines_added?: unknown };
          return [payload.lines_removed, payload.lines_added];
        });
    expect(editDeltas('claude-code')).toEqual([[2, 3]]);
    expect(editDeltas('pi')).toEqual([[2, 3]]);
    expect(editDeltas('opencode')).toEqual([[2, 3]]);
    expect(editDeltas('cursor')).toEqual([[1, 2]]);
    expect(editDeltas('codex')).toEqual([[undefined, undefined]]);
  });

  test('the remember clause is byte-identical to Claude (Pi strips the trailing period)', () => {
    const rememberContent = (runtime: Parameters<typeof translateScenario>[0]): string[] =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'remember' && event.kind === 'explicit.remember')
        .map(({ event }) => String((event.payload as { content: string }).content));
    expect(rememberContent('pi')).toEqual([SCENARIO.rememberedClause]);
    expect(rememberContent('pi')).toEqual(rememberContent('claude-code'));
  });
});

// ---------------------------------------------------------------------------
// 2. Memory-level conformance (the real pipeline)
// ---------------------------------------------------------------------------

describe('pi conformance — memory.upsert', () => {
  test('the canonical session yields the same memories and evidence as Claude', () => {
    expect(results['pi']?.memories).toEqual(results['claude-code']?.memories);
  });

  test('the extraction counts agree (same events in, same candidates out)', () => {
    expect(results['pi']?.extraction).toEqual(results['claude-code']?.extraction);
    expect(results['pi']?.extraction?.events_processed).toBe(11);
    expect(results['pi']?.extraction?.memories_inserted).toBe(3);
  });

  test('the memories are the expected ones — equality above is not vacuous', () => {
    const contents = (results['pi']?.memories ?? []).map((memory) => memory.content).sort();
    expect(contents).toEqual(
      [
        "Failure: MODULE_NOT_FOUND — Error: Cannot find module './middleware' — resolved by: `bun test src/auth/`",
        'Recurring command: `bun test src/auth/` (used 2 times)',
        SCENARIO.rememberedClause,
      ].sort(),
    );
  });

  test('evidence cites the same canonical facts as Claude (upsert provenance)', () => {
    const evidence = (runtime: string): unknown =>
      results[runtime]?.memories.map((memory) => [memory.type, memory.evidence]);
    expect(evidence('pi')).toEqual(evidence('claude-code'));
    const failure = results['pi']?.memories.find((memory) => memory.type === 'failure');
    expect(failure?.evidence).toEqual(['event:failure', 'event:success-2']);
  });

  test('working memory (the session sweep surface) is identical to Claude', () => {
    expect(results['pi']?.working).toEqual(results['claude-code']?.working);
    expect(results['pi']?.working).toEqual([
      { kind: 'current_file', content: 'Editing src/auth/middleware.ts', evidence: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. memory.search + memory_get conformance
// ---------------------------------------------------------------------------

describe('pi conformance — memory.search / memory_get', () => {
  test('the same query returns the same ranking as Claude', () => {
    expect(results['pi']?.search.query).toBe(CONFORMANCE_QUERY);
    expect(results['pi']?.search.ranking).toEqual(results['claude-code']?.search.ranking);
    expect(results['pi']?.search.ranking).toEqual([`semantic|${SCENARIO.rememberedClause}`]);
  });

  test('memory_get returns the same payload as Claude', () => {
    const pi = results['pi']?.get;
    expect(pi).not.toBeNull();
    expect(pi).toEqual(results['claude-code']?.get);
    expect(pi?.type).toBe('semantic');
    expect(pi?.status).toBe('active');
    expect(pi?.importance).toBe(0.9);
    expect(pi?.confidence).toBe(0.95);
    expect(pi?.evidence).toEqual(['event:remember']);
  });
});

// ---------------------------------------------------------------------------
// 4. The payload builders are Pi's real wire contract
// ---------------------------------------------------------------------------

describe('pi conformance — the canonical payloads are runtime-native', () => {
  test('Pi receives its documented extension event vocabulary', () => {
    const types = nativePayloads('pi', ctx).map((entry) => String((entry.payload as { type: string }).type));
    expect(types).toEqual([
      'session_start',
      'message_end',
      'message_end',
      'tool_result',
      'tool_result',
      'tool_result',
      'message_end',
      'message_end',
      'tool_result',
      'session_shutdown',
    ]);
  });
});
