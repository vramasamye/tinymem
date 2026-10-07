/**
 * Translation tests: every row of the mapping table in `translate.ts`, plus the counted drops.
 * All fixtures come from `testing.ts` (verified OpenCode wire shapes).
 */

import { describe, expect, test } from 'bun:test';

import { validateOnememoryEvent } from '@onememory-ai/core';

import { createOpenCodeTranslator, type OpenCodeTranslateContext } from './translate';
import {
  bashToolAfter,
  chatMessageHook,
  editToolAfter,
  eventHookInput,
  sessionCreatedEvent,
  sessionIdleEvent,
  textPartUpdatedEvent,
  toolPartUpdatedEvent,
  writeToolAfter,
  FIXTURE_ASSISTANT_MESSAGE_ID,
  FIXTURE_CWD,
  FIXTURE_SESSION_ID,
  FIXTURE_USER_MESSAGE_ID,
} from './testing';

const NOW = new Date('2026-10-06T09:00:00.000Z');
const BASE: OpenCodeTranslateContext = {
  projectId: '01900000-0000-7000-8000-00000000000d',
  projectRoot: FIXTURE_CWD,
};
const CALL = { now: NOW };

interface KindOf {
  kind: string;
  [key: string]: unknown;
}

function kinds(events: Array<{ kind: string }>): string[] {
  return events.map((event) => event.kind);
}

function payloadOf(event: { payload: KindOf }): KindOf {
  return event.payload;
}

function scopeOf(event: { scope: Record<string, unknown> }): Record<string, unknown> {
  return event.scope;
}

describe('translateEvent — session lifecycle', () => {
  test('session.created → session.start with cwd and the session title in the summary', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(eventHookInput(sessionCreatedEvent()), CALL);
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('session.start');
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'session.start',
      cwd: FIXTURE_CWD,
      summary: 'opencode session start (title: fix the failing retrieval benchmark)',
    });
    expect(scopeOf(events[0]!)).toMatchObject({ session_id: FIXTURE_SESSION_ID, agent_id: 'opencode' });
  });

  test('session.created without directory and no projectRoot fallback is a counted drop', () => {
    const { events, dropped } = createOpenCodeTranslator({}).translateEvent(
      eventHookInput(sessionCreatedEvent({ directory: '' })),
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'session_start_missing_cwd', count: 1 }]);
  });

  test('session.created with an empty directory falls back to the projectRoot', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput(sessionCreatedEvent({ directory: '' })),
      CALL,
    );
    expect(dropped).toEqual([]);
    expect(payloadOf(events[0]!)).toMatchObject({ cwd: FIXTURE_CWD });
  });

  test('session.idle → session.end (the quiescence boundary; cwd from the plugin context)', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(eventHookInput(sessionIdleEvent()), CALL);
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['session.end']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'session.end',
      cwd: FIXTURE_CWD,
      summary: 'opencode session idle (the agent turn loop is complete)',
    });
    expect(scopeOf(events[0]!)).toMatchObject({ session_id: FIXTURE_SESSION_ID });
  });

  test('session.idle without a projectRoot is a counted drop, not an invented cwd', () => {
    const { events, dropped } = createOpenCodeTranslator({}).translateEvent(eventHookInput(sessionIdleEvent()), CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'session_end_missing_cwd', count: 1 }]);
  });
});

