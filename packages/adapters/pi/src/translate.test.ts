/**
 * Translation tests: every row of the mapping table in `translate.ts`, plus the counted drops.
 * All fixtures come from `testing.ts` (verified Pi wire shapes).
 */

import { describe, expect, test } from 'bun:test';

import { validateOnememoryEvent } from '@onememory-ai/core';

import type { GitCommitFacts } from './git';
import { translatePiEvent } from './translate';
import {
  assistantMessageEndEvent,
  bashToolResultEvent,
  editToolResultEvent,
  sessionShutdownEvent,
  sessionStartEvent,
  userMessageEndEvent,
  writeToolResultEvent,
  FIXTURE_CWD,
} from './testing';

const BASE_CONTEXT = { cwd: FIXTURE_CWD, projectId: '01900000-0000-7000-8000-000000000009', now: new Date('2026-10-06T09:00:00.000Z') };

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

describe('translatePiEvent — session lifecycle', () => {
  test('session_start (any reason) → session.start with cwd and reason in the summary', () => {
    for (const reason of ['startup', 'reload', 'new', 'resume', 'fork'] as const) {
      const { events, dropped } = translatePiEvent(sessionStartEvent({ reason }), BASE_CONTEXT);
      expect(dropped).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('session.start');
      expect(payloadOf(events[0]!)).toMatchObject({ cwd: FIXTURE_CWD, summary: `pi session start (reason: ${reason})` });
    }
  });

  test('session_start without cwd is a counted drop, not an invented path', () => {
    const { events, dropped } = translatePiEvent(sessionStartEvent(), {});
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'session_start_missing_cwd', count: 1 }]);
  });

  test('session_shutdown (any reason) → session.end', () => {
    for (const reason of ['quit', 'reload', 'new', 'resume', 'fork'] as const) {
      const { events } = translatePiEvent(sessionShutdownEvent({ reason }), BASE_CONTEXT);
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('session.end');
      expect(payloadOf(events[0]!)).toMatchObject({ cwd: FIXTURE_CWD });
    }
  });
});

describe('translatePiEvent — conversation', () => {
  test('user message → conversation.message (role user)', () => {
    const { events, dropped } = translatePiEvent(
      userMessageEndEvent('Why does the build fail on darwin?'),
      BASE_CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(events).toHaveLength(1);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'conversation.message',
      role: 'user',
      content: 'Why does the build fail on darwin?',
    });
  });

  test('the message timestamp becomes occurred_at while ingested_at stays the clock', () => {
    const { events } = translatePiEvent(
      userMessageEndEvent('later message', { timestamp: '2026-10-06T09:01:00.000Z' }),
      BASE_CONTEXT,
    );
    expect(events[0]!.occurred_at).toBe('2026-10-06T09:01:00.000Z');
    expect(events[0]!.ingested_at).toBe('2026-10-06T09:00:00.000Z');
  });

  test('leading "remember that …" → exactly one explicit.remember (never also a message)', () => {
    const { events, dropped } = translatePiEvent(
      userMessageEndEvent('Remember that we settled on PGlite for the embedded profile'),
      BASE_CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['explicit.remember']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'explicit.remember',
      content: 'we settled on PGlite for the embedded profile',
    });
  });

  test('conversational "do you remember yesterday?" stays a conversation.message', () => {
    const { events } = translatePiEvent(
      userMessageEndEvent('Do you remember yesterday when the tests were red?'),
      BASE_CONTEXT,
    );
    expect(kinds(events)).toEqual(['conversation.message']);
  });

  test('assistant message → conversation.message (role assistant)', () => {
    const { events, dropped } = translatePiEvent(
      assistantMessageEndEvent('The failure is the darwin lib search path; fixed in 91d2b89.'),
      BASE_CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'conversation.message',
      role: 'assistant',
      content: 'The failure is the darwin lib search path; fixed in 91d2b89.',
    });
  });

  test('our own injected context is dropped, never re-ingested as user prose', () => {
    const { events, dropped } = translatePiEvent(
      userMessageEndEvent('[onememory:project-memory-context]\n\n## Decisions\n- use PGlite'),
      BASE_CONTEXT,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'own_injection', count: 1 }]);
  });

  test('system / toolResult / custom roles are counted drops, not conversation prose', () => {
    for (const role of ['system', 'toolResult', 'artifact']) {
      const { events, dropped } = translatePiEvent(
        { type: 'message_end', message: { role, content: [{ type: 'text', text: 'no' }] } },
        BASE_CONTEXT,
      );
      expect(events).toEqual([]);
      expect(dropped).toEqual([{ reason: `message_role_not_captured:${role}`, count: 1 }]);
    }
  });

  test('plain-string content is tolerated (providers normalize differently)', () => {
    const { events } = translatePiEvent(
      { type: 'message_end', message: { role: 'user', content: 'plain string prompt' } },
      BASE_CONTEXT,
    );
    expect(payloadOf(events[0]!)).toMatchObject({ role: 'user', content: 'plain string prompt' });
  });
});

