import { describe, expect, test } from 'bun:test';

import { validateOnememoryEvent, type OnememoryEvent } from '@onememory/core';

import { translateCodexHook } from './translate-hooks';
import {
  bashToolResponse,
  FIXTURE_PROJECT_ID,
  FIXTURE_SESSION_ID,
  postToolUseHookInput,
  sessionEndHookInput,
  sessionStartHookInput,
  stopHookInput,
  userPromptSubmitHookInput,
} from './testing';

const NOW = new Date('2026-10-03T10:00:00.000Z');
const CONTEXT = { projectId: FIXTURE_PROJECT_ID, now: NOW };

/** Every translated event must pass the canonical validator — the task's hard contract. */
function expectAllValid(events: OnememoryEvent[]): void {
  for (const event of events) {
    const result = validateOnememoryEvent(event);
    expect(result.ok).toBe(true);
    expect(event.source.runtime).toBe('codex');
    expect(event.source.adapter_version).toBe('0.1.0');
    expect(event.occurred_at).toBe(NOW.toISOString());
    expect(event.scope.session_id).toBe(FIXTURE_SESSION_ID);
    expect(event.scope.project_id).toBe(FIXTURE_PROJECT_ID);
  }
}

describe('translateCodexHook — session lifecycle', () => {
  test('SessionStart becomes a session.start event', () => {
    const { events, dropped } = translateCodexHook(sessionStartHookInput(), CONTEXT);
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(1);
    expectAllValid(events);
    const payload = events[0]!.payload as { kind: string; cwd: string; summary: string };
    expect(payload.kind).toBe('session.start');
    expect(payload.cwd).toBe('/workspace/demo');
    expect(payload.summary).toBe('codex session started (startup)');
  });

  test('SessionEnd becomes a session.end event', () => {
    const { events } = translateCodexHook(sessionEndHookInput(), CONTEXT);
    expect(events).toHaveLength(1);
    expectAllValid(events);
    const payload = events[0]!.payload as { kind: string; cwd: string };
    expect(payload.kind).toBe('session.end');
  });
});

describe('translateCodexHook — user prompts', () => {
  test('a plain prompt becomes a user conversation.message', () => {
    const { events, dropped } = translateCodexHook(
      userPromptSubmitHookInput('Let us decide the storage layer today.'),
      CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(1);
    expectAllValid(events);
    const payload = events[0]!.payload as { kind: string; role: string; content: string };
    expect(payload.kind).toBe('conversation.message');
    expect(payload.role).toBe('user');
    expect(payload.content).toBe('Let us decide the storage layer today.');
  });

  test('a leading "remember that" directive becomes explicit.remember (one event, not two)', () => {
    const { events, dropped } = translateCodexHook(
      userPromptSubmitHookInput('Remember that we use bun test over jest in this repo.'),
      CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(1);
    expectAllValid(events);
    const payload = events[0]!.payload as { kind: string; content: string };
    expect(payload.kind).toBe('explicit.remember');
    expect(payload.content).toBe('we use bun test over jest in this repo.');
  });

  test('remember directives mid-sentence stay plain messages (conservative detection)', () => {
    const { events } = translateCodexHook(
      userPromptSubmitHookInput('While you are at it, remember the migration order.'),
      CONTEXT,
    );
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { kind: string }).kind).toBe('conversation.message');
  });

  test('"don\'t forget" is recognized; a bare "remember" is not', () => {
    const forget = translateCodexHook(userPromptSubmitHookInput("Don't forget: PGlite migrations run on both dialects."), CONTEXT);
    expect((forget.events[0]!.payload as { kind: string }).kind).toBe('explicit.remember');
    expect((forget.events[0]!.payload as { content: string }).content).toBe('PGlite migrations run on both dialects.');

    const bare = translateCodexHook(userPromptSubmitHookInput('Remember.'), CONTEXT);
    expect((bare.events[0]!.payload as { kind: string }).kind).toBe('conversation.message');
  });
});

