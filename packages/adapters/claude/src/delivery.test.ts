/**
 * Delivery against a real fake HTTP server (Bun.serve): the documented REST contract
 * (`POST /v1/projects/{id}/events` → per-event outcomes), bounded timeouts, and fail-soft on
 * every failure mode — a delivery failure is a result, never an exception.
 */

import { afterAll, describe, expect, test } from 'bun:test';

import { deliverEvents, DEFAULT_DELIVERY_TIMEOUT_MS, type DaemonTarget } from './deliver';
import { contextBudgetFromEnv, fetchSessionContext, DEFAULT_CONTEXT_BUDGET } from './context';

const TARGET: DaemonTarget = {
  url: 'http://127.0.0.1',
  projectId: '0195a7f0-9f5e-7a1d-bc2d-0000000000aa',
};

let requests: Array<{ method: string; path: string; body: unknown }> = [];
let behavior: 'ok' | 'slow' | 'error500' = 'ok';
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : null;
    requests.push({ method: request.method, path: url.pathname + url.search, body });
    if (behavior === 'slow') await new Promise((resolve) => setTimeout(resolve, 400));
    if (behavior === 'error500') return new Response('boom', { status: 500 });
    if (url.pathname.endsWith('/context')) {
      return Response.json({
        project_id: '0195a7f0-9f5e-7a1d-bc2d-0000000000aa',
        budget: Number(url.searchParams.get('budget') ?? 750),
        used: 42,
        text: 'Project memory (onememory): a compact, token-budgeted digest.',
        sections: [{ kind: 'digest', tokens: 42, text: 'Project memory (onememory): a compact, token-budgeted digest.' }],
        warnings: [],
      });
    }
    const events = (body as { events: unknown[] } | null)?.events ?? [];
    return Response.json({
      outcomes: events.map((_, index) => ({ index, status: 'stored' })),
      stored: events.length,
      duplicates: 0,
      excluded: 0,
      dead_lettered: 0,
      normalize_job_id: '0195a7f0-9f5e-7a1d-bc2d-0000000000c1',
      warnings: [],
    });
  },
});

afterAll(() => server.stop(true));

const liveTarget: DaemonTarget = { url: `http://127.0.0.1:${server.port}`, projectId: TARGET.projectId };

describe('deliverEvents', () => {
  test('posts the documented body shape and summarizes the outcomes', async () => {
    requests = [];
    const result = await deliverEvents(liveTarget, [{ kind: 'terminal.output' }, { kind: 'file.changed' }]);
    expect(result.delivered).toBeTrue();
    expect(result.stored).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe(`/v1/projects/${TARGET.projectId}/events`);
    expect((requests[0]!.body as { events: unknown[] }).events).toHaveLength(2);
  });

  test('a non-2xx response is a fail-soft result carrying the status, never an exception', async () => {
    behavior = 'error500';
    try {
      const result = await deliverEvents(liveTarget, [{ kind: 'terminal.output' }]);
      expect(result.delivered).toBeFalse();
      expect(result.error).toContain('500');
      expect(result.stored).toBe(0);
    } finally {
      behavior = 'ok';
    }
  });

  test('a slow daemon is cut off at the bounded timeout (fail-soft, not blocking)', async () => {
    behavior = 'slow';
    try {
      const started = Date.now();
      const result = await deliverEvents(liveTarget, [{ kind: 'terminal.output' }], { timeoutMs: 60 });
      expect(result.delivered).toBeFalse();
      expect(result.error).toContain('cannot reach');
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      behavior = 'ok';
    }
  });

  test('a dead port fails soft with the origin in the message (no payload contents)', async () => {
    const result = await deliverEvents({ url: 'http://127.0.0.1:1', projectId: TARGET.projectId }, [{ kind: 'x' }], {
      timeoutMs: 250,
    });
    expect(result.delivered).toBeFalse();
    expect(result.error).toContain('http://127.0.0.1:1');
  });

  test('default timeout budget stays hook-sized (1s)', () => {
    expect(DEFAULT_DELIVERY_TIMEOUT_MS).toBe(1000);
  });
});

describe('fetchSessionContext', () => {
  test('requests the token budget as a query parameter and reads the context text', async () => {
    requests = [];
    const result = await fetchSessionContext(liveTarget, 750);
    expect(result.ok).toBeTrue();
    expect(requests[0]!.path).toBe(`/v1/projects/${TARGET.projectId}/context?budget=750`);
  });

  test('a context failure is a result, never a throw', async () => {
    behavior = 'error500';
    try {
      const result = await fetchSessionContext(liveTarget, 750);
      expect(result.ok).toBeFalse();
      expect(result.error).toContain('500');
    } finally {
      behavior = 'ok';
    }
  });
});

describe('contextBudgetFromEnv', () => {
  test('default 750, honoring valid overrides and ignoring invalid ones', () => {
    expect(contextBudgetFromEnv({})).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(contextBudgetFromEnv({ ONEMEMORY_CONTEXT_BUDGET: '900' })).toBe(900);
    expect(contextBudgetFromEnv({ ONEMEMORY_CONTEXT_BUDGET: '1' })).toBe(1);
    expect(contextBudgetFromEnv({ ONEMEMORY_CONTEXT_BUDGET: '4000' })).toBe(4000);
    expect(contextBudgetFromEnv({ ONEMEMORY_CONTEXT_BUDGET: '0' })).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(contextBudgetFromEnv({ ONEMEMORY_CONTEXT_BUDGET: 'abc' })).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(contextBudgetFromEnv({ ONEMEMORY_CONTEXT_BUDGET: '999999' })).toBe(DEFAULT_CONTEXT_BUDGET);
  });
});