describe('translatePiEvent — tool results', () => {
  test('bash, exit 0 → terminal.output with exit_code 0 and the combined output digest', () => {
    const { events, dropped } = translatePiEvent(
      bashToolResultEvent({ command: 'bun test packages/adapters/pi' }, { output: '12 pass\n0 fail', exitCode: 0 }),
      BASE_CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['terminal.output']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'terminal.output',
      command: 'bun test packages/adapters/pi',
      exit_code: 0,
      output_digest: '12 pass\n0 fail',
      shell: 'bash',
    });
  });

  test('bash, non-zero exit → terminal.output AND error.raised (the resolution-pair family)', () => {
    const { events } = translatePiEvent(
      bashToolResultEvent({ command: 'bun test' }, { output: 'error: cannot find module', exitCode: 1 }),
      BASE_CONTEXT,
    );
    expect(kinds(events)).toEqual(['terminal.output', 'error.raised']);
    expect(payloadOf(events[0]!)).toMatchObject({ exit_code: 1 });
    expect(payloadOf(events[1]!)).toMatchObject({
      kind: 'error.raised',
      origin: 'terminal',
      message: 'error: cannot find module',
      context: 'bun test',
    });
  });

  test('bash error without structuredContent keeps exit_code null (never guessed)', () => {
    const event = bashToolResultEvent({ command: 'bun test' }, { output: 'boom', exitCode: 1 });
    delete (event as { structuredContent?: unknown }).structuredContent;
    const { events } = translatePiEvent(event, BASE_CONTEXT);
    expect(payloadOf(events[0]!)).toMatchObject({ exit_code: null });
  });

  test('bash git commit with agreeing enrichment → git.commit', () => {
    const facts: GitCommitFacts = {
      sha: '91d2b8900000000000000000000000000000000',
      authorName: 'Ada Lovelace',
      message: 'feat(pi): adapter package',
      files: ['packages/adapters/pi/src/translate.ts'],
    };
    const { events } = translatePiEvent(
      bashToolResultEvent(
        { command: 'git commit -m "feat(pi): adapter package"' },
        { output: '[main 91d2b89] feat(pi): adapter package\n 1 file changed, 2 insertions(+)', exitCode: 0 },
      ),
      { ...BASE_CONTEXT, gitCommitFacts: facts },
    );
    expect(kinds(events)).toEqual(['terminal.output', 'git.commit']);
    expect(payloadOf(events[1]!)).toMatchObject({
      kind: 'git.commit',
      sha: facts.sha,
      message: 'feat(pi): adapter package',
      author_name: 'Ada Lovelace',
      files: ['packages/adapters/pi/src/translate.ts'],
      stats: { files_changed: 1, insertions: 2, deletions: 0 },
    });
  });

  test('bash git commit without enrichment is a counted drop; terminal.output still flows', () => {
    const { events, dropped } = translatePiEvent(
      bashToolResultEvent(
        { command: 'git commit -m "x"' },
        { output: '[main 91d2b89] x', exitCode: 0 },
      ),
      BASE_CONTEXT,
    );
    expect(kinds(events)).toEqual(['terminal.output']);
    expect(dropped).toEqual([{ reason: 'git_commit_facts_unavailable', count: 1 }]);
  });

  test('edit → file.changed with exact line deltas from edits[]', () => {
    const { events, dropped } = translatePiEvent(
      editToolResultEvent({
        path: '/workspace/demo/packages/api/src/server.ts',
        edits: [
          { oldText: 'const port = 3000;', newText: 'const port = 7331;\nconst host = "127.0.0.1";' },
          { oldText: 'old block\nline two', newText: 'new block' },
        ],
      }),
      BASE_CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(kinds(events)).toEqual(['file.changed']);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'file.changed',
      path: 'packages/api/src/server.ts', // relativized against projectRoot
      change: 'modified',
      lines_removed: 3,
      lines_added: 3,
    });
  });

  test('write → file.changed modified with NO line deltas (no create/overwrite signal exists)', () => {
    const { events, dropped } = translatePiEvent(
      writeToolResultEvent({ path: '/workspace/demo/docs/notes.md', content: 'a\nb' }),
      BASE_CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(payloadOf(events[0]!)).toMatchObject({
      kind: 'file.changed',
      path: 'docs/notes.md',
      change: 'modified',
    });
    expect(payloadOf(events[0]!)).not.toHaveProperty('lines_added');
    expect(payloadOf(events[0]!)).not.toHaveProperty('lines_removed');
  });

  test('a failed other-tool result → error.raised with origin tool', () => {
    const { events } = translatePiEvent(
      {
        type: 'tool_result',
        toolCallId: 'call_09',
        toolName: 'mcp__github__create_issue',
        input: { title: 'x' },
        content: [{ type: 'text', text: '403: rate limited' }],
        isError: true,
      },
      BASE_CONTEXT,
    );
    expect(kinds(events)).toEqual(['error.raised']);
    expect(payloadOf(events[0]!)).toMatchObject({
      origin: 'tool',
      message: '403: rate limited',
      context: 'mcp__github__create_issue',
    });
  });

  test('successful read-only tools are counted drops (must not cost events)', () => {
    for (const toolName of ['read', 'grep', 'find', 'ls']) {
      const { events, dropped } = translatePiEvent(
        {
          type: 'tool_result',
          toolCallId: 'call_r',
          toolName,
          input: {},
          content: [{ type: 'text', text: 'contents' }],
          isError: false,
        },
        BASE_CONTEXT,
      );
      expect(events).toEqual([]);
      expect(dropped).toEqual([{ reason: `unmapped_tool:${toolName}`, count: 1 }]);
    }
  });

  test('our own memory tools are never captured', () => {
    const { events, dropped } = translatePiEvent(
      {
        type: 'tool_result',
        toolCallId: 'call_m',
        toolName: 'mcp__onememory__memory_search',
        input: { query: 'database dialect' },
        content: [{ type: 'text', text: '[]' }],
        isError: false,
      },
      BASE_CONTEXT,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'own_memory_tool', count: 1 }]);
  });

  test('nested tool calls (parentToolCallId) are captured like any other', () => {
    const { events } = translatePiEvent(
      bashToolResultEvent({ command: 'echo nested' }, { output: 'nested', exitCode: 0 }, {
        parentToolCallId: 'call_codemode_1',
      }),
      BASE_CONTEXT,
    );
    expect(kinds(events)).toEqual(['terminal.output']);
  });

  test('malformed bash input is a counted drop, never a crash', () => {
    const { events, dropped } = translatePiEvent(
      {
        type: 'tool_result',
        toolCallId: 'call_b',
        toolName: 'bash',
        input: { nope: true },
        content: [{ type: 'text', text: 'out' }],
        isError: false,
      },
      BASE_CONTEXT,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'missing_command:bash', count: 1 }]);
  });
});

