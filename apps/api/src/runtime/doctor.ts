/**
 * `onemem doctor` — the health gate, as a shared library (the CLI, the REST API and, later, the
 * adapters all call it).
 *
 * Three rules shape every check:
 *
 * 1. **Honest status.** A check is `pass`, `warn` or `fail`, with the evidence that produced it.
 *    Nothing is reported green on optimism, and nothing is reported red because it is optional.
 * 2. **Degraded is a state, not a failure.** No embedder, no LLM route and a missing `re_embed`
 *    handler are all *working* configurations (lexical+graph retrieval, heuristic extraction), so
 *    they warn — the offline default must pass.
 * 3. **Fail closed where correctness is at stake.** A dimension/model disagreement between the
 *    embedder, its recorded metadata and the vector index is a `fail` with a remediation, exactly
 *    as the `re_embed` handler would refuse it (ADR-0006 §5).
 *
 * The overall exit code is 0 unless a check fails.
 */

import {
  configSummary,
  networkGuardPlan,
  type ConfigSummary,
  type LoadedConfig,
  type OnememoryConfig,
} from '@onememory/config';
import {
  buildArchitectureDigest,
  DEFAULT_DIGEST_BUDGET_TOKENS,
  isCurrentArchitectureDigest,
  loadDigestInputs,
} from '@onememory/codememory';
import { memoryContentHash } from '@onememory/core';
import { MODEL_OPERATIONS } from '@onememory/llm';
import { PATTERN_GROUPS } from '@onememory/security';
import { DEFAULT_VECTOR_CONFIG } from '@onememory/storage';

import type { OnememoryRuntime } from './composition';
import { daemonMcpUrl, runtimeScaffoldChecks } from './runtime-scaffolds';
import { ONEMEMORY_VERSION } from './version';

/**
 * `info` is reserved for facts that are neither healthy nor degraded — an opt-in feature left
 * off (an agent runtime not wired). It never changes the report status or exit code.
 */
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  status: 'ok' | 'degraded' | 'failed';
  /** Process exit code the CLI should use (0 = usable, 1 = a failing check). */
  exit_code: 0 | 1;
  generated_at: string;
  version: string;
  config_path: string | null;
  /** `null` only when the configuration itself could not be loaded. */
  config: ConfigSummary | null;
  /** Counts over `checks` + `runtimes`; derived by {@link finalizeDoctorReport}, never by hand. */
  summary: { pass: number; warn: number; fail: number; info: number };
  checks: DoctorCheck[];
  /**
   * The agent-runtime wiring group (Claude Code, Codex): project-scope scaffolds vs the configured
   * daemon MCP URL. Counted in `summary` like `checks`.
   */
  runtimes: DoctorCheck[];
}

export interface DoctorOptions {
  /** Probe the configured embedder (dimension discovery). Default true. */
  probeEmbedder?: boolean;
}

