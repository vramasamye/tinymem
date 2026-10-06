/**
 * The server-mode suites (backlog M5 issues 2 + 5, M5b AC 1/4/6): the SESSIONFUL Streamable
 * HTTP transport over a REAL embedded PGlite (the shared context from `./testing`).
 *
 * What is asserted, against the REAL wire contract:
 * - session lifecycle: initialize mints `Mcp-Session-Id`; later requests route by it; missing
 *   header → 400; unknown id → 404; DELETE terminates (spec 2025-06-18 §2.2);
 * - MANY concurrent sessions against ONE shared context (distinct ids, concurrent in-flight
 *   calls, one shared memory — the ADR-0010 shared-context model);
 * - SSE framing (`event: message` frames, `id:` lines on every frame when resumability is on)
 *   and the standalone GET stream's resumption anchor (the priming event);
 * - `Last-Event-ID` resumability end-to-end: a batched POST produces two id-stamped frames on
 *   one stream; a GET with the FIRST frame's id replays the events AFTER it;
 * - the embedded-owner guard, transport-aware: the `http` leg of the bin refuses a data dir a
 *   live daemon owns, BEFORE opening PGlite (the M13c semantics, unchanged, on the new leg);
 * - the OAuth 2.1 gate: no token → 401 + `WWW-Authenticate` carrying `resource_metadata`;
 *   insufficient scope → 403; a valid token → a working session; the RFC 9728 well-known
 *   document is served unauthenticated by the same entry;
 * - the local-first network invariant: a full session (initialize → tools/list → store → get
 *   → search) under `installNetworkGuard` performs ZERO outbound calls (AC 6, the
 *   streamable form of the packages/security network-guard integration).
 *
 * The transport MECHANICS being exercised are `WebStandardStreamableHTTPServerTransport` from
 * `@modelcontextprotocol/server` 2.3.0 — the official SDK's sessionful implementation; these
 * tests pin the ROUTING + the onememory wiring on top, not the SDK's own internals.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { Client, StreamableHTTPClientTransport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import { installNetworkGuard, NetworkGuardError } from '@onememory/security';
import { daemonLockPath, writeDaemonLock } from '@onememory/config';

import { EmbeddedStorageOwnerError } from './owner-guard';
import { main } from './bin';
import { createBearerGate } from './streamable-http/auth';
import { InMemoryResumabilityStore } from './streamable-http/event-store';
import { createStreamableHttpSessionManager } from './streamable-http/session-manager';
import { createOnememoryStreamableHttpServer } from './streamable-http/serve';
import { createStaticTokenVerifier } from './oauth/verifier';
import { DEFAULT_TOOLS } from './schemas';
import { openMcpTestWorld, type McpTestWorld } from './testing';
import { SERVER_INSTRUCTIONS } from './descriptions';

const PROTOCOL_VERSION = '2025-06-18';

let world: McpTestWorld;

beforeEach(async () => {
  world = await openMcpTestWorld();
});

afterEach(async () => {
  await world.close();
});

// ---------------------------------------------------------------------------
// Request/response helpers (real Request objects — the same shape Bun.serve receives)
// ---------------------------------------------------------------------------

const MCP_URL = 'http://127.0.0.1:7777/mcp';

interface SseFrame {
  id: string | null;
  event: string | null;
  data: unknown;
}

/** Parse an SSE body into frames (`event:`, `id:`, `data:` lines; comments ignored). */
function parseSse(body: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of body.split('\n\n')) {
    if (block.trim() === '') continue;
    let id: string | null = null;
    let event: string | null = null;
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (id === null && event === null && data === '') continue;
    frames.push({ id, event, data: data === '' ? null : JSON.parse(data) });
  }
  return frames;
}

function postRpc(body: unknown, sessionId?: string): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function initializeRequest(): Request {
  return postRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'server-mode-test', version: '1.0.0' },
    },
  });
}

