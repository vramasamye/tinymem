/**
 * The composition root: config → storage → security → embedder → retrieval engine → model router
 * → job handlers → worker.
 *
 * This is the ONE place that knows how the pieces fit (AGENTS.md: "the server composition root
 * wires…"). The daemon calls it to build the process, the CLI calls it for direct (no-daemon) mode,
 * and the API's service layer only ever sees the resulting {@link OnememoryRuntime}. A later MCP
 * server (M5) can reuse it unchanged.
 *
 * Ordering matters and is explicit below: the privacy guard is installed before anything can make
 * a request; the vector index is bound to the configured embedder's model/dimension *before* the
 * `re_embed` handler is constructed, so a drift becomes a construction error (fail closed) rather
 * than a database error later.
 */

import { mkdirSync } from 'node:fs';

import {
  exclusionGlobs,
  loadConfig,
  networkGuardPlan,
  redactionOptions,
  routerConfigFrom,
  embedderSelection,
  vectorIndexBinding,
  type OnememoryConfig,
  type LoadedConfig,
  type RedactionOptions,
} from '@onememory/config';
import {
  createCodeMemoryOrchestration,
  createCodeMemoryScheduler,
  parseDriftScanJobPayload,
  parseReindexJobPayload,
  type CodeMemoryOrchestrationStatus,
  type DriftScanInput,
  type DriftScanResult,
  type ReindexInput,
  type ReindexResult,
} from '@onememory/codememory';
import type { Extractor, JobKind } from '@onememory/core';
import { createReEmbedJobHandler, type EmbedderHandle } from '@onememory/embeddings';
import {
  createExtractHandler,
  createFallbackExtractor,
  createHeuristicClassifier,
  createHeuristicExtractor,
  createLlmExtractor,
  createNormalizeHandler,
} from '@onememory/extraction';
import { createModelRouter, type ModelRouter } from '@onememory/llm';
import { createRetrievalEngine, type RetrievalEngine } from '@onememory/retrieval';
import {
  createPathExclusionPolicy,
  createRedactor,
  installNetworkGuard,
  NetworkGuardError,
  type NetworkGuard,
  type PathExclusionPolicy,
} from '@onememory/security';
import {
  DEFAULT_VECTOR_CONFIG,
  createEmbeddedDb,
  createHandlerRegistry,
  createJobWorker,
  createServerDb,
  type HandlerRegistry,
  type JobHandler,
  type JobWorker,
  type OnememoryStorage,
  type VectorConfig,
} from '@onememory/storage';

import { createEmbedder, type EmbedderFactoryOptions } from './embedder';

/** Non-fatal degradation recorded while wiring (surfaced by doctor/stats, never silent). */
export interface RuntimeDegradation {
  /** Times the LLM extractor failed and the heuristic path took over. */
  fallback_extractions: number;
  last_fallback: string | null;
  /** False when the embedder/index/router refused to bind (see `warnings`). */
  re_embed_registered: boolean;
}

/** How code-memory orchestration is wired into this runtime (doctor + CLI/MCP exposure). */
export interface CodeMemoryRuntimeInfo {
  /** True while the periodic drift-scan scheduler is armed. */
  readonly scheduler_running: boolean;
  /** The configured drift-scan interval in milliseconds. */
  readonly scheduler_interval_ms: number;
  /** The registered project the scheduler scans (null when none is registered). */
  readonly project_id: string | null;
  /** Last-pass timestamps and the scanned project (live). */
  status(): CodeMemoryOrchestrationStatus;
  /** Run one drift scan now (the `drift_scan` handler's body). */
  runDriftScan(input: DriftScanInput): Promise<DriftScanResult>;
  /** Run one re-index + digest pass now (the `reindex` handler's body). */
  runReindex(input: ReindexInput): Promise<ReindexResult>;
}

export interface OnememoryRuntime {
  readonly config: OnememoryConfig;
  readonly loaded: LoadedConfig;
  readonly storage: OnememoryStorage;
  readonly embedder: EmbedderHandle | null;
  readonly engine: RetrievalEngine;
  readonly router: ModelRouter;
  readonly extractor: Extractor;
  readonly worker: JobWorker;
  readonly handlers: HandlerRegistry;
  readonly registered_kinds: string[];
  readonly exclusionPolicy: PathExclusionPolicy;
  readonly redaction: RedactionOptions;
  /** Compiled once per process (ADR-0007: the write path redacts before anything is persisted). */
  readonly redactor: ReturnType<typeof createRedactor>;
  readonly networkGuard: NetworkGuard | null;
  readonly degradation: RuntimeDegradation;
  /** Code-memory orchestration handle (always present; the scheduler only runs with the worker). */
  readonly code_memory: CodeMemoryRuntimeInfo;
  readonly warnings: string[];
  readonly started_at: number;
  readonly worker_running: boolean;
  stopWorker(): Promise<void>;
  close(): Promise<void>;
}

