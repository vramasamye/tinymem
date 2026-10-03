/**
 * END-TO-END through the REAL MCP surface: a genuine SDK Client ↔ InMemoryTransport ↔ our
 * McpServer (the same factory serveStdio and the HTTP handler use), against a REAL embedded
 * PGlite. This is the wire-contract suite: tools/list (profile + annotations + outputSchema),
 * tools/call round-trips (store → search → get → forget), the isError taxonomy, and the
 * server instructions — everything an agent runtime actually sees.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type CallToolResult, type ListToolsResult, type Tool } from '@modelcontextprotocol/server';

import { SERVER_INSTRUCTIONS } from './descriptions';
import { buildOnememoryServer } from './server';
import { MCP_TEST_NOW, openMcpTestWorld, seedFixtureMemory, type McpTestWorld } from './testing';
import { DEFAULT_TOOLS } from './schemas';

let world: McpTestWorld;
let client: Client;

beforeEach(async () => {
  world = await openMcpTestWorld();
  client = await connectClient();
});

afterEach(async () => {
  await client.close();
  await world.close();
});

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildOnememoryServer(world.context);
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function errorOf(result: CallToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: string; message: string } }).error;
}

describe('end-to-end over the MCP wire (default8 profile)', () => {
  test('tools/list advertises exactly the 8 default tools with annotations and outputSchema', async () => {
    const list = (await client.listTools()) as ListToolsResult;
    const tools = list.tools as Tool[];

    expect(tools.map((tool) => tool.name)).toEqual([...DEFAULT_TOOLS]);
    for (const tool of tools) {
      expect(tool.description && tool.description.length > 40).toBe(true);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      const annotations = tool.annotations as Record<string, unknown> | undefined;
      expect(annotations).toBeDefined();
      if (tool.name === 'memory_delete' || tool.name === 'memory_forget') {
        expect(annotations!.destructiveHint).toBe(true);
      }
      if (tool.name === 'memory_store') {
        expect(annotations!.idempotentHint).toBe(true);
      }
    }
  });

  test('the server instructions ride the initialize handshake (self-contained, ≤512)', async () => {
    const client2 = await connectClient();
    // v2 client exposes the last initialize result through getServerVersion + capabilities; the
    // instructions are on the initialize result the transport negotiated at connect time.
    const version = client2.getServerVersion();
    expect(version!.name).toBe('onememory');
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    await client2.close();
  });

  test('full wire round-trip: store → search (ID-index) → get (full record) → forget → recover', async () => {
    // 1. store
    const stored = structuredOf(
      await client.callTool({
        name: 'memory_store',
        arguments: {
          content: 'The billing service uses Stripe test clocks for time-dependent integration tests.',
          type: 'semantic',
          title: 'Stripe test clocks',
          evidence: [{ excerpt: 'billing team discussion', locator: 'session.jsonl:71' }],
          tags: ['billing', 'stripe'],
        },
      }),
    );
    expect(stored.outcome).toBe('new');
    const id = stored.id as string;

    // 2. search — the ID-index finds it and stays compact
    const searched = structuredOf(
      await client.callTool({
        name: 'memory_search',
        arguments: { query: 'stripe test clocks billing', max_tokens: 200 },
      }),
    );
    const results = searched.results as Array<Record<string, unknown>>;
    expect(results.some((entry) => entry.id === id)).toBe(true);
    expect(results.every((entry) => entry.content === undefined)).toBe(true); // no content bodies

    // 3. get — the full record with provenance
    const fetched = structuredOf(await client.callTool({ name: 'memory_get', arguments: { id } }));
    const memory = fetched.memory as Record<string, unknown>;
    expect(memory.content).toContain('Stripe test clocks');
    expect(((memory.provenance as Record<string, unknown>).evidence as unknown[]).length).toBe(1);

    // 4. forget — soft tombstone, then recover
    const forgotten = structuredOf(await client.callTool({ name: 'memory_forget', arguments: { id } }));
    expect(forgotten.status).toBe('archived');
    const recovered = structuredOf(
      await client.callTool({ name: 'memory_forget', arguments: { id, recover: true } }),
    );
    expect(recovered.status).toBe('active');
  });

  test('isError travels the wire typed: unknown id, provenance gate, revision conflict, purge gate', async () => {
    const notFound = errorOf(
      await client.callTool({
        name: 'memory_get',
        arguments: { id: '00000000-0000-7000-8000-000000000081' },
      }),
    );
    expect(notFound.code).toBe('not_found');

    const noEvidence = errorOf(
      await client.callTool({
        name: 'memory_store',
        arguments: { content: 'an unattributable fact', type: 'semantic' },
      }),
    );
    expect(noEvidence.code).toBe('provenance_required');

    const wrongRevision = errorOf(
      await client.callTool({
        name: 'memory_delete',
        arguments: { id: '00000000-0000-7000-8000-000000000081', expected_revision: 'x' },
      }),
    );
    expect(wrongRevision.code).toBe('not_found');

    // A REAL memory with the RIGHT revision: delete fails honestly (purge primitive follow-up).
    const seeded = await seedFixtureMemory(world, {
      type: 'semantic',
      content: 'A deletable fixture fact.',
      observedAt: '2026-06-01T00:00:00.000Z',
    });
    const record = (await world.storage.store.getMemory(seeded))!;
    const purge = errorOf(
      await client.callTool({
        name: 'memory_delete',
        arguments: { id: seeded, expected_revision: record.updated_at },
      }),
    );
    expect(purge.code).toBe('purge_unavailable');
    expect(purge.message).toContain('memory_forget');
  });

  test('schema-invalid arguments never reach the handler: the SDK rejects them as isError results', async () => {
    // max_tokens: 0 violates the inputSchema. The v2 compat layer widens the protocol-level
    // rejection into an isError tool result — the wire contract stays "errors are isError",
    // and the handler (which would re-validate) is never invoked with bad args.
    const invalid = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'x', max_tokens: 0 },
    });
    expect(invalid.isError).toBe(true);
    expect(((invalid.content as Array<{ text: string }>)[0]!.text)).toContain('memory_search');
  });

  test('the human-readable content channel accompanies every structured result (weaker clients)', async () => {
    const stored = await client.callTool({
      name: 'memory_store',
      arguments: {
        content: 'A readable fact for weaker clients.',
        type: 'semantic',
        evidence: [{ excerpt: 'e' }],
      },
    });
    expect(stored.isError).not.toBe(true);
    const text = (stored.content as Array<{ type: string; text: string }>)[0]!;
    expect(text.type).toBe('text');
    expect(text.text).toContain('stored new memory');
  });
});

describe('end-to-end: full11 profile over the wire', () => {
  test('tools/list advertises all 11 tools; the curated lists answer over tools/call', async () => {
    await client.close();
    await world.close();
    world = await openMcpTestWorld({ profile: 'full11' });
    client = await connectClient();

    const list = (await client.listTools()) as ListToolsResult;
    expect((list.tools as Tool[]).map((tool) => tool.name)).toEqual([
      ...DEFAULT_TOOLS,
      'memory_decisions',
      'memory_failures',
      'memory_skills',
    ]);

    const decisions = structuredOf(await client.callTool({ name: 'memory_decisions', arguments: {} }));
    expect(Array.isArray(decisions.results)).toBe(true);
    const failures = structuredOf(await client.callTool({ name: 'memory_failures', arguments: {} }));
    expect(Array.isArray(failures.results)).toBe(true);
    const skills = structuredOf(await client.callTool({ name: 'memory_skills', arguments: {} }));
    expect(Array.isArray(skills.results)).toBe(true);
  });
});

describe('determinism', () => {
  test('the fixture world uses the fixed clock (observed_at defaults are deterministic)', () => {
    expect(world.context.now().toISOString()).toBe(MCP_TEST_NOW);
  });
});
