/**
 * The streamable-http conformance pipeline (M5b AC 3): the SAME canonical 10-fact session as
 * the in-process form (`../adapter-conformance/pipeline.ts`), with the model-facing session
 * surface driven over the REAL Streamable-HTTP transport — a real `Bun.serve` socket, the
 * official SDK client (`Client` + `StreamableHTTPClientTransport` from
 * `@modelcontextprotocol/client` 2.3.0), `Mcp-Session-Id` routing, one MCP session per run.
 *
 * What rides the WIRE here (what the Streamable-HTTP transport adds over the in-process form):
 * initialize (session minting), tools/list, `memory_search` (the progressive-disclosure
 * ID-index), and `memory_get` for every index row (the flow an agent actually runs). What
 * stays engine-side — in BOTH forms, by architecture: the adapter event lane (hook payload →
 * adapter translation → `ingestEvent`) and the extract job. Adapters deliver events through
 * the storage ingest path, not through MCP tools, so the transport under test is the
 * model-facing surface; comparing per runtime against the in-process result then proves the
 * session through the HTTP-serving world yields byte-identical memories AND reads back
 * identically over the wire.
 *
 * Every tool result crossing the wire is parsed with the tool's own exported Zod output
 * schema (`TOOL_SCHEMAS`) — the wire contract validates the wire, no `any` at the boundary.
 *
 * Normalization is imported from the in-process pipeline — ONE implementation for both
 * forms, so the byte-identical assertion cannot be satisfied by a second normalizer that
 * merely agrees with itself.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createExtractHandler, createHeuristicClassifier, createHeuristicExtractor } from '@onememory/extraction';
import {
  MemoryGetOutputSchema,
  MemorySearchOutputSchema,
  DEFAULT_TOOLS,
  createOnememoryMcpContext,
  createStreamableHttpSessionManager,
} from '@onememory/mcp';
import { createEmbeddedDb } from '@onememory/storage';
import type { OnememoryStorage } from '@onememory/storage';
import type { MemoryGetOutput, MemorySearchOutput } from '@onememory/mcp';
import type { MemoryRecord } from '@onememory/core';

import {
  CONFORMANCE_QUERY,
  ENGINE_NOW,
  compareMemories,
  normalizeGet,
  normalizeMemory,
  normalizeWorking,
  type NormalizedGet,
  type NormalizedMemory,
  type NormalizedWorking,
  type PipelineResult,
} from '../adapter-conformance/pipeline';
import { RUNTIMES, SCENARIO, SCENARIO_NOW, translateScenario, type RuntimeName, type ScenarioContext } from '../adapter-conformance/scenario';

/** The wire leg's observable transport facts (asserted separately from the memory results). */
export interface StreamableTransportFacts {
  /** The session id the SDK client negotiated (the transport mints `Mcp-Session-Id`). */
  sessionId: string | undefined;
  /** Live sessions in the manager's registry while the run's session was connected. */
  liveSessionsDuringRun: number;
  /** `tools/list` over the wire, in advertised order. */
  toolsListed: string[];
  /**
   * The search response's packing mode, as the wire reports it (`tokens.packing`). The ranking
   * reconstruction below is exact in every mode but branches on this value ('content' uses
   * `memory_get` bodies; other modes use the index row's own summary) — pinned by a dedicated
   * test so a packing change cannot silently weaken the byte-identical comparison.
   */
  searchPacking: string;
}

export interface StreamablePipelineResult {
  runtime: RuntimeName;
  transport: StreamableTransportFacts;
  /** Event kinds in session order — the adapter lane, identical in both forms by construction. */
  eventKinds: string[];
  /** Counted translation drops (reported, not asserted equal across runtimes). */
  drops: Array<{ reason: string; count: number }>;
  extraction: PipelineResult['extraction'];
  memories: NormalizedMemory[];
  working: NormalizedWorking[];
  search: {
    query: string;
    ranking: string[];
    top: NormalizedGet | null;
  };
  /** The `memory_get` payload for the top search result (the full record, over the wire). */
  get: NormalizedGet | null;
}

/** One tool call over the wire, validated against the tool's own output schema. */
async function callTool<Output>(
  client: Client,
  schemas: { output: { parse(data: unknown): Output } },
  name: string,
  args: Record<string, unknown>,
): Promise<Output> {
  const result = await client.callTool({ name, arguments: args });
  if ((result as { isError?: boolean }).isError === true) {
    throw new Error(
      `tools/call ${name} over streamable-http returned isError: ${JSON.stringify((result as { content?: unknown[] }).content)}`,
    );
  }
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured === undefined) {
    throw new Error(`tools/call ${name} over streamable-http carried no structuredContent`);
  }
  return schemas.output.parse(structured);
}

/**
 * Run one runtime's canonical session through the streamable-http serving world: the adapter
 * event lane + the extract job against a fresh embedded PGlite (exactly the in-process form),
 * then the memory surface — `memory_search` + `memory_get` for every index row — through the
 * real SDK client over a real socket, one MCP session for the run.
 */
