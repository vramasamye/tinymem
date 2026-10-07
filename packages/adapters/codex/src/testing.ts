/**
 * `@onememory-ai/adapter-codex/testing` — fixtures built from VERIFIED Codex wire shapes.
 *
 * Every fixture mirrors a published contract (read 2026-10-03):
 * - hook inputs: the generated command-hook schemas in the Codex repository
 *   (`codex-rs/hooks/schema/generated/*.command.input.schema.json`);
 * - the Bash tool response header (`Process exited with code N`) from
 *   `codex-rs/core/src/tools/context.rs` (`ExecCommandToolOutput::response_header`);
 * - the apply_patch directive set from `codex-rs/apply-patch`;
 * - rollout lines (`{timestamp, ordinal?, type, payload}`) from `codex-rs/rollout/src/recorder.rs`
 *   + `codex-rs/history/src/rollout_payload.rs`, with `session_meta`/`response_item` payloads from
 *   `codex-rs/protocol/src/protocol.rs` (`SessionMeta`) and `models.rs` (`ResponseItem`,
 *   `ContentItem`).
 *
 * Nothing here is a real transcript; no secrets are embedded (AGENTS.md rule 6).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';

import { renderConfigForProject } from '@onememory-ai/config';

import type {
  SessionStartHookInput,
  SessionEndHookInput,
  UserPromptSubmitHookInput,
  PostToolUseHookInput,
  StopHookInput,
} from './codex-wire';

export const FIXTURE_SESSION_ID = 'thr_9f2c1a4b7d6e';
export const FIXTURE_CWD = '/workspace/demo';
export const FIXTURE_MODEL = 'gpt-6.1-sol';
export const FIXTURE_PROJECT_ID = '01900000-0000-7000-8000-000000000c07';

const BASE_TIME = Date.parse('2026-10-03T09:00:00.000Z');

export function sessionStartHookInput(overrides: Partial<SessionStartHookInput> = {}): SessionStartHookInput {
  return {
    session_id: FIXTURE_SESSION_ID,
    transcript_path: `${FIXTURE_CWD}/.codex/rollout.jsonl`,
    cwd: FIXTURE_CWD,
    hook_event_name: 'SessionStart',
    model: FIXTURE_MODEL,
    permission_mode: 'default',
    turn_id: 'turn_0',
    source: 'startup',
    ...overrides,
  };
}

export function sessionEndHookInput(overrides: Partial<SessionEndHookInput> = {}): SessionEndHookInput {
  return {
    session_id: FIXTURE_SESSION_ID,
    transcript_path: `${FIXTURE_CWD}/.codex/rollout.jsonl`,
    cwd: FIXTURE_CWD,
    hook_event_name: 'SessionEnd',
    reason: 'other',
    ...overrides,
  };
}

export function userPromptSubmitHookInput(prompt: string, overrides: Partial<UserPromptSubmitHookInput> = {}): UserPromptSubmitHookInput {
  return {
    session_id: FIXTURE_SESSION_ID,
    transcript_path: `${FIXTURE_CWD}/.codex/rollout.jsonl`,
    cwd: FIXTURE_CWD,
    hook_event_name: 'UserPromptSubmit',
    model: FIXTURE_MODEL,
    permission_mode: 'default',
    turn_id: 'turn_1',
    prompt,
    ...overrides,
  };
}

export function postToolUseHookInput(
  tool: { name: string; input: unknown; response: unknown },
  overrides: Partial<PostToolUseHookInput> = {},
): PostToolUseHookInput {
  return {
    session_id: FIXTURE_SESSION_ID,
    transcript_path: `${FIXTURE_CWD}/.codex/rollout.jsonl`,
    cwd: FIXTURE_CWD,
    hook_event_name: 'PostToolUse',
    model: FIXTURE_MODEL,
    permission_mode: 'default',
    turn_id: 'turn_1',
    tool_name: tool.name,
    tool_use_id: 'toolu_01',
    tool_input: tool.input,
    tool_response: tool.response,
    ...overrides,
  };
}

export function stopHookInput(overrides: Partial<StopHookInput> = {}): StopHookInput {
  return {
    session_id: FIXTURE_SESSION_ID,
    transcript_path: `${FIXTURE_CWD}/.codex/rollout.jsonl`,
    cwd: FIXTURE_CWD,
    hook_event_name: 'Stop',
    model: FIXTURE_MODEL,
    permission_mode: 'default',
    turn_id: 'turn_1',
    stop_hook_active: false,
    last_assistant_message: 'The suite passes again after fixing the import path.',
    ...overrides,
  };
}

/** A Bash tool_response in the verified model-facing shape (header, then output). */
export function bashToolResponse(output: string, exitCode: number | null): string {
  const lines = [
    'Chunk ID: exec_01',
    'Wall time: 1.2345 seconds',
    ...(exitCode === null ? ['Process running with session ID 4242'] : [`Process exited with code ${exitCode}`]),
    'Output:',
    output,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rollout fixtures
// ---------------------------------------------------------------------------

function rolloutTimestamp(offsetSeconds: number): string {
  return new Date(BASE_TIME + offsetSeconds * 1000).toISOString();
}

function line(offsetSeconds: number, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp: rolloutTimestamp(offsetSeconds), type, payload });
}

