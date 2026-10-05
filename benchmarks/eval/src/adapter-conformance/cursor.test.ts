/**
 * Adapter conformance (backlog M5.4 / M8 acceptance 5): ONE canonical session, rendered into each
 * runtime's NATIVE hook payloads, translated by each adapter's own entry point, and then run
 * through the REAL engine (PGlite storage + migrations, the real extract job over the heuristic
 * extractor, the real retrieval engine).
 *
 * What is asserted:
 * - the same events (kind + the payload fields the memory model depends on) for every fact;
 * - the same `memory.upsert` result — same memories, same evidence (by canonical fact);
 * - the same working-memory rows (the Stop/SessionEnd sweep surface);
 * - the same `memory.search` ranking for one canonical query;
 * - the same `memory_get` payload for the top result.
 *
 * What is NOT asserted equal, and WHY (each pinned by a test below, so it cannot grow silently):
 * - session summaries and output digests carry runtime-native wording by design;
 * - the FAILED shell command's `exit_code`: Claude and Codex report `1` (Claude parses
 *   "Exit code 1", Codex parses "Process exited with code 1"), Cursor reports `null` because
 *   Cursor's hook contract exposes NO exit code for a failed command (documented gap — see the
 *   adapter README). Failure DETECTION still agrees, because all three emit `error.raised`;
 * - the explicit.remember clause's trailing sentence punctuation: Claude and Cursor strip it
 *   (their shared `extractRememberUtterance` semantics), Codex keeps it. This is a pre-existing
 *   Codex normalization difference, reported as a follow-up, not a Cursor defect.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OnememoryEvent } from '@onememory/core';

import { CONFORMANCE_QUERY, runAllPipelines, type PipelineResult } from './pipeline';
import { RUNTIMES, SCENARIO, nativePayloads, translateScenario, type RuntimeName, type ScenarioContext } from './scenario';

const PROJECT_ID = '01900000-0000-7000-8000-0000000000f1';

const roots: string[] = [];
let ctx: ScenarioContext;
let results: Record<RuntimeName, PipelineResult>;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'onemem-conformance-root-'));
  roots.push(root);
  ctx = { root, projectId: PROJECT_ID };
  results = await runAllPipelines(ctx);
}, 180_000);

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Strip a trailing sentence terminator — the Claude/Cursor remember-clause normalization. */
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

function projectEvents(runtime: RuntimeName): string[] {
  return translateScenario(runtime, ctx).events.map(({ fact, event }) =>
    JSON.stringify([fact, event.kind, projectPayload(event)]),
  );
}

// ---------------------------------------------------------------------------
// 1. Event-level conformance
// ---------------------------------------------------------------------------

describe('cursor conformance — events', () => {
  test('every canonical fact produces the same events as Claude and Codex', () => {
    const claude = projectEvents('claude-code');
    const codex = projectEvents('codex');
    const cursor = projectEvents('cursor');
    expect(cursor.length).toBeGreaterThanOrEqual(11);
    expect(cursor).toEqual(claude);
    expect(cursor).toEqual(codex);
  });

  test('all three adapters cover every canonical fact (nothing is silently dropped)', () => {
    const facts = (runtime: RuntimeName): string[] => [
      ...new Set(translateScenario(runtime, ctx).events.map(({ fact }) => fact)),
    ];
    const expected = [
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
    ];
    for (const runtime of RUNTIMES) expect(facts(runtime)).toEqual(expected);
  });

  test('Cursor reports no unmapped canonical payloads (the session is fully covered)', () => {
    expect(results['cursor'].drops).toEqual([]);
  });

  test('DOCUMENTED DIVERGENCE: only Cursor lacks an exit code for the failed command', () => {
    const failureExitCodes = (runtime: RuntimeName): unknown[] =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'failure' && event.kind === 'terminal.output')
        .map(({ event }) => (event.payload as { exit_code: unknown }).exit_code);
    expect(failureExitCodes('claude-code')).toEqual([1]);
    expect(failureExitCodes('codex')).toEqual([1]);
    expect(failureExitCodes('cursor')).toEqual([null]);
  });

  test('DOCUMENTED DIVERGENCE: Codex keeps the remember clause’s trailing period, Claude/Cursor strip it', () => {
    const rememberContent = (runtime: RuntimeName): string[] =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'remember' && event.kind === 'explicit.remember')
        .map(({ event }) => String((event.payload as { content: string }).content));
    expect(rememberContent('claude-code')).toEqual([SCENARIO.rememberedClause]);
    expect(rememberContent('cursor')).toEqual([SCENARIO.rememberedClause]);
    expect(rememberContent('codex')).toEqual([`${SCENARIO.rememberedClause}.`]);
  });
});

// ---------------------------------------------------------------------------
// 2. Memory-level conformance (the real pipeline)
// ---------------------------------------------------------------------------