export async function runStreamablePipeline(runtime: RuntimeName, ctx: ScenarioContext): Promise<StreamablePipelineResult> {
  const dataDir = await mkdtemp(join(tmpdir(), `onemem-conformance-http-${runtime}-`));
  let storage: OnememoryStorage | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let manager: ReturnType<typeof createStreamableHttpSessionManager> | null = null;
  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;
  try {
    const translated = translateScenario(runtime, ctx);
    const eventIdToFact = new Map(translated.events.map(({ fact, event }) => [event.id, fact]));

    storage = await createEmbeddedDb(dataDir);
    const project = await storage.store.createProject({
      name: `conformance-http-${runtime}`,
      root_path: ctx.root,
    });
    for (const { event } of translated.events) {
      const result = await storage.store.ingestEvent({ ...event, scope: { ...event.scope, project_id: project.id } });
      if (result.status !== 'stored') throw new Error(`event ${event.kind} was not stored (${result.status})`);
    }

    const extraction = createExtractHandler(
      storage.store,
      storage.jobs,
      createHeuristicExtractor(),
      createHeuristicClassifier(),
      { enqueueReEmbed: false, now: () => SCENARIO_NOW },
    );
    const extractResult = await extraction({ id: `extract-http-${runtime}`, kind: 'extract', payload: {} });

    // The serving world: the shared MCP context over the SAME storage the session was
    // ingested into, with the retrieval clock at ENGINE_NOW (the in-process form's clock).
    const context = await createOnememoryMcpContext({
      storage,
      projectId: project.id,
      agentId: `conformance-http-${runtime}`,
      now: () => new Date(ENGINE_NOW),
      env: {},
    });
    manager = createStreamableHttpSessionManager({ context });
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => manager!.handle(request),
    });

    // The real wire: the official SDK client against the real socket.
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
    client = new Client({ name: `conformance-http-${runtime}`, version: '1.0.0' });
    await client.connect(transport);
    const sessionId = transport.sessionId;
    const liveSessionsDuringRun = manager.sessions().length;

    const list = await client.listTools();
    const toolsListed = list.tools.map((tool) => tool.name);

    // memory_search → the progressive-disclosure ID-index; memory_get completes each row.
    const search = await callTool(client, { output: MemorySearchOutputSchema }, 'memory_search', {
      query: CONFORMANCE_QUERY,
      project_id: project.id,
    });
    const searchPacking = search.tokens.packing;

    const gets: MemoryGetOutput[] = [];
    for (const row of search.results) {
      gets.push(await callTool(client, { output: MemoryGetOutputSchema }, 'memory_get', { id: row.id }));
    }
    const topRecord: MemoryRecord | null = gets.length > 0 ? gets[0]!.memory : null;
    // The in-process form's ranking is `type|content ?? summary` over the ENGINE rows, and the
    // engine row's packing decides which field that is. The ID-index omits content bodies by
    // design, so the wire reconstruction follows the wire-REPORTED packing mode: 'content'
    // packs full record content (exactly what memory_get returns); every other mode ('summary',
    // 'title-only') is represented by the index row's own summary — the engine row's summary,
    // verbatim. Exact in all three modes; the mode itself is pinned by a dedicated test.
    const ranking = search.results.map((row, index) => {
      const body = searchPacking === 'content' ? gets[index]!.memory.content : row.summary;
      return `${row.type}|${body}`;
    });

    // The durable state as read back from the SAME storage the HTTP world served — normalized
    // with the shared in-process normalizers.
    const current = await storage.store.queryCurrent({ project_id: project.id });
    const memories = current.map((memory) => normalizeMemory(memory, eventIdToFact)).sort(compareMemories);
    const workingRows = await storage.store.listWorking(SCENARIO.sessionId);
    const working = normalizeWorking(workingRows, eventIdToFact);

    return {
      runtime,
      transport: { sessionId, liveSessionsDuringRun, toolsListed, searchPacking },
      eventKinds: translated.events.map(({ event }) => event.kind),
      drops: translated.drops,
      extraction: {
        events_processed: extractResult.events_processed,
        memories_inserted: extractResult.memories_inserted,
        duplicates: extractResult.duplicates,
        working_inserted: extractResult.working_inserted,
        candidates_discarded: extractResult.candidates_discarded,
        needs_review: extractResult.needs_review,
      },
      memories,
      working,
      search: {
        query: CONFORMANCE_QUERY,
        ranking,
        top: topRecord === null ? null : normalizeGet(topRecord, eventIdToFact),
      },
      get: topRecord === null ? null : normalizeGet(topRecord, eventIdToFact),
    };
  } finally {
    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await manager?.close().catch(() => undefined);
    server?.stop(true);
    await storage?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Every runtime's streamable-http result, keyed by runtime name. */
export async function runAllStreamablePipelines(ctx: ScenarioContext): Promise<Record<RuntimeName, StreamablePipelineResult>> {
  const entries = await Promise.all(
    RUNTIMES.map(async (runtime) => [runtime, await runStreamablePipeline(runtime, ctx)] as const),
  );
  return Object.fromEntries(entries) as Record<RuntimeName, StreamablePipelineResult>;
}

export { CONFORMANCE_QUERY, DEFAULT_TOOLS };
