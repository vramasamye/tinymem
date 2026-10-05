/**
 * The benchmark runtime: composes the real workspace packages exactly the way
 * `apps/api/src/runtime/composition.ts` does for the offline default, but for embedded PGlite only.
 *
 * Why compose directly instead of depending on `@onememory/api/runtime`: the dependency direction
 * is one-way (`apps` depend on `packages`, never the reverse — repository-structure.md rule 1), and
 * a benchmark must never reach into an application. The pieces here are the same ones the daemon
 * wires: `@onememory/storage` (PGlite + migrations), `@onememory/extraction` (heuristic extractor +
 * classifier + job handler), `@onememory/retrieval` (the real search engine), and — for datasets
 * that opt in — `@onememory/consolidation` (the M14 automatic lifecycle).
 *
 * Offline by construction: no embedder and no model router are wired, so retrieval runs the
 * documented lexical + graph default, extraction is the heuristic (no-LLM) baseline, and the
 * consolidation pass runs its vector-free passes (contradiction resolution, decay) while the
 * vector-dependent passes (derivation, near-duplicate merge) skip with recorded warnings.
 * Nothing in the runtime can make an outbound call (AGENTS.md rule 4).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConsolidation, type ConsolidationReport } from '@onememory/consolidation';
import {
  eventContentHash,
  uuidv7,
  validateOnememoryEvent,
  type EventPayload,
  type MemoryRecord,
  type OnememoryEvent,
} from '@onememory/core';
import {
  createExtractHandler,
  createHeuristicClassifier,
  createHeuristicExtractor,
  type ExtractHandlerResult,
} from '@onememory/extraction';
import { createRetrievalEngine, type RetrievalEngine } from '@onememory/retrieval';
import { installNetworkGuard, type NetworkGuard } from '@onememory/security';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory/storage';

import {
  GLOBAL_PROJECT_KEY,
  type DatasetEvent,
  type GoldenDataset,
  type MemoryMatcher,
} from './dataset';

/** The immutable view of one memory the metrics need (content/scope never change after insert). */
export interface CorpusMemory {
  id: string;
  type: string;
  subtype: string | null;
  content: string;
  project_id: string | null;
  observed_at: string;
}

export interface ResolvedFact {
  key: string;
  description: string;
  scenario: string;
  memory: CorpusMemory;
}

/**
 * What the automatic consolidation pass did to one dataset's corpus (M14), reduced to the stable
 * summary the benchmark report publishes — per-memory uuids stay out of committed results.
 */
export interface ConsolidationPassSummary {
  ran_at: string;
  actor: string;
  /** Contradiction pairs the pass detected. */
  pairs: number;
  /** Pairs resolved by the authority order (winner current, loser superseded). */
  resolved: number;
  /** Full-authority-tie pairs: both sides `disputed`, excluded from current answers. */
  disputed_pairs: number;
  /** Rows absorbed by the near-duplicate merge (0 offline — the pass is vector-gated). */
  merged_sources: number;
  /** Semantic memories derived from episodic clusters (0 offline — the pass is vector-gated). */
  derived: number;
  /** Rows archived by decay (fixtures are minutes old, so 0 unless a dataset intends archival). */
  archived: number;
  /** The pass's degradations and per-item failures — never silent (memory-model.md §1.6). */
  warnings: readonly string[];
}

export interface BenchRuntimeOptions {
  /** Install the process-wide network guard around the run and record attempted calls. */
  enforceNetworkGuard?: boolean;
}

export interface BenchRuntime {
  engine: RetrievalEngine;
  /** Every durable memory the run produced, before supersessions were applied. */
  corpus: readonly CorpusMemory[];
  facts: ReadonlyMap<string, ResolvedFact>;
  /** Project key → project uuid (the reserved global key maps to null). */
  project_ids: ReadonlyMap<string, string | null>;
  /** Memory ids that were explicitly superseded by the dataset's supersession fixtures. */
  superseded: ReadonlySet<string>;
  /** What the automatic consolidation pass did (null when the dataset did not opt in). */
  consolidation: ConsolidationPassSummary | null;
  extraction: ExtractHandlerResult;
  /** Attempted outbound calls recorded by the network guard (null when not enforced). */
  network_attempts: number | null;
  warnings: readonly string[];
  close(): Promise<void>;
}

function summarizeConsolidation(report: ConsolidationReport): ConsolidationPassSummary {
  return {
    ran_at: report.ran_at,
    actor: report.actor,
    pairs: report.contradictions.pairs,
    resolved: report.contradictions.resolved,
    disputed_pairs: report.contradictions.disputed_pairs,
    merged_sources: report.merge.sources_closed,
    derived: report.derivations.derived,
    archived: report.decay.archived,
    warnings: report.warnings,
  };
}

function eventOccurredAt(dataset: GoldenDataset, offsetSeconds: number): string {
  return new Date(Date.parse(dataset.base_time) + offsetSeconds * 1000).toISOString();
}

