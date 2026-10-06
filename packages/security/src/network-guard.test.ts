/**
 * Privacy network gate tests: zero-outbound enforcement for the `local` profile.
 * No test performs a real outbound call — the guard must block first.
 *
 * The M5b addition (bottom describe) pins the claim at the whole-server level: starting up
 * the Streamable-HTTP MCP server with the DEFAULT config — embedded PGlite + migrations, the
 * session manager, a `Bun.serve` socket bind, a full model-facing session, shutdown — records
 * ZERO outbound calls. That is the local-first invariant's "zero outbound in default config"
 * claim verified against the Streamable-HTTP startup path (the stdio/in-process form is
 * covered by the taint integration test over the same storage pipeline).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOnememoryStreamableHttpServer } from '@onememory/mcp';

import { installNetworkGuard, NetworkGuardError } from './index';

let activeGuard: { restore(): void } | null = null;

afterEach(() => {
  activeGuard?.restore();
  activeGuard = null;
});

describe('installNetworkGuard', () => {
  test('a fetch attempt throws, is recorded as origin-only, and assertZeroCalls fails', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;

    expect(() =>
      fetch('https://api.example.com/v1/data?api_key=SYNTHETIC-SECRET-1234', { method: 'POST' }),
    ).toThrow(NetworkGuardError);

    expect(guard.count).toBe(1);
    const attempt = guard.attempts[0]!;
    expect(attempt.url).toBe('https://api.example.com'); // origin only
    expect(attempt.url).not.toContain('api_key'); // taint: query string never recorded
    expect(attempt.url).not.toContain('SYNTHETIC-SECRET-1234');
    expect(attempt.method).toBe('POST');

    expect(() => guard.assertZeroCalls()).toThrow(NetworkGuardError);
    try {
      guard.assertZeroCalls();
      throw new Error('assertZeroCalls should have thrown');
    } catch (error) {
      // The report lists origins — never the path or query, so never the secret.
      expect(String(error)).toContain('https://api.example.com');
      expect(String(error)).not.toContain('SYNTHETIC-SECRET-1234');
    }
  });

  test('assertZeroCalls passes when nothing tried to call out', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;
    guard.assertZeroCalls(); // no throw
    expect(guard.count).toBe(0);
    expect(guard.attempts).toEqual([]);
  });

  test('reject mode returns a rejected promise and still records the attempt', async () => {
    const guard = installNetworkGuard({ mode: 'reject' });
    activeGuard = guard;

    await expect(fetch('http://localhost:9999/x')).rejects.toBeInstanceOf(NetworkGuardError);
    expect(guard.count).toBe(1);
    expect(guard.attempts[0]!.method).toBe('GET');
  });

  test('multiple attempts accumulate; Request-like inputs give method and origin', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;

    const requestLike = { url: 'https://cdn.example.net/a.js', method: 'GET' };
    expect(() => fetch(requestLike as unknown as Parameters<typeof fetch>[0])).toThrow(NetworkGuardError);
    expect(() => fetch('postgres://db.example.com:5432/app')).toThrow(NetworkGuardError);

    expect(guard.count).toBe(2);
    expect(guard.attempts.map((attempt) => attempt.url)).toEqual([
      'https://cdn.example.net',
      'postgres://db.example.com:5432',
    ]);
  });

  test('double install is rejected; restore returns the original fetch and is idempotent', () => {
    const original = globalThis.fetch;
    const guard = installNetworkGuard();

    expect(() => installNetworkGuard()).toThrow(NetworkGuardError);

    guard.restore();
    expect(globalThis.fetch).toBe(original);

    guard.restore(); // idempotent
    expect(globalThis.fetch).toBe(original);

    // re-installable after restore
    const second = installNetworkGuard();
    expect(() => fetch('https://x.example.org/')).toThrow(NetworkGuardError);
    second.restore();
    activeGuard = null; // both restored already
  });

  test('the patched fetch is re-entrant for callers that catch and retry', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;

    let attempts = 0;
    try {
      fetch('https://a.example.com/1');
    } catch {
      attempts += 1;
    }
    try {
      fetch('https://a.example.com/2');
    } catch {
      attempts += 1;
    }

    expect(attempts).toBe(2);
    expect(guard.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Zero-outbound in the default profile — the Streamable-HTTP server (M5b)
// ---------------------------------------------------------------------------

describe('zero-outbound in the default profile — the Streamable-HTTP MCP server', () => {
  /**
   * The default-config startup path (`onemem-mcp` with ONEMEMORY_MCP_TRANSPORT=http runs
   * exactly this: owner guard → context → session manager → Bun.serve) under the network
   * guard. Everything the local-first invariant covers happens here with the guard ACTIVE:
   * opening embedded PGlite + running migrations, building the session manager, BINDING the
   * serving socket, serving a full model-facing session (initialize → tools/list → store →
   * get → search → DELETE terminate), and shutdown.
   *
   * Requests are driven as real `Request` objects through the serve entry's `handle` — the
   * same shape `Bun.serve` receives — because the guard (correctly) blocks even loopback
   * fetch: an SDK CLIENT over the socket would be an outbound call by definition. The server
   * side, which is what the default-profile claim is about, is fully exercised.
   */
  test('startup + a full session + shutdown make zero network calls', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'onemem-guard-streamable-'));
    const guard = installNetworkGuard();
    try {
      // Default config: no auth issuer (no bearer gate), default8 profile, embedded storage.
      const server = await createOnememoryStreamableHttpServer({
        storageConfig: { mode: 'embedded', dataDir },
      });
      const socket = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => server.handle(request),
      });
      try {
        guard.assertZeroCalls(); // storage open + migrations + session manager + socket bind: offline

        // The session's data (a project) is created through the server's own storage — the
        // same lane an init flow uses; the server CONFIG stays untouched/default.
        const project = await server.context.storage.store.createProject({
          name: 'network-guard-streamable',
          root_path: dataDir,
        });

        const url = `http://127.0.0.1:${socket.port}/mcp`;
        const postRpc = (body: unknown, sessionId?: string): Request =>
          new Request(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
            },
            body: JSON.stringify(body),
          });

        const initialize = await server.handle(
          postRpc({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'network-guard-test', version: '1.0.0' },
            },
          }),
        );
        expect(initialize.status).toBe(200);
        const sessionId = initialize.headers.get('mcp-session-id')!;
        expect(sessionId).toBeString();
        expect(initialize.headers.get('content-type')).toContain('text/event-stream');
        await initialize.text();

        const list = await server.handle(
          postRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId),
        );
        expect(list.status).toBe(200);
        await list.text();

        const store = await server.handle(
          postRpc(
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'memory_store',
                arguments: {
                  content: 'The default-profile streamable-http server stores offline.',
                  type: 'semantic',
                  project_id: project.id,
                  evidence: [{ excerpt: 'network guard probe', locator: 'session.jsonl:7' }],
                },
              },
            },
            sessionId,
          ),
        );
        expect(store.status).toBe(200);
        const storeFrames = (await store.text()).split('\n\n').filter((block) => block.trim() !== '');
        const stored = JSON.parse(
          (storeFrames[0] ?? '').split('\n').find((line) => line.startsWith('data:'))!.slice(5).trim(),
        ) as { result: { structuredContent: { id: string; outcome: string } } };
        expect(stored.result.structuredContent.outcome).toBe('new');

        const get = await server.handle(
          postRpc(
            {
              jsonrpc: '2.0',
              id: 4,
              method: 'tools/call',
              params: { name: 'memory_get', arguments: { id: stored.result.structuredContent.id } },
            },
            sessionId,
          ),
        );
        expect(get.status).toBe(200);
        await get.text();

        const search = await server.handle(
          postRpc(
            {
              jsonrpc: '2.0',
              id: 5,
              method: 'tools/call',
              params: {
                name: 'memory_search',
                arguments: { query: 'offline', project_id: project.id },
              },
            },
            sessionId,
          ),
        );
        expect(search.status).toBe(200);
        await search.text();

        guard.assertZeroCalls(); // a full model-facing session: still offline

        const terminate = await server.handle(
          new Request(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }),
        );
        expect(terminate.status).toBe(200);
        expect(server.manager.sessions().length).toBe(0);
      } finally {
        socket.stop(true);
        await server.close();
      }

      guard.assertZeroCalls(); // shutdown is offline too
      expect(guard.count).toBe(0);
      expect(guard.attempts).toEqual([]);
    } finally {
      guard.restore();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