/** Default drift-scan interval: frequent enough to notice edits, cheap enough to run all day. */
export const DEFAULT_DRIFT_SCAN_INTERVAL_MS = 300_000;

export interface OpenRuntimeOptions {
  cwd?: string;
  configPath?: string | null;
  env?: Record<string, string | undefined>;
  /** Require a config file (default true; `false` uses built-in local defaults). */
  requireConfig?: boolean;
  /** Apply committed migrations on open (default true; idempotent). */
  migrate?: boolean;
  /** Start the job worker loop (daemon: true; CLI direct mode: false). */
  startWorker?: boolean;
  /** Start the periodic drift-scan scheduler alongside the worker (default true). */
  codeMemoryScheduler?: boolean;
  /** Drift-scan interval in milliseconds (default {@link DEFAULT_DRIFT_SCAN_INTERVAL_MS}). */
  driftScanIntervalMs?: number;
  /** Install the M12 network guard when the config plan says so (default true). */
  installNetworkGuard?: boolean;
  /** Injectable clock for deterministic retrieval behaviour. */
  now?: () => Date;
  /** Test seams for the embedder factories (no network, no model download). */
  embedderFactory?: EmbedderFactoryOptions;
  /** Where runtime messages go (default: `process.stderr` via console.error). */
  onWarning?: (message: string) => void;
}