describe('translateEvent — message parts', () => {
  test('completed assistant text part → conversation.message (assistant)', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput(textPartUpdatedEvent('The build fails on darwin because of the pty linking.')),
      CALL,
    );
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['conversation.message']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'conversation.message',
      role: 'assistant',
      content: 'The build fails on darwin because of the pty linking.',
    });
    expect(scopeOf(events[0]!)).toMatchObject({ session_id: FIXTURE_SESSION_ID });
  });

  test('a streaming part (time.end unset) is a counted drop — deltas are not stable text', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput(textPartUpdatedEvent('partial', { time: { start: 1_800_000_000_000 } })),
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'text_part_streaming', count: 1 }]);
  });

  test('a synthetic part is a counted drop (runtime-injected prose is not conversation)', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput(textPartUpdatedEvent('injected', { synthetic: true })),
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'synthetic_part', count: 1 }]);
  });

  test('an ignored part is a counted drop', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput(textPartUpdatedEvent('quiet', { ignored: true })),
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'ignored_part', count: 1 }]);
  });

  test('tool part error state → error.raised with origin tool and the tool name as context', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput(toolPartUpdatedEvent({ status: 'error', error: 'spawn bun ENOENT' })),
      CALL,
    );
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['error.raised']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'error.raised',
      origin: 'tool',
      message: 'spawn bun ENOENT',
      context: 'bash',
    });
  });

  test('tool part error state without an error string invents nothing — names the tool', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput(toolPartUpdatedEvent({ status: 'error' })),
      CALL,
    );
    expect(dropped).toEqual([]);
    expect(payloadOf(events[0]!)).toMatchObject({ origin: 'tool', message: 'tool bash failed' });
  });

  test('tool part non-error states are counted drops (progress, not failure)', () => {
    for (const status of ['pending', 'running', 'completed'] as const) {
      const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
        eventHookInput(toolPartUpdatedEvent({ status })),
        CALL,
      );
      expect(events).toEqual([]);
      expect(dropped).toEqual([{ reason: `tool_part_state:${status}`, count: 1 }]);
    }
  });

  test('non-prose part types are counted drops with the part type named', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput({
        type: 'message.part.updated',
        properties: { part: { id: 'p1', sessionID: FIXTURE_SESSION_ID, messageID: 'm1', type: 'step-start', time: {} } },
      }),
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'part_not_prose:step-start', count: 1 }]);
  });

  test('a part with no type field is a part_not_prose:unknown drop, never a crash', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput({ type: 'message.part.updated', properties: { part: { id: 'p1' } } }),
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'part_not_prose:unknown', count: 1 }]);
  });
});

describe('translateEvent — the unsubscribed and malformed ledger', () => {
  test('unsubscribed event types are counted drops naming the type', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(
      eventHookInput({ type: 'session.error', properties: { sessionID: FIXTURE_SESSION_ID } }),
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'unsubscribed_event:session.error', count: 1 }]);
  });

  test('a malformed wrapper (no event field) is a counted drop', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent({}, CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'malformed_event_wrapper', count: 1 }]);
  });

  test('an event without a type is a counted drop', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateEvent(eventHookInput({}), CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'malformed_event', count: 1 }]);
  });
});

describe('translateToolAfter — bash', () => {
  test('exit 0 → terminal.output only (success costs one event)', () => {
    const pair = bashToolAfter({ command: 'bun test packages/core' }, { output: '96 pass\n0 fail', exit: 0 });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['terminal.output']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'terminal.output',
      command: 'bun test packages/core',
      exit_code: 0,
      output_digest: '96 pass\n0 fail',
      shell: 'bash',
    });
  });

  test('exit > 0 → terminal.output + error.raised (origin terminal, first meaningful line)', () => {
    const pair = bashToolAfter(
      { command: 'bun test packages/api' },
      { output: '\n\nerror: connect ECONNREFUSED 127.0.0.1:5432\nRan 12 tests', exit: 3 },
    );
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['terminal.output', 'error.raised']);
    expect(payloadOf(events[1]!)).toMatchObject({
      kind: 'error.raised',
      origin: 'terminal',
      message: 'error: connect ECONNREFUSED 127.0.0.1:5432',
      context: 'bun test packages/api',
    });
  });

  test('exit null (abort/timeout) → error.raised says abort, never a guessed exit code', () => {
    const pair = bashToolAfter({ command: 'bun test --timeout=1' }, { output: '', exit: null });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(payloadOf(events[0]!)).toMatchObject({ exit_code: null });
    expect(payloadOf(events[1]!)).toMatchObject({
      origin: 'terminal',
      message: 'command failed (aborted or timed out)',
    });
  });

  test('bash without a command arg is a counted drop', () => {
    const pair = bashToolAfter({ command: '' }, { output: '', exit: 0 });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(
      { ...pair.input, args: {} },
      pair.output,
      CALL,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'bash_missing_command', count: 1 }]);
  });

  test('a giant output is clamped into the digest budget (never dead-lettered)', () => {
    const pair = bashToolAfter({ command: 'cat huge.log' }, { output: 'x'.repeat(50_000), exit: 0 });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(String(payloadOf(events[0]!)['output_digest']).length).toBeLessThanOrEqual(2000);
    expect(String(payloadOf(events[0]!)['output_digest'])).toContain('truncated');
  });
});