describe('cursor conformance — memory.upsert', () => {
  test('the canonical session yields the same memories and the same evidence as Claude', () => {
    expect(results['cursor'].memories).toEqual(results['claude-code'].memories);
  });

  test('the canonical session yields the same memories as Codex (modulo the punctuation divergence)', () => {
    const normalize = (result: PipelineResult): unknown =>
      result.memories.map((memory) => ({ ...memory, content: stripTrailingPunctuation(memory.content) }));
    expect(normalize(results['cursor'])).toEqual(normalize(results['codex']));
  });

  test('the extraction counts agree (same events in, same candidates out)', () => {
    expect(results['cursor'].extraction).toEqual(results['claude-code'].extraction);
    expect(results['cursor'].extraction).toEqual(results['codex'].extraction);
    expect(results['cursor'].extraction.memories_inserted).toBe(3);
    expect(results['cursor'].extraction.events_processed).toBe(11);
  });

  test('the memories are the expected ones — equality above is not vacuous', () => {
    const contents = results['cursor'].memories.map((memory) => memory.content).sort();
    expect(contents).toEqual(
      [
        "Failure: MODULE_NOT_FOUND — Error: Cannot find module './middleware' — resolved by: `bun test src/auth/`",
        'Recurring command: `bun test src/auth/` (used 2 times)',
        SCENARIO.rememberedClause,
      ].sort(),
    );
    const byType = new Map(results['cursor'].memories.map((memory) => [memory.type, memory]));
    expect(byType.get('failure')?.subtype).toBe('failure.resolved');
    expect(byType.get('procedural')?.subtype).toBe('procedural.command');
    expect(byType.get('semantic')?.subtype).toBe('semantic.explicit');
  });

  test('evidence cites the same canonical facts in every runtime (upsert provenance)', () => {
    const evidence = (runtime: RuntimeName): unknown =>
      results[runtime].memories.map((memory) => [memory.type, memory.evidence]);
    expect(evidence('cursor')).toEqual(evidence('claude-code'));
    expect(evidence('cursor')).toEqual(evidence('codex'));
    // The failure is cited against the failing command and the re-run that resolved it.
    const failure = results['cursor'].memories.find((memory) => memory.type === 'failure');
    expect(failure?.evidence).toEqual(['event:failure', 'event:success-2']);
    // The recurring command cites both successful runs.
    const procedure = results['cursor'].memories.find((memory) => memory.type === 'procedural');
    expect(procedure?.evidence).toEqual(['event:success-1', 'event:success-2']);
    // The explicit remember cites the user's own utterance.
    const semantic = results['cursor'].memories.find((memory) => memory.type === 'semantic');
    expect(semantic?.evidence).toEqual(['event:remember']);
  });

  test('working memory (the session sweep surface) is identical across runtimes', () => {
    const working = (runtime: RuntimeName): unknown => results[runtime].working;
    expect(results['cursor'].working).toEqual([
      { kind: 'current_file', content: 'Editing src/auth/middleware.ts', evidence: [] },
    ]);
    expect(working('cursor')).toEqual(working('claude-code'));
    expect(working('cursor')).toEqual(working('codex'));
  });
});

// ---------------------------------------------------------------------------
// 3. memory.search + memory_get conformance
// ---------------------------------------------------------------------------

describe('cursor conformance — memory.search / memory_get', () => {
  test('the same query returns the same ranking in every runtime', () => {
    expect(results['cursor'].search.query).toBe(CONFORMANCE_QUERY);
    expect(results['cursor'].search.ranking).toEqual([
      `semantic|${SCENARIO.rememberedClause}`,
    ]);
    expect(results['cursor'].search.ranking).toEqual(results['claude-code'].search.ranking);
    // Codex's ranking string differs only by the documented trailing period.
    expect(results['codex'].search.ranking.map(stripTrailingPunctuation)).toEqual(
      results['cursor'].search.ranking.map(stripTrailingPunctuation),
    );
  });

  test('memory_get returns the same payload as Claude (and Codex modulo the punctuation divergence)', () => {
    const cursor = results['cursor'].get;
    expect(cursor).not.toBeNull();
    expect(cursor).toEqual(results['claude-code'].get);
    expect(cursor?.type).toBe('semantic');
    expect(cursor?.status).toBe('active');
    expect(cursor?.importance).toBe(0.9);
    expect(cursor?.confidence).toBe(0.95);
    expect(cursor?.evidence).toEqual(['event:remember']);
    const codex = results['codex'].get;
    expect(codex).not.toBeNull();
    expect({ ...cursor, content: stripTrailingPunctuation(String(cursor?.content)) }).toEqual({
      ...codex,
      content: stripTrailingPunctuation(String(codex?.content)),
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The payload builders are the runtimes' real contracts
// ---------------------------------------------------------------------------

describe('cursor conformance — the canonical payloads are runtime-native', () => {
  test('each runtime receives its own hook event vocabulary', () => {
    const events = (runtime: RuntimeName): string[] =>
      nativePayloads(runtime, ctx).map((entry) => String((entry.payload as { hook_event_name: string }).hook_event_name));
    expect(events('claude-code')).toEqual([
      'SessionStart',
      'PostToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]);
    expect(events('codex')).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'PostToolUse',
      'PostToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'PostToolUse',
      'SessionEnd',
    ]);
    expect(events('cursor')).toEqual([
      'sessionStart',
      'beforeSubmitPrompt',
      'afterAgentResponse',
      'postToolUse',
      'afterFileEdit',
      'postToolUseFailure',
      'beforeSubmitPrompt',
      'afterAgentResponse',
      'postToolUse',
      'sessionEnd',
    ]);
  });
});
