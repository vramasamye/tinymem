/**
 * Configuration schema (`docs/plan/mission-reports/mission-3.md` §9 for the `llm:` fragment).
 *
 * Design rules (AGENTS.md rule 4, ADR-0006, ADR-0007):
 * - **strict everywhere**: an unknown key is a typo, not forward compatibility. A misspelled
 *   `embedding:` is a false sense of security, so it fails at load with the key path;
 * - **fail closed**: `llm.profile: local` rejects hosted provider kinds, non-loopback base URLs,
 *   and inline API keys on non-loopback endpoints — the same checks the router performs, surfaced
 *   at config load so the message can name the file and the fix;
 * - **no inline secrets**: `storage.pg_url` is either a credential-free Postgres URL or the NAME
 *   of an environment variable; `api_key_env` is likewise a variable name;
 * - **local-first defaults**: embedded storage, zero providers, no embedder — everything works
 *   offline with lexical+graph retrieval.
 *
 * The routing vocabulary (operations, provider kinds, profiles, loopback rule) is imported from
 * `@onememory/llm` and the redaction vocabulary from `@onememory/security`: one source of truth per
 * vocabulary, never a copy that can drift.
 */

import {
  MODEL_OPERATIONS,
  PROVIDER_KINDS,
  ROUTER_PROFILES,
  RouterConfigSchema,
  isHostedProviderKind,
  isLoopbackBaseUrl,
} from '@onememory/llm';
import { PATTERN_GROUP_IDS, ExtraPatternSchema } from '@onememory/security';
import { z } from 'zod';

/** Config format version; only version 1 exists. An unknown version fails loudly. */
export const CONFIG_VERSION = 1 as const;

export const STORAGE_MODES = ['embedded', 'server'] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

export const VECTOR_BACKENDS = ['auto', 'pgvector', 'float8'] as const;
export type VectorBackendSetting = (typeof VECTOR_BACKENDS)[number];

/** Embedding providers implemented by `@onememory/embeddings` (ADR-0006 §3). */
export const EMBEDDING_PROVIDERS = ['ollama', 'openai-compatible', 'local-transformers'] as const;
export type EmbeddingProviderSetting = (typeof EMBEDDING_PROVIDERS)[number];

export const NETWORK_GUARD_MODES = ['auto', 'enforce', 'off'] as const;
export type NetworkGuardMode = (typeof NETWORK_GUARD_MODES)[number];

/** Loopback defaults per embedding provider (ADR-0006 §4: loopback unless explicitly changed). */
export const DEFAULT_OLLAMA_EMBED_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OPENAI_COMPATIBLE_EMBED_BASE_URL = 'http://127.0.0.1:1234/v1';

/** The default `daemon.port` (loopback admin/API surface). */
export const DEFAULT_DAEMON_PORT = 7331;
/** D4: raw events older than this window are eligible for compaction. */
export const DEFAULT_RETENTION_DAYS = 30;
/**
 * Default interval between scheduled consolidation passes (memory-model.md §8 stages 12–14:
 * "scheduled batch"). Hourly: consolidation is cheap pure-SQL offline, and the interval bounds
 * how stale contradictions/duplicates can get without loading the daemon.
 */
export const DEFAULT_CONSOLIDATE_INTERVAL_MS = 3_600_000;
/** Session-context budget default (retrieval.md §5 / ADR-0010 progressive disclosure). */
export const DEFAULT_CONTEXT_BUDGET = 750;
/** Search budget default (event-memory-schemas.md §6). */
export const DEFAULT_SEARCH_MAX_TOKENS = 800;

const identifier = z.string().min(1);

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const ProjectSectionSchema = z.strictObject({
  /** Slug/display name; `onemem init` defaults it to the directory name. */
  name: identifier.optional(),
  root_path: identifier.optional(),
  git_remote: identifier.optional(),
});
export type ProjectSection = z.infer<typeof ProjectSectionSchema>;

export const StorageSectionSchema = z.strictObject({
  mode: z.enum(STORAGE_MODES).default('embedded'),
  /** PGlite data directory (embedded mode). Relative paths resolve against the config file. */
  data_dir: identifier.default('.onememory/data'),
  /**
   * Server mode only: either a credential-free `postgres://` URL, or the NAME of an environment
   * variable holding one (`pg_url: ONEMEMORY_PG_URL`). Credentials are never written in config.
   */
  pg_url: identifier.optional(),
  vector_backend: z.enum(VECTOR_BACKENDS).default('auto'),
});
export type StorageSection = z.infer<typeof StorageSectionSchema>;