describe('translateToolAfter — edit and write', () => {
  test('edit → file.changed modified with the Claude baseline line math (byte-identical deltas)', () => {
    const pair = editToolAfter({
      filePath: `${FIXTURE_CWD}/packages/api/src/server.ts`,
      oldString: 'const port = 3000;',
      newString: 'const port = 7331;\nconst host = "127.0.0.1";',
    });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['file.changed']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'file.changed',
      path: 'packages/api/src/server.ts',
      change: 'modified',
      lines_removed: 1,
      lines_added: 2,
    });
  });

  test('edit line counts use the Claude baseline formula (a trailing newline is a split boundary)', () => {
    const pair = editToolAfter({
      filePath: `${FIXTURE_CWD}/a.ts`,
      oldString: 'old block\n',
      newString: 'new block\n',
    });
    const { events } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(payloadOf(events[0]!)).toMatchObject({ lines_removed: 2, lines_added: 2 });
  });

  test('edit of a path outside the project root keeps its path untouched', () => {
    const pair = editToolAfter({ filePath: '/etc/hosts', oldString: 'a', newString: 'b' });
    const { events } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(payloadOf(events[0]!)).toMatchObject({ path: '/etc/hosts', change: 'modified' });
  });

  test('edit without filePath is a counted drop', () => {
    const pair = editToolAfter({ filePath: '', oldString: 'a', newString: 'b' });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'edit_missing_file_path', count: 1 }]);
  });

  test('write with exists:false → file.changed created with lines_added (the create signal)', () => {
    const pair = writeToolAfter({ filePath: `${FIXTURE_CWD}/docs/notes.md`, content: 'a\nb\n' }, { exists: false });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['file.changed']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'file.changed',
      path: 'docs/notes.md',
      change: 'created',
      lines_added: 3, // the Claude baseline formula: 'a\nb\n' splits into 3
    });
  });

  test('write over an existing file → modified with NO line deltas (never guessed)', () => {
    const pair = writeToolAfter({ filePath: `${FIXTURE_CWD}/docs/notes.md`, content: 'a\nb\n' }, { exists: true });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(payloadOf(events[0]!)).toMatchObject({ path: 'docs/notes.md', change: 'modified' });
    expect(payloadOf(events[0]!)).not.toHaveProperty('lines_added');
    expect(payloadOf(events[0]!)).not.toHaveProperty('lines_removed');
  });

  test('write with missing metadata falls back to modified (the signal is absent, not false)', () => {
    const pair = writeToolAfter({ filePath: `${FIXTURE_CWD}/docs/new.md`, content: 'a' }, { exists: true });
    const { events } = createOpenCodeTranslator(BASE).translateToolAfter(
      pair.input,
      { ...pair.output, metadata: {} },
      CALL,
    );
    expect(payloadOf(events[0]!)).toMatchObject({ change: 'modified' });
  });
});