export interface RolloutFixtureOptions {
  /** Inject a fake secret-bearing user message (secret-leak tests). */
  secretPrompt?: string;
}

/**
 * A realistic rollout: session meta, an injected environment-context user message (harness
 * machinery — must be skipped), a real decision-bearing user message, an assistant answer, a
 * shell call + output (with the verified exit-code header), an apply_patch call, an MCP tool
 * call + result, and records Codex's own memory pipeline ignores (event_msg, turn_context).
 */
export function goldenRollout(options: RolloutFixtureOptions = {}): string {
  const lines: string[] = [
    line(0, 'session_meta', {
      id: '019a7c0e-5b1f-7000-8000-00000000e001',
      session_id: '019a7c0e-5b1f-7000-8000-00000000e001',
      timestamp: rolloutTimestamp(0),
      cwd: FIXTURE_CWD,
      originator: 'codex_cli_rs',
      cli_version: '0.134.0',
      source: 'startup',
      model_provider: 'openai',
    }),
    line(1, 'turn_context', { cwd: FIXTURE_CWD, model: FIXTURE_MODEL, approval_policy: 'on-request' }),
    line(2, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: "<ENVIRONMENT_CONTEXT>\nworking directory: /workspace/demo\n</ENVIRONMENT_CONTEXT>" }],
    }),
    line(5, 'response_item', {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            options.secretPrompt ??
            'We decided to use PostgreSQL with pgvector as the only database dialect.',
        },
      ],
    }),
    line(10, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Running the suite now.' }],
    }),
    line(15, 'response_item', {
      type: 'function_call',
      name: 'shell',
      call_id: 'call_01',
      arguments: JSON.stringify({ command: ['bun', 'test'] }),
    }),
    line(16, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_01',
      output: bashToolResponse('error: Cannot find module "./schema"', 1),
    }),
    line(20, 'response_item', {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call_02',
      arguments: JSON.stringify({ command: ['bun', 'test'], timeout_ms: 30_000 }),
    }),
    line(21, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_02',
      output: bashToolResponse('87 pass, 0 fail (1.2s)', 0),
    }),
    line(25, 'response_item', {
      type: 'function_call',
      name: 'apply_patch',
      call_id: 'call_03',
      arguments: JSON.stringify({
        input:
          '*** Begin Patch\n*** Update File: packages/storage/src/store.ts\n@@\n+export {}\n*** Add File: packages/storage/src/README.md\n+# storage\n*** End Patch',
      }),
    }),
    line(30, 'response_item', {
      type: 'function_call',
      name: 'mcp__linter__lint',
      call_id: 'call_04',
      arguments: JSON.stringify({ path: 'src/index.ts' }),
    }),
    line(31, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_04',
      output: 'lint: 0 problems',
    }),
    line(32, 'response_item', {
      type: 'function_call',
      name: 'mcp__onememory__memory_store',
      call_id: 'call_05',
      arguments: JSON.stringify({ content: 'We use bun test.' }),
    }),
    line(35, 'event_msg', { type: 'user_message', message: 'We decided to use PostgreSQL with pgvector.' }),
    line(36, 'event_msg', { type: 'agent_message', message: 'Noted.' }),
    line(37, 'response_item', { type: 'reasoning', content: [], encrypted_content: 'opaque' }),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * MCP tool calls and results on the verified rollout wire shape (M7b). Current Codex serializes
 * an MCP `CallToolResult` as a `function_call_output` whose `output` is a content-item array
 * (text content becomes `input_text` items) or — when the tool returned `structuredContent` —
 * the serialized-JSON string (`codex-rs/protocol/src/models.rs`
 * `CallToolResult::as_function_call_output_payload`). The runtime failure status is NOT on the
 * wire (the serializer drops the internal `success` flag), so the failing `read_file` result is
 * byte-shape-identical to a success — exactly like a real rollout. Outputs arrive in reverse
 * call order (parallel calls) to pin `call_id` correlation.
 */
