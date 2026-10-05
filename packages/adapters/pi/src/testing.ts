/**
 * `@onememory/adapter-pi` internal fixtures — payloads built from VERIFIED Pi wire shapes.
 *
 * Every fixture mirrors a documented contract (read 2026-10-06, mission 9):
 * - event payloads: `packages/coding-agent/src/core/extensions/types.ts` in earendil-works/pi
 *   (SessionStartEvent / SessionShutdownEvent / MessageEndEvent / ToolResultEvent);
 * - tool shapes: `src/core/tools/bash.ts` (`{command, timeout?}` in,
 *   `{output, truncated, full_output_path?, exit_code, wall_time_seconds}` structured out,
 *   `Command exited with code N` + isError on non-zero exits), `edit.ts` (`{path, edits[]}`),
 *   `write.ts` (`{path, content}`, "Successfully wrote to X").
 *
 * Nothing here is a real session; no secrets are embedded (AGENTS.md rule 6).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';

import { renderConfigForProject } from '@onememory/config';

import type {
  PiSessionStartEvent,
  PiSessionShutdownEvent,
  PiMessageEndEvent,
  PiToolResultEvent,
} from './pi-wire';
import type { IngestResponse, SessionContextResponse } from './delivery';

export const FIXTURE_SESSION_ID = 'sess_9f2c1a4b7d6e';
export const FIXTURE_CWD = '/workspace/demo';
export const FIXTURE_PROJECT_ID = '01900000-0000-7000-8000-000000000009';

const BASE_TIME = Date.parse('2026-10-06T09:00:00.000Z');

export function sessionStartEvent(
  overrides: Partial<PiSessionStartEvent> = {},
): PiSessionStartEvent {
  return { type: 'session_start', reason: 'startup', ...overrides };
}

export function sessionShutdownEvent(
  overrides: Partial<PiSessionShutdownEvent> = {},
): PiSessionShutdownEvent {
  return { type: 'session_shutdown', reason: 'quit', ...overrides };
}

export function userMessageEndEvent(text: string, overrides: Partial<PiMessageEndEvent['message']> = {}): PiMessageEndEvent {
  return {
    type: 'message_end',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: new Date(BASE_TIME).toISOString(),
      ...overrides,
    },
  };
}

export function assistantMessageEndEvent(text: string, overrides: Partial<PiMessageEndEvent['message']> = {}): PiMessageEndEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: new Date(BASE_TIME + 30_000).toISOString(),
      ...overrides,
    },
  };
}

/** A bash tool_result in the verified shape (structuredContent carries the exit code). */
export function bashToolResultEvent(
  input: { command: string },
  result: { output: string; exitCode: number },
  overrides: Partial<PiToolResultEvent> = {},
): PiToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: 'call_01',
    toolName: 'bash',
    input,
    content: [
      {
        type: 'text',
        text:
          result.exitCode === 0
            ? result.output
            : `${result.output}\n\nCommand exited with code ${result.exitCode}`,
      },
    ],
    structuredContent: {
      output: result.output,
      truncated: false,
      exit_code: result.exitCode,
      wall_time_seconds: 0.4,
    },
    isError: result.exitCode !== 0,
    ...overrides,
  };
}

export function editToolResultEvent(
  input: { path: string; edits: Array<{ oldText: string; newText: string }> },
  isError = false,
): PiToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: 'call_02',
    toolName: 'edit',
    input,
    content: [{ type: 'text', text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
    isError,
  };
}

export function writeToolResultEvent(input: { path: string; content: string }): PiToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: 'call_03',
    toolName: 'write',
    input,
    content: [{ type: 'text', text: `Successfully wrote to ${input.path}` }],
    isError: false,
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