describe('translateToolAfter — tool dispatch and the drop ledger', () => {
  test('our own memory-tool traffic is a counted drop, whatever the tool name', () => {
    for (const tool of ['onememory_memory_search', 'mcp__onememory__memory_store', 'Memory_Onememory_Search']) {
      const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(
        { tool, sessionID: FIXTURE_SESSION_ID, callID: 'cal_1', args: {} },
        { title: 'MCP', output: '', metadata: {} },
        CALL,
      );
      expect(events).toEqual([]);
      expect(dropped).toEqual([{ reason: 'own_memory_tool', count: 1 }]);
    }
  });

  test('unsubscribed tools (read/grep/glob) are counted drops', () => {
    for (const tool of ['read', 'grep', 'glob', 'list']) {
      const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(
        { tool, sessionID: FIXTURE_SESSION_ID, callID: 'cal_1', args: {} },
        { title: tool, output: '', metadata: {} },
        CALL,
      );
      expect(events).toEqual([]);
      expect(dropped).toEqual([{ reason: `unsubscribed_tool:${tool}`, count: 1 }]);
    }
  });

  test('a malformed tool-after input is a counted drop', () => {
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter({ tool: 'bash' }, {}, CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'malformed_tool_after_input', count: 1 }]);
  });

  test('a malformed tool-after output is a counted drop', () => {
    const pair = bashToolAfter({ command: 'ls' }, { output: '', exit: 0 });
    const { events, dropped } = createOpenCodeTranslator(BASE).translateToolAfter(pair.input, { title: 1 }, CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'malformed_tool_after_output', count: 1 }]);
  });
});

describe('translateChatMessage — the user-message channel', () => {
  test('a user message → conversation.message (role user)', () => {
    const pair = chatMessageHook('Why does the build fail on darwin?');
    const { events, dropped } = createOpenCodeTranslator(BASE).translateChatMessage(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['conversation.message']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'conversation.message',
      role: 'user',
      content: 'Why does the build fail on darwin?',
    });
    expect(scopeOf(events[0]!)).toMatchObject({ session_id: FIXTURE_SESSION_ID, agent_id: 'opencode' });
  });

  test('a leading imperative remember request → exactly ONE explicit.remember, never both', () => {
    const pair = chatMessageHook('Remember that we settled on PGlite for the embedded profile');
    const { events, dropped } = createOpenCodeTranslator(BASE).translateChatMessage(pair.input, pair.output, CALL);
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['explicit.remember']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'explicit.remember',
      content: 'we settled on PGlite for the embedded profile',
    });
  });

  test('multiple text parts are concatenated with a newline', () => {
    const pair = chatMessageHook('first');
    const output = {
      ...pair.output,
      parts: [
        ...pair.output.parts!,
        { ...pair.output.parts![0]!, id: 'prt_2', text: 'second' },
      ],
    };
    const { events } = createOpenCodeTranslator(BASE).translateChatMessage(pair.input, output, CALL);
    expect(payloadOf(events[0]!)).toMatchObject({ role: 'user', content: 'first\nsecond' });
  });

  test('the hook claims the user message id: its parts are never double-captured', () => {
    const translator = createOpenCodeTranslator(BASE);
    const pair = chatMessageHook('hello from the user');
    const claimed = translator.translateChatMessage(pair.input, pair.output, CALL);
    expect(claimed.events).toHaveLength(1);

    const partStream = translator.translateEvent(
      eventHookInput(
        textPartUpdatedEvent('hello from the user', { messageID: FIXTURE_USER_MESSAGE_ID, sessionID: FIXTURE_SESSION_ID }),
      ),
      CALL,
    );
    expect(partStream.events).toEqual([]);
    expect(partStream.dropped).toEqual([{ reason: 'user_message_via_chat_hook', count: 1 }]);

    // The assistant's parts on the same session keep flowing (only the claimed id is dropped).
    const assistant = translator.translateEvent(eventHookInput(textPartUpdatedEvent('assistant reply')), CALL);
    expect(assistant.dropped).toEqual([]);
    expect(kinds(assistant.events)).toEqual(['conversation.message']);
    expect(payloadOf(assistant.events[0]!)).toMatchObject({ role: 'assistant' });
  });

  test('a malformed chat input is a counted drop', () => {
    const pair = chatMessageHook('hello');
    const { events, dropped } = createOpenCodeTranslator(BASE).translateChatMessage({}, pair.output, CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'malformed_chat_input', count: 1 }]);
  });

  test('a malformed chat output is a counted drop', () => {
    const pair = chatMessageHook('hello');
    const { events, dropped } = createOpenCodeTranslator(BASE).translateChatMessage(pair.input, {}, CALL);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'malformed_chat_output', count: 1 }]);
  });
});

