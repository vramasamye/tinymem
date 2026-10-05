import { describe, expect, test } from 'bun:test';

import { validateOnememoryEvent } from '@onememory/core';

import { parseHookInput } from './hook-input';
import { translateHookInput } from './translate';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const PROJECT_ID = '019a7c0e-5b1f-7000-8000-00000000e001';
const ROOT = '/work/demo';

function translate(payload: Record<string, unknown>, projectId: string | null = PROJECT_ID) {
  return translateHookInput(payload, { now: NOW, projectId, projectRoot: ROOT });
}

/** Every event must survive the canonical envelope validation the daemon applies. */
function expectValid(result: ReturnType<typeof translateHookInput>): void {
  for (const event of result.events) {
    const validated = validateOnememoryEvent(event);
    expect(validated.ok).toBe(true);
    expect(event.source.runtime).toBe('cursor');
    expect(event.source.adapter_version).toBe('0.1.0');
  }
}

const COMMON = { cursor_version: '1.7.2', workspace_roots: [ROOT], conversation_id: 'conv-1' };

describe('cursor translation — session lifecycle', () => {
  test('sessionStart → session.start with the workspace root as cwd', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'sessionStart',
      session_id: 'sess-1',
      is_background_agent: false,
      composer_mode: 'agent',
    });
    expectValid(result);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: 'session.start',
      occurred_at: NOW.toISOString(),
      scope: { project_id: PROJECT_ID, session_id: 'sess-1', agent_id: 'cursor' },
      payload: { kind: 'session.start', cwd: ROOT },
    });
  });

  test('sessionStart falls back to the hook-discovered project root when workspace_roots is absent', () => {
    const result = translate({ hook_event_name: 'sessionStart', session_id: 'sess-1' });
    expectValid(result);
    expect(result.events[0]?.payload).toMatchObject({ kind: 'session.start', cwd: ROOT });
  });

  test('sessionStart without any cwd source is a counted drop, never a guessed path', () => {
    const result = translateHookInput(
      { hook_event_name: 'sessionStart', session_id: 'sess-1' },
      { now: NOW, projectId: PROJECT_ID },
    );
    expect(result.events).toEqual([]);
    expect(result.drops).toEqual([{ reason: 'session_start_missing_cwd', count: 1 }]);
  });

  test('sessionEnd → session.end (the daemon working-memory sweep trigger)', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'sessionEnd',
      session_id: 'sess-1',
      reason: 'user_close',
    });
    expectValid(result);
    expect(result.events[0]).toMatchObject({ kind: 'session.end', payload: { kind: 'session.end', cwd: ROOT } });
  });

  test('stop maps to nothing (per-turn loop end; documented gap)', () => {
    const result = translate({ ...COMMON, hook_event_name: 'stop', status: 'completed', loop_count: 0 });
    expect(result.events).toEqual([]);
    expect(result.drops).toEqual([{ reason: 'turn_end_no_event', count: 1 }]);
  });
});

describe('cursor translation — conversation', () => {
  test('beforeSubmitPrompt → conversation.message (user)', () => {
    const result = translate({ ...COMMON, hook_event_name: 'beforeSubmitPrompt', prompt: 'How does auth work?' });
    expectValid(result);
    expect(result.events[0]).toMatchObject({
      kind: 'conversation.message',
      payload: { kind: 'conversation.message', role: 'user', content: 'How does auth work?' },
    });
  });

  test('an imperative remember prompt becomes explicit.remember, not a message', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'Remember that the auth module uses signed session cookies.',
    });
    expectValid(result);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: 'explicit.remember',
      payload: { kind: 'explicit.remember', content: 'the auth module uses signed session cookies' },
    });
  });

  test('a conversational "do you remember" stays a message', () => {
    const result = translate({ ...COMMON, hook_event_name: 'beforeSubmitPrompt', prompt: 'Do you remember yesterday?' });
    expect(result.events[0]?.kind).toBe('conversation.message');
  });

  test('afterAgentResponse → conversation.message (assistant)', () => {
    const result = translate({ ...COMMON, hook_event_name: 'afterAgentResponse', text: 'The auth module is three files.' });
    expectValid(result);
    expect(result.events[0]).toMatchObject({
      kind: 'conversation.message',
      payload: { role: 'assistant', content: 'The auth module is three files.' },
    });
  });
});

