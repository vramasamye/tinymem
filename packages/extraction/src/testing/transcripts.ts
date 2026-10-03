/**
 * Test-only fixture builders (not exported from the package index).
 *
 * Synthetic but realistic agent-session transcripts: a golden session containing every pattern the
 * heuristic extractor recognizes, and a noise session containing none. Fixtures contain no secrets
 * and no real transcripts (AGENTS.md rule 6).
 */

import {
  eventContentHash,
  uuidv7,
  validateOnememoryEvent,
  type ExtractionInput,
  type EventPayload,
  type EventRuntime,
  type OnememoryEvent,
  type SourceRef,
} from '@onememory/core';

export const FIXTURE_PROJECT_ID = '01900000-0000-7000-8000-0000000000aa';
export const FIXTURE_SESSION_ID = 'sess-m3-golden';
export const FIXTURE_RUNTIME: EventRuntime = 'claude-code';

const BASE_TIME = Date.parse('2026-10-03T09:00:00.000Z');

export interface InputOptions {
  /** Seconds after the fixture base time. */
  offsetSeconds?: number;
  sessionId?: string | null;
  projectId?: string | null;
  sourceId?: string;
}

function buildEvent(
  kind: OnememoryEvent['kind'],
  payload: EventPayload,
  options: InputOptions,
): OnememoryEvent {
  const offset = options.offsetSeconds ?? 0;
  const occurred = new Date(BASE_TIME + offset * 1000).toISOString();
  const candidate = {
    id: uuidv7(),
    kind,
    occurred_at: occurred,
    ingested_at: occurred,
    source: { runtime: FIXTURE_RUNTIME, adapter_version: '1.0.0' },
    scope: {
      ...(options.projectId === null ? {} : { project_id: options.projectId ?? FIXTURE_PROJECT_ID }),
      ...(options.sessionId === null ? {} : { session_id: options.sessionId ?? FIXTURE_SESSION_ID }),
      agent_id: 'claude-code',
    },
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
  };
  const result = validateOnememoryEvent(candidate);
  if (!result.ok) {
    throw new Error(
      `fixture event (${kind}) failed validation: ${JSON.stringify(result.dead_letter.issues)}`,
    );
  }
  return result.value;
}

export function makeInput(
  kind: OnememoryEvent['kind'],
  payload: EventPayload,
  options: InputOptions = {},
): ExtractionInput {
  const sourceId = options.sourceId ?? uuidv7();
  const source: SourceRef = {
    id: sourceId,
    kind: 'conversation',
    uri: `session/${options.sessionId ?? FIXTURE_SESSION_ID}`,
    title: 'fixture session',
  };
  return { event: buildEvent(kind, payload, options), source };
}

export function makeSource(kind: SourceRef['kind'] = 'conversation', id?: string): SourceRef {
  return { id: id ?? uuidv7(), kind, uri: `fixture/${uuidv7()}` };
}

function message(
  role: 'user' | 'assistant',
  content: string,
  offsetSeconds: number,
  options: InputOptions = {},
): ExtractionInput {
  return makeInput('conversation.message', { kind: 'conversation.message', role, content }, {
    offsetSeconds,
    ...options,
  });
}

function terminal(command: string, exitCode: number | null, offsetSeconds: number, output = '') {
  return makeInput(
    'terminal.output',
    { kind: 'terminal.output', command, exit_code: exitCode, output_digest: output },
    { offsetSeconds },
  );
}

/**
 * A realistic session: a stack decision, a stated preference, an error that gets fixed by a
 * related command, a repeated command sequence, a versioned fact, a stack mention in a commit,
 * plus an unresolved error and assorted session-scoped context.
 */
export function goldenSession(): ExtractionInput[] {
  return [
    message('user', 'Let us get the storage layer decided today.', 0),
    message('user', 'We decided to use PostgreSQL with pgvector as the only database dialect.', 5),
    message('user', 'I prefer bun test over jest because it is faster.', 10),
    message('user', 'Please always run bun install before bun test in CI.', 15),
    terminal('bun install', 0, 20, 'installed 154 packages'),
    terminal('bun test', 0, 25, '87 pass, 0 fail (1.2s)'),
    message('assistant', 'Running the suite now.', 30),
    terminal('bun test', 1, 35, 'error: Cannot find module "./schema"'),
    makeInput(
      'error.raised',
      {
        kind: 'error.raised',
        origin: 'build',
        message: 'Cannot find module "./schema" imported from src/store.ts',
        context: 'bun test in packages/storage',
      },
      { offsetSeconds: 36 },
    ),
    terminal('bun install', 0, 40, 'installed 154 packages (cache hit)'),
    terminal('bun test', 0, 45, '87 pass, 0 fail (1.4s)'),
    message('assistant', 'Fixed the import path; the suite passes again.', 50),
    terminal('bunx tsc --noEmit', 0, 52, 'no errors'),
    message('user', 'We upgraded to Node 22 across all packages last week.', 55),
    makeInput(
      'git.commit',
      {
        kind: 'git.commit',
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        message: 'feat(storage): drizzle schema and migrations',
        author_name: 'Fixture Author',
        files: ['packages/storage/src/schema/tables.ts'],
        stats: { files_changed: 1, insertions: 120, deletions: 3 },
      },
      { offsetSeconds: 60 },
    ),
    makeInput(
      'error.raised',
      {
        kind: 'error.raised',
        origin: 'runtime',
        message: 'ECONNREFUSED 127.0.0.1:11434',
        context: 'embedding probe against ollama',
      },
      { offsetSeconds: 65 },
    ),
    makeInput(
      'file.changed',
      { kind: 'file.changed', path: 'packages/storage/src/vectors/embedding-index.ts', change: 'modified' },
      { offsetSeconds: 70 },
    ),
    message('user', 'Should we ship the embedded profile as experimental?', 75),
    message('assistant', 'I think the issue is the migration order, let me try a different path.', 80),
    message('user', 'Next I will wire the extract handler into the daemon.', 85),
    terminal('git status --short', 0, 90, 'clean'),
    terminal('git status --short', 0, 95, 'clean (nothing to commit)'),
    terminal('bunx tsc --noEmit', 0, 100, 'no errors (2.1s)'),
  ];
}

/** The same session with nothing worth remembering: small talk and state inspection. */
export function noiseSession(): ExtractionInput[] {
  return [
    message('user', 'Hi, how are you doing today?', 0),
    message('assistant', 'Doing well, ready to help.', 5),
    message('user', 'I always forget where I put my keys.', 10),
    message('user', 'Thanks, that makes sense.', 15),
    message('assistant', 'Sure thing.', 20),
    terminal('git status --short', 0, 25, 'clean'),
    terminal('git status --short', 0, 30, 'clean'),
    terminal('ls', 0, 35, 'packages docs'),
    terminal('ls', 0, 40, 'packages docs'),
  ];
}

/** A session with no session id: nothing can be routed to working memory. */
export function sessionlessInputs(): ExtractionInput[] {
  return [
    makeInput(
      'error.raised',
      { kind: 'error.raised', origin: 'runtime', message: 'TypeError: x is not a function' },
      { sessionId: null, offsetSeconds: 0 },
    ),
    makeInput(
      'file.changed',
      { kind: 'file.changed', path: 'src/index.ts', change: 'modified' },
      { sessionId: null, offsetSeconds: 5 },
    ),
  ];
}