function payloadFor(event: DatasetEvent): EventPayload {
  switch (event.kind) {
    case 'conversation.message':
      return { kind: 'conversation.message', role: event.role, content: event.content };
    case 'terminal.output':
      return {
        kind: 'terminal.output',
        command: event.command,
        exit_code: event.exit_code,
        output_digest: event.output_digest,
      };
    case 'error.raised':
      return {
        kind: 'error.raised',
        origin: event.origin,
        message: event.message,
        context: event.context,
      };
    case 'explicit.remember':
      return {
        kind: 'explicit.remember',
        content: event.content,
        ...(event.type === undefined ? {} : { type: event.type }),
        ...(event.importance === undefined ? {} : { importance: event.importance }),
      };
  }
}

/** Build the real `OnememoryEvent` envelope from a dataset fixture (validated by core). */
export function buildEvent(
  dataset: GoldenDataset,
  event: DatasetEvent,
  projectId: string | null,
): OnememoryEvent {
  const occurredAt = eventOccurredAt(dataset, event.offset_seconds);
  const payload = payloadFor(event);
  const candidate = {
    id: uuidv7(),
    kind: event.kind,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    source: { runtime: 'claude-code', adapter_version: 'benchmarks/1.0.0' },
    scope: {
      ...(projectId === null ? {} : { project_id: projectId }),
      session_id: event.session,
      agent_id: 'benchmark-harness',
    },
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
  };
  const result = validateOnememoryEvent(candidate);
  if (!result.ok) {
    throw new Error(
      `benchmark fixture event (${event.kind} @${event.offset_seconds}s) failed envelope validation: ${JSON.stringify(result.dead_letter.issues)}`,
    );
  }
  return result.value;
}

function toCorpusMemory(record: MemoryRecord): CorpusMemory {
  return {
    id: record.id,
    type: record.type,
    subtype: record.subtype ?? null,
    content: record.content,
    project_id: record.project_id ?? null,
    observed_at: record.observed_at,
  };
}

export function memoryMatches(
  matcher: MemoryMatcher,
  memory: CorpusMemory,
  projectIdByKey: ReadonlyMap<string, string | null>,
): boolean {
  if (matcher.type !== undefined && memory.type !== matcher.type) return false;
  if (matcher.subtype !== undefined && memory.subtype !== matcher.subtype) return false;
  if (matcher.project !== undefined) {
    const wanted =
      matcher.project === GLOBAL_PROJECT_KEY ? null : (projectIdByKey.get(matcher.project) ?? null);
    if (memory.project_id !== wanted) return false;
  }
  if (matcher.content_equals !== undefined && memory.content !== matcher.content_equals) return false;
  if (matcher.content_contains !== undefined && !memory.content.includes(matcher.content_contains)) {
    return false;
  }
  return true;
}

export function matchMemories(
  corpus: readonly CorpusMemory[],
  matcher: MemoryMatcher,
  projectIdByKey: ReadonlyMap<string, string | null>,
): CorpusMemory[] {
  return corpus.filter((memory) => memoryMatches(matcher, memory, projectIdByKey));
}

function resolveUnique(
  corpus: readonly CorpusMemory[],
  matcher: MemoryMatcher,
  projectIdByKey: ReadonlyMap<string, string | null>,
  where: string,
): CorpusMemory {
  const matches = matchMemories(corpus, matcher, projectIdByKey);
  if (matches.length === 0) {
    throw new Error(
      `benchmark fixture '${where}' matched no memory (${JSON.stringify(matcher)}) — the dataset no longer reflects what extraction produces`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `benchmark fixture '${where}' matched ${matches.length} memories (${JSON.stringify(matcher)}) — make the matcher more specific`,
    );
  }
  return matches[0]!;
}

/**
 * Open the runtime for one dataset: fresh PGlite, ingest every fixture event, run one real
 * extraction pass, resolve fact keys, apply the dataset's explicit supersessions, then (opt-in)
 * run the M14 automatic consolidation pass. Probes see the post-pass corpus: contradiction losers
 * are superseded, full-tie sides are disputed, and decay archives — all excluded from current
 * answers. Fact keys still resolve against the pre-pass corpus snapshot, because consolidation
 * only changes status, never content/scope/type.
 *
 * The extract handler's `re_embed` enqueue is off because there is no embedder — the same choice
 * `composition.ts` makes when `embeddings.provider` is unset.
 */
