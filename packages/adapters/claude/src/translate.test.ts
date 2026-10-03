/**
 * Translation fixtures: REAL Claude Code hook JSON shapes (copied from the official hooks
 * reference examples, verified 2026-10-03 — see mission-6.md §1 for citations) → validated
 * OnememoryEvent envelopes. Every test re-validates each produced envelope and asserts the
 * mapping lands in a family the mission-3 extractor recognizes.
 */

import { describe, expect, test } from 'bun:test';

import { eventContentHash, validateOnememoryEvent, type OnememoryEvent } from '@onememory/core';

import { translateHookInput, type TranslateContext } from './translate';

const NOW = new Date('2026-10-03T10:00:00.000Z');
const PROJECT_ID = '0195a7f0-9f5e-7a1d-bc2d-0000000000aa';
const SESSION_ID = 'abc123';

const baseContext: TranslateContext = { now: NOW, projectId: PROJECT_ID };

/** Assert every event is a valid canonical envelope with a truthful content hash. */
function expectValidEnvelope(event: OnememoryEvent): void {
  expect(validateOnememoryEvent(event).ok).toBe(true);
  expect(event.content_hash).toBe(eventContentHash(event.payload));
  expect(event.source.runtime).toBe('claude-code');
  expect(event.source.adapter_version).toBe('0.1.0');
  expect(event.scope.agent_id).toBe('claude-code');
  expect(event.redactions).toEqual([]);
}

function singleEvent(result: ReturnType<typeof translateHookInput>): OnememoryEvent {
  expect(result.events).toHaveLength(1);
  const event = result.events[0]!;
  expectValidEnvelope(event);
  return event;
}

function kindOf(event: OnememoryEvent): string {
  return event.kind;
}

// ---------------------------------------------------------------------------
// Fixtures — the documented hook payload shapes
// ---------------------------------------------------------------------------

/** PostToolUse for Bash — fields from the hooks reference's own PreToolUse example + the Bash output shape. */
const postToolUseBash = {
  session_id: SESSION_ID,
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  transcript_path: '/home/user/.claude/projects/-home-user-my-project/abc123.jsonl',
  cwd: '/home/user/my-project',
  scratchpad_dir: '/tmp/claude-1000/-home-user-my-project/abc123/scratchpad',
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: {
    command: 'npm test',
    description: 'Run test suite',
    timeout: 120000,
    run_in_background: false,
  },
  tool_response: { stdout: '87 pass, 0 fail', stderr: '', interrupted: false, isImage: false },
  tool_use_id: 'toolu_01ABC123...',
} as const;

/** PostToolUse for Write — the reference's own PostToolUse input example. */
const postToolUseWrite = {
  session_id: SESSION_ID,
  transcript_path: '/Users/u/.claude/projects/-Users-u-app/abc123.jsonl',
  cwd: '/Users/u/app',
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: '/Users/u/app/notes/todo.txt', content: 'line one\nline two' },
  tool_response: { filePath: '/Users/u/app/notes/todo.txt', type: 'create' },
  tool_use_id: 'toolu_01ABC123...',
  duration_ms: 12,
} as const;

/** PostToolUseFailure for Bash — the reference's own PostToolUseFailure input example. */
const postToolUseFailureBash = {
  session_id: SESSION_ID,
  transcript_path: '/Users/u/.claude/projects/-Users-u-app/abc123.jsonl',
  cwd: '/Users/u/app',
  permission_mode: 'default',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run test suite' },
  tool_use_id: 'toolu_01ABC123...',
  error: "Exit code 1\nError: Cannot find module 'express'",
  is_interrupt: false,
  duration_ms: 4187,
} as const;

/** SessionStart (resume) — the reference's own SessionStart input example. */
const sessionStartResume = {
  session_id: SESSION_ID,
  transcript_path: '/Users/u/.claude/projects/-Users-u-app/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd: '/Users/u/app',
  hook_event_name: 'SessionStart',
  source: 'resume',
  model: 'claude-opus-5',
  seconds_since_last_response: 5400,
  context_tokens: 182340,
  prompt_cache_likely_expired: true,
  estimated_cache_write_usd: 1.1396,
} as const;