export const EmbeddingsSectionSchema = z.strictObject({
  /** Absent = no embedder: retrieval degrades to lexical + graph (warned, never silent). */
  provider: z.enum(EMBEDDING_PROVIDERS).optional(),
  model: identifier.optional(),
  /** Known dimension; when omitted the provider discovers it (`probe()`), and doctor compares. */
  dim: z.number().int().min(1).max(8192).optional(),
  base_url: identifier.optional(),
  /** Pinned model revision (local-transformers), recorded as vector provenance. */
  revision: identifier.optional(),
  batch_size: z.number().int().min(1).max(512).optional(),
  timeout_ms: z.number().int().min(1).max(600_000).optional(),
});
export type EmbeddingsSection = z.infer<typeof EmbeddingsSectionSchema>;

export const LlmProviderSectionSchema = z.strictObject({
  id: identifier,
  kind: z.enum(PROVIDER_KINDS),
  base_url: identifier.optional(),
  /** Inline key: allowed only for loopback endpoints that demand a dummy key. */
  api_key: identifier.optional(),
  /** Preferred: the NAME of an environment variable holding the key. */
  api_key_env: identifier.optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type LlmProviderSection = z.infer<typeof LlmProviderSectionSchema>;

export const LlmRouteSectionSchema = z.strictObject({
  provider: identifier,
  model: identifier,
});
export type LlmRouteSection = z.infer<typeof LlmRouteSectionSchema>;

export const LlmDefaultsSectionSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  max_retries: z.number().int().min(0).max(5).optional(),
  max_output_tokens: z.number().int().min(1).optional(),
  timeout_ms: z.number().int().min(1).optional(),
});
export type LlmDefaultsSection = z.infer<typeof LlmDefaultsSectionSchema>;

const routesShape = Object.fromEntries(
  MODEL_OPERATIONS.map((operation) => [operation, LlmRouteSectionSchema.optional()]),
) as { [K in (typeof MODEL_OPERATIONS)[number]]: z.ZodOptional<typeof LlmRouteSectionSchema> };

/** The `llm:` fragment — a strict mirror of `RouterConfigSchema` (mission-3.md §9). */
export const LlmSectionSchema = z.strictObject({
  profile: z.enum(ROUTER_PROFILES).default('local'),
  providers: z.array(LlmProviderSectionSchema).default([]),
  routes: z.strictObject(routesShape).default({}),
  defaults: LlmDefaultsSectionSchema.optional(),
});
export type LlmSection = z.infer<typeof LlmSectionSchema>;

export const DaemonSectionSchema = z.strictObject({
  /** Loopback by default; a non-loopback bind needs `onemem serve --listen-public`. */
  host: identifier.default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(DEFAULT_DAEMON_PORT),
  /** Worker poll interval (ms) when the queue is empty. */
  poll_interval_ms: z.number().int().min(10).max(600_000).default(250),
  /** Jobs claimed per worker pass (a real worker pool is a follow-up; see the M13 report). */
  concurrency: z.number().int().min(1).max(64).default(4),
  lease_seconds: z.number().int().min(5).max(3600).default(60),
  /** D4: retention window for raw events, in days (0 = keep forever). */
  retention_days: z.number().int().min(0).max(3650).default(DEFAULT_RETENTION_DAYS),
  /**
   * How often the daemon enqueues a consolidation pass (ms; 0 disables the schedule). The pass
   * runs contradiction → derivation → merge → decay over the registered project.
   */
  consolidate_interval_ms: z
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(DEFAULT_CONSOLIDATE_INTERVAL_MS),
});
export type DaemonSection = z.infer<typeof DaemonSectionSchema>;

export const RedactionSectionSchema = z.strictObject({
  /**
   * Per-group on/off switches — a PARTIAL map (only the keys you switch off). Zod 4's
   * `z.record(z.enum(...), …)` would demand every key exhaustively, which would make the template's
   * documented `groups: { jwt: false }` example invalid; `@onememory/security`'s own rule (unknown
   * ids rejected, omitted ids default on) is mirrored here instead so the two cannot drift.
   */
  groups: z
    .record(z.string(), z.boolean())
    .refine((groups) => Object.keys(groups).every((id) => (PATTERN_GROUP_IDS as readonly string[]).includes(id)), {
      message: `unknown pattern group id (known groups: ${PATTERN_GROUP_IDS.join(', ')})`,
    })
    .optional(),
  extra_patterns: z.array(ExtraPatternSchema).max(100).optional(),
});
export type RedactionSection = z.infer<typeof RedactionSectionSchema>;

