/**
 * `@onememory/adapter-opencode` internal fixtures — payloads built from VERIFIED OpenCode wire
 * shapes (the mirrors in `wire.ts`; nothing here is a real session, and no secrets are embedded —
 * AGENTS.md rule 6).
 *
 * Every fixture mirrors a documented contract (read 2026-10-06, mission 9):
 * - event payloads: `@opencode-ai/sdk@1.18.34` `dist/gen/types.gen.d.ts` — `EventSessionCreated
 *   { info: Session }`, `EventSessionIdle { sessionID }`, `EventMessagePartUpdated { part,
 *   delta? }` with `TextPart { …, synthetic?, ignored?, time?: { start, end? } }` and
 *   `ToolPart { tool, callID, state: ToolState }`;
 * - hook payloads: `@opencode-ai/plugin@1.18.34` `dist/index.d.ts` — `{ event }`,
 *   `tool.execute.after` (input `{ tool, sessionID, callID, args }`, output `{ title, output,
 *   metadata }`), `chat.message` (output `{ message: UserMessage, parts: Part[] }`);
 * - tool shapes: opencode `tool/shell.ts` (id `"bash"`, `metadata.exit: number | null`),
 *   `tool/edit.ts` (`{ filePath, oldString, newString, replaceAll? }`), `tool/write.ts`
 *   (`{ filePath, content }`, `metadata.exists`).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';

import { renderConfigForProject } from '@onememory/config';

import type { z } from 'zod';

import type {
  ChatMessageInput,
  ChatMessageOutput,
  MessagePartUpdatedEvent,
  SessionCreatedEvent,
  SessionIdleEvent,
  ToolAfterInput,
  ToolAfterOutput,
  UserMessage,
} from './wire';
import { TextPartSchema, ToolPartSchema } from './wire';
import type { IngestResponse, SessionContextResponse } from './delivery';

/** The exact wire types the part fixtures override (z.infer, never hand-rolled). */
type TextPartFixture = z.infer<typeof TextPartSchema>;
type ToolPartFixture = z.infer<typeof ToolPartSchema>;

export const FIXTURE_SESSION_ID = 'ses_01JOPENCODEFIXTURE00000';
export const FIXTURE_CWD = '/workspace/demo';
export const FIXTURE_PROJECT_ID = '01900000-0000-7000-8000-00000000000d';
export const FIXTURE_USER_MESSAGE_ID = 'msg_user_01JOPENCODEFIXTURE00';
export const FIXTURE_ASSISTANT_MESSAGE_ID = 'msg_asst_01JOPENCODEFIXTURE0';
export const FIXTURE_AGENT = 'build';

const BASE_TIME = Date.parse('2026-10-06T09:00:00.000Z');
const BASE_TIME_MS = 1_800_000_000_000;

export function sessionCreatedEvent(overrides: Partial<SessionCreatedEvent['properties']['info']> = {}): SessionCreatedEvent {
  return {
    type: 'session.created',
    properties: {
      info: {
        id: FIXTURE_SESSION_ID,
        projectID: 'prj_01JOPENCODEFIXTURE0000',
        directory: FIXTURE_CWD,
        title: 'fix the failing retrieval benchmark',
        version: 'opencode@0.18.34',
        time: { created: BASE_TIME_MS, updated: BASE_TIME_MS },
        ...overrides,
      },
    },
  };
}

export function sessionIdleEvent(overrides: Partial<SessionIdleEvent['properties']> = {}): SessionIdleEvent {
  return {
    type: 'session.idle',
    properties: { sessionID: FIXTURE_SESSION_ID, ...overrides },
  };
}

/** A completed assistant text part event (streaming done: `time.end` is set). */
export function textPartUpdatedEvent(text: string, overrides: Partial<TextPartFixture> = {}): MessagePartUpdatedEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_01JOPENCODEFIXTURE000000',
        sessionID: FIXTURE_SESSION_ID,
        messageID: FIXTURE_ASSISTANT_MESSAGE_ID,
        type: 'text',
        text,
        time: { start: BASE_TIME_MS, end: BASE_TIME_MS + 5_000 },
        ...overrides,
      },
    },
  };
}