describe('translatePiEvent — boundaries', () => {
  test('before_agent_start is the injection-only channel (counted, not captured)', () => {
    const { events, dropped } = translatePiEvent(
      { type: 'before_agent_start', prompt: 'fix the tests' },
      BASE_CONTEXT,
    );
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'before_agent_start_not_captured', count: 1 }]);
  });

  test('an unsubscribed event type is counted as not captured, not as a wire error', () => {
    const { events, dropped } = translatePiEvent({ type: 'turn_end', turnIndex: 1 }, BASE_CONTEXT);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'event_not_captured:turn_end', count: 1 }]);
  });

  test('a malformed subscribed payload is counted as a wire error', () => {
    const { events, dropped } = translatePiEvent({ type: 'session_start', reason: 'nonsense' }, BASE_CONTEXT);
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ reason: 'wire_invalid:session_start', count: 1 }]);
  });

  test('scope carries runtime pi, the session id, and the agent id', () => {
    const { events } = translatePiEvent(
      bashToolResultEvent({ command: 'true' }, { output: '', exitCode: 0 }),
      { ...BASE_CONTEXT, sessionId: 'sess_1', agentId: 'pi-build' },
    );
    expect(events[0]!.source.runtime).toBe('pi');
    expect(events[0]!.scope).toMatchObject({ session_id: 'sess_1', agent_id: 'pi-build' });
  });

  test('every translated event passes core envelope validation', () => {
    const fixtures = [
      sessionStartEvent(),
      sessionShutdownEvent(),
      userMessageEndEvent('remember that we pinned bun'),
      assistantMessageEndEvent('done'),
      bashToolResultEvent({ command: 'bun test' }, { output: 'ok', exitCode: 0 }),
      bashToolResultEvent({ command: 'bun test' }, { output: 'fail', exitCode: 1 }),
      editToolResultEvent({ path: '/workspace/demo/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
      writeToolResultEvent({ path: '/workspace/demo/b.ts', content: 'b' }),
    ];
    for (const fixture of fixtures) {
      const { events } = translatePiEvent(fixture, BASE_CONTEXT);
      for (const event of events) {
        const result = validateOnememoryEvent(event);
        expect(result.ok).toBe(true);
      }
    }
  });
});