export const SecuritySectionSchema = z.strictObject({
  /**
   * `auto` (default): enforce the M12 network guard when the resolved config has no
   * network-capable component (no embedder provider, no LLM providers); `enforce`: always install
   * (a loopback provider will then fail its probes loudly); `off`: rejected while the profile is
   * `local` (it would break the local-first invariant).
   */
  network_guard: z.enum(NETWORK_GUARD_MODES).default('auto'),
  /** ADDITIONAL path exclusion globs; `@onememory/security`'s defaults cannot be removed. */
  exclude_globs: z.array(identifier).default([]),
  redaction: RedactionSectionSchema.optional(),
});
export type SecuritySection = z.infer<typeof SecuritySectionSchema>;

/**
 * Skill-artifact write surface (M15 follow-up 3, ADR-0009 rule 5). Skills are files
 * (`<skills-root>/<name>/SKILL.md`) so runtime-native loaders find them; every runtime scans a
 * skills root (none consumes a manifest — see `@onememory/core`'s runtime-skill table).
 */
export const SkillsSectionSchema = z.strictObject({
  /**
   * Default directory `onemem skills promote` writes into. Absent → `<project root>/skills` (the
   * documented default). A `~/...` value resolves against HOME (e.g. `~/.claude/skills`). Per-run
   * `--dir <path>` and `--runtime <id>` override it.
   */
  dir: identifier.optional(),
});
export type SkillsSection = z.infer<typeof SkillsSectionSchema>;

// ---------------------------------------------------------------------------
// Root schema + fail-closed cross-field rules
// ---------------------------------------------------------------------------

const RootShape = {
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  project: ProjectSectionSchema.default(() => ProjectSectionSchema.parse({})),
  storage: StorageSectionSchema.default(() => StorageSectionSchema.parse({})),
  embeddings: EmbeddingsSectionSchema.default(() => EmbeddingsSectionSchema.parse({})),
  llm: LlmSectionSchema.default(() => LlmSectionSchema.parse({})),
  daemon: DaemonSectionSchema.default(() => DaemonSectionSchema.parse({})),
  security: SecuritySectionSchema.default(() => SecuritySectionSchema.parse({})),
  skills: SkillsSectionSchema.default(() => SkillsSectionSchema.parse({})),
};

/** One actionable validation failure (path + message; never a secret value). */
export interface ConfigIssue {
  path: string;
  message: string;
}

interface CrossFieldContext {
  addIssue(path: string, message: string): void;
  value: {
    storage: StorageSection;
    embeddings: EmbeddingsSection;
    llm: LlmSection;
    security: SecuritySection;
  };
}

function effectiveProviderBaseUrl(provider: LlmProviderSection): string | null {
  if (provider.base_url !== undefined) return provider.base_url;
  if (provider.kind === 'ollama') return DEFAULT_OLLAMA_EMBED_BASE_URL;
  return null;
}

/** The router's own fail-closed checks, restated at config load (same rules, file-level message). */
function checkLlmSection(ctx: CrossFieldContext): void {
  const { llm } = ctx.value;
  const ids = new Set<string>();
  for (const [index, provider] of llm.providers.entries()) {
    if (ids.has(provider.id)) {
      ctx.addIssue(`llm.providers[${index}].id`, `duplicate provider id '${provider.id}'`);
    }
    ids.add(provider.id);

    if (llm.profile === 'local' && isHostedProviderKind(provider.kind)) {
      ctx.addIssue(
        `llm.providers[${index}].kind`,
        `provider kind '${provider.kind}' is hosted and cannot be used with llm.profile: local — set llm.profile: hybrid to opt into hosted providers (AGENTS.md rule 4)`,
      );
    }
    const baseUrl = effectiveProviderBaseUrl(provider);
    if (llm.profile === 'local' && baseUrl !== null && !isLoopbackBaseUrl(baseUrl)) {
      ctx.addIssue(
        `llm.providers[${index}].base_url`,
        `base_url '${baseUrl}' is not loopback and cannot be used with llm.profile: local — use a 127.0.0.1/localhost endpoint, or set llm.profile: hybrid`,
      );
    }
    if (provider.api_key !== undefined && (baseUrl === null || !isLoopbackBaseUrl(baseUrl))) {
      ctx.addIssue(
        `llm.providers[${index}].api_key`,
        `an inline api_key is only allowed for loopback endpoints; use api_key_env (an environment variable name) instead of writing a key into the config file`,
      );
    }
  }

  for (const [operation, route] of Object.entries(llm.routes)) {
    if (route === undefined) continue;
    if (!ids.has(route.provider)) {
      ctx.addIssue(
        `llm.routes.${operation}.provider`,
        `route references unknown provider id '${route.provider}' (known: ${[...ids].join(', ') || 'none'})`,
      );
    }
  }
}