describe('translate — boundaries', () => {
  test('every translated event passes core envelope validation', () => {
    const translator = createOpenCodeTranslator(BASE);
    const bashPair = bashToolAfter({ command: 'bun test' }, { output: 'ok', exit: 0 });
    const editPair = editToolAfter({ filePath: `${FIXTURE_CWD}/a.ts`, oldString: 'a', newString: 'b' });
    const writePair = writeToolAfter({ filePath: `${FIXTURE_CWD}/b.ts`, content: 'x' }, { exists: false });
    const chatPair = chatMessageHook('remember that we ship on Fridays');
    const everything = [
      ...translator.translateEvent(eventHookInput(sessionCreatedEvent()), CALL).events,
      ...translator.translateEvent(eventHookInput(sessionIdleEvent()), CALL).events,
      ...translator.translateEvent(eventHookInput(textPartUpdatedEvent('assistant text')), CALL).events,
      ...translator.translateEvent(
        eventHookInput(toolPartUpdatedEvent({ status: 'error', error: 'nope' })),
        CALL,
      ).events,
      ...translator.translateToolAfter(bashPair.input, bashPair.output, CALL).events,
      ...translator.translateToolAfter(editPair.input, editPair.output, CALL).events,
      ...translator.translateToolAfter(writePair.input, writePair.output, CALL).events,
      ...translator.translateChatMessage(chatPair.input, chatPair.output, CALL).events,
    ];
    // One event per subscribed signal: session.start, session.end, assistant message, tool
    // error, bash terminal.output, edit file.changed, write file.changed, chat user message.
    expect(everything).toHaveLength(8);
    for (const event of everything) {
      expect(validateOnememoryEvent(event).ok).toBe(true);
      expect(event.source.runtime).toBe('opencode');
      expect(event.occurred_at).toBe(NOW.toISOString());
      expect(event.ingested_at).toBe(NOW.toISOString());
    }
  });

  test('the injected clock sets ingested_at without collapsing occurred_at', () => {
    const pair = chatMessageHook('hello');
    const { events } = createOpenCodeTranslator(BASE).translateChatMessage(pair.input, pair.output, {
      now: new Date('2026-10-06T10:30:00.000Z'),
    });
    expect(events[0]!.ingested_at).toBe('2026-10-06T10:30:00.000Z');
    expect(events[0]!.occurred_at).toBe('2026-10-06T10:30:00.000Z');
  });

  test('an omitted projectId keeps the scope minimal (never an invented id)', () => {
    const pair = bashToolAfter({ command: 'ls' }, { output: '', exit: 0 });
    const { events } = createOpenCodeTranslator({ projectRoot: FIXTURE_CWD }).translateToolAfter(
      pair.input,
      pair.output,
      CALL,
    );
    expect(scopeOf(events[0]!)).not.toHaveProperty('project_id');
    expect(scopeOf(events[0]!)).toMatchObject({ session_id: FIXTURE_SESSION_ID, agent_id: 'opencode' });
  });

  test('a custom agentId rides the scope (the plugin passes the configured one)', () => {
    const pair = bashToolAfter({ command: 'ls' }, { output: '', exit: 0 });
    const { events } = createOpenCodeTranslator({ ...BASE, agentId: 'build' }).translateToolAfter(
      pair.input,
      pair.output,
      CALL,
    );
    expect(scopeOf(events[0]!)).toMatchObject({ agent_id: 'build' });
  });

  test('assistant message ids differ from user ones (the claim set is per message, not per session)', () => {
    const translator = createOpenCodeTranslator(BASE);
    const chatPair = chatMessageHook('user turn');
    translator.translateChatMessage(chatPair.input, chatPair.output, CALL);
    const assistantPart = translator.translateEvent(
      eventHookInput(textPartUpdatedEvent('assistant turn', { messageID: FIXTURE_ASSISTANT_MESSAGE_ID })),
      CALL,
    );
    expect(assistantPart.dropped).toEqual([]);
    expect(kinds(assistantPart.events)).toEqual(['conversation.message']);
  });
});