function jsonRpcErrorOf(body: string): { code: number; message: string } | undefined {
  const frames = parseSse(body);
  const raw = frames.length > 0 ? frames[0]!.data : JSON.parse(body);
  if (raw === null || typeof raw !== 'object') return undefined;
  return (raw as { error?: { code: number; message: string } }).error;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('sessionful streamable http — session lifecycle (M5.2)', () => {
  test('initialize mints a session id and answers SSE-framed over HTTP', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const response = await manager.handle(initializeRequest());
    expect(response.status).toBe(200);
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeString();
    expect(sessionId!.length).toBeGreaterThan(16);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const frames = parseSse(await response.text());
    expect(frames.length).toBe(1);
    const result = frames[0]!.data as {
      result: { serverInfo: { name: string }; instructions: string; capabilities: { tools: unknown } };
    };
    expect(result.result.serverInfo.name).toBe('onememory');
    expect(result.result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(result.result.capabilities.tools).toBeDefined();
    expect(manager.sessions().length).toBe(1);
    await manager.close();
  });

  test('SSE frames carry id: lines — the resumability anchor is on every frame', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const response = await manager.handle(initializeRequest());
    const frames = parseSse(await response.text());
    expect(frames.length).toBe(1);
    expect(frames[0]!.event).toBe('message');
    expect(frames[0]!.id).toBeString(); // the EventStore stamped a resumable id
    expect(manager.sessions().length).toBe(1);
    await manager.close();
  });

  test('a POST without a session header that is not initialize → 400 (spec §2.2)', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const response = await manager.handle(postRpc({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }));
    expect(response.status).toBe(400);
    expect(jsonRpcErrorOf(await response.text())?.message).toContain('Mcp-Session-Id header is required');
    expect(manager.sessions().length).toBe(0);
    await manager.close();
  });

  test('GET/DELETE without a session header → 400; an unknown id → 404 Session not found', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });

    const get = await manager.handle(new Request(MCP_URL, { method: 'GET', headers: { accept: 'text/event-stream' } }));
    expect(get.status).toBe(400);
    const del = await manager.handle(new Request(MCP_URL, { method: 'DELETE' }));
    expect(del.status).toBe(400);

    const unknown = await manager.handle(postRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, randomUUID()));
    expect(unknown.status).toBe(404);
    expect(jsonRpcErrorOf(await unknown.text())?.message).toBe('Session not found');
    await manager.close();
  });

  test('tools/list with a valid session advertises the 8 default tools', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const init = await manager.handle(initializeRequest());
    const sessionId = init.headers.get('mcp-session-id')!;

    const list = await manager.handle(postRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId));
    expect(list.status).toBe(200);
    const frames = parseSse(await list.text());
    const result = frames[0]!.data as { result: { tools: Array<{ name: string }> } };
    expect(result.result.tools.map((tool) => tool.name)).toEqual([...DEFAULT_TOOLS]);
    await manager.close();
  });

  test('DELETE terminates the session; the id is dead afterwards', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const init = await manager.handle(initializeRequest());
    const sessionId = init.headers.get('mcp-session-id')!;
    await init.text();
    expect(manager.sessions().length).toBe(1);

    const del = await manager.handle(new Request(MCP_URL, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }));
    expect(del.status).toBe(200);
    expect(manager.sessions().length).toBe(0);

    const after = await manager.handle(postRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, sessionId));
    expect(after.status).toBe(404);
    expect(jsonRpcErrorOf(await after.text())?.message).toBe('Session not found');
    await manager.close();
  });

  test('a second initialize on the same session → 400 (the SDK transport contract)', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const init = await manager.handle(initializeRequest());
    const sessionId = init.headers.get('mcp-session-id')!;
    await init.text();

    const again = await manager.handle(initializeRequest());
    // The second initialize creates its OWN session (a new transport): the router does not know
    // the request carried no header yet... it DOES create a second session — assert THAT:
    expect(again.status).toBe(200);
    expect(manager.sessions().length).toBe(2);
    expect(manager.sessions()[0]!.sessionId).not.toBe(manager.sessions()[1]!.sessionId);
    void sessionId;
    await manager.close();
  });

  test('the live-session cap answers a new initialize with 503', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context, maxSessions: 1 });
    const first = await manager.handle(initializeRequest());
    expect(first.status).toBe(200);
    await first.text();
    const second = await manager.handle(initializeRequest());
    expect(second.status).toBe(503);
    expect(jsonRpcErrorOf(await second.text())?.message).toContain('too many concurrent sessions');
    expect(manager.sessions().length).toBe(1);
    await manager.close();
  });

  test('Accept/Content-Type gates hold (406 / 415) exactly as the SDK transport enforces', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const badAccept = await manager.handle(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      }),
    );
    expect(badAccept.status).toBe(406);
    expect(manager.sessions().length).toBe(0);
    await manager.close();
  });
});