export function mcpToolResultsRollout(): string {
  const lines: string[] = [
    line(0, 'session_meta', {
      id: '019a7c0e-5b1f-7000-8000-00000000e002',
      session_id: '019a7c0e-5b1f-7000-8000-00000000e002',
      timestamp: rolloutTimestamp(0),
      cwd: FIXTURE_CWD,
      originator: 'codex_cli_rs',
      cli_version: '0.134.0',
      source: 'startup',
    }),
    line(2, 'response_item', {
      type: 'function_call',
      name: 'mcp__linter__lint',
      call_id: 'call_a',
      arguments: JSON.stringify({ path: 'src/index.ts' }),
    }),
    line(3, 'response_item', {
      type: 'function_call',
      name: 'mcp__files__read_file',
      call_id: 'call_b',
      arguments: JSON.stringify({ path: '../outside-root.txt' }),
    }),
    line(4, 'response_item', {
      type: 'function_call',
      name: 'mcp__search__query',
      call_id: 'call_c',
      arguments: JSON.stringify({ q: 'schema module' }),
    }),
    line(5, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_c',
      output: [
        { type: 'input_text', text: "top match: error: Cannot find module './schema' was fixed in 0.9.0" },
      ],
    }),
    line(6, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_b',
      output: [{ type: 'input_text', text: 'Error: path outside the allowed roots' }],
    }),
    line(7, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_a',
      output: [{ type: 'input_text', text: 'lint: 0 problems' }],
    }),
  ];
  return `${lines.join('\n')}\n`;
}

/** Rollout lines that must all be skipped or dropped, producing no events. */
export function noiseRollout(): string {
  return [
    line(0, 'token_usage_record', { last_turn: { input_tokens: 100 } }),
    line(1, 'event_msg', { type: 'token_count', info: { total_token_usage: {} } }),
    line(2, 'response_item', {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<SKILLS_INSTRUCTIONS>\nsample\n</SKILLS_INSTRUCTIONS>' }],
    }),
    'not json at all',
  ].join('\n');
}

/** A rollout line that is valid JSON but not a rollout record. */
export function malformedRolloutLine(): string {
  return JSON.stringify({ timestamp: rolloutTimestamp(1), payload: {} });
}

// ---------------------------------------------------------------------------
// The fake daemon + project fixtures (the same pattern as `@onememory-ai/mcp/testing`)
// ---------------------------------------------------------------------------

import type { IngestResponse, SessionContextResponse } from './delivery';

export interface WrittenProject {
  root: string;
  configDir: string;
  projectId: string;
  daemonUrl: string;
}

/**
 * Write a realistic onememory project into `root`: `.onememory/onememory.yaml` (the real
 * `onemem init` template), `.onememory/project.json` (the registered pointer), and
 * `.onememory/daemon.json` (the v1 lock pointing at the given daemon).
 */
export function writeOnememoryProject(root: string, daemon: { url: string; pid?: number }): WrittenProject {
  const projectId = FIXTURE_PROJECT_ID;
  const configDir = join(root, '.onememory');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'onememory.yaml'),
    renderConfigForProject('demo'),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'project.json'),
    `${JSON.stringify(
      {
        version: 1,
        project_id: projectId,
        name: 'demo',
        root_path: root,
        created_at: new Date(BASE_TIME).toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const url = new URL(daemon.url);
  writeFileSync(
    join(configDir, 'daemon.json'),
    `${JSON.stringify(
      {
        version: 1,
        pid: daemon.pid ?? process.pid,
        host: url.hostname,
        port: Number.parseInt(url.port, 10),
        url: daemon.url,
        started_at: new Date(BASE_TIME).toISOString(),
        version_string: '0.1.0-test',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, configDir, projectId, daemonUrl: daemon.url };
}

/** A config directory with onememory.yaml but NO registered project.json. */
export function writeConfigWithoutProject(root: string): WrittenProject {
  const configDir = join(root, '.onememory');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'onememory.yaml'), renderConfigForProject('demo'), 'utf8');
  return { root, configDir, projectId: FIXTURE_PROJECT_ID, daemonUrl: 'http://127.0.0.1:9' };
}

/** A fake onememory project WITHOUT a daemon lock (the "no daemon runs" case). */
export function writeProjectWithoutDaemon(root: string): WrittenProject {
  const projectId = FIXTURE_PROJECT_ID;
  const configDir = join(root, '.onememory');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'onememory.yaml'), renderConfigForProject('demo'), 'utf8');
  writeFileSync(
    join(configDir, 'project.json'),
    `${JSON.stringify(
      { version: 1, project_id: projectId, name: 'demo', root_path: root, created_at: new Date(BASE_TIME).toISOString() },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, configDir, projectId, daemonUrl: 'http://127.0.0.1:9' };
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeDaemon {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Bodies of accepted ingest events, in order. */
  receivedEvents: Array<Record<string, unknown>>;
  contextText: string;
  close(): Promise<void>;
}

/**
 * A loopback fake of the daemon's public REST surface (mission-13 contract): POST
 * `/v1/projects/:id/events` (with content-hash duplicate detection), GET `/v1/projects/:id/context`,
 * GET `/v1/health`. Plain `node:http` so it runs identically under Bun and Node LTS.
 */
export async function startFakeDaemon(
  options: { port?: number; contextText?: string; failIngest?: boolean; delayMs?: number } = {},
): Promise<FakeDaemon> {
  const requests: RecordedRequest[] = [];
  const receivedEvents: Array<Record<string, unknown>> = [];
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
    if (options.delayMs !== undefined && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
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
        sections: [{ kind: 'decisions', tokens: 40, text: contextText }],
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