function vectorConfigFor(config: OnememoryConfig): VectorConfig {
  const binding = vectorIndexBinding(config);
  return {
    model: binding.model ?? DEFAULT_VECTOR_CONFIG.model,
    dim: binding.dim ?? DEFAULT_VECTOR_CONFIG.dim,
    backend: binding.backend,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open storage for the configured profile. Embedded mode creates the data directory; the embedded
 * database is single-owner (ADR-0002) — the caller must have checked the daemon lock first.
 */
export async function openStorage(options: {
  loaded: LoadedConfig;
  vector: VectorConfig;
  migrate?: boolean;
}): Promise<OnememoryStorage> {
  const { loaded } = options;
  if (loaded.config.storage.mode === 'server') {
    if (loaded.pg_url === null) {
      // loadConfig's cross-field rule makes this unreachable; kept as a hard invariant.
      throw new Error('storage.mode: server without a resolved pg_url');
    }
    return createServerDb(loaded.pg_url, {
      vector: options.vector,
      ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
    });
  }
  mkdirSync(loaded.paths.data_dir, { recursive: true });
  return createEmbeddedDb(loaded.paths.data_dir, {
    vector: options.vector,
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  });
}

/** The daemon's handler registry, built exactly as mission-3.md §9 specifies. */
export interface RuntimeHandlerDeps {
  storage: OnememoryStorage;
  engine: RetrievalEngine;
  extractor: Extractor;
  /** Absent → `re_embed` stays unregistered and the worker dead-letters it loudly. */
  embedder: EmbedderHandle | null;
  /** Pending events read before an extract pass, to know which projects' caches to invalidate. */
  extractMaxEvents?: number;
}

export interface RuntimeHandlers {
  handlers: Partial<Record<JobKind, JobHandler>>;
  registered_kinds: string[];
  warnings: string[];
}

export function createRuntimeHandlers(deps: RuntimeHandlerDeps): RuntimeHandlers {
  const warnings: string[] = [];
  const handlers: Partial<Record<JobKind, JobHandler>> = {};

  const normalize = createNormalizeHandler(deps.storage.store, deps.storage.jobs);
  handlers.normalize = async ({ job }) => {
    await normalize(job);
  };

  const extract = createExtractHandler(deps.storage.store, deps.storage.jobs, deps.extractor, createHeuristicClassifier(), {
    // Nothing can be embedded without an embedder: skipping the enqueue keeps the queue honest
    // instead of dead-lettering backfill jobs that could never run.
    enqueueReEmbed: deps.embedder !== null,
  });
  const extractMaxEvents = deps.extractMaxEvents ?? 100;
  handlers.extract = async ({ job }) => {
    // retrieval.md §5: every durable write path invalidates the result cache. The project ids are
    // read before the pass because the handler marks the events processed (and the Store port has
    // no "which projects did that write to" answer). With no project in the batch the cache is
    // cleared wholesale — coarser, never wrong.
    const pending = await deps.storage.store.listPendingEvents(extractMaxEvents);
    await extract(job);
    const projectIds = new Set<string>();
    let includesGlobalScope = false;
    for (const event of pending) {
      if (typeof event.project_id === 'string') projectIds.add(event.project_id);
      else includesGlobalScope = true;
    }
    // Unscoped queries see every project, so a global-scope write (or an empty batch) clears all.
    if (includesGlobalScope || projectIds.size === 0) deps.engine.invalidateCache();
    else for (const id of projectIds) deps.engine.invalidateCache(id);
  };

  if (deps.embedder !== null) {
    // Fail-closed provenance: this constructor throws when embedder, embedder metadata and vector
    // index disagree about model/dimension (ADR-0006 §5).
    try {
      const reEmbed = createReEmbedJobHandler(deps.storage.vectors, deps.embedder, deps.embedder.meta);
      handlers.re_embed = async ({ job }) => {
        await reEmbed(job);
      };
    } catch (error) {
      warnings.push(
        `re_embed handler not registered: ${errorMessage(error)} — vectors will not be written until the embedder, its metadata, and the vector index agree`,
      );
    }
  } else {
    warnings.push(
      're_embed handler not registered: no embedder configured (embeddings.provider) — vector search stays off and extraction enqueues no backfill jobs',
    );
  }

  return { handlers, registered_kinds: Object.keys(handlers), warnings };
}

/**
 * Build the full runtime. Always resolves; degradations are reported through `warnings` and the
 * doctor report rather than thrown, because a lexical-only onememory is a working onememory.
 */
export async function openRuntime(options: OpenRuntimeOptions = {}): Promise<OnememoryRuntime> {
  const loaded: LoadedConfig = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.requireConfig === undefined ? {} : { required: options.requireConfig }),
  });

  const warnings: string[] = [...loaded.warnings];
  const onWarning =
    options.onWarning ??
    ((message: string) => {
      console.error(`onememory: ${message}`);
    });
  for (const warning of warnings) onWarning(warning);

  // 1. Privacy guard first: nothing downstream may make a request before this decision is applied.
  //    The guard patches the PROCESS, not the runtime: if another runtime in this process already
  //    installed one (tests, an embedded SDK use), the first installation keeps protecting and the
  //    second open says so instead of failing — every request is still blocked either way.
  const guardPlan = networkGuardPlan(loaded.config);
  let networkGuard: NetworkGuard | null = null;
  if (options.installNetworkGuard !== false && guardPlan.enforce) {
    try {
      networkGuard = installNetworkGuard();
    } catch (error) {
      if (error instanceof NetworkGuardError && error.message.includes('already installed')) {
        warnings.push(
          'network guard: another runtime in this process already installed the guard; that instance keeps protecting every request',
        );
      } else {
        throw error;
      }
    }
  }

  // 2. Storage (single owner process in embedded mode).
  const vectorConfig = vectorConfigFor(loaded.config);
  const storage = await openStorage({
    loaded,
    vector: vectorConfig,
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  });

  // The retrieval engine's REINFORCE stage fires `void store.reinforce(...)` — a floating write
  // that must not race `close()`: PGlite's close waits for in-flight queries indefinitely, so a
  // short-lived CLI process that closes right after a search can deadlock. This seam is the only
  // place storage and the engine meet, so the floating writes are tracked here and drained before
  // storage closes. (Fix scoped to the composition root; engine.ts is mission-2's file.)
  const inflightWrites = new Set<Promise<unknown>>();
  const trackWrite = <T>(promise: Promise<T>): Promise<T> => {
    const entry: Promise<unknown> = promise;
    inflightWrites.add(entry);
    return promise.finally(() => {
      inflightWrites.delete(entry);
    });
  };
  const engineStorage: OnememoryStorage = {
    ...storage,
    store: {
      ...storage.store,
      reinforce: (memoryIds: string[], at?: string): Promise<void> =>
        trackWrite(storage.store.reinforce(memoryIds, at)),
    },
  };

  // 3. Embedder + retrieval engine.
  const selection = embedderSelection(loaded.config);
  const embedder = createEmbedder(selection, options.embedderFactory ?? {});
  if (embedder === null) {
    warnings.push(
      'no embedder configured (embeddings.provider): search runs lexical + graph only, semantic recall is off',
    );
  }
  const engine = createRetrievalEngine(engineStorage, {
    ...(embedder === null ? {} : { embedder }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // 4. Model router + extractor (heuristics are the zero-model baseline; the LLM path degrades).
  const router = createModelRouter(routerConfigFrom(loaded.config), {
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const degradation: RuntimeDegradation = {
    fallback_extractions: 0,
    last_fallback: null,
    re_embed_registered: false,
  };
  const extractor = createFallbackExtractor(createLlmExtractor({ router }), createHeuristicExtractor(), {
    onFallback: (error) => {
      degradation.fallback_extractions += 1;
      degradation.last_fallback = errorMessage(error);
    },
  });

  // 5. Job handlers + worker.
  const runtimeHandlers = createRuntimeHandlers({ storage, engine, extractor, embedder });
  warnings.push(...runtimeHandlers.warnings);
  degradation.re_embed_registered = runtimeHandlers.handlers.re_embed !== undefined;

  const exclusionPolicy = createPathExclusionPolicy({ globs: exclusionGlobs(loaded.config) });
  const redactionConfig = redactionOptions(loaded.config);
  const redactor = createRedactor(redactionConfig);

  // 5b. Code-memory orchestration (M4f): drift_scan + reindex handlers and the periodic scheduler
  //     that feeds them. The extraction pipeline is COMPOSED (the same extractor + classifier the
  //     `extract` job uses), never re-implemented, and re-read file text is redacted before it can
  //     reach a candidate.
  const classifier = createHeuristicClassifier();
  const orchestration = createCodeMemoryOrchestration({
    store: storage.store,
    codeMemory: storage.codeMemory,
    jobs: storage.jobs,
    extractor,
    classify: (candidate) => classifier.classify(candidate),
    projectId: loaded.project_state?.project_id ?? null,
    rootPath: loaded.paths.root,
    exclusionGlobs: exclusionGlobs(loaded.config),
    redactText: (text) => redactor.redactSync(text).value as string,
    enqueueReEmbed: embedder !== null,
    onWarning,
  });

  runtimeHandlers.handlers.drift_scan = async ({ job }) => {
    await orchestration.runDriftScan(parseDriftScanJobPayload(job.payload));
  };
  runtimeHandlers.handlers.reindex = async ({ job }) => {
    await orchestration.runReindex(parseReindexJobPayload(job.payload));
  };
  runtimeHandlers.registered_kinds = Object.keys(runtimeHandlers.handlers);

  const driftScanIntervalMs = Math.max(
    1_000,
    options.driftScanIntervalMs ?? DEFAULT_DRIFT_SCAN_INTERVAL_MS,
  );
  const scheduler = createCodeMemoryScheduler({
    intervalMs: driftScanIntervalMs,
    tick: async () => {
      await orchestration.tick();
    },
    onError: (error) => onWarning(`code-memory schedule pass failed: ${errorMessage(error)}`),
  });

  const registry = createHandlerRegistry(runtimeHandlers.handlers);
  const worker = createJobWorker({
    db: storage.client,
    registry,
    pollIntervalMs: loaded.config.daemon.poll_interval_ms,
    batchSize: loaded.config.daemon.concurrency,
    leaseSeconds: loaded.config.daemon.lease_seconds,
    onError: (error, job) => {
      onWarning(`job ${job?.kind ?? '?'} ${job?.id ?? ''} failed: ${errorMessage(error)}`);
    },
  });
  let workerRunning = false;
  let schedulerRunning = false;
  if (options.startWorker === true) {
    worker.start();
    workerRunning = true;
    if (options.codeMemoryScheduler !== false) {
      scheduler.start();
      schedulerRunning = true;
    }
  }

  async function stopWorker(): Promise<void> {
    // Stop the scheduler first: no new drift_scan jobs may be enqueued while the worker drains.
    if (schedulerRunning) {
      await scheduler.stop();
      schedulerRunning = false;
    }
    if (!workerRunning) return;
    await worker.stop();
    workerRunning = false;
  }

  async function close(): Promise<void> {
    await stopWorker();
    // Drain the engine's fire-and-forget writes before the database disappears underneath them
    // (see `inflightWrites` above): loss is acceptable to the engine, a wedged close is not.
    await Promise.allSettled([...inflightWrites]);
    inflightWrites.clear();
    await storage.close();
    networkGuard?.restore();
  }

  return {
    config: loaded.config,
    loaded,
    storage,
    embedder,
    engine,
    router,
    extractor,
    worker,
    handlers: registry,
    registered_kinds: runtimeHandlers.registered_kinds,
    exclusionPolicy,
    redaction: redactionConfig,
    redactor,
    networkGuard,
    degradation,
    code_memory: {
      scheduler_interval_ms: driftScanIntervalMs,
      project_id: loaded.project_state?.project_id ?? null,
      get scheduler_running(): boolean {
        return schedulerRunning;
      },
      status: () => orchestration.status(),
      runDriftScan: (input) => orchestration.runDriftScan(input),
      runReindex: (input) => orchestration.runReindex(input),
    },
    warnings,
    started_at: Date.now(),
    get worker_running(): boolean {
      return workerRunning;
    },
    stopWorker,
    close,
  };
}
