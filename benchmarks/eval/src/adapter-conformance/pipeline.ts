/**
 * The conformance pipeline: one runtime's canonical session, run through the REAL engine —
 * embedded PGlite storage (migrations included), the real extract job handler over the real
 * heuristic extractor + classifier, the real retrieval engine — and normalized for comparison.
 *
 * Nothing here is mocked: this is the same code path the daemon runs, minus the daemon. Each
 * runtime gets its own storage directory so no state can leak between runs.
 *
 * Normalization is deliberately strict about what MUST match (memory type/subtype/content,
 * evidence by canonical fact, search ranking, the `memory_get` record) and deliberately silent
 * about what legitimately differs per channel (session summaries, output digests, line-count
 * fields — see the conformance test's "documented divergence" assertions).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExtractHandler, createHeuristicClassifier, createHeuristicExtractor } from '@onememory/extraction';
import { createRetrievalEngine } from '@onememory/retrieval';
import { createEmbeddedDb } from '@onememory/storage';
import type { OnememoryStorage } from '@onememory/storage';
import type { EvidenceSpan, MemoryRecord } from '@onememory/core';

import { FACT_IDS, RUNTIMES, SCENARIO, SCENARIO_NOW, translateScenario, type RuntimeName, type ScenarioContext } from './scenario';

/** The canonical query every runtime must answer the same way. */
export const CONFORMANCE_QUERY = 'how do I run the auth tests';

/**
 * The retrieval clock: one hour after the session. It must be strictly AFTER every memory's
 * `valid_from` (which derives from the event timeline), otherwise the temporal filter correctly
 * hides the freshly written memories from a "current" query.
 */
export const ENGINE_NOW = new Date(Date.parse(SCENARIO_NOW) + 3_600_000).toISOString();

export interface NormalizedMemory {
  type: string;
  subtype: string | null;
  content: string;
  /** Evidence, normalized: `event:<uuid>` becomes `event:<factId>`. Sorted. */
  evidence: string[];
}

export interface NormalizedWorking {
  kind: string;
  content: string;
  evidence: string[];
}

export interface NormalizedGet {
  type: string;
  subtype: string | null;
  content: string;
  status: string;
  importance: number;
  confidence: number;
  evidence: string[];
  entities: string[];
}

export interface PipelineResult {
  runtime: RuntimeName;
  /** Event kinds in session order (the adapter-level contract). */
  eventKinds: string[];
  /** Counted translation drops (reported, not asserted equal). */
  drops: Array<{ reason: string; count: number }>;
  extraction: {
    events_processed: number;
    memories_inserted: number;
    duplicates: number;
    working_inserted: number;
    candidates_discarded: number;
    needs_review: number;
  };
  memories: NormalizedMemory[];
  working: NormalizedWorking[];
  search: {
    query: string;
    ranking: string[];
    top: NormalizedGet | null;
  };
  /** The `memory_get` payload for the top search result (the full stored record). */
  get: NormalizedGet | null;
}

function factOfEventId(id: string, eventIdToFact: ReadonlyMap<string, string>): string {
  return eventIdToFact.get(id) ?? `unknown:${id}`;
}

/** `event:<uuid>` locators become `event:<canonical fact>`; other locators pass through. */
export function normalizeEvidence(evidence: readonly EvidenceSpan[], eventIdToFact: ReadonlyMap<string, string>): string[] {
  return evidence
    .map((span) => {
      if (span.kind === 'event' && span.locator.startsWith('event:')) {
        return `event:${factOfEventId(span.locator.slice('event:'.length), eventIdToFact)}`;
      }
      return `${span.kind}:${span.locator}`;
    })
    .sort();
}

/**
 * Normalization is shared with the streamable-http conformance form
 * (`../mcp-conformance/pipeline.ts`, M5b): the two forms must compare byte for byte, so they
 * MUST normalize through one implementation — a second copy could drift into its own notion
 * of "equal" and make the cross-form assertion vacuous.
 */