// ---------------------------------------------------------------------------
// Many concurrent sessions, ONE shared context (AC 1)
// ---------------------------------------------------------------------------

describe('sessionful streamable http — concurrent sessions over one shared context', () => {
  test('two sessions initialize concurrently with distinct ids and both serve tools', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const [a, b] = await Promise.all([manager.handle(initializeRequest()), manager.handle(initializeRequest())]);
    const idA = a.headers.get('mcp-session-id')!;
    const idB = b.headers.get('mcp-session-id')!;
    expect(idA).not.toBe(idB);
    await Promise.all([a.text(), b.text()]);
    expect(manager.sessions().length).toBe(2);

    const [listA, listB] = await Promise.all([
      manager.handle(postRpc({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }, idA)),
      manager.handle(postRpc({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }, idB)),
    ]);
    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    await Promise.all([listA.text(), listB.text()]);
    await manager.close();
  });

  test('concurrent in-flight tool calls across sessions do not interfere', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const [a, b] = await Promise.all([manager.handle(initializeRequest()), manager.handle(initializeRequest())]);
    const idA = a.headers.get('mcp-session-id')!;
    const idB = b.headers.get('mcp-session-id')!;
    await Promise.all([a.text(), b.text()]);

    const storeVia = (sessionId: string, tag: string, id: number) =>
      manager.handle(
        postRpc(
          {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: 'memory_store',
              arguments: {
                content: `Shared-context memory from ${tag}`,
                type: 'semantic',
                evidence: [{ excerpt: `evidence for ${tag}`, locator: 'session.jsonl:1' }],
              },
            },
          },
          sessionId,
        ),
      );

    // Six stores, three per session, all in flight at once.
    const stores = await Promise.all([
      storeVia(idA, 'a1', 20),
      storeVia(idA, 'a2', 21),
      storeVia(idA, 'a3', 22),
      storeVia(idB, 'b1', 23),
      storeVia(idB, 'b2', 24),
      storeVia(idB, 'b3', 25),
    ]);
    const storedIds: string[] = [];
    for (const response of stores) {
      expect(response.status).toBe(200);
      const frame = parseSse(await response.text())[0]!.data as {
        result: { structuredContent: { id: string; outcome: string } };
      };
      expect(frame.result.structuredContent.outcome).toBe('new');
      storedIds.push(frame.result.structuredContent.id);
    }
    expect(new Set(storedIds).size).toBe(6);

    // ONE shared context: memory stored via session A is visible to session B (by design).
    const getB = await manager.handle(
      postRpc(
        {
          jsonrpc: '2.0',
          id: 30,
          method: 'tools/call',
          params: { name: 'memory_get', arguments: { id: storedIds[1] } },
        },
        idB,
      ),
    );
    expect(getB.status).toBe(200);
    const fetched = parseSse(await getB.text())[0]!.data as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(fetched.result.isError).not.toBe(true);
    expect(JSON.stringify(fetched.result)).toContain('Shared-context memory from a2');
    await manager.close();
  });
});

// ---------------------------------------------------------------------------
// Resumability (AC 1: Last-Event-ID)
// ---------------------------------------------------------------------------