describe('translateCodexHook — Stop (assistant turn)', () => {
  test('last_assistant_message becomes an assistant conversation.message', () => {
    const { events, dropped } = translateCodexHook(stopHookInput(), CONTEXT);
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(1);
    expectAllValid(events);
    const payload = events[0]!.payload as { kind: string; role: string; content: string };
    expect(payload.kind).toBe('conversation.message');
    expect(payload.role).toBe('assistant');
  });

  test('a Stop with no assistant message is dropped with a counted reason', () => {
    const { events, dropped } = translateCodexHook(
      stopHookInput({ last_assistant_message: null }),
      CONTEXT,
    );
    expect(events).toHaveLength(0);
    expect(dropped).toEqual([{ reason: 'no-assistant-message', count: 1 }]);
  });
});

describe('translateCodexHook — PostToolUse (Bash)', () => {
  test('a successful command becomes terminal.output with the verified exit code', () => {
    const { events, dropped } = translateCodexHook(
      postToolUseHookInput({
        name: 'Bash',
        input: { command: 'bun test' },
        response: bashToolResponse('87 pass, 0 fail (1.2s)', 0),
      }),
      CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(1); // success: no error.raised
    expectAllValid(events);
    const payload = events[0]!.payload as {
      kind: string;
      command: string;
      exit_code: number | null;
      output_digest: string;
    };
    expect(payload.kind).toBe('terminal.output');
    expect(payload.command).toBe('bun test');
    expect(payload.exit_code).toBe(0);
    expect(payload.output_digest).toContain('87 pass, 0 fail (1.2s)');
  });

  test('an argv-array command is joined into one command line', () => {
    const { events } = translateCodexHook(
      postToolUseHookInput({
        name: 'Bash',
        input: { command: ['bun', 'test', 'packages/storage'] },
        response: bashToolResponse('ok', 0),
      }),
      CONTEXT,
    );
    expect((events[0]!.payload as { command: string }).command).toBe('bun test packages/storage');
  });

  test('a non-zero exit yields terminal.output AND error.raised (the resolution-pair family)', () => {
    const { events } = translateCodexHook(
      postToolUseHookInput({
        name: 'Bash',
        input: { command: 'bun test' },
        response: bashToolResponse('error: Cannot find module "./schema"', 1),
      }),
      CONTEXT,
    );
    expect(events).toHaveLength(2);
    expectAllValid(events);
    const [terminal, error] = events as [
      OnememoryEvent & { payload: { kind: string; exit_code: number | null } },
      OnememoryEvent & { payload: { kind: string; origin: string; message: string; context?: string } },
    ];
    expect(terminal.payload.kind).toBe('terminal.output');
    expect(terminal.payload.exit_code).toBe(1);
    expect(error.payload.kind).toBe('error.raised');
    expect(error.payload.origin).toBe('terminal');
    expect(error.payload.message).toContain('Cannot find module');
    expect(error.payload.context).toBe('codex: bun test');
  });

  test('an ongoing PTY session has no exit code and raises no error', () => {
    const { events } = translateCodexHook(
      postToolUseHookInput({
        name: 'Bash',
        input: { command: 'npm run dev' },
        response: bashToolResponse('server listening', null),
      }),
      CONTEXT,
    );
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { exit_code: number | null };
    expect(payload.exit_code).toBeNull();
  });

  test('a tool_input without a command is dropped with a counted reason, never coerced', () => {
    const { events, dropped } = translateCodexHook(
      postToolUseHookInput({ name: 'Bash', input: { timeout_ms: 1000 }, response: 'x' }),
      CONTEXT,
    );
    expect(events).toHaveLength(0);
    expect(dropped).toEqual([{ reason: 'bash-command-unmappable', count: 1 }]);
  });

  test('long output is bounded to the schema cap with head and tail kept', () => {
    // A realistic long log: noise up front, outcome line last — the clamp must keep BOTH ends
    // (the leading header and the final outcome) and elide only the middle.
    const long = `${'a'.repeat(4000)}\n${'b'.repeat(4000)}\nTHE OUTCOME LINE`;
    const { events } = translateCodexHook(
      postToolUseHookInput({ name: 'Bash', input: { command: 'cat big.log' }, response: bashToolResponse(long, 0) }),
      CONTEXT,
    );
    const digest = (events[0]!.payload as { output_digest: string }).output_digest;
    expect(digest.length).toBeLessThanOrEqual(2000);
    expect(digest.startsWith('Chunk ID:')).toBe(true); // head: the verified transport header survives
    expect(digest.endsWith('THE OUTCOME LINE')).toBe(true); // tail: the final outcome survives
    expect(digest).toContain('truncated'); // the elision is visible, not silent
    expect(digest).toContain('aaa');
    expect(digest).toContain('bbb');
  });
});

describe('translateCodexHook — PostToolUse (apply_patch)', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: packages/storage/src/store.ts',
    '*** Move to: packages/storage/src/store2.ts',
    '@@',
    '+x',
    '*** Add File: packages/storage/README.md',
    '*** Delete File: packages/storage/src/old.ts',
    '*** End Patch',
  ].join('\n');

  test('file edits become file.changed events with verified change kinds', () => {
    const { events, dropped } = translateCodexHook(
      postToolUseHookInput({ name: 'apply_patch', input: { command: patch }, response: 'Success' }),
      CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(3);
    expectAllValid(events);
    expect(events.map((event) => (event.payload as { change: string }).change)).toEqual([
      'renamed',
      'created',
      'deleted',
    ]);
    const renamed = events[0]!.payload as { path: string; old_path?: string };
    expect(renamed.path).toBe('packages/storage/src/store2.ts');
    expect(renamed.old_path).toBe('packages/storage/src/store.ts');
  });

  test('the Edit/Write matcher aliases translate identically', () => {
    const { events } = translateCodexHook(
      postToolUseHookInput({
        name: 'Edit',
        input: { command: '*** Begin Patch\n*** Add File: new.ts\n+x\n*** End Patch' },
        response: 'Success',
      }),
      CONTEXT,
    );
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { change: string }).change).toBe('created');
  });

  test('a non-patch payload is dropped with a counted reason', () => {
    const { events, dropped } = translateCodexHook(
      postToolUseHookInput({ name: 'apply_patch', input: { command: 'not a patch' }, response: 'Success' }),
      CONTEXT,
    );
    expect(events).toHaveLength(0);
    expect(dropped).toEqual([{ reason: 'apply-patch-unparseable', count: 1 }]);
  });
});

