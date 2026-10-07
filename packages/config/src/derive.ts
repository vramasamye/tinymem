/**
 * Config → component decisions. Pure functions, no I/O: the runtime composition root
 * (`apps/api/src/runtime`) turns these into live objects, and `onemem doctor` reports them.
 *
 * Keeping the mapping here (not in the CLI) means the daemon, the CLI's direct mode and the tests
 * all make the same decision from the same config — one place to read, one place to change.
 */

import { MODEL_OPERATIONS, isLoopbackBaseUrl, type ModelOperation } from '@onememory-ai/llm';
import type { ExtraPatternInput } from '@onememory-ai/security';

import type { ConfigIssue, OnememoryConfig, VectorBackendSetting } from './schema';
import {
  DEFAULT_OPENAI_COMPATIBLE_EMBED_BASE_URL,
  DEFAULT_OLLAMA_EMBED_BASE_URL,
} from './schema';

// ---------------------------------------------------------------------------
// Embedder selection
// ---------------------------------------------------------------------------

export type EmbedderSelection =
  | {
      provider: 'ollama';
      model: string;
      dim: number | null;
      base_url: string;
      batch_size?: number;
      timeout_ms?: number;
    }
  | {
      provider: 'openai-compatible';
      model: string;
      dim: number | null;
      base_url: string;
      batch_size?: number;
      timeout_ms?: number;
    }
  | {
      provider: 'local-transformers';
      model: string;
      dim: number | null;
      revision?: string;
      batch_size?: number;
      timeout_ms?: number;
    };

/**
 * The configured embedder, or `null` for the offline default (lexical + graph retrieval, warned).
 * `dim: null` means "discover it" — `onemem doctor` probes and compares, and `re_embed` fails
 * closed if the discovered dimension disagrees with the vector index.
 */
export function embedderSelection(config: OnememoryConfig): EmbedderSelection | null {
  const section = config.embeddings;
  if (section.provider === undefined || section.model === undefined) return null;

  const shared = {
    model: section.model,
    dim: section.dim ?? null,
    ...(section.batch_size === undefined ? {} : { batch_size: section.batch_size }),
    ...(section.timeout_ms === undefined ? {} : { timeout_ms: section.timeout_ms }),
  };

  if (section.provider === 'local-transformers') {
    return {
      ...shared,
      provider: 'local-transformers',
      ...(section.revision === undefined ? {} : { revision: section.revision }),
    };
  }
  const baseUrl =
    section.base_url ??
    (section.provider === 'ollama' ? DEFAULT_OLLAMA_EMBED_BASE_URL : DEFAULT_OPENAI_COMPATIBLE_EMBED_BASE_URL);
  return { ...shared, provider: section.provider, base_url: baseUrl };
}

/** The vector index binding implied by config (model/dim null = nothing to bind yet). */
export interface VectorIndexBinding {
  model: string | null;
  dim: number | null;
  backend: VectorBackendSetting;
}

export function vectorIndexBinding(config: OnememoryConfig): VectorIndexBinding {
  const selection = embedderSelection(config);
  return {
    model: selection?.model ?? null,
    dim: selection?.dim ?? null,
    backend: config.storage.vector_backend,
  };
}

// ---------------------------------------------------------------------------
// Privacy: the network guard and redaction
// ---------------------------------------------------------------------------

export interface NetworkGuardPlan {
  enforce: boolean;
  reason: string;
  /** Network-capable components the resolved config enables (embedders, LLM providers). */
  network_capable: string[];
}

/**
 * Decide whether the M12 network guard is installed (ADR-0007, AGENTS.md rule 4).
 *
 * `auto` (default): enforce exactly when the resolved config enables no network-capable component —
 * i.e. no embedding provider and no LLM provider. That is the state the local-first invariant
 * promises ("zero network with the default config").
 *
 * The guard blocks *every* `fetch`, including loopback, so it cannot be combined with a loopback
 * Ollama embedder: `auto` therefore reports "not enforced" with the reason, and `doctor` surfaces
 * that as a warning rather than pretending the process is sealed. A loopback-allowlisting guard is
 * a coordinator follow-up (see the M13 report).
 */
