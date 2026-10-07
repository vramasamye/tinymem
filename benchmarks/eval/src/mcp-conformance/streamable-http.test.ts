/**
 * Adapter conformance in STREAMABLE-HTTP form (M5b AC 3): the canonical 10-fact session of
 * `../adapter-conformance/scenario.ts`, rendered into each runtime's native hook payloads,
 * translated by each adapter's own entry point, run through the real engine — and then the
 * model-facing memory surface served over the REAL Streamable-HTTP transport: a real
 * `Bun.serve` socket, the official SDK client (`Client` + `StreamableHTTPClientTransport`),
 * `Mcp-Session-Id` routing, SSE framing, one MCP session per run.
 *
 * The headline assertion, per runtime, against the in-process ("stdio") form's result:
 * BYTE-IDENTICAL memory results — the same events, the same extraction counts, the same
 * memories with the same evidence, the same working memory, the same `memory_search` ranking,
 * the same `memory_get` payload. The adapter event lane (hook → adapter translation →
 * ingestEvent → extract job) is engine-side in both forms by architecture; the Streamable-HTTP
 * transport under test is the model-facing surface, and this suite proves it changes nothing
 * about what the session remembers or what the model reads back.
 *
 * Known deviations are pinned by dedicated tests, never folded into equality:
 * - the ranking reconstruction branches on the wire-reported packing mode ('summary' for this
 *   scenario — pinned); the branch is exact in every mode, so only a mode change can ever
 *   surface, loudly;
 * - the pre-existing cross-runtime divergences of the stdio form (Codex keeps the remember
 *   clause's trailing period; Cursor reports no exit code) are per-runtime facts of the
 *   adapter lane and therefore reproduce identically through this form — a dedicated test
 *   pins the one that touches memory content, exactly like the M8/M9 suites do.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_TOOLS } from '@onememory-ai/mcp';

import { runAllPipelines, type PipelineResult } from '../adapter-conformance/pipeline';
import {
  RUNTIMES,
  SCENARIO,
  nativePayloads,
  translateScenario,
  type RuntimeName,
  type ScenarioContext,
} from '../adapter-conformance/scenario';
import { runAllStreamablePipelines, type StreamablePipelineResult } from './pipeline';

const PROJECT_ID = '01900000-0000-7000-8000-0000000000f2';

const roots: string[] = [];
let ctx: ScenarioContext;
let stdio: Record<RuntimeName, PipelineResult>;
let wire: Record<RuntimeName, StreamablePipelineResult>;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'onemem-conformance-http-root-'));
  roots.push(root);
  ctx = { root, projectId: PROJECT_ID };
  // The in-process ("stdio") form is the baseline this suite compares against, so both forms
  // run in the SAME beforeAll — five adapter lanes through the engine, plus five full
  // streamable-http serving worlds (each its own socket, session, and fresh PGlite).
  [stdio, wire] = await Promise.all([runAllPipelines(ctx), runAllStreamablePipelines(ctx)]);
}, 300_000);

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Iterate the five runtimes with a label, so a failure names its runtime. */
function eachRuntime(apply: (runtime: RuntimeName) => void): void {
  for (const runtime of RUNTIMES) {
    try {
      apply(runtime);
    } catch (error) {
      if (error instanceof Error) error.message = `[${runtime}] ${error.message}`;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The wire surface — the transport facts of every runtime's run
// ---------------------------------------------------------------------------

describe('streamable-http conformance — the wire surface', () => {
  test('the SDK client negotiates a real session over the socket, one live session per run', () => {
    eachRuntime((runtime) => {
      const run = wire[runtime];
      expect(run.transport.sessionId).toBeString();
      expect(run.transport.sessionId!.length).toBeGreaterThan(16);
      expect(run.transport.liveSessionsDuringRun).toBe(1);
    });
  });

  test('tools/list over the wire advertises the default 8-tool profile, in order', () => {
    eachRuntime((runtime) => {
      expect(wire[runtime].transport.toolsListed).toEqual([...DEFAULT_TOOLS]);
    });
  });

  test('memory_search answers in summary packing — the ranking reconstruction mode is pinned', () => {
    // The ID-index omits content bodies by design; this suite reconstructs ranking content from
    // what the wire reports. The branch is exact in every mode, but the MODE itself is a fact
    // of the scenario that a budget/packing change could alter — pin it here so the change
    // flips THIS test, not silently the byte-identical comparison above.
    eachRuntime((runtime) => {
      expect(wire[runtime].transport.searchPacking).toBe('summary');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Byte-identical memory results vs the in-process (stdio) form
// ---------------------------------------------------------------------------

describe('streamable-http conformance — byte-identical vs the stdio form', () => {
  test('the same events reach storage through the adapter lane', () => {
    eachRuntime((runtime) => {
      expect(wire[runtime].eventKinds).toEqual(stdio[runtime].eventKinds);
      expect(wire[runtime].drops).toEqual(stdio[runtime].drops);
    });
  });

  test('the extraction counts agree (same events in, same candidates out)', () => {
    eachRuntime((runtime) => {
      expect(wire[runtime].extraction).toEqual(stdio[runtime].extraction);
    });
  });

  test('the canonical session yields the same memories and the same evidence', () => {
    eachRuntime((runtime) => {
      expect(wire[runtime].memories).toEqual(stdio[runtime].memories);
    });
  });

  test('the working-memory sweep surface is identical', () => {
    eachRuntime((runtime) => {
      expect(wire[runtime].working).toEqual(stdio[runtime].working);
    });
  });

  test('the same query returns the same ranking over the wire', () => {
    eachRuntime((runtime) => {
      expect(wire[runtime].search.query).toBe(stdio[runtime].search.query);
      expect(wire[runtime].search.ranking).toEqual(stdio[runtime].search.ranking);
    });
  });

  test('memory_get over the wire returns the same full-record payload', () => {
    eachRuntime((runtime) => {
      expect(wire[runtime].get).toEqual(stdio[runtime].get);
      expect(wire[runtime].search.top).toEqual(stdio[runtime].search.top);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The wire results are not vacuous + cross-runtime agreement in the new form
// ---------------------------------------------------------------------------

/** Strip a trailing sentence terminator — the Claude-baseline remember-clause normalization
 *  (the same helper the M8/M9 suites use for the documented Codex divergence). */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, '').trim();
}

/** The remember clause a runtime's memories carry: the Claude baseline, or Codex's kept
 *  trailing period — the pre-existing, stdio-form-pinned normalization divergence. */
function rememberedContent(runtime: RuntimeName): string {
  return runtime === 'codex' ? `${SCENARIO.rememberedClause}.` : SCENARIO.rememberedClause;
}

describe('streamable-http conformance — the results are the expected ones', () => {
  test('every runtime produces the canonical memories with the canonical evidence', () => {
    eachRuntime((runtime) => {
      const run = wire[runtime];
      const contents = run.memories.map((memory) => memory.content).sort();
      expect(contents).toEqual(
        [
          "Failure: MODULE_NOT_FOUND — Error: Cannot find module './middleware' — resolved by: `bun test src/auth/`",
          'Recurring command: `bun test src/auth/` (used 2 times)',
          rememberedContent(runtime),
        ].sort(),
      );
      const byType = new Map(run.memories.map((memory) => [memory.type, memory]));
      expect(byType.get('failure')?.subtype).toBe('failure.resolved');
      expect(byType.get('procedural')?.subtype).toBe('procedural.command');
      expect(byType.get('semantic')?.subtype).toBe('semantic.explicit');
      expect(byType.get('failure')?.evidence).toEqual(['event:failure', 'event:success-2']);
      expect(byType.get('procedural')?.evidence).toEqual(['event:success-1', 'event:success-2']);
      expect(byType.get('semantic')?.evidence).toEqual(['event:remember']);
    });
  });

  test('the canonical query surfaces the remember clause as the top result over the wire', () => {
    eachRuntime((runtime) => {
      const run = wire[runtime];
      expect(run.search.ranking).toEqual([`semantic|${rememberedContent(runtime)}`]);
      expect(run.get?.type).toBe('semantic');
      expect(run.get?.status).toBe('active');
      expect(run.get?.importance).toBe(0.9);
      expect(run.get?.confidence).toBe(0.95);
      expect(run.get?.evidence).toEqual(['event:remember']);
    });
  });

  test('all five runtimes agree with each other byte for byte in the streamable-http form', () => {
    // The M8/M9 cross-runtime claim, restated for the new form: every runtime's WIRE result
    // matches Claude's wire result exactly — memories, working memory, ranking, memory_get —
    // modulo the ONE documented adapter-lane divergence (Codex's kept trailing period), which
    // the dedicated test below pins. Everything else is byte for byte.
    eachRuntime((runtime) => {
      const mine = wire[runtime];
      const claude = wire['claude-code'];
      const normalize = (result: StreamablePipelineResult) => ({
        memories: result.memories.map((memory) => ({ ...memory, content: stripTrailingPunctuation(memory.content) })),
        working: result.working,
        ranking: result.search.ranking.map(stripTrailingPunctuation),
        get: result.get === null ? null : { ...result.get, content: stripTrailingPunctuation(result.get.content) },
      });
      expect(normalize(mine)).toEqual(normalize(claude));
    });
  });

  test('DOCUMENTED DIVERGENCE: only Codex keeps the remember clause’s trailing period over the wire', () => {
    // The pre-existing stdio-form divergence, reproduced and pinned in the new form: the
    // adapter lane is engine-side in both forms, so the divergence is IDENTICAL here — which
    // is exactly what the per-runtime byte-identical tests above prove for Codex.
    const semanticContent = (runtime: RuntimeName): string =>
      wire[runtime].memories.find((memory) => memory.type === 'semantic')?.content ?? '(missing)';
    expect(semanticContent('claude-code')).toBe(SCENARIO.rememberedClause);
    expect(semanticContent('cursor')).toBe(SCENARIO.rememberedClause);
    expect(semanticContent('pi')).toBe(SCENARIO.rememberedClause);
    expect(semanticContent('opencode')).toBe(SCENARIO.rememberedClause);
    expect(semanticContent('codex')).toBe(`${SCENARIO.rememberedClause}.`);
  });
});

// ---------------------------------------------------------------------------
// 4. The session boundary, pinned in THIS form too (M5b follow-up 2)
// ---------------------------------------------------------------------------

describe('streamable-http conformance — the session boundary is pinned in this form', () => {
  /**
   * The stdio form pins OpenCode's `session.idle → session.end` translation
   * (`../adapter-conformance/opencode.test.ts`). The same rule must hold in this form: a
   * runtime whose session never closes leaves the wire run's working-memory sweep open, so
   * the boundary is pinned per canonical fact AND through the wire run's own event lane.
   */
  test('every runtime closes the session, and the boundary is the last event in the lane', () => {
    eachRuntime((runtime) => {
      const boundary = translateScenario(runtime, ctx).events.filter(({ fact }) => fact === 'session-end');
      expect(boundary).toHaveLength(1);
      expect(boundary[0]!.event.kind).toBe('session.end');
      // …and it survives into the wire run's event lane (the pipeline throws if a translated
      // event fails to store, so presence here means the boundary reached storage).
      expect(wire[runtime].eventKinds.at(-1)).toBe('session.end');
    });
  });

  test("OpenCode's session-end signal is the session.idle quiescence event, not a quit hook", () => {
    // OpenCode's plugin API has no quit/close event; `session.idle` (its docs' "session
    // completed" notification) is the lifecycle boundary, and the adapter maps it explicitly.
    const boundary = nativePayloads('opencode', ctx).filter(({ fact }) => fact === 'session-end');
    expect(boundary).toHaveLength(1);
    expect(boundary[0]!.channel).toBe('event');
    expect(boundary[0]!.payload).toEqual({
      type: 'session.idle',
      properties: { sessionID: SCENARIO.sessionId },
    });
  });
});