describe('translateCodexHook — everything else is counted, never coerced', () => {
  test('an unsubscribed tool name is dropped as unmapped', () => {
    const { events, dropped } = translateCodexHook(
      postToolUseHookInput({ name: 'update_plan', input: {}, response: 'ok' }),
      CONTEXT,
    );
    expect(events).toHaveLength(0);
    expect(dropped).toEqual([{ reason: 'unmapped-tool:update_plan', count: 1 }]);
  });

  test('an unsupported hook event is dropped as such', () => {
    const { events, dropped } = translateCodexHook({ hook_event_name: 'PreCompact', cwd: '/x' }, CONTEXT);
    expect(events).toHaveLength(0);
    expect(dropped).toEqual([{ reason: 'unsupported-hook-event:PreCompact', count: 1 }]);
  });

  test('a payload without a hook event name is dropped', () => {
    const { events, dropped } = translateCodexHook({ cwd: '/x' }, CONTEXT);
    expect(dropped).toEqual([{ reason: 'missing-hook-event-name', count: 1 }]);
  });

  test('wire-schema violations are dropped, not guessed from', () => {
    const { events, dropped } = translateCodexHook({ hook_event_name: 'UserPromptSubmit' }, CONTEXT);
    expect(events).toHaveLength(0);
    expect(dropped).toEqual([{ reason: 'unmappable-user-prompt', count: 1 }]);

    const badStop = translateCodexHook({ hook_event_name: 'Stop', cwd: '/x' }, CONTEXT);
    expect(badStop.dropped).toEqual([{ reason: 'unmappable-stop', count: 1 }]);
  });

  test('unknown wire fields pass through (forward compatibility)', () => {
    const { events } = translateCodexHook(
      userPromptSubmitHookInput('hello', { some_future_field: 'x' } as never),
      CONTEXT,
    );
    expect(events).toHaveLength(1);
  });
});