/** A tool part event with an error state (the part channel's failure signal). */
export function toolPartUpdatedEvent(
  state: { status: 'error'; error?: string } | { status: 'pending' | 'running' | 'completed'; error?: string },
  overrides: Partial<ToolPartFixture> = {},
): MessagePartUpdatedEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_01JOPENCODEFIXTURE000001',
        sessionID: FIXTURE_SESSION_ID,
        messageID: FIXTURE_ASSISTANT_MESSAGE_ID,
        type: 'tool',
        callID: 'cal_01JOPENCODEFIXTURE00000',
        tool: 'bash',
        state,
        ...overrides,
      },
    },
  };
}

/** The `event` hook's input wrapper. */
export function eventHookInput(event: unknown): { event: unknown } {
  return { event };
}

/** A bash `tool.execute.after` pair in the verified shape (`metadata.exit`, null on abort). */
export function bashToolAfter(
  args: { command: string },
  result: { output: string; exit: number | null },
  overrides: Partial<ToolAfterInput> = {},
): { input: ToolAfterInput; output: ToolAfterOutput } {
  return {
    input: {
      tool: 'bash',
      sessionID: FIXTURE_SESSION_ID,
      callID: 'cal_01JOPENCODEFIXTURE00000',
      args,
      ...overrides,
    },
    output: {
      title: 'Bash',
      output: result.output,
      metadata: { output: result.output, exit: result.exit, truncated: false, duration: 400 },
    },
  };
}

/** An edit `tool.execute.after` pair (`Edit applied successfully.` + `metadata.filediff`). */
export function editToolAfter(
  args: { filePath: string; oldString: string; newString: string; replaceAll?: boolean },
  overrides: Partial<ToolAfterInput> = {},
): { input: ToolAfterInput; output: ToolAfterOutput } {
  return {
    input: {
      tool: 'edit',
      sessionID: FIXTURE_SESSION_ID,
      callID: 'cal_01JOPENCODEFIXTURE00001',
      args,
      ...overrides,
    },
    output: {
      title: 'Edit',
      output: 'Edit applied successfully.',
      metadata: {
        filediff: {
          file: args.filePath,
          patch: `--- ${args.filePath}\n+++ ${args.filePath}\n@@ -1,1 +1,2 @@\n-${args.oldString}\n+${args.newString}`,
          additions: args.newString.split('\n').length,
          deletions: args.oldString.split('\n').length,
        },
      },
    },
  };
}

/** A write `tool.execute.after` pair (`metadata.exists` is the create/overwrite signal). */
export function writeToolAfter(
  args: { filePath: string; content: string },
  result: { exists: boolean },
  overrides: Partial<ToolAfterInput> = {},
): { input: ToolAfterInput; output: ToolAfterOutput } {
  return {
    input: {
      tool: 'write',
      sessionID: FIXTURE_SESSION_ID,
      callID: 'cal_01JOPENCODEFIXTURE00002',
      args,
      ...overrides,
    },
    output: {
      title: 'Write',
      output: `Successfully wrote to ${args.filePath}`,
      metadata: { exists: result.exists, filepath: args.filePath },
    },
  };
}

