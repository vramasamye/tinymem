/**
 * The stateless Streamable HTTP handler (shared-server mode, gated behind explicit opt-in —
 * ADR-0010 §1): a real Request → Response roundtrip through `createMcpHandler`, against a REAL
 * embedded PGlite. NO SSE transport: these are plain stateless POSTs (no sessions, no
 * Mcp-Session-Id, no GET streams) — the 2026-07-28 protocol direction.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { McpHttpHandler } from '@modelcontextprotocol/server';

import { SERVER_INSTRUCTIONS } from './descriptions';
import { createOnememoryStreamableHttpHandler } from './http';
import { DEFAULT_TOOLS } from './schemas';
import { openMcpTestWorld, type McpTestWorld } from './testing';

let world: McpTestWorld;
let handler: McpHttpHandler;

beforeEach(async () => {
  world = await openMcpTestWorld();
  handler = createOnememoryStreamableHttpHandler(world.context);
});

afterEach(async () => {
  await handler.close();
  await world.close();
});

/** POST one stateless JSON-RPC request; the SDK answers with a single `event: message` frame
 * (the Streamable HTTP POST response format — NOT an SSE transport stream). */
async function rpc(method: string, params: unknown, id: number): Promise<Record<string, unknown>> {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const match = body.match(/^data: (.+)$/m);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

describe('stateless Streamable HTTP handler (shared-server mode)', () => {
  test('initialize: serverInfo, tools capability, and the instructions are on the wire', async () => {
    const result = (await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '1.0.0' },
    }, 1)) as {
      result: { serverInfo: { name: string }; capabilities: { tools: unknown }; instructions: string };
    };
    expect(result.result.serverInfo.name).toBe('onememory');
    expect(result.result.capabilities.tools).toBeDefined();
    expect(result.result.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  test('stateless by design: no session handshake is needed for tools/list', async () => {
    const result = (await rpc('tools/list', {}, 2)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(result.result.tools.map((tool) => tool.name)).toEqual([...DEFAULT_TOOLS]);
  });

  test('tools/call round-trips with structuredContent over plain HTTP', async () => {
    const stored = (await rpc(
      'tools/call',
      {
        name: 'memory_store',
        arguments: {
          content: 'The HTTP shared server stores facts for many agents.',
          type: 'semantic',
          evidence: [{ excerpt: 'http probe', locator: 'session.jsonl:99' }],
        },
      },
      3,
    )) as { result: { structuredContent: { id: string; outcome: string }; isError?: boolean } };

    expect(stored.result.isError).toBeUndefined();
    expect(stored.result.structuredContent.outcome).toBe('new');
    const id = stored.result.structuredContent.id;

    const fetched = (await rpc('tools/call', { name: 'memory_get', arguments: { id } }, 4)) as {
      result: { structuredContent: { memory: { content: string } } };
    };
    expect(fetched.result.structuredContent.memory.content).toContain('HTTP shared server');
  });

  test('isError results travel over HTTP exactly like over stdio', async () => {
    const failure = (await rpc(
      'tools/call',
      { name: 'memory_get', arguments: { id: '00000000-0000-7000-8000-000000000079' } },
      5,
    )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
    expect(failure.result.isError).toBe(true);
    expect(failure.result.structuredContent.error.code).toBe('not_found');
  });

  test('the handler never mutates per-request state: two lists from cold requests agree', async () => {
    const first = (await rpc('tools/list', {}, 6)) as { result: { tools: unknown[] } };
    const second = (await rpc('tools/list', {}, 7)) as { result: { tools: unknown[] } };
    expect(first.result.tools.length).toBe(second.result.tools.length);
    expect(first.result.tools.length).toBe(8);
  });
});
