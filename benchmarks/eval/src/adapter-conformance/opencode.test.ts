/**
 * Adapter conformance for OpenCode (backlog M5.4 / M8 acceptance 5, mission 9): the SAME
 * canonical session as the other runtimes, rendered into OpenCode's native plugin payloads
 * (the `event` hook, `tool.execute.after`, `chat.message`) and translated by the OpenCode
 * translator's own entry points — then run through the REAL engine alongside every other runtime.
 *
 * What is asserted:
 * - the same events (kind + the payload fields the memory model depends on) as Claude for every
 *   canonical fact — including the failed command's exit code (`metadata.exit: 1`, so OpenCode
 *   CONFORMS with Claude/Codex/Pi where Cursor reports null);
 * - the same `memory.upsert` result, the same working memory, the same `memory.search` ranking,
 *   and the same `memory_get` payload as Claude;
 * - the explicit.remember clause strips the trailing period (the sibling remember extractor), so
 *   OpenCode matches Claude/Cursor/Pi exactly — the divergence is Codex-only;
 * - the chat hook claims the user message ids, so the part channel never double-captures a turn
 *   (the scenario's user turns ride `chat.message` only);
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
  const root = mkdtempSync(join(tmpdir(), 'onemem-conformance-opencode-root-'));
  roots.push(root);
  ctx = { root, projectId: '01900000-0000-7000-8000-0000000000f3' };
  results = await runAllPipelines(ctx);
}, 180_000);

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Strip a trailing sentence terminator — the Claude/Cursor/Pi/OpenCode remember normalization. */
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