function check(
  id: string,
  title: string,
  status: DoctorCheckStatus,
  detail: string,
  remediation?: string,
): DoctorCheck {
  return remediation === undefined ? { id, title, status, detail } : { id, title, status, detail, remediation };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function configCheck(config: OnememoryConfig, loaded: LoadedConfig): Promise<DoctorCheck> {
  const summary = configSummary(config, loaded.paths.config_path, loaded.paths.data_dir);
  return check(
    'config',
    'configuration',
    'pass',
    `loaded ${loaded.paths.config_path ?? '(built-in defaults)'}; version ${config.version}; llm profile ${config.llm.profile}; data dir ${summary.storage.data_dir}`,
  );
}

async function storageCheck(runtime: OnememoryRuntime): Promise<DoctorCheck> {
  try {
    // The migrations are applied by the driver on open; re-running is a no-op (drizzle journal),
    // and a port call proves the schema actually answers.
    await runtime.storage.migrate();
    await runtime.storage.store.listPendingEvents(1);
    return check(
      'storage',
      'storage',
      'pass',
      `${runtime.storage.profile} profile reachable at ${runtime.storage.profile === 'embedded' ? runtime.loaded.paths.data_dir : '(pg_url)'}; migrations applied (idempotent runner); queries answered`,
    );
  } catch (error) {
    return check(
      'storage',
      'storage',
      'fail',
      `storage is not usable: ${errorMessage(error)}`,
      runtime.storage.profile === 'embedded'
        ? 'check write access to the data directory; if the directory is held by a running daemon, stop it first (embedded storage has exactly one owner process)'
        : 'check storage.pg_url / the referenced environment variable and that the server is reachable with the vector extension installed',
    );
  }
}

function vectorBackendCheck(runtime: OnememoryRuntime): DoctorCheck {
  const backend = runtime.storage.vectors.backend;
  const detail = `vector backend: ${backend} (index: ${runtime.storage.vectors.model} @ ${runtime.storage.vectors.dim} dims)`;
  if (backend === 'pgvector') return check('vector-backend', 'vector index', 'pass', detail);
  return check(
    'vector-backend',
    'vector index',
    'warn',
    `${detail} — the in-process float8 fallback is in use (GATE-1 insurance seam, not the primary path)`,
    'install the pgvector extension (@electric-sql/pglite-pgvector loads it automatically in embedded mode; server mode needs CREATE EXTENSION vector)',
  );
}

async function embedderChecks(runtime: OnememoryRuntime, probe: boolean): Promise<DoctorCheck[]> {
  const embedder = runtime.embedder;
  const committedDim = DEFAULT_VECTOR_CONFIG.dim;
  if (embedder === null) {
    return [
      check(
        'embedder',
        'embedding model',
        'warn',
        'no embedder configured: search runs the lexical + graph channels only, and extraction enqueues no vector backfill jobs',
        'optional: set embeddings.provider/model (ollama, openai-compatible, or local-transformers) and run onemem doctor again — the local-first default works without it',
      ),
    ];
  }

  const base = `embedder: ${embedder.provider}/${embedder.model}`;
  if (!probe) {
    return [check('embedder', 'embedding model', 'warn', `${base} — not probed (probeEmbedder: false)`)];
  }

  let dim: number | null;
  let revision: string | null;
  try {
    const meta = await embedder.probe();
    dim = meta.dim;
    revision = meta.revision;
  } catch (error) {
    return [
      check(
        'embedder',
        'embedding model',
        'fail',
        `${base} probe failed: ${errorMessage(error)}`,
        embedder.provider === 'local-transformers'
          ? "the optional peer dependency '@huggingface/transformers' may be missing or the pinned weights are not cached: install it and run the probe once with network access, or use ollama/openai-compatible"
          : 'confirm the local embedding service is running and reachable at the configured base_url',
      ),
    ];
  }

  const checks: DoctorCheck[] = [
    check(
      'embedder',
      'embedding model',
      'pass',
      `${base}; probe succeeded${dim === null ? '' : ` → ${dim} dimensions`}${revision === null ? '' : `; revision ${revision}`}`,
    ),
  ];

  if (dim === null) {
    checks.push(
      check(
        'embedder-dimension',
        'embedding dimension',
        'fail',
        `${base} reported no dimension`,
        'the provider must report a dimension on its first response; check the endpoint and model name',
      ),
    );
    return checks;
  }

  const configuredDim = runtime.config.embeddings.dim ?? null;
  if (configuredDim !== null && configuredDim !== dim) {
    checks.push(
      check(
        'embedder-dimension',
        'embedding dimension',
        'fail',
        `embeddings.dim is ${configuredDim} but ${base} produced ${dim} dimensions`,
        'fix embeddings.dim to match the model (a mismatch would mix incompatible vectors; ADR-0006 §5)',
      ),
    );
  } else if (runtime.storage.vectors.dim !== dim) {
    checks.push(
      check(
        'embedder-dimension',
        'embedding dimension',
        'fail',
        `${base} produces ${dim} dimensions but the vector index is bound to ${runtime.storage.vectors.dim}`,
        'align embeddings.dim with the vector index; re_embed refuses mismatches rather than mixing vectors',
      ),
    );
  } else {
    checks.push(
      check(
        'embedder-dimension',
        'embedding dimension',
        'pass',
        `${base} → ${dim} dimensions; agrees with embeddings.dim and the vector index`,
      ),
    );
  }

  if (runtime.storage.vectors.model !== embedder.model) {
    checks.push(
      check(
        'embedder-model',
        'embedding model identity',
        'fail',
        `the vector index is bound to '${runtime.storage.vectors.model}' but the embedder produces '${embedder.model}'`,
        'vectors from different models never mix (ADR-0006 §5): align the config, then run a re_embed with reason model_change',
      ),
    );
  }

  if (dim !== committedDim) {
    checks.push(
      check(
        'vector-column',
        'vector column dimension',
        'fail',
        `${dim} dimensions do not fit the committed schema: memory_vectors.embedding is vector(${committedDim})`,
        `use a ${committedDim}-dimension model (e.g. Xenova/bge-small-en-v1.5) or ship a migration that alters the column and then re-embed every memory (ADR-0006 §5)`,
      ),
    );
  } else {
    checks.push(
      check(
        'vector-column',
        'vector column dimension',
        'pass',
        `${dim} dimensions match the committed memory_vectors.embedding column (vector(${committedDim}))`,
      ),
    );
  }
  return checks;
}

function routerCheck(runtime: OnememoryRuntime): DoctorCheck {
  const routed = MODEL_OPERATIONS.filter((operation) => runtime.config.llm.routes[operation] !== undefined);
  const unconfigured = MODEL_OPERATIONS.filter((operation) => runtime.config.llm.routes[operation] === undefined);
  if (routed.length === 0) {
    return check(
      'router',
      'model router',
      'warn',
      `profile ${runtime.config.llm.profile}: no operation is routed — extraction runs the heuristic baseline and query understanding stays rule-based (correct, just less recall)`,
      'optional: configure llm.providers + llm.routes (e.g. ollama) to enable the LLM extractor',
    );
  }
  return check(
    'router',
    'model router',
    unconfigured.length === 0 ? 'pass' : 'warn',
    `profile ${runtime.config.llm.profile}; routed: ${routed.join(', ')}${unconfigured.length === 0 ? '' : `; unconfigured (degraded to heuristics/lexical): ${unconfigured.join(', ')}`}`,
  );
}

function networkGuardCheck(runtime: OnememoryRuntime): DoctorCheck {
  const plan = networkGuardPlan(runtime.config);
  const attempts = runtime.networkGuard?.count ?? 0;
  if (runtime.networkGuard !== null) {
    return check(
      'network-guard',
      'privacy network guard',
      'pass',
      `enforced (${plan.reason}); outbound attempts recorded: ${attempts}`,
    );
  }
  return check(
    'network-guard',
    'privacy network guard',
    'warn',
    `not enforced — ${plan.reason}`,
    plan.network_capable.length === 0
      ? 'set security.network_guard: enforce to install the M12 guard for this process'
      : 'network-capable components are configured (loopback endpoints are permitted); the guard blocks every fetch, including loopback, so it cannot be combined with them yet (coordinator follow-up)',
  );
}

function handlerCheck(runtime: OnememoryRuntime): DoctorCheck {
  const kinds = runtime.registered_kinds;
  const missing = ['normalize', 'extract'].filter((kind) => !kinds.includes(kind));
  if (missing.length > 0) {
    return check(
      'handlers',
      'job handlers',
      'fail',
      `the daemon would dead-letter ${missing.join(', ')} jobs (registered: ${kinds.join(', ') || 'none'})`,
    );
  }
  const detail = `registered handlers: ${kinds.join(', ')}${runtime.degradation.re_embed_registered ? '' : ' (re_embed absent: no embedder)'}`;
  return check('handlers', 'job handlers', runtime.degradation.re_embed_registered ? 'pass' : 'warn', detail);
}

function retentionCheck(runtime: OnememoryRuntime): DoctorCheck {
  const days = runtime.config.daemon.retention_days;
  if (days === 0) {
    return check('retention', 'raw-event retention', 'pass', 'retention_days: 0 — raw events are kept forever');
  }
  return check(
    'retention',
    'raw-event retention',
    'warn',
    `retention_days: ${days} (decision D4) — but no scheduled compaction exists: no job kind performs raw-event compaction, so nothing is being deleted`,
    'implementing retention requires a new job kind or a coordinator-approved scheduled job (see the mission-13 report follow-ups); until then retention is configured-only',
  );
}

function jobsCheck(): DoctorCheck {
  return check(
    'job-queue',
    'job queue',
    'warn',
    'job queue statistics are unavailable: neither the JobQueue port nor @onememory/storage exposes a job-count query',
    'coordinator follow-up: add a read-only jobs statistic to the storage repository layer (the mission-13 report lists it)',
  );
}

/**
 * The code-memory / drift section (M4f): how much code the engine tracks, how much of it is stale,
 * whether the architecture digest matches the current code shape, and whether the drift-scan
 * scheduler is actually armed. This is a read over the `CodeMemoryStore` and `Store` ports —
 * no git, no model, no network. Every lookup is guarded: a failure fails THIS check, never the
 * report.
 *
 * Status rules follow the doctor's honesty contract: a lookup failure is a `fail`; a project with
 * no registered repository, or one whose scheduler is not running, is `warn` (degraded, usable);
 * an armed scheduler over a registered repository is `pass`. It is never `info`, so the report's
 * informational count stays owned by the runtime-wiring group.
 */
export async function codeMemoryCheck(runtime: OnememoryRuntime): Promise<DoctorCheck> {
  const info = runtime.code_memory;
  const projectId = info.project_id;
  if (projectId === null) {
    return check(
      'code-memory',
      'code memory / drift',
      'warn',
      'no project is registered: code fingerprints and drift scanning are inactive',
      'run onemem init in the project root to register it, then onemem serve',
    );
  }

  let repositories: Awaited<ReturnType<OnememoryRuntime['storage']['codeMemory']['listRepositories']>>;
  try {
    repositories = await runtime.storage.codeMemory.listRepositories(projectId);
  } catch (error) {
    return check(
      'code-memory',
      'code memory / drift',
      'fail',
      `the code-memory repository registry could not be read: ${errorMessage(error)}`,
      'check the storage profile and that migrations are applied (onemem migrate)',
    );
  }

  if (repositories.length === 0) {
    return check(
      'code-memory',
      'code memory / drift',
      'warn',
      'no code repository is registered yet: no fingerprint has been captured for this project',
      'the daemon registers the project root and enqueues drift scans on its interval (onemem serve)',
    );
  }

  let refs = 0;
  let lastIndexed: string | null = null;
  try {
    for (const repository of repositories) {
      refs += (await runtime.storage.codeMemory.listCodeRefs(repository.id)).length;
      if (repository.last_indexed_at !== null && (lastIndexed === null || repository.last_indexed_at > lastIndexed)) {
        lastIndexed = repository.last_indexed_at;
      }
    }
  } catch (error) {
    return check(
      'code-memory',
      'code memory / drift',
      'fail',
      `code references could not be read: ${errorMessage(error)}`,
    );
  }

  // Every remaining lookup is guarded like its siblings: a store failure fails THIS check, never
  // the whole report (inspectRuntime must always come back with an honest report).
  let stale = 0;
  let digestDetail: string;
  try {
    const current = await runtime.storage.store.queryCurrent({ project_id: projectId, limit: 1000 });
    stale = current.filter((memory) => memory.status === 'stale').length;

    // Digest presence is PROBED, not window-scavenged: the expected digest text is rebuilt from
    // the same persisted inputs the re-index pass feeds `buildArchitectureDigest`
    // (`loadDigestInputs` is the shared assembly), then located through the Store's exact-dedupe
    // probe — indexed and windowless, so a long-unchanged digest in a busy project is found at any
    // age instead of being reported "not built" because it fell outside a recency window.
    const inputs = await loadDigestInputs(runtime.storage.codeMemory, projectId, repositories);
    const digest = buildArchitectureDigest({
      repositories: inputs,
      budgetTokens: DEFAULT_DIGEST_BUDGET_TOKENS,
    });
    if (digest.file_count === 0 && digest.symbol_count === 0) {
      digestDetail = 'architecture digest not built (no code data captured yet)';
    } else {
      const found = await runtime.storage.store.findDuplicate(
        { project_id: projectId },
        'semantic',
        memoryContentHash(digest.text),
      );
      digestDetail = isCurrentArchitectureDigest(found)
        ? `architecture digest present and current (${digest.tokens} tokens${digest.truncated ? ', truncated' : ''})`
        : 'architecture digest not found for the current code shape (the daemon\'s re-index pass rebuilds it after each drift scan)';
    }
  } catch (error) {
    return check(
      'code-memory',
      'code memory / drift',
      'fail',
      `the current-memory or digest lookup failed: ${errorMessage(error)}`,
      'check the storage profile and that migrations are applied (onemem migrate)',
    );
  }

  const status = info.status();
  const intervalSeconds = Math.round(info.scheduler_interval_ms / 1000);
  const detail =
    `${repositories.length} repository(ies), ${refs} tracked code ref(s); ${stale} stale memor(ies); ` +
    `${digestDetail}; last fingerprint ${lastIndexed ?? 'never'}; ` +
    `last drift scan ${status.last_drift_scan_at ?? 'not in this process'}; ` +
    `scheduler ${info.scheduler_running ? `running every ${intervalSeconds}s` : 'not running (direct mode)'}`;

  if (!info.scheduler_running) {
    return check(
      'code-memory',
      'code memory / drift',
      'warn',
      detail,
      'run the daemon (onemem serve) so drift scans and re-indexing run on their interval; direct-mode commands do not schedule them',
    );
  }
  return check('code-memory', 'code memory / drift', 'pass', detail);
}

function redactionCheck(runtime: OnememoryRuntime): DoctorCheck {
  const extra = runtime.config.security.redaction?.extra_patterns?.length ?? 0;
  const excluded = runtime.config.security.exclude_globs.length;
  return check(
    'redaction',
    'secret redaction',
    'pass',
    `${PATTERN_GROUPS.length} detector groups active${extra === 0 ? '' : ` + ${extra} extra pattern(s)`}; redaction happens before persist; ${excluded} additional exclusion glob(s) (the built-in .env/key/credential exclusions cannot be disabled)`,
  );
}

function degradationCheck(runtime: OnememoryRuntime): DoctorCheck | null {
  if (runtime.degradation.fallback_extractions === 0) return null;
  return check(
    'degradation',
    'extraction degradation',
    'warn',
    `the LLM extractor fell back to heuristics ${runtime.degradation.fallback_extractions} time(s); last: ${runtime.degradation.last_fallback ?? '(unknown)'}`,
  );
}

function warningsCheck(runtime: OnememoryRuntime): DoctorCheck | null {
  if (runtime.warnings.length === 0) return null;
  return check('runtime-warnings', 'runtime warnings', 'warn', runtime.warnings.join(' | '));
}

function summarise(checks: DoctorCheck[]): DoctorReport['summary'] {
  return {
    pass: checks.filter((entry) => entry.status === 'pass').length,
    warn: checks.filter((entry) => entry.status === 'warn').length,
    fail: checks.filter((entry) => entry.status === 'fail').length,
    info: checks.filter((entry) => entry.status === 'info').length,
  };
}

/**
 * `status`/`exit_code` are a pure function of the summary: only a `fail` makes onememory unusable
 * (exit 1). A `warn` is degraded-but-usable — the default state of a local install — so it never
 * becomes an error.
 */
function outcome(summary: DoctorReport['summary']): Pick<DoctorReport, 'status' | 'exit_code'> {
  return {
    status: summary.fail > 0 ? 'failed' : summary.warn > 0 ? 'degraded' : 'ok',
    exit_code: summary.fail > 0 ? 1 : 0,
  };
}

/**
 * A report whose derived fields (`summary`, `status`, `exit_code`) do not exist yet: what the
 * assembly sites below build, and the input {@link finalizeDoctorReport} completes. A finished
 * `DoctorReport` also satisfies it — its derived fields are simply replaced.
 */
export type DoctorDraft = Omit<DoctorReport, 'status' | 'exit_code' | 'summary'>;

/**
 * The ONE place `summary`, `status` and `exit_code` are derived. Every code path that assembles a
 * report routes through here — the runtime inspection, the failed-to-open fallback, and any caller
 * that appends checks of its own after inspecting (the CLI's daemon/worker mode check, which can
 * only be chosen once the CLI knows how it resolved the backend).
 *
 * Deriving the counts from the fully assembled checks is the point: computing a summary before a
 * caller appends its check leaves a report whose displayed counts disagree with the checks it
 * lists. `extra` is appended to `report.checks` (never to the `runtimes` group, which the report
 * carries separately), and the result is a new object — neither `report` nor its arrays are
 * mutated.
 */
export function finalizeDoctorReport(
  report: DoctorDraft,
  extra: readonly DoctorCheck[] = [],
): DoctorReport {
  const checks = extra.length === 0 ? report.checks : [...report.checks, ...extra];
  const summary = summarise([...checks, ...report.runtimes]);
  return { ...report, checks, summary, ...outcome(summary) };
}

/** Run the checks against a live runtime (the daemon and the API reuse this). */
export async function inspectRuntime(
  runtime: OnememoryRuntime,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(await configCheck(runtime.config, runtime.loaded));
  checks.push(await storageCheck(runtime));
  checks.push(vectorBackendCheck(runtime));
  checks.push(...(await embedderChecks(runtime, options.probeEmbedder ?? true)));
  checks.push(routerCheck(runtime));
  checks.push(networkGuardCheck(runtime));
  checks.push(handlerCheck(runtime));
  checks.push(await codeMemoryCheck(runtime));
  checks.push(retentionCheck(runtime));
  checks.push(jobsCheck());
  checks.push(redactionCheck(runtime));
  const degradation = degradationCheck(runtime);
  if (degradation !== null) checks.push(degradation);
  const warnings = warningsCheck(runtime);
  if (warnings !== null) checks.push(warnings);

  const projectId = runtime.loaded.project_state?.project_id;
  const runtimes = runtimeScaffoldChecks(runtime.loaded.paths.root, {
    expectedUrl: daemonMcpUrl(runtime.config.daemon),
    storageProfile: runtime.storage.profile,
    ...(projectId === undefined ? {} : { projectId }),
  });

  return finalizeDoctorReport({
    generated_at: new Date().toISOString(),
    version: ONEMEMORY_VERSION,
    config_path: runtime.loaded.paths.config_path,
    config: configSummary(runtime.config, runtime.loaded.paths.config_path, runtime.loaded.paths.data_dir),
    checks,
    runtimes,
  });
}

/** A report for when the runtime could not even be opened (config or storage failure). */
export function failedDoctorReport(
  configPath: string | null,
  reason: string,
  remediation: string,
  checkId: 'config' | 'storage' = 'storage',
): DoctorReport {
  const checks = [
    check(checkId, checkId === 'config' ? 'configuration' : 'storage', 'fail', reason, remediation),
  ];
  return finalizeDoctorReport({
    generated_at: new Date().toISOString(),
    version: ONEMEMORY_VERSION,
    config_path: configPath,
    config: null,
    checks,
    runtimes: [],
  });
}