export function networkGuardPlan(config: OnememoryConfig): NetworkGuardPlan {
  const capable: string[] = [];
  const selection = embedderSelection(config);
  if (selection !== null) capable.push(`embeddings:${selection.provider}`);
  for (const provider of config.llm.providers) capable.push(`llm:${provider.id}(${provider.kind})`);

  if (config.security.network_guard === 'enforce') {
    return {
      enforce: true,
      reason:
        capable.length === 0
          ? 'security.network_guard: enforce'
          : `security.network_guard: enforce (configured network-capable components: ${capable.join(', ')} — their requests will fail while the guard is installed)`,
      network_capable: capable,
    };
  }
  if (config.security.network_guard === 'off') {
    return { enforce: false, reason: 'security.network_guard: off', network_capable: capable };
  }
  return capable.length === 0
    ? { enforce: true, reason: 'network_guard: auto — no embedder and no LLM provider configured (100% local)', network_capable: capable }
    : {
        enforce: false,
        reason: `network_guard: auto — ${capable.join(', ')} configured (loopback endpoints are allowed; the guard would block them)`,
        network_capable: capable,
      };
}

/** The redactor options for `@onememory-ai/security` (kind + location + length only, ADR-0007). */
export interface RedactionOptions {
  groups?: Record<string, boolean>;
  extraPatterns?: ExtraPatternInput[];
}

export function redactionOptions(config: OnememoryConfig): RedactionOptions {
  const redaction = config.security.redaction;
  if (redaction === undefined) return {};
  return {
    ...(redaction.groups === undefined ? {} : { groups: redaction.groups }),
    ...(redaction.extra_patterns === undefined ? {} : { extraPatterns: redaction.extra_patterns }),
  };
}

/** Additional path exclusion globs (the built-in .env/key/credential exclusions are non-removable). */
export function exclusionGlobs(config: OnememoryConfig): string[] {
  return [...config.security.exclude_globs];
}

// ---------------------------------------------------------------------------
// Model router summary (doctor / stats)
// ---------------------------------------------------------------------------

export interface LlmProfileSummary {
  profile: OnememoryConfig['llm']['profile'];
  providers: Array<{ id: string; kind: string; loopback: boolean | null; api_key_env: string | null }>;
  routed_operations: ModelOperation[];
  /** Operations with no route: the caller degrades (heuristics / lexical) — degraded-but-working. */
  unconfigured_operations: ModelOperation[];
}

export function llmProfileSummary(config: OnememoryConfig): LlmProfileSummary {
  const routed = MODEL_OPERATIONS.filter((operation) => config.llm.routes[operation] !== undefined);
  return {
    profile: config.llm.profile,
    providers: config.llm.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      loopback:
        provider.base_url === undefined
          ? provider.kind === 'ollama'
          : isLoopbackBaseUrl(provider.base_url),
      api_key_env: provider.api_key_env ?? null,
    })),
    routed_operations: [...routed],
    unconfigured_operations: MODEL_OPERATIONS.filter((operation) => config.llm.routes[operation] === undefined),
  };
}

/** Everything doctor may print — safe by construction: no key values, no connection strings. */
export interface ConfigSummary {
  config_path: string | null;
  version: number;
  project_name: string | null;
  storage: { mode: string; data_dir: string; vector_backend: string };
  embeddings: { provider: string | null; model: string | null; dim: number | null; base_url: string | null };
  llm: LlmProfileSummary;
  daemon: { host: string; port: number; poll_interval_ms: number; concurrency: number; retention_days: number };
  security: { network_guard: string; exclude_globs: number };
  issues: ConfigIssue[];
}

export function configSummary(config: OnememoryConfig, configPath: string | null, dataDir: string): ConfigSummary {
  const selection = embedderSelection(config);
  return {
    config_path: configPath,
    version: config.version,
    project_name: config.project.name ?? null,
    storage: { mode: config.storage.mode, data_dir: dataDir, vector_backend: config.storage.vector_backend },
    embeddings: {
      provider: selection?.provider ?? null,
      model: selection?.model ?? null,
      dim: selection?.dim ?? null,
      base_url: selection !== null && 'base_url' in selection ? selection.base_url : null,
    },
    llm: llmProfileSummary(config),
    daemon: {
      host: config.daemon.host,
      port: config.daemon.port,
      poll_interval_ms: config.daemon.poll_interval_ms,
      concurrency: config.daemon.concurrency,
      retention_days: config.daemon.retention_days,
    },
    security: {
      network_guard: config.security.network_guard,
      exclude_globs: config.security.exclude_globs.length,
    },
    issues: [],
  };
}