/** SessionEnd — the reference's own SessionEnd input example. */
const sessionEndOther = {
  session_id: SESSION_ID,
  transcript_path: '/Users/u/.claude/projects/-Users-u-app/abc123.jsonl',
  cwd: '/Users/u/app',
  hook_event_name: 'SessionEnd',
  reason: 'other',
} as const;

/** Stop — the reference's own Stop input example (trimmed to the fields we map). */
const stopInput = {
  session_id: SESSION_ID,
  transcript_path: '~/.claude/projects/-Users-u-app/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd: '/Users/u/app',
  permission_mode: 'default',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: "I've completed the refactoring. Here's a summary...",
} as const;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('translation: SessionStart/SessionEnd', () => {
  test('resume start → session.start carrying the source', () => {
    const event = singleEvent(translateHookInput(sessionStartResume, baseContext));
    expect(kindOf(event)).toBe('session.start');
    expect(event.occurred_at).toBe('2026-10-03T10:00:00.000Z');
    expect(event.scope.project_id).toBe(PROJECT_ID);
    expect(event.scope.session_id).toBe(SESSION_ID);
    expect(event.payload).toEqual({
      kind: 'session.start',
      started_at: '2026-10-03T10:00:00.000Z',
      cwd: '/Users/u/app',
      summary: 'claude-code session start (source: resume)',
    });
  });

  test.each([['startup'] as const, ['resume'] as const, ['clear'] as const, ['fork'] as const])(
    'source %s → session.start',
    (source) => {
      const event = singleEvent(
        translateHookInput({ ...sessionStartResume, source }, baseContext),
      );
      expect(event.kind).toBe('session.start');
      expect((event.payload as { summary: string }).summary).toContain(source);
    },
  );

  test('source compact is context compaction, not a session start — dropped with a counted reason', () => {
    const result = translateHookInput({ ...sessionStartResume, source: 'compact' }, baseContext);
    expect(result.events).toHaveLength(0);
    expect(result.drops).toEqual([{ reason: 'session_start_compact', count: 1 }]);
  });

  test('missing cwd → counted drop (the session payload requires it)', () => {
    const { cwd: _cwd, ...withoutCwd } = sessionStartResume;
    const result = translateHookInput(withoutCwd, baseContext);
    expect(result.events).toHaveLength(0);
    expect(result.drops.map((drop) => drop.reason)).toContain('session_start_missing_cwd');
  });

  test('SessionEnd reason other → session.end', () => {
    const event = singleEvent(translateHookInput(sessionEndOther, baseContext));
    expect(kindOf(event)).toBe('session.end');
    expect(event.payload).toEqual({
      kind: 'session.end',
      ended_at: '2026-10-03T10:00:00.000Z',
      cwd: '/Users/u/app',
      summary: 'claude-code session end (reason: other)',
    });
  });

  test.each([['clear'] as const, ['resume'] as const, ['logout'] as const, ['prompt_input_exit'] as const])(
    'SessionEnd reason %s → session.end',
    (reason) => {
      const event = singleEvent(translateHookInput({ ...sessionEndOther, reason }, baseContext));
      expect((event.payload as { summary: string }).summary).toContain(reason);
    },
  );
});

// ---------------------------------------------------------------------------
// Command execution + failures
// ---------------------------------------------------------------------------

