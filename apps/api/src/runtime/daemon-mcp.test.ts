/**
 * The daemon-backed MCP surface (ADR-0010 amendment 2026-10-04): `onemem serve` mounts the
 * stateless Streamable HTTP handler at /mcp over its OWN storage and retrieval engine. REST /v1
 * and MCP /mcp are therefore two views of one memory and one result cache — the cache-domain
 * claim is proven by searching FIRST (caching the empty result), writing over MCP, and searching
 * again: without the shared engine the second search would still serve the cached miss.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProjectStateSchema, renderDefaultConfigYaml, saveProjectState } from '@onememory-ai/config';

import { openRuntime, startDaemon, type DaemonHandle } from './index';

/**
 * The pre-guard fetch (the runtime.test.ts pattern): captured at import time, before any runtime
 * in this process installs the privacy guard, and used for every daemon round trip.
 */
const rawFetch = globalThis.fetch.bind(globalThis);

let handle: DaemonHandle;
let projectId: string;
let root: string;

beforeAll(async () => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-daemon-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(root, '.onememory'), { recursive: true });
  writeFileSync(join(root, '.onememory', 'onememory.yaml'), renderDefaultConfigYaml(), 'utf8');

  handle = await startDaemon({ cwd: root, env: {}, port: 0, installSignalHandlers: false, fetch: rawFetch });

  const created = (await (
    await rawFetch(`${handle.info.url}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'daemon-mcp-test', root_path: root }),
    })
  ).json()) as { id: string };
  projectId = created.id;
}, 60_000);

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

/** POST one stateless JSON-RPC request to a daemon's /mcp; parse the `data:` frame reply. */
async function rpc(method: string, params: unknown, id: number, target: DaemonHandle = handle): Promise<Record<string, unknown>> {
  const response = await rawFetch(`${target.info.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  const match = body.match(/^data: (.+)$/m);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

async function restSearch(query: string): Promise<Array<{ id: string }>> {
  const response = await rawFetch(`${handle.info.url}/v1/projects/${projectId}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { memories: Array<{ id: string }> };
  return parsed.memories;
}

describe('the daemon at /mcp — one storage, one engine with /v1', () => {
  test('initialize answers with the onememory server info over the daemon socket', async () => {
    const result = (await rpc(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'daemon-mcp-test', version: '1.0.0' },
      },
      1,
    )) as { result: { serverInfo: { name: string }; capabilities: { tools: unknown } } };
    expect(result.result.serverInfo.name).toBe('onememory');
    expect(result.result.capabilities.tools).toBeDefined();
  }, 20_000);

  test('an MCP write is visible to a REST search that ran before it (one cache domain)', async () => {
    // 1. The REST search runs FIRST and caches its (empty) result for this exact query.
    expect((await restSearch('quantum flange torque')).map((memory) => memory.id)).toEqual([]);

    // 2. The write arrives over MCP.
    const stored = (await rpc(
      'tools/call',
      {
        name: 'memory_store',
        arguments: {
          content: 'The quantum flange torque spec is 12 Nm, never more.',
          type: 'semantic',
          project_id: projectId,
          evidence: [{ excerpt: 'assembly manual, torque table', locator: 'manual.pdf#torque' }],
        },
      },
      2,
    )) as { result: { structuredContent: { id: string; outcome: string }; isError?: boolean } };
    expect(stored.result.isError).toBeUndefined();
    expect(stored.result.structuredContent.outcome).toBe('new');

    // 3. The same REST search finds it now — possible only because memory_store invalidated the
    //    shared engine cache (a second engine would still hold the empty result). The REST
    //    response rides the engine's default summary packing (no content bodies), so visibility
    //    is asserted on the id the MCP write returned.
    const found = await restSearch('quantum flange torque');
    expect(found.map((memory) => memory.id)).toContain(stored.result.structuredContent.id);
  }, 20_000);

  test('the reverse direction: a REST write is visible to an MCP search', async () => {
    const created = await rawFetch(`${handle.info.url}/v1/projects/${projectId}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Krypton widgets are painted after welding.', type: 'decision' }),
    });
    expect(created.status).toBe(201);

    const searched = (await rpc(
      'tools/call',
      {
        name: 'memory_search',
        arguments: { query: 'krypton widgets painting', project_id: projectId },
      },
      3,
    )) as { result: { structuredContent: { results: Array<{ id: string; summary: string }> } } };
    expect(searched.result.structuredContent.results.length).toBeGreaterThan(0);
  }, 20_000);
});

describe('the daemon at /mcp — the registered project is the default scope', () => {
  test('project-scoped tools work without an explicit project_id when project.json exists', async () => {
    const root = join(
      process.env.TMPDIR ?? '/tmp',
      `onemem-daemon-mcp-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(join(root, '.onememory'), { recursive: true });
    writeFileSync(join(root, '.onememory', 'onememory.yaml'), renderDefaultConfigYaml(), 'utf8');

    // Register the project and write project.json BEFORE booting the daemon: the MCP context
    // pins the default project from the loaded state at boot.
    const runtime = await openRuntime({ cwd: root, env: {}, startWorker: false });
    const project = await runtime.storage.store.createProject({ name: 'daemon-mcp-default', root_path: root });
    await runtime.close();
    saveProjectState(
      join(root, '.onememory'),
      ProjectStateSchema.parse({
        project_id: project.id,
        name: project.name,
        root_path: root,
        created_at: new Date().toISOString(),
      }),
    );

    const daemon = await startDaemon({ cwd: root, env: {}, port: 0, installSignalHandlers: false, fetch: rawFetch });
    try {
      // A write with NO project_id lands in the registered project (scope "project" resolves).
      const stored = (await rpc(
        'tools/call',
        {
          name: 'memory_store',
          arguments: {
            content: 'Default-scope writes need no project_id over HTTP.',
            type: 'semantic',
            scope: 'project',
            evidence: [{ excerpt: 'init-wiring follow-up', locator: 'daemon-mcp.test.ts:1' }],
          },
        },
        10,
        daemon,
      )) as { result: { structuredContent: { id: string; outcome: string }; isError?: boolean } };
      expect(stored.result.isError).toBeUndefined();
      expect(stored.result.structuredContent.outcome).toBe('new');

      // And memory_project_context with no project_id answers for that same project.
      const context = (await rpc('tools/call', { name: 'memory_project_context', arguments: {} }, 11, daemon)) as {
        result: { structuredContent: { project_id: string; text: string } };
      };
      expect(context.result.structuredContent.project_id).toBe(project.id);
      expect(typeof context.result.structuredContent.text).toBe('string');
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