describe('opencode conformance — events', () => {
  test('every canonical fact produces the same events as Claude', () => {
    const opencode = projectEvents('opencode');
    expect(opencode.length).toBeGreaterThanOrEqual(11);
    expect(opencode).toEqual(projectEvents('claude-code'));
  });

  test('the full session is covered: every canonical fact, nothing silently dropped', () => {
    const facts = [...new Set(translateScenario('opencode', ctx).events.map(({ fact }) => fact))];
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
    expect(results['opencode']?.drops).toEqual([]);
  });

  test('OpenCode reports the failed command\'s exit code (CONFORMS with Claude/Codex/Pi)', () => {
    const failureExitCodes = (runtime: Parameters<typeof translateScenario>[0]): unknown[] =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'failure' && event.kind === 'terminal.output')
        .map(({ event }) => (event.payload as { exit_code: unknown }).exit_code);
    expect(failureExitCodes('opencode')).toEqual([1]);
    expect(failureExitCodes('opencode')).toEqual(failureExitCodes('claude-code'));
    expect(failureExitCodes('opencode')).toEqual(failureExitCodes('pi'));
  });

  test('the file-edit line deltas match the Claude baseline exactly', () => {
    const editDeltas = (runtime: Parameters<typeof translateScenario>[0]): unknown =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'file-edit' && event.kind === 'file.changed')
        .map(({ event }) => {
          const payload = event.payload as { lines_removed?: unknown; lines_added?: unknown };
          return [payload.lines_removed, payload.lines_added];
        });
    expect(editDeltas('opencode')).toEqual([[2, 3]]);
    expect(editDeltas('opencode')).toEqual(editDeltas('claude-code'));
  });

  test('the remember clause is byte-identical to Claude (the trailing period is stripped)', () => {
    const rememberContent = (runtime: Parameters<typeof translateScenario>[0]): string[] =>
      translateScenario(runtime, ctx)
        .events.filter(({ fact, event }) => fact === 'remember' && event.kind === 'explicit.remember')
        .map(({ event }) => String((event.payload as { content: string }).content));
    expect(rememberContent('opencode')).toEqual([SCENARIO.rememberedClause]);
    expect(rememberContent('opencode')).toEqual(rememberContent('claude-code'));
  });

  test('each user turn is captured exactly once (the chat hook claims the message id)', () => {
    // The plain user question is one conversation.message; the remember turn is one
    // explicit.remember (never also a message) — the utterance is captured exactly once each.
    const userMessages = translateScenario('opencode', ctx).events.filter(
      ({ event }) => event.kind === 'conversation.message' && (event.payload as { role: string }).role === 'user',
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages.map(({ event }) => (event.payload as { content: string }).content)).toEqual([
      SCENARIO.userPrompt,
    ]);
    const assistantMessages = translateScenario('opencode', ctx).events.filter(
      ({ event }) => event.kind === 'conversation.message' && (event.payload as { role: string }).role === 'assistant',
    );
    expect(assistantMessages.map(({ event }) => (event.payload as { content: string }).content)).toEqual([
      SCENARIO.assistantFirst,
      SCENARIO.assistantFinal,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Memory-level conformance (the real pipeline)
// ---------------------------------------------------------------------------

describe('opencode conformance — memory.upsert', () => {
  test('the canonical session yields the same memories and evidence as Claude', () => {
    expect(results['opencode']?.memories).toEqual(results['claude-code']?.memories);
  });

  test('the extraction counts agree (same events in, same candidates out)', () => {
    expect(results['opencode']?.extraction).toEqual(results['claude-code']?.extraction);
    expect(results['opencode']?.extraction?.events_processed).toBe(11);
    expect(results['opencode']?.extraction?.memories_inserted).toBe(3);
  });

  test('the memories are the expected ones — equality above is not vacuous', () => {
    const contents = (results['opencode']?.memories ?? []).map((memory) => memory.content).sort();
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
    expect(evidence('opencode')).toEqual(evidence('claude-code'));
    const failure = results['opencode']?.memories.find((memory) => memory.type === 'failure');
    expect(failure?.evidence).toEqual(['event:failure', 'event:success-2']);
    const procedure = results['opencode']?.memories.find((memory) => memory.type === 'procedural');
    expect(procedure?.evidence).toEqual(['event:success-1', 'event:success-2']);
    const semantic = results['opencode']?.memories.find((memory) => memory.type === 'semantic');
    expect(semantic?.evidence).toEqual(['event:remember']);
  });

  test('working memory (the session sweep surface) is identical to Claude', () => {
    expect(results['opencode']?.working).toEqual(results['claude-code']?.working);
    expect(results['opencode']?.working).toEqual([
      { kind: 'current_file', content: 'Editing src/auth/middleware.ts', evidence: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. memory.search + memory_get conformance
// ---------------------------------------------------------------------------

describe('opencode conformance — memory.search / memory_get', () => {
  test('the same query returns the same ranking as Claude', () => {
    expect(results['opencode']?.search.query).toBe(CONFORMANCE_QUERY);
    expect(results['opencode']?.search.ranking).toEqual(results['claude-code']?.search.ranking);
    expect(results['opencode']?.search.ranking).toEqual([`semantic|${SCENARIO.rememberedClause}`]);
  });

  test('memory_get returns the same payload as Claude', () => {
    const opencode = results['opencode']?.get;
    expect(opencode).not.toBeNull();
    expect(opencode).toEqual(results['claude-code']?.get);
    expect(opencode?.type).toBe('semantic');
    expect(opencode?.status).toBe('active');
    expect(opencode?.importance).toBe(0.9);
    expect(opencode?.confidence).toBe(0.95);
    expect(opencode?.evidence).toEqual(['event:remember']);
  });
});

// ---------------------------------------------------------------------------
// 4. The payload builders are OpenCode's real wire contract
// ---------------------------------------------------------------------------

describe('opencode conformance — the canonical payloads are runtime-native', () => {
  test('the session rides the three documented hook channels', () => {
    const entries = nativePayloads('opencode', ctx);
    expect(entries.filter((entry) => entry.channel === 'event').map((entry) =>
      String((entry.payload as { type: string }).type),
    )).toEqual(['session.created', 'message.part.updated', 'message.part.updated', 'session.idle']);
    expect(entries.filter((entry) => entry.channel === 'tool').map((entry) =>
      String((entry.payload as { tool: string }).tool),
    )).toEqual(['bash', 'edit', 'bash', 'bash']);
    expect(entries.filter((entry) => entry.channel === 'chat')).toHaveLength(2);
    // The bash tool keeps the "bash" id upstream ("kept for compatibility") and carries
    // metadata.exit (null = abort/timeout, the exit code otherwise).
    const failureTool = entries.find(
      (entry) => entry.fact === 'failure' && entry.channel === 'tool',
    )!;
    expect((failureTool.output as { metadata: { exit: number } }).metadata.exit).toBe(1);
  });
});