export function normalizeMemory(memory: MemoryRecord, eventIdToFact: ReadonlyMap<string, string>): NormalizedMemory {
  return {
    type: memory.type,
    subtype: memory.subtype ?? null,
    content: memory.content,
    evidence: normalizeEvidence(memory.provenance.evidence, eventIdToFact),
  };
}

export function normalizeGet(memory: MemoryRecord, eventIdToFact: ReadonlyMap<string, string>): NormalizedGet {
  return {
    type: memory.type,
    subtype: memory.subtype ?? null,
    content: memory.content,
    status: memory.status,
    importance: memory.importance,
    confidence: memory.confidence,
    evidence: normalizeEvidence(memory.provenance.evidence, eventIdToFact),
    entities: memory.entities.map((entity) => entity.name).sort(),
  };
}

/** Working-memory rows, normalized + deterministically sorted (shared by both forms). */
export function normalizeWorking(
  rows: ReadonlyArray<{ kind: string; content: string; evidence: readonly EvidenceSpan[] }>,
  eventIdToFact: ReadonlyMap<string, string>,
): NormalizedWorking[] {
  return rows
    .map((row) => ({
      kind: row.kind,
      content: row.content,
      evidence: normalizeEvidence(row.evidence, eventIdToFact),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.content.localeCompare(b.content) : a.kind.localeCompare(b.kind)));
}

/** Run one runtime's canonical session through the real pipeline. */
export async function runPipeline(runtime: RuntimeName, ctx: ScenarioContext): Promise<PipelineResult> {
  const dataDir = await mkdtemp(join(tmpdir(), `onemem-conformance-${runtime}-`));
  let storage: OnememoryStorage | null = null;
  try {
    const translated = translateScenario(runtime, ctx);
    const eventIdToFact = new Map(translated.events.map(({ fact, event }) => [event.id, fact]));

    storage = await createEmbeddedDb(dataDir);
    const project = await storage.store.createProject({
      name: `conformance-${runtime}`,
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
    const extractResult = await extraction({ id: `extract-${runtime}`, kind: 'extract', payload: {} });

    const current = await storage.store.queryCurrent({ project_id: project.id });
    const memories = current.map((memory) => normalizeMemory(memory, eventIdToFact)).sort(compareMemories);

    const workingRows = await storage.store.listWorking(SCENARIO.sessionId);
    const working = normalizeWorking(workingRows, eventIdToFact);

    const engine = createRetrievalEngine(storage, { now: () => new Date(ENGINE_NOW) });
    const response = await engine.search({ query: CONFORMANCE_QUERY, project_id: project.id });
    const ranking = response.memories.map((item) => `${item.type}|${item.content ?? item.summary}`);
    const topId = response.memories[0]?.id ?? null;
    const topRecord = topId === null ? null : await storage.store.getMemory(topId);

    return {
      runtime,
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
    await storage?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Every runtime's result, keyed by runtime name. */
export async function runAllPipelines(ctx: ScenarioContext): Promise<Record<RuntimeName, PipelineResult>> {
  const entries = await Promise.all(
    RUNTIMES.map(async (runtime) => [runtime, await runPipeline(runtime, ctx)] as const),
  );
  return Object.fromEntries(entries) as Record<RuntimeName, PipelineResult>;
}

/** Sort order shared by both conformance forms (memories compare by type, subtype, content). */
export function compareMemories(a: NormalizedMemory, b: NormalizedMemory): number {
  if (a.type !== b.type) return a.type.localeCompare(b.type);
  const subtypeA = a.subtype ?? '';
  const subtypeB = b.subtype ?? '';
  if (subtypeA !== subtypeB) return subtypeA.localeCompare(subtypeB);
  return a.content.localeCompare(b.content);
}

/** The canonical fact index for a fact id (evidence assertions are easier to read as indices). */
export function factIndex(fact: string): number {
  return FACT_IDS.indexOf(fact as (typeof FACT_IDS)[number]);
}

/** Assertion helper: the memory a runtime produced for a given content (or `undefined`). */
export function memoryWithContent(result: PipelineResult, content: string): NormalizedMemory | undefined {
  return result.memories.find((memory) => memory.content === content);
}

export { SCENARIO };