describe('translation: PostToolUse Bash', () => {
  test('successful command → terminal.output with exit code 0 (the hook fires only on success)', () => {
    const event = singleEvent(translateHookInput(postToolUseBash, baseContext));
    expect(kindOf(event)).toBe('terminal.output');
    expect(event.payload).toEqual({
      kind: 'terminal.output',
      command: 'npm test',
      exit_code: 0,
      output_digest: '87 pass, 0 fail',
      shell: 'bash',
    });
  });

  test('PowerShell tool → terminal.output with shell: powershell', () => {
    const event = singleEvent(
      translateHookInput(
        { ...postToolUseBash, tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' }, tool_response: { stdout: 'a b' } },
        baseContext,
      ),
    );
    expect(kindOf(event)).toBe('terminal.output');
    expect((event.payload as { shell: string }).shell).toBe('powershell');
  });

  test('stderr is used for the digest only when stdout is empty', () => {
    const event = singleEvent(
      translateHookInput(
        { ...postToolUseBash, tool_response: { stdout: '', stderr: 'warning: deprecated' } },
        baseContext,
      ),
    );
    expect((event.payload as { output_digest: string }).output_digest).toBe('warning: deprecated');
  });

  test('output digest is clamped to the schema max (2000)', () => {
    const long = 'x'.repeat(5000);
    const event = singleEvent(
      translateHookInput({ ...postToolUseBash, tool_response: { stdout: long } }, baseContext),
    );
    expect((event.payload as { output_digest: string }).output_digest).toHaveLength(2000);
  });

  test('background commands are dropped with a counted reason (output is not in the payload yet)', () => {
    const result = translateHookInput(
      { ...postToolUseBash, tool_input: { ...postToolUseBash.tool_input, run_in_background: true } },
      baseContext,
    );
    expect(result.events).toHaveLength(0);
    expect(result.drops).toEqual([{ reason: 'background_command', count: 1 }]);
  });

  test('interrupted responses are dropped, not misattributed as clean output', () => {
    const result = translateHookInput(
      { ...postToolUseBash, tool_response: { ...postToolUseBash.tool_response, interrupted: true } },
      baseContext,
    );
    expect(result.events).toHaveLength(0);
    expect(result.drops).toEqual([{ reason: 'interrupted_command', count: 1 }]);
  });

  test('missing command → counted drop', () => {
    const result = translateHookInput(
      { ...postToolUseBash, tool_input: { description: 'no command' } },
      baseContext,
    );
    expect(result.events).toHaveLength(0);
    expect(result.drops.map((drop) => drop.reason)).toContain('missing_command:Bash');
  });

  test('a tool with no honest mapping (Read) → counted drop, no event', () => {
    const result = translateHookInput(
      { ...postToolUseBash, tool_name: 'Read', tool_input: { file_path: '/a' } },
      baseContext,
    );
    expect(result.events).toHaveLength(0);
    expect(result.drops).toEqual([{ reason: 'unmapped_tool:Read', count: 1 }]);
  });
});

describe('translation: PostToolUseFailure', () => {
  test('failed command → terminal.output with the parsed exit code + error.raised (terminal)', () => {
    const result = translateHookInput(postToolUseFailureBash, baseContext);
    expect(result.events).toHaveLength(2);
    for (const event of result.events) expectValidEnvelope(event);
    expect(result.events.map(kindOf)).toEqual(['terminal.output', 'error.raised']);

    const [terminal, raised] = result.events as unknown as [
      { payload: Record<string, unknown> },
      { payload: Record<string, unknown> },
    ];
    expect(terminal.payload).toEqual({
      kind: 'terminal.output',
      command: 'npm test',
      exit_code: 1,
      output_digest: "Error: Cannot find module 'express'",
      shell: 'bash',
    });
    expect(raised.payload).toEqual({
      kind: 'error.raised',
      origin: 'terminal',
      message: "Error: Cannot find module 'express'",
      context: 'npm test',
    });
  });

  test('no "Exit code N" line (shell could not start) → exit code null, honest unknown', () => {
    const result = translateHookInput(
      { ...postToolUseFailureBash, error: 'sh: npm: command not found' },
      baseContext,
    );
    expect(result.events.map(kindOf)).toEqual(['terminal.output', 'error.raised']);
    const terminal = result.events[0]!;
    expect((terminal.payload as { exit_code: number | null }).exit_code).toBeNull();
    expect((result.events[1]!.payload as { message: string }).message).toBe('sh: npm: command not found');
  });

  test('missing command still yields the error.raised event (context omitted, never guessed)', () => {
    const result = translateHookInput(
      { ...postToolUseFailureBash, tool_input: {} },
      baseContext,
    );
    expect(result.events.map(kindOf)).toEqual(['error.raised']);
    expect(result.drops.map((drop) => drop.reason)).toContain('missing_command:Bash');
    const raised = result.events[0]!;
    expect(raised.payload).toEqual({
      kind: 'error.raised',
      origin: 'terminal',
      message: "Error: Cannot find module 'express'",
    });
  });

  test('non-command tool failure (WebFetch) → error.raised with origin tool', () => {
    const event = singleEvent(
      translateHookInput(
        { ...postToolUseFailureBash, tool_name: 'WebFetch', tool_input: { url: 'https://x' }, error: 'DNS lookup failed for host' },
        baseContext,
      ),
    );
    expect(kindOf(event)).toBe('error.raised');
    expect(event.payload).toEqual({
      kind: 'error.raised',
      origin: 'tool',
      message: 'DNS lookup failed for host',
      context: 'WebFetch',
    });
  });

  test('interrupts are not errors to remember — dropped with a counted reason', () => {
    const result = translateHookInput({ ...postToolUseFailureBash, is_interrupt: true }, baseContext);
    expect(result.events).toHaveLength(0);
    expect(result.drops).toEqual([{ reason: 'interrupted_failure', count: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// File edits
// ---------------------------------------------------------------------------

describe('translation: file-edit tools', () => {
  test('Write with response type "create" → file.changed created with exact line count', () => {
    const event = singleEvent(
      translateHookInput(postToolUseWrite, { ...baseContext, projectRoot: '/Users/u/app' }),
    );
    expect(kindOf(event)).toBe('file.changed');
    expect(event.payload).toEqual({
      kind: 'file.changed',
      path: 'notes/todo.txt',
      change: 'created',
      lines_added: 2,
    });
  });

  test('Write overwrite (no "create" response) → modified without guessed line deltas', () => {
    const event = singleEvent(
      translateHookInput(
        { ...postToolUseWrite, tool_response: { filePath: '/Users/u/app/notes/todo.txt', type: 'overwrite' } },
        { ...baseContext, projectRoot: '/Users/u/app' },
      ),
    );
    expect(event.payload).toEqual({ kind: 'file.changed', path: 'notes/todo.txt', change: 'modified' });
  });

  test('paths outside the project root stay absolute', () => {
    const event = singleEvent(
      translateHookInput(postToolUseWrite, { ...baseContext, projectRoot: '/Users/u/other' }),
    );
    expect((event.payload as { path: string }).path).toBe('/Users/u/app/notes/todo.txt');
  });

  test('Edit → file.changed modified with exact old/new line counts', () => {
    const event = singleEvent(
      translateHookInput(
        {
          ...postToolUseWrite,
          tool_name: 'Edit',
          tool_input: {
            file_path: '/Users/u/app/src/index.ts',
            old_string: 'const a = 1;\nconst b = 2;',
            new_string: 'const a = 2;\nconst b = 4;\nconst c = 6;',
          },
          tool_response: { filePath: '/Users/u/app/src/index.ts', type: 'edit' },
        },
        { ...baseContext, projectRoot: '/Users/u/app' },
      ),
    );
    expect(kindOf(event)).toBe('file.changed');
    expect(event.payload).toEqual({
      kind: 'file.changed',
      path: 'src/index.ts',
      change: 'modified',
      lines_removed: 2,
      lines_added: 3,
    });
  });

  test('Edit without old/new strings still reports the edit (deltas unknown, not guessed)', () => {
    const event = singleEvent(
      translateHookInput(
        {
          ...postToolUseWrite,
          tool_name: 'Edit',
          tool_input: { file_path: '/Users/u/app/src/index.ts' },
          tool_response: {},
        },
        baseContext,
      ),
    );
    expect(event.payload).toEqual({ kind: 'file.changed', path: '/Users/u/app/src/index.ts', change: 'modified' });
  });

  test('NotebookEdit → file.changed modified on the notebook path', () => {
    const event = singleEvent(
      translateHookInput(
        {
          ...postToolUseWrite,
          tool_name: 'NotebookEdit',
          tool_input: { notebook_path: '/Users/u/app/notebooks/explore.ipynb', cell_id: 'c1', edit_mode: 'replace' },
          tool_response: {},
        },
        { ...baseContext, projectRoot: '/Users/u/app' },
      ),
    );
    expect(event.payload).toEqual({
      kind: 'file.changed',
      path: 'notebooks/explore.ipynb',
      change: 'modified',
    });
  });

  test('NotebookEdit without any path field → counted drop (both spellings absent)', () => {
    const result = translateHookInput(
      {
        ...postToolUseWrite,
        tool_name: 'NotebookEdit',
        tool_input: { cell_id: 'c1' },
        tool_response: {},
      },
      baseContext,
    );
    expect(result.events).toHaveLength(0);
    expect(result.drops).toEqual([{ reason: 'notebook_edit_missing_path', count: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Stop: transcript deltas + explicit remember
// ---------------------------------------------------------------------------

describe('translation: Stop', () => {
  test('last_assistant_message → assistant conversation.message (the documented final-text field)', () => {
    const event = singleEvent(translateHookInput(stopInput, { ...baseContext, transcriptEntries: [] }));
    expect(kindOf(event)).toBe('conversation.message');
    expect(event.payload).toEqual({
      kind: 'conversation.message',
      role: 'assistant',
      content: "I've completed the refactoring. Here's a summary...",
    });
  });

  test('user deltas → user conversation.message; assistant deltas deduped against last_assistant_message', () => {
    const result = translateHookInput(stopInput, {
      ...baseContext,
      transcriptEntries: [
        { kind: 'text', role: 'user', text: 'We decided to use PostgreSQL with pgvector.', timestamp: '2026-10-03T09:55:00.000Z' },
        { kind: 'text', role: 'assistant', text: 'Running the suite now.', timestamp: '2026-10-03T09:56:00.000Z' },
        { kind: 'text', role: 'assistant', text: "I've completed the refactoring. Here's a summary...", timestamp: '2026-10-03T09:59:00.000Z' },
      ],
    });
    // The final assistant text is carried ONCE: the transcript copy is deduped against the
    // documented last_assistant_message mapping, which mints it with the hook clock.
    expect(result.events).toHaveLength(3);
    for (const event of result.events) expectValidEnvelope(event);

    const [userMessage, assistantMessage, finalMessage] = result.events as unknown as [
      { payload: Record<string, unknown>; occurred_at: string },
      { payload: Record<string, unknown> },
      { payload: Record<string, unknown> },
    ];
    expect(userMessage.payload).toEqual({
      kind: 'conversation.message',
      role: 'user',
      content: 'We decided to use PostgreSQL with pgvector.',
    });
    // Transcript timestamps become the event's occurred_at (honest event time, not delivery time).
    expect(userMessage.occurred_at).toBe('2026-10-03T09:55:00.000Z');
    expect(assistantMessage.payload).toEqual({
      kind: 'conversation.message',
      role: 'assistant',
      content: 'Running the suite now.',
    });
    expect(finalMessage.payload).toEqual({
      kind: 'conversation.message',
      role: 'assistant',
      content: "I've completed the refactoring. Here's a summary...",
    });
    expect(result.drops).toEqual([{ reason: 'stop_deduped_last_message', count: 1 }]);
  });

  test('an imperative remember utterance becomes explicit.remember, not a second conversation.message', () => {
    const result = translateHookInput(stopInput, {
      ...baseContext,
      transcriptEntries: [{ kind: 'text', role: 'user', text: 'Remember that we use bun test over jest', uuid: 'u2' }],
    });
    expect(result.events).toHaveLength(2); // the remember event + last_assistant_message
    const remember = result.events.find((event) => event.kind === 'explicit.remember');
    expect(remember).toBeDefined();
    expect(remember!.payload).toEqual({
      kind: 'explicit.remember',
      content: 'we use bun test over jest',
    });
    expect(remember!.scope.session_id).toBe(SESSION_ID);
  });

  test('a conversational "do you remember" question stays a conversation.message', () => {
    const result = translateHookInput(stopInput, {
      ...baseContext,
      transcriptEntries: [{ kind: 'text', role: 'user', text: 'Do you remember yesterday?' }],
    });
    expect(result.events.filter((event) => event.kind === 'explicit.remember')).toHaveLength(0);
    const userMessages = result.events.filter(
      (event) => event.kind === 'conversation.message' && (event.payload as { role: string }).role === 'user',
    );
    expect(userMessages).toHaveLength(1);
    expect((userMessages[0]!.payload as { content: string }).content).toBe('Do you remember yesterday?');
  });

  test('invalid transcript timestamps fall back to the hook clock, never an invalid event', () => {
    const event = singleEvent(
      translateHookInput(
        { ...stopInput, last_assistant_message: '' },
        { ...baseContext, transcriptEntries: [{ kind: 'text', role: 'user', text: 'hello', timestamp: 'yesterday-ish' }] },
      ),
    );
    expect(event.occurred_at).toBe('2026-10-03T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Commit capture
// ---------------------------------------------------------------------------

describe('translation: git commit capture', () => {
  const gitCommitPostToolUse = {
    ...postToolUseBash,
    tool_input: {
      command: 'git commit -m "feat(storage): drizzle schema and migrations"',
    },
    tool_response: {
      stdout: '[main a1b2c3d] feat(storage): drizzle schema and migrations\n 2 files changed, 120 insertions(+), 3 deletions(-)',
      stderr: '',
      interrupted: false,
      isImage: false,
    },
  } as const;

  const facts = {
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    authorName: 'Fixture Author',
    message: 'feat(storage): drizzle schema and migrations',
    files: ['packages/storage/src/schema/tables.ts', 'packages/storage/src/schema/index.ts'],
  };

  test('commit command + summary line + matching facts → git.commit', () => {
    const result = translateHookInput(gitCommitPostToolUse, { ...baseContext, gitCommitFacts: facts });
    expect(result.events.map(kindOf)).toEqual(['terminal.output', 'git.commit']);
    for (const event of result.events) expectValidEnvelope(event);
    const commit = result.events[1]!;
    expect(commit.payload).toEqual({
      kind: 'git.commit',
      sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      message: 'feat(storage): drizzle schema and migrations',
      author_name: 'Fixture Author',
      files: ['packages/storage/src/schema/tables.ts', 'packages/storage/src/schema/index.ts'],
      stats: { files_changed: 2, insertions: 120, deletions: 3 },
    });
  });

  test('no enrichment → git.commit dropped with a counted reason, the command event still flows', () => {
    const result = translateHookInput(gitCommitPostToolUse, baseContext);
    expect(result.events.map(kindOf)).toEqual(['terminal.output']);
    expect(result.drops).toEqual([{ reason: 'git_commit_facts_unavailable', count: 1, detail: 'no enrichment provided' }]);
  });

  test('enrichment error → dropped with the error detail in the reason tally', () => {
    const result = translateHookInput(gitCommitPostToolUse, {
      ...baseContext,
      gitCommitFacts: { error: 'git log failed: not a git repository' },
    });
    expect(result.events.map(kindOf)).toEqual(['terminal.output']);
    expect(result.drops[0]!.reason).toBe('git_commit_facts_unavailable');
    expect(result.drops[0]!.detail).toContain('not a git repository');
  });

  test('a git commit whose stdout carries no summary line (e.g. -q) → counted drop', () => {
    const result = translateHookInput(
      { ...gitCommitPostToolUse, tool_response: { stdout: '', stderr: '', interrupted: false } },
      { ...baseContext, gitCommitFacts: facts },
    );
    expect(result.events.map(kindOf)).toEqual(['terminal.output']);
    expect(result.drops[0]!.reason).toBe('git_commit_without_summary_output');
  });
});

// ---------------------------------------------------------------------------
// Input tolerance
// ---------------------------------------------------------------------------

describe('translation: input tolerance', () => {
  test('unknown hook events (PreToolUse) → counted drop', () => {
    const result = translateHookInput({ ...postToolUseBash, hook_event_name: 'PreToolUse' }, baseContext);
    expect(result.events).toHaveLength(0);
    expect(result.drops.map((drop) => drop.reason)).toContain('unhandled_hook_event:PreToolUse');
  });

  test('non-object and null inputs → counted drops, never a throw', () => {
    expect(translateHookInput(null, baseContext).drops[0]!.reason).toBe('invalid_input:not_an_object');
    expect(translateHookInput('junk', baseContext).drops[0]!.reason).toBe('invalid_input:not_an_object');
    expect(translateHookInput({ tool_name: 'Bash' }, baseContext).drops[0]!.reason).toBe(
      'invalid_input:missing_hook_event_name',
    );
  });

  test('SessionStart without a source violates the documented contract → counted drop', () => {
    const { source: _source, ...withoutSource } = sessionStartResume;
    const result = translateHookInput(withoutSource, baseContext);
    expect(result.events).toHaveLength(0);
    expect(result.drops[0]!.reason).toMatch(/^invalid_input:/);
  });

  test('unknown fields on the hook input are ignored (forward compatibility)', () => {
    const event = singleEvent(
      translateHookInput({ ...postToolUseBash, brand_new_field: { nested: true } }, baseContext),
    );
    expect(kindOf(event)).toBe('terminal.output');
  });

  test('no project scope is valid: unscoped events still mint', () => {
    const event = singleEvent(translateHookInput(postToolUseBash, { now: NOW, projectId: null }));
    expect(event.scope.project_id).toBeUndefined();
  });
});