describe('cursor translation — tool activity', () => {
  test('postToolUse Shell → terminal.output with the documented tool_output exit code', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'bun test src/auth/' },
      tool_output: JSON.stringify({ exitCode: 0, stdout: '3 pass (0.41s)' }),
      tool_use_id: 'call-1',
      cwd: ROOT,
      duration: 410,
    });
    expectValid(result);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: 'terminal.output',
      payload: {
        kind: 'terminal.output',
        command: 'bun test src/auth/',
        exit_code: 0,
        output_digest: '3 pass (0.41s)',
      },
    });
  });

  test('an unparseable Shell tool_output yields exit_code null rather than a fabricated 0', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'bun test' },
      tool_output: 'raw text, not JSON',
    });
    expectValid(result);
    expect(result.events[0]?.payload).toMatchObject({ exit_code: null, output_digest: '' });
    expect(result.drops).toEqual([{ reason: 'shell_output_unparseable', count: 1 }]);
  });

  test('afterFileEdit → file.changed with the path relativized and exact line deltas', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'afterFileEdit',
      file_path: `${ROOT}/src/auth/middleware.ts`,
      edits: [{ old_string: 'const a = 1;\n', new_string: 'const a = 2;\nconst b = 3;\n' }],
    });
    expectValid(result);
    expect(result.events[0]).toMatchObject({
      kind: 'file.changed',
      payload: { kind: 'file.changed', path: 'src/auth/middleware.ts', change: 'modified', lines_removed: 1, lines_added: 2 },
    });
  });

  test('postToolUse for a file-edit tool is dropped (afterFileEdit owns the edit)', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'postToolUse',
      tool_name: 'Write',
      tool_input: { file_path: `${ROOT}/x.ts` },
    });
    expect(result.events).toEqual([]);
    expect(result.drops).toEqual([{ reason: 'file_edit_via_afterFileEdit:Write', count: 1 }]);
  });

  test('an unmapped tool is a counted drop', () => {
    const result = translate({ ...COMMON, hook_event_name: 'postToolUse', tool_name: 'Grep', tool_input: {} });
    expect(result.events).toEqual([]);
    expect(result.drops).toEqual([{ reason: 'unmapped_tool:Grep', count: 1 }]);
  });
});

describe('cursor translation — failures', () => {
  test('a failed Shell command → terminal.output (exit_code null, documented gap) + error.raised', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'postToolUseFailure',
      tool_name: 'Shell',
      tool_input: { command: "bun test src/auth/middleware.test.ts" },
      error_message: "Error: Cannot find module './middleware'",
      failure_type: 'error',
      duration: 5000,
      is_interrupt: false,
    });
    expectValid(result);
    expect(result.events.map((event) => event.kind)).toEqual(['terminal.output', 'error.raised']);
    expect(result.events[0]?.payload).toMatchObject({ command: "bun test src/auth/middleware.test.ts", exit_code: null });
    expect(result.events[1]?.payload).toMatchObject({
      kind: 'error.raised',
      origin: 'terminal',
      message: "Error: Cannot find module './middleware'",
      context: "bun test src/auth/middleware.test.ts",
    });
  });

  test('a non-Shell tool failure → error.raised (origin tool)', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'postToolUseFailure',
      tool_name: 'Read',
      tool_input: { file_path: '/nope' },
      error_message: 'File not found',
      failure_type: 'error',
    });
    expectValid(result);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.payload).toMatchObject({ kind: 'error.raised', origin: 'tool', message: 'File not found', context: 'Read' });
  });

  test('a user interrupt is not an error the project should remember', () => {
    const result = translate({
      ...COMMON,
      hook_event_name: 'postToolUseFailure',
      tool_name: 'Shell',
      tool_input: { command: 'bun test' },
      error_message: 'cancelled',
      is_interrupt: true,
    });
    expect(result.events).toEqual([]);
    expect(result.drops).toEqual([{ reason: 'interrupted_failure', count: 1 }]);
  });
});

describe('cursor translation — parse boundary', () => {
  test('a payload that violates a field we key on is a counted drop, never a crash', () => {
    const result = translate({ hook_event_name: 'postToolUseFailure', tool_name: 'Shell' });
    expect(result.events).toEqual([]);
    expect(result.drops[0]?.reason.startsWith('invalid_input:')).toBe(true);
  });

  test('an unsubscribed Cursor event is reported by name', () => {
    const parsed = parseHookInput({ hook_event_name: 'preToolUse', tool_name: 'Shell' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('unhandled_hook_event:preToolUse');
  });

  test('a non-object payload is rejected', () => {
    expect(parseHookInput('nope').ok).toBe(false);
    expect(translateHookInput(null, {}).drops[0]?.reason).toBe('invalid_input:not_an_object');
  });

  test('the project id is omitted from scope when unresolved (no fabricated project)', () => {
    const result = translate({ ...COMMON, hook_event_name: 'beforeSubmitPrompt', prompt: 'hello' }, null);
    expect(result.events[0]?.scope.project_id).toBeUndefined();
    expect(result.events[0]?.scope.agent_id).toBe('cursor');
  });
});