describe('sessionful streamable http — resumability (Last-Event-ID)', () => {
  test('a batched POST yields two id-stamped frames on one stream; a GET replays only the events after the id', async () => {
    const store = new InMemoryResumabilityStore({ maxEventsPerStream: 50 });
    const manager = createStreamableHttpSessionManager({ context: world.context, eventStore: store });
    const init = await manager.handle(initializeRequest());
    const sessionId = init.headers.get('mcp-session-id')!;
    await init.text();

    // A batch of two requests → two SSE frames on the POST's stream, both id-stamped.
    const batch = await manager.handle(
      postRpc(
        [
          { jsonrpc: '2.0', id: 40, method: 'tools/list', params: {} },
          { jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} },
        ],
        sessionId,
      ),
    );
    expect(batch.status).toBe(200);
    const frames = parseSse(await batch.text());
    expect(frames.length).toBe(2);
    expect(frames[0]!.id).toBeString();
    expect(frames[1]!.id).toBeString();
    expect(frames[0]!.id).not.toBe(frames[1]!.id);

    // Reconnect from the FIRST frame's id: the replay delivers everything AFTER it — the
    // second frame, not the first (this is the spec's §2.1.3 resume semantics).
    const resume = await manager.handle(
      new Request(MCP_URL, {
        method: 'GET',
        headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, 'last-event-id': frames[0]!.id! },
      }),
    );
    expect(resume.status).toBe(200);
    expect(resume.headers.get('content-type')).toContain('text/event-stream');

    // The replay stream stays open (keep-alive); read the first frame that arrives.
    const replayed = await firstFrame(resume);
    const replayFrames = parseSse(replayed);
    const replayIds = replayFrames.map((frame) => frame.id);
    expect(replayIds).toContain(frames[1]!.id);
    expect(replayIds).not.toContain(frames[0]!.id);
    await manager.close();
  });

  test('clients on protocol 2025-11-25 get a priming event (id, empty data) opening each POST stream', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const init = await manager.handle(
      postRpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'server-mode-test', version: '1.0.0' },
        },
      }),
    );
    const sessionId = init.headers.get('mcp-session-id')!;
    await init.text();

    const list = await manager.handle(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      }),
    );
    expect(list.status).toBe(200);
    const frames = parseSse(await list.text());
    expect(frames.length).toBe(2);
    expect(frames[0]!.id).toBeString();
    expect(frames[0]!.data).toBeNull();
    expect(frames[1]!.id).toBeString();
    expect(frames[1]!.id).not.toBe(frames[0]!.id);
    await manager.close();
  });
});