export async function openBenchRuntime(
  dataset: GoldenDataset,
  options: BenchRuntimeOptions = {},
): Promise<BenchRuntime> {
  const warnings: string[] = [];
  let networkGuard: NetworkGuard | null = null;
  if (options.enforceNetworkGuard === true) {
    try {
      networkGuard = installNetworkGuard();
    } catch (error) {
      // Another runtime in the process already installed the guard (tests): that instance keeps
      // protecting every request, so zero-network is still enforced — just not counted here.
      warnings.push(
        `network guard already installed elsewhere in this process: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Each dataset run owns a fresh PGlite data directory, removed when the runtime closes.
  const dataDir = await mkdtemp(join(tmpdir(), `onemem-bench-${dataset.id}-`));
  const storage: OnememoryStorage = await createEmbeddedDb(dataDir);

  // The retrieval engine fires `void store.reinforce(...)`; PGlite's close waits for in-flight
  // queries, so track those writes and drain them before close (mirrors composition.ts).
  const inflight = new Set<Promise<unknown>>();
  const trackWrite = <T>(promise: Promise<T>): Promise<T> => {
    const entry: Promise<unknown> = promise;
    inflight.add(entry);
    return promise.finally(() => inflight.delete(entry));
  };
  const engineStorage = {
    ...storage,
    store: {
      ...storage.store,
      reinforce: (ids: string[], at?: string): Promise<void> => trackWrite(storage.store.reinforce(ids, at)),
    },
  };

  const projectIdByKey = new Map<string, string | null>([[GLOBAL_PROJECT_KEY, null]]);
  try {
    for (const project of dataset.projects) {
      const created = await storage.store.createProject({
        name: project.name,
        ...(project.description === undefined ? {} : { description: project.description }),
      });
      projectIdByKey.set(project.key, created.id);
    }

    for (const event of dataset.events) {
      const projectId = projectIdByKey.get(event.project);
      if (projectId === undefined) {
        throw new Error(`benchmark fixture event references unknown project '${event.project}'`);
      }
      const outcome = await storage.store.ingestEvent(buildEvent(dataset, event, projectId));
      if (outcome.status !== 'stored') {
        warnings.push(
          `event at offset ${event.offset_seconds}s (${event.kind}) was not stored: ${outcome.status}`,
        );
      }
    }

    const extractHandler = createExtractHandler(
      storage.store,
      storage.jobs,
      createHeuristicExtractor(),
      createHeuristicClassifier(),
      { enqueueReEmbed: false, maxEvents: dataset.events.length + 16 },
    );
    const extraction = await extractHandler({
      id: `bench:${dataset.id}`,
      kind: 'extract',
      payload: {},
    });

    const records = await storage.store.queryCurrent({});
    const corpus = records.map(toCorpusMemory);

    const facts = new Map<string, ResolvedFact>();
    for (const fact of dataset.facts) {
      const memory = resolveUnique(corpus, fact.match, projectIdByKey, `fact '${fact.key}'`);
      facts.set(fact.key, {
        key: fact.key,
        description: fact.description,
        scenario: fact.scenario,
        memory,
      });
    }

    // Explicit, audited supersession — the dataset's declared ground truth. Declared supersessions
    // run BEFORE the automatic pass (their windows close `valid_until`, so a declared loser can
    // never be re-detected by the contradiction pass — declared beats automatic by construction).
    const superseded = new Set<string>();
    for (const supersession of dataset.supersessions) {
      const loser = resolveUnique(corpus, supersession.loser, projectIdByKey, 'supersession.loser');
      const winner = resolveUnique(corpus, supersession.winner, projectIdByKey, 'supersession.winner');
      await storage.store.updateMemoryStatus(loser.id, 'superseded', {
        actor: 'bench:supersession',
        reason: supersession.reason,
        valid_until: winner.observed_at,
        superseded_by_id: winner.id,
      });
      superseded.add(loser.id);
    }

    // The M14 automatic consolidation pass — dataset opt-in only (`consolidation_pass`). Runs with
    // the dataset's deterministic clock so decay/prominence see the same `now` the probes do.
    // No embedder and no router are wired (offline default): contradiction resolution and decay
    // run; derivation and near-duplicate merge skip with recorded warnings.
    let consolidation: ConsolidationPassSummary | null = null;
    if (dataset.consolidation_pass !== undefined) {
      const report = await runConsolidation({
        store: storage.store,
        actor: dataset.consolidation_pass.actor,
        now: () => new Date(dataset.now),
        ...(dataset.consolidation_pass.config === undefined
          ? {}
          : { config: dataset.consolidation_pass.config }),
      });
      consolidation = summarizeConsolidation(report);
      warnings.push(...report.warnings);
    }

    const engine = createRetrievalEngine(engineStorage, {
      now: () => new Date(dataset.now),
    });

    const network_attempts = networkGuard === null ? null : networkGuard.count;

    return {
      engine,
      corpus,
      facts,
      project_ids: projectIdByKey,
      superseded,
      consolidation,
      extraction,
      network_attempts,
      warnings,
      async close(): Promise<void> {
        await Promise.allSettled([...inflight]);
        inflight.clear();
        await storage.close();
        networkGuard?.restore();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Never leak the PGlite instance or the guard on a setup failure.
    await Promise.allSettled([...inflight]);
    await storage.close().catch(() => {});
    networkGuard?.restore();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
