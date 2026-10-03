import { describe, expect, test } from 'bun:test';

import { validateOnememoryEvent, type OnememoryEvent } from '@onememory/core';

import { translateRolloutSession } from './translate-rollout';
import { FIXTURE_PROJECT_ID, goldenRollout, noiseRollout } from './testing';

const CONTEXT = { projectId: FIXTURE_PROJECT_ID, now: new Date('2026-10-03T10:00:00.000Z') };

describe('translateRolloutSession — the golden rollout', () => {
  const result = translateRolloutSession(goldenRollout(), CONTEXT);

  test('produces validated events in document order', () => {
    expect(result.events.length).toBeGreaterThan(0);
    for (const event of result.events) {
      expect(validateOnememoryEvent(event).ok).toBe(true);
      expect(event.source.runtime).toBe('codex');
    }
    const occurred = result.events.map((event) => event.occurred_at);
    expect(occurred).toEqual([...occurred].sort());
  });

  test('session_meta becomes session.start with the meta timestamp and cwd', () => {
    const start = result.events.find((event) => event.kind === 'session.start') as
      | (OnememoryEvent & { payload: { cwd: string; started_at: string; summary: string } })
      | undefined;
    expect(start).toBeDefined();
    expect(start!.payload.cwd).toBe('/workspace/demo');
    expect(start!.payload.started_at).toBe('2026-10-03T09:00:00.000Z');
    expect(start!.payload.summary).toContain('codex_cli_rs');
    expect(start!.occurred_at).toBe('2026-10-03T09:00:00.000Z');
  });

  test('the session id from session_meta is returned for scope use', () => {
    expect(result.sessionId).toBe('019a7c0e-5b1f-7000-8000-00000000e001');
  });

  test('harness-injected environment context is skipped; real user text is kept', () => {
    const userMessages = result.events.filter(
      (event) =>
        event.kind === 'conversation.message' &&
        (event.payload as { role: string }).role === 'user',
    );
    expect(userMessages).toHaveLength(1);
    expect((userMessages[0]!.payload as { content: string }).content).toContain('PostgreSQL with pgvector');
    expect(result.dropped).toContainEqual({ reason: 'harness-injected-context', count: 1 });
  });

  test('assistant output_text becomes an assistant message with the line timestamp', () => {
    const assistant = result.events.find(
      (event) =>
        event.kind === 'conversation.message' &&
        (event.payload as { role: string }).role === 'assistant',
    );
    expect(assistant).toBeDefined();
    expect(assistant!.occurred_at).toBe('2026-10-03T09:00:10.000Z');
  });

  test('shell calls pair with their outputs into terminal.output (+ error.raised on failure)', () => {
    const terminal = result.events.filter((event) => event.kind === 'terminal.output');
    expect(terminal).toHaveLength(2);

    const failed = terminal[0]! as OnememoryEvent & {
      payload: { command: string; exit_code: number | null; output_digest: string };
    };
    expect(failed.payload.command).toBe('bun test');
    expect(failed.payload.exit_code).toBe(1);
    expect(failed.payload.output_digest).toContain('Cannot find module');

    const ok = terminal[1]! as OnememoryEvent & { payload: { exit_code: number | null } };
    expect(ok.payload.exit_code).toBe(0);

    const errors = result.events.filter((event) => event.kind === 'error.raised');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.payload as { message: string }).message).toContain('Cannot find module');
  });

  test('apply_patch becomes file.changed events (update + add)', () => {
    const fileChanges = result.events
      .filter((event) => event.kind === 'file.changed')
      .map((event) => {
        const payload = event.payload as { path: string; change: string };
        return { path: payload.path, change: payload.change };
      });
    expect(fileChanges).toEqual([
      { path: 'packages/storage/src/store.ts', change: 'modified' },
      { path: 'packages/storage/src/README.md', change: 'created' },
    ]);
  });

  test('other tools become tool_call/tool_result; onememory tools are excluded', () => {
    const calls = result.events.filter((event) => event.kind === 'conversation.tool_call');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.payload as { tool: string }).tool).toBe('mcp__linter__lint');

    const toolResults = result.events.filter((event) => event.kind === 'conversation.tool_result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0]!.payload as { output_digest: string }).output_digest).toContain('lint: 0 problems');

    expect(result.dropped).toContainEqual({ reason: 'own-memory-tool', count: 1 });
  });

  test('records the native pipeline also ignores are counted as skipped', () => {
    expect(result.dropped).toContainEqual({ reason: 'skipped:turn_context', count: 1 });
    expect(result.dropped).toContainEqual({ reason: 'skipped:event_msg', count: 2 });
    expect(result.dropped).toContainEqual({ reason: 'skipped:response_item:reasoning', count: 1 });
    expect(result.lines.read).toBe(17); // 16 records + the split() remainder of the final newline
    expect(result.lines.skipped).toBe(4); // turn_context + 2 event_msg + reasoning
  });
});

describe('translateRolloutSession — noise and malformed input', () => {
  test('the noise rollout yields zero events with counted drops', () => {
    const result = translateRolloutSession(noiseRollout(), CONTEXT);
    expect(result.events).toHaveLength(0);
    expect(result.dropped).toContainEqual({ reason: 'skipped:token_usage_record', count: 1 });
    expect(result.dropped).toContainEqual({ reason: 'skipped:event_msg', count: 1 });
    expect(result.dropped).toContainEqual({ reason: 'unsupported-role:developer', count: 1 });
    expect(result.dropped).toContainEqual({ reason: 'invalid-jsonl-line', count: 1 });
  });

  test('an orphan output (call_id with no call) is counted', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-03T09:00:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_none', output: 'x' },
    });
    const result = translateRolloutSession(`${line}\n`, CONTEXT);
    expect(result.events).toHaveLength(0);
    expect(result.dropped).toContainEqual({ reason: 'orphan-output', count: 1 });
  });

  test('a shell call whose output never arrives is counted (interrupted turn)', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-03T09:00:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', call_id: 'call_x', arguments: '{"command":["bash","-lc","bun test"]}' },
    });
    const result = translateRolloutSession(`${line}\n`, CONTEXT);
    expect(result.events).toHaveLength(0);
    expect(result.dropped).toContainEqual({ reason: 'call-without-output', count: 1 });
  });

  test('structured function_call_output content items are flattened', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-10-03T09:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls"]}' },
      }),
      JSON.stringify({
        timestamp: '2026-10-03T09:00:01.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'output_text', text: 'one' }, { type: 'output_text', text: 'two' }] },
      }),
    ];
    const result = translateRolloutSession(`${lines.join('\n')}\n`, CONTEXT);
    const terminal = result.events.find((event) => event.kind === 'terminal.output');
    expect((terminal!.payload as { output_digest: string }).output_digest).toContain('one');
    expect((terminal!.payload as { output_digest: string }).output_digest).toContain('two');
  });

  test('byte and line bounds are enforced with counted overflow', () => {
    const huge = `${noiseRollout()}\n`.repeat(30);
    const result = translateRolloutSession(huge, CONTEXT);
    expect(result.lines.read).toBeLessThanOrEqual(20_000);
  });
});