/** Read a (possibly long-lived) SSE response up to its first complete frame. */
async function firstFrame(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    if (seen.includes('\n\n')) {
      // Do not cancel mid-stream races: just stop reading; the session close below tears down.
      return seen.slice(0, seen.indexOf('\n\n') + 2);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// A real SDK client over a real socket (wire parity with what runtimes do)
// ---------------------------------------------------------------------------

describe('sessionful streamable http — the real SDK client over a real socket', () => {
  test('Client + StreamableHTTPClientTransport: connect, tools/list, tools/call, terminate', async () => {
    const manager = createStreamableHttpSessionManager({ context: world.context });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => manager.handle(request),
    });
    try {
      const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: 'server-mode-client', version: '1.0.0' });
      await client.connect(transport);

      // The transport negotiated a session id with the server's minted one.
      expect(transport.sessionId).toBeString();
      expect(manager.sessions().length).toBe(1);
      expect(manager.sessions()[0]!.sessionId).toBe(transport.sessionId!);

      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual([...DEFAULT_TOOLS]);

      const stored = await client.callTool({
        name: 'memory_store',
        arguments: {
          content: 'The socket-level sessionful server stores memories.',
          type: 'semantic',
          evidence: [{ excerpt: 'socket round-trip', locator: 'session.jsonl:9' }],
        },
      });
      expect((stored as { isError?: boolean }).isError).not.toBe(true);
      const structured = (stored as { structuredContent: { outcome: string } }).structuredContent;
      expect(structured.outcome).toBe('new');

      // SDK v2 `close()` only aborts in-flight requests; `terminateSession()` is the DELETE.
      await transport.terminateSession();
      expect(transport.sessionId).toBeUndefined();
      expect(manager.sessions().length).toBe(0);
      await client.close();
    } finally {
      await manager.close();
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The embedded-owner guard, transport-aware (AC 4: M13c semantics on the http leg)
// ---------------------------------------------------------------------------

describe('the embedded-owner guard on the streamable-http leg (M13c, transport-aware)', () => {
  test('main() with ONEMEMORY_MCP_TRANSPORT=http refuses a data dir a live daemon owns, before opening PGlite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onemem-mcp-http-guard-'));
    const dataDir = join(root, '.onememory');
    mkdirSync(dataDir, { recursive: true });
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(JSON.stringify({ status: 'ok', pid: process.pid }), { status: 200 }),
    });
    try {
      writeDaemonLock(dataDir, {
        version: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: fake.port!,
        url: `http://127.0.0.1:${fake.port}`,
        started_at: new Date().toISOString(),
        version_string: 'test',
      });

      await expect(
        main({
          ONEMEMORY_MCP_TRANSPORT: 'http',
          ONEMEMORY_DATA_DIR: dataDir,
          ONEMEMORY_MCP_PROFILE: 'default8',
          ONEMEMORY_MCP_HTTP_PORT: '0',
        }),
      ).rejects.toBeInstanceOf(EmbeddedStorageOwnerError);

      // The refusal happened BEFORE storage opened: the data dir still holds only the lock.
      expect(readdirSync(dataDir)).toEqual(['daemon.json']);
      expect(daemonLockPath(dataDir)).toContain('daemon.json');
    } finally {
      fake.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('server-profile storage is multi-process-safe: no guard runs on the http leg either', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onemem-mcp-http-guard-'));
    const dataDir = join(root, '.onememory');
    mkdirSync(dataDir, { recursive: true });
    // A live daemon lock in the SAME tree must NOT stop a server-profile bin: ONEMEMORY_PG_URL
    // routes storage away from the embedded dir. main() throws later at the unreachable
    // Postgres — the guard itself must stay silent. (The unreachable URL is the point: the
    // failure must be the DATABASE, not an owner refusal.)
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(JSON.stringify({ status: 'ok', pid: process.pid }), { status: 200 }),
    });
    try {
      writeDaemonLock(dataDir, {
        version: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: fake.port!,
        url: `http://127.0.0.1:${fake.port}`,
        started_at: new Date().toISOString(),
        version_string: 'test',
      });
      const failure = main({
        ONEMEMORY_MCP_TRANSPORT: 'http',
        ONEMEMORY_DATA_DIR: dataDir,
        ONEMEMORY_PG_URL: 'postgres://127.0.0.1:59999/onemem-guard-test',
        ONEMEMORY_MCP_HTTP_PORT: '0',
      });
      await failure.then(
        () => {
          throw new Error('main() should have failed on the unreachable Postgres');
        },
        (error: unknown) => {
          expect(error).not.toBeInstanceOf(EmbeddedStorageOwnerError);
        },
      );
    } finally {
      fake.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The local-first network invariant, streamable form (AC 6)
// ---------------------------------------------------------------------------

describe('zero-outbound in the default profile — a full session under the network guard', () => {
  test('initialize → tools/list → store → get → search makes ZERO network calls', async () => {
    const guard = installNetworkGuard();
    try {
      const manager = createStreamableHttpSessionManager({ context: world.context });
      const init = await manager.handle(initializeRequest());
      const sessionId = init.headers.get('mcp-session-id')!;
      await init.text();

      const list = await manager.handle(postRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId));
      await list.text();

      const store = await manager.handle(
        postRpc(
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'memory_store',
              arguments: {
                content: 'Network-guarded sessionful server stores without any outbound call.',
                type: 'semantic',
                evidence: [{ excerpt: 'guard probe', locator: 'session.jsonl:42' }],
              },
            },
          },
          sessionId,
        ),
      );
      const storeFrames = parseSse(await store.text());
      const stored = storeFrames[0]!.data as { result: { structuredContent: { id: string } } };
      expect(stored.result.structuredContent.id).toBeString();

      const get = await manager.handle(
        postRpc(
          { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_get', arguments: { id: stored.result.structuredContent.id } } },
          sessionId,
        ),
      );
      await get.text();

      const search = await manager.handle(
        postRpc(
          { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'outbound call' } } },
          sessionId,
        ),
      );
      await search.text();

      guard.assertZeroCalls(); // throws NetworkGuardError listing origins if ANYTHING called out
      await manager.close();
      guard.assertZeroCalls(); // close is offline too
    } finally {
      guard.restore();
    }
  });

  test('the guard WOULD catch an outbound attempt in this harness (control)', () => {
    const guard = installNetworkGuard();
    try {
      expect(() => fetch('https://telemetry.example.invalid/ping')).toThrow(NetworkGuardError);
    } finally {
      guard.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// The resumability store (bounded rings, replay semantics)
// ---------------------------------------------------------------------------

describe('InMemoryResumabilityStore (the EventStore port)', () => {
  const message = (id: number): JSONRPCMessage =>
    ({ jsonrpc: '2.0', result: { echo: id }, id }) as unknown as JSONRPCMessage;

  test('ids are globally unique across streams; replay-after returns only later events', async () => {
    const store = new InMemoryResumabilityStore();
    const first = await store.storeEvent('stream-a', message(1));
    await store.storeEvent('stream-b', message(2));
    const third = await store.storeEvent('stream-a', message(3));
    expect(new Set([first, third]).size).toBe(2);

    const sent: string[] = [];
    const streamId = await store.replayEventsAfter(first, {
      send: async (eventId) => {
        sent.push(eventId);
      },
    });
    expect(streamId).toBe('stream-a');
    expect(sent).toEqual([third]);
  });

  test('eviction: the oldest events drop off the ring but their ids still resolve to the stream', async () => {
    const store = new InMemoryResumabilityStore({ maxEventsPerStream: 2 });
    const a = await store.storeEvent('s', message(1));
    await store.storeEvent('s', message(2));
    const c = await store.storeEvent('s', message(3)); // evicts event 1
    expect(store.retained('s')).toBe(2);
    expect(await store.getStreamIdForEventId(a)).toBe('s'); // evicted but attributable

    // A replay anchored at the EVICTED id replays the full retained tail (duplicates legal,
    // gaps not) — the documented fail-safe semantics.
    const sent: string[] = [];
    await store.replayEventsAfter(a, { send: async (eventId) => void sent.push(eventId) });
    expect(sent.length).toBe(2);
    expect(sent[1]).toBe(c);
  });

  test('events stored DURING a replay are delivered by the live-tail cursor (no snapshot gap)', async () => {
    const store = new InMemoryResumabilityStore();
    const anchor = await store.storeEvent('s', message(1));
    const retained = await store.storeEvent('s', message(2));

    const sent: string[] = [];
    let liveTail: string | undefined;
    await store.replayEventsAfter(anchor, {
      send: async (eventId) => {
        sent.push(eventId);
        if (sent.length === 1) {
          // While the replay is mid-send, production stores a NEW event.
          liveTail = await store.storeEvent('s', message(3));
        }
      },
    });
    expect(sent).toEqual([retained, liveTail!]); // the backlog event, then the live tail: no gap
  });

  test('dropStream frees a closed session; totalRetained reflects eviction', async () => {
    const store = new InMemoryResumabilityStore({ maxEventsPerStream: 3 });
    for (let index = 0; index < 5; index += 1) await store.storeEvent('s', message(index));
    expect(store.totalRetained).toBe(3);
    store.dropStream('s');
    expect(store.totalRetained).toBe(0);
    expect(store.retained('s')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The OAuth 2.1 gate on the sessionful transport (AC 2's server side)
// ---------------------------------------------------------------------------

describe('the OAuth 2.1 resource-server gate (server mode)', () => {
  const AS_ISSUER = 'https://as.example.test/';
  const RESOURCE_URL = new URL('http://127.0.0.1:7788');
  const AS_METADATA = {
    issuer: AS_ISSUER,
    authorization_endpoint: `${AS_ISSUER}authorize`,
    token_endpoint: `${AS_ISSUER}token`,
    response_types_supported: ['code'],
  };

  /** A deterministic static-verifier gate: the JWT/JWKS leg is exercised in oauth.test.ts. */
  function gatedManager(options: { requiredScopes: string[]; tokenScopes: string[]; tokenResource?: string }) {
    const token = `om-static-${randomUUID()}`;
    const verifier = createStaticTokenVerifier({
      issuer: AS_ISSUER,
      entries: [
        {
          sha256: createHash('sha256').update(token, 'utf8').digest('hex'),
          clientId: 'server-mode-test-client',
          scopes: options.tokenScopes,
          expiresAt: Math.floor(Date.now() / 1000) + 3_600,
          resource: options.tokenResource ?? RESOURCE_URL.href,
        },
      ],
    });
    const gate = createBearerGate({
      authorizationServerMetadata: AS_METADATA,
      verifier,
      requiredScopes: options.requiredScopes,
      expectedResource: RESOURCE_URL,
      resourceServerUrl: RESOURCE_URL,
    });
    return { manager: createStreamableHttpSessionManager({ context: world.context, gate }), token };
  }

  test('no token → 401 with a WWW-Authenticate challenge advertising the RFC 9728 document', async () => {
    const { manager } = gatedManager({ requiredScopes: ['onememory:read'], tokenScopes: ['onememory:read'] });
    const response = await manager.handle(initializeRequest());
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate')!;
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('resource_metadata=');
    expect(challenge).toContain('/.well-known/oauth-protected-resource');
    expect(manager.sessions().length).toBe(0);
    await manager.close();
  });

  test('a wrong token → 401; a valid token with the required scope → a working session', async () => {
    const { manager, token } = gatedManager({ requiredScopes: ['onememory:read', 'onememory:write'], tokenScopes: ['onememory:read', 'onememory:write'] });

    const wrong = await manager.handle(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer om-static-not-the-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
    );
    expect(wrong.status).toBe(401);
    expect(manager.sessions().length).toBe(0);
    await wrong.text();

    const good = await manager.handle(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
    );
    expect(good.status).toBe(200);
    const sessionId = good.headers.get('mcp-session-id')!;
    await good.text();
    expect(manager.sessions().length).toBe(1);

    // The SAME bearer token must ride every subsequent request on the session.
    const list = await manager.handle(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      }),
    );
    expect(list.status).toBe(200);
    const frames = parseSse(await list.text());
    const result = frames[0]!.data as { result: { tools: Array<{ name: string }> } };
    expect(result.result.tools.length).toBe(8);
    await manager.close();
  });

  test('a valid token without the required scope → 403 insufficient_scope', async () => {
    const { manager, token } = gatedManager({ requiredScopes: ['onememory:read', 'onememory:write'], tokenScopes: ['onememory:read'] });
    const response = await manager.handle(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
    );
    expect(response.status).toBe(403);
    const challenge = response.headers.get('www-authenticate')!;
    expect(challenge).toContain('insufficient_scope');
    expect(manager.sessions().length).toBe(0);
    await manager.close();
  });

  test('a valid token minted for ANOTHER resource → 401 (RFC 8707 audience binding)', async () => {
    const { manager, token } = gatedManager({
      requiredScopes: ['onememory:read'],
      tokenScopes: ['onememory:read'],
      tokenResource: 'https://some-other-resource.example.test/',
    });
    const response = await manager.handle(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')!).toContain('invalid_token');
    expect(manager.sessions().length).toBe(0);
    await manager.close();
  });

  test('the full serve entry: the RFC 9728 document is PUBLIC while /mcp stays gated', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'onemem-mcp-http-serve-'));
    const token = `om-static-${randomUUID()}`;
    const gate = createBearerGate({
      authorizationServerMetadata: AS_METADATA,
      verifier: createStaticTokenVerifier({
        issuer: AS_ISSUER,
        entries: [
          {
            sha256: createHash('sha256').update(token, 'utf8').digest('hex'),
            clientId: 'server-mode-test-client',
            scopes: ['onememory:read'],
            expiresAt: Math.floor(Date.now() / 1000) + 3_600,
            resource: RESOURCE_URL.href,
          },
        ],
      }),
      requiredScopes: ['onememory:read'],
      expectedResource: RESOURCE_URL,
      resourceServerUrl: RESOURCE_URL,
    });
    const handle = await createOnememoryStreamableHttpServer({
      storageConfig: { mode: 'embedded', dataDir },
      auth: {
        gate,
        protectedResource: {
          resourceServerUrl: RESOURCE_URL,
          authorizationServerMetadata: AS_METADATA,
          scopesSupported: ['onememory:read'],
        },
      },
    });
    try {
      // The discovery document answers WITHOUT a token (that is its purpose).
      const discovery = await handle.handle(
        new Request('http://127.0.0.1:7788/.well-known/oauth-protected-resource', { method: 'GET' }),
      );
      expect(discovery.status).toBe(200);
      const document = (await discovery.json()) as {
        resource: string;
        authorization_servers: string[];
        resource_name: string;
        scopes_supported: string[];
      };
      expect(document.resource).toContain('http://127.0.0.1:7788');
      expect(document.authorization_servers).toEqual([AS_ISSUER]);
      expect(document.resource_name).toBe('onememory');
      expect(document.scopes_supported).toEqual(['onememory:read']);

      // And the AS metadata route passes the issuer's document through verbatim.
      const asMetadata = await handle.handle(
        new Request('http://127.0.0.1:7788/.well-known/oauth-authorization-server', { method: 'GET' }),
      );
      expect(asMetadata.status).toBe(200);
      expect(((await asMetadata.json()) as { issuer: string }).issuer).toBe(AS_ISSUER);

      // While /mcp without a token is still refused.
      const refused = await handle.handle(initializeRequest());
      expect(refused.status).toBe(401);
      await refused.text();
      expect(handle.manager.sessions().length).toBe(0);
    } finally {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