function checkStorageSection(ctx: CrossFieldContext): void {
  const { storage } = ctx.value;
  if (storage.mode === 'server' && storage.pg_url === undefined) {
    ctx.addIssue(
      'storage.pg_url',
      'storage.mode: server requires pg_url — a credential-free postgres:// URL, or the NAME of an environment variable holding one (e.g. pg_url: ONEMEMORY_PG_URL)',
    );
  }
  if (storage.mode === 'embedded' && storage.pg_url !== undefined) {
    ctx.addIssue(
      'storage.pg_url',
      'pg_url is only used with storage.mode: server; remove it or set storage.mode: server',
    );
  }
}

function checkEmbeddingsSection(ctx: CrossFieldContext): void {
  const { embeddings, llm } = ctx.value;
  if (embeddings.provider !== undefined && embeddings.model === undefined) {
    ctx.addIssue(
      'embeddings.model',
      `embeddings.provider: ${embeddings.provider} requires embeddings.model (e.g. nomic-embed-text for ollama, Xenova/bge-small-en-v1.5 for local-transformers)`,
    );
  }
  if (embeddings.provider === undefined) {
    if (embeddings.model !== undefined || embeddings.dim !== undefined || embeddings.base_url !== undefined) {
      ctx.addIssue(
        'embeddings.provider',
        'embeddings.model/dim/base_url are set but embeddings.provider is not — add provider: ollama | openai-compatible | local-transformers',
      );
    }
    return;
  }
  if (embeddings.base_url !== undefined && llm.profile === 'local' && !isLoopbackBaseUrl(embeddings.base_url)) {
    ctx.addIssue(
      'embeddings.base_url',
      `base_url '${embeddings.base_url}' is not loopback and cannot be used with llm.profile: local — embeddings run locally by default (ADR-0006); set llm.profile: hybrid to opt into a remote embedding endpoint`,
    );
  }
  if (embeddings.provider === 'local-transformers' && embeddings.dim !== undefined && embeddings.dim !== 384) {
    ctx.addIssue(
      'embeddings.dim',
      `local-transformers (pinned Xenova/bge-small-en-v1.5) produces 384 dimensions; embeddings.dim: ${embeddings.dim} would never match a stored vector`,
    );
  }
}

function checkSecuritySection(ctx: CrossFieldContext): void {
  const { security, llm } = ctx.value;
  if (security.network_guard === 'off' && llm.profile === 'local') {
    ctx.addIssue(
      'security.network_guard',
      'network_guard: off is rejected while llm.profile is local — the 100%-local guarantee is a product invariant (AGENTS.md rule 4); use auto or enforce',
    );
  }
}

export const OnememoryConfigSchema = z
  .strictObject(RootShape)
  .check((ctx) => {
    if (!ctx.value) return;
    const context: CrossFieldContext = {
      addIssue: (path, message) => {
        ctx.issues.push({ code: 'custom', input: undefined, path: path.split('.'), message });
      },
      value: ctx.value,
    };
    checkStorageSection(context);
    checkEmbeddingsSection(context);
    checkLlmSection(context);
    checkSecuritySection(context);
  });

export type OnememoryConfig = z.infer<typeof OnememoryConfigSchema>;
export type OnememoryConfigInput = z.input<typeof OnememoryConfigSchema>;

/**
 * The `llm:` fragment handed to `createModelRouter(parseRouterConfig(config.llm))`. Re-validated
 * against the router's own schema so a config that passes here can never fail at router
 * construction (strict keys here, the router's loose schema there).
 */
export function routerConfigFrom(config: OnememoryConfig): z.infer<typeof RouterConfigSchema> {
  return RouterConfigSchema.parse({
    profile: config.llm.profile,
    providers: config.llm.providers,
    routes: config.llm.routes,
    ...(config.llm.defaults === undefined ? {} : { defaults: config.llm.defaults }),
  });
}

/** Parse a config object (or already-parsed YAML) into a fully-defaulted config. */
export function parseConfig(input: unknown): OnememoryConfig {
  return OnememoryConfigSchema.parse(input ?? {});
}

/** Safe parse returning issues instead of throwing (used by `loadConfig` for better messages). */
export function safeParseConfig(input: unknown): { success: true; data: OnememoryConfig } | { success: false; issues: ConfigIssue[] } {
  const result = OnememoryConfigSchema.safeParse(input ?? {});
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}