/** A `chat.message` hook pair — the user text rides the message's parts. */
export function chatMessageHook(
  text: string,
  overrides: { input?: Partial<ChatMessageInput>; message?: Partial<UserMessage> } = {},
): { input: ChatMessageInput; output: ChatMessageOutput } {
  const message: UserMessage = {
    id: FIXTURE_USER_MESSAGE_ID,
    sessionID: FIXTURE_SESSION_ID,
    role: 'user',
    time: { created: BASE_TIME_MS },
    agent: FIXTURE_AGENT,
    ...overrides.message,
  };
  return {
    input: { sessionID: FIXTURE_SESSION_ID, agent: FIXTURE_AGENT, messageID: message.id, ...overrides.input },
    output: {
      message,
      parts: [
        {
          id: 'prt_01JOPENCODEFIXTURE000002',
          sessionID: message.sessionID,
          messageID: message.id,
          type: 'text',
          text,
          time: { start: BASE_TIME_MS, end: BASE_TIME_MS },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// The onememory project world (what discovery reads)
// ---------------------------------------------------------------------------

export interface ProjectWorld {
  root: string;
  daemonUrl: string;
}

/** Write `.onememory/` (config + project + a live-looking daemon lock) under `root`. */
export function writeOnememoryProject(root: string, daemon: { url: string; pid: number }): ProjectWorld {
  const dir = join(root, '.onememory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'onememory.yaml'), renderConfigForProject('demo'), 'utf8');
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      {
        version: 1,
        project_id: FIXTURE_PROJECT_ID,
        name: 'demo',
        root_path: root,
        created_at: new Date(BASE_TIME).toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(dir, 'daemon.json'),
    JSON.stringify(
      {
        version: 1,
        pid: daemon.pid,
        host: new URL(daemon.url).hostname,
        port: Number(new URL(daemon.url).port),
        url: daemon.url,
        started_at: new Date(BASE_TIME).toISOString(),
        version_string: 'onememory/0.1.0',
      },
      null,
      2,
    ),
    'utf8',
  );
  return { root, daemonUrl: daemon.url };
}

/** Write `.onememory/` without a daemon lock (the "capture is a no-op" state). */
export function writeProjectWithoutDaemon(root: string): ProjectWorld {
  const dir = join(root, '.onememory');
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, 'daemon.json'), { force: true });
  writeFileSync(join(dir, 'onememory.yaml'), renderConfigForProject('demo'), 'utf8');
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      {
        version: 1,
        project_id: FIXTURE_PROJECT_ID,
        name: 'demo',
        root_path: root,
        created_at: new Date(BASE_TIME).toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  return { root, daemonUrl: 'http://127.0.0.1:1' };
}

// ---------------------------------------------------------------------------
// A loopback fake of the daemon's public REST surface
// ---------------------------------------------------------------------------

export interface FakeDaemon {
  url: string;
  port: number;
  requests: Array<{ method: string; path: string; body: unknown }>;
  receivedEvents: Array<Record<string, unknown>>;
  contextText: string;
  close(): Promise<void>;
}

/**
 * POST `/v1/projects/:id/events` (content-hash duplicate detection), GET
 * `/v1/projects/:id/context`, GET `/v1/health`. Plain `node:http` so it runs identically under
 * Bun and Node LTS.
 */
export async function startFakeDaemon(
  options: { port?: number; contextText?: string; failIngest?: boolean } = {},
): Promise<FakeDaemon> {
  const requests: FakeDaemon['requests'] = [];
  const receivedEvents: FakeDaemon['receivedEvents'] = [];
  const seenHashes = new Set<string>();
  const contextText = options.contextText ?? '## Decisions\n- PostgreSQL with pgvector is the only database dialect.';

  const server: Server = await new Promise((resolve) => {
    const instance = createServer((req, res) => {
      void handle(req, res);
    });
    instance.listen(options.port ?? 0, '127.0.0.1', () => resolve(instance));
  });

  async function handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(req);
    requests.push({ method: req.method ?? 'GET', path: url.pathname, body });

    if (req.method === 'POST' && /^\/v1\/projects\/[^/]+\/events$/.test(url.pathname)) {
      if (options.failIngest === true) {
        respond(res, 500, { error: { code: 'internal', message: 'boom' } });
        return;
      }
      const events = Array.isArray((body as { events?: unknown })?.events)
        ? ((body as { events: unknown[] }).events as Array<Record<string, unknown>>)
        : [];
      const outcomes: IngestResponse['outcomes'] = events.map((event, index) => {
        const hash = typeof event['content_hash'] === 'string' ? event['content_hash'] : String(index);
        if (seenHashes.has(hash)) {
          return { index, status: 'duplicate' as const, duplicate_of: '00000000-0000-7000-8000-000000000001' };
        }
        seenHashes.add(hash);
        receivedEvents.push(event);
        return {
          index,
          status: 'stored' as const,
          event_id: typeof event['id'] === 'string' ? event['id'] : '00000000-0000-7000-8000-000000000002',
        };
      });
      respond(res, 200, {
        outcomes,
        stored: outcomes.filter((o) => o.status === 'stored').length,
        duplicates: outcomes.filter((o) => o.status === 'duplicate').length,
        excluded: 0,
        dead_lettered: 0,
        normalize_job_id: null,
        warnings: [],
      } satisfies IngestResponse);
      return;
    }

    if (req.method === 'GET' && /^\/v1\/projects\/[^/]+\/context$/.test(url.pathname)) {
      respond(res, 200, {
        project_id: FIXTURE_PROJECT_ID,
        budget: 750,
        used: 40,
        text: contextText,
        warnings: [],
      } satisfies SessionContextResponse);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      respond(res, 200, { status: 'ok' });
      return;
    }

    respond(res, 404, { error: { code: 'not_found', message: `no route ${url.pathname}` } });
  }

  function respond(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.length === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });
  }

  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    receivedEvents,
    contextText,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
