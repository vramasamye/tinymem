/**
 * MCP server configuration (ADR-0010 §1–§2, §6): tool profile, storage profile, embedder
 * injection, project scope, redaction policy.
 *
 * Local-first invariant (AGENTS.md rule 4): the default profile is `embedded` storage + NO
 * embedder — the server boots fully offline, retrieval degrades to lexical + graph with an
 * explicit warning, and zero external API calls happen. An `Embedder` port instance arrives by
 * injection (M3 owns implementations); this package never constructs a provider itself.
 */

import { z } from 'zod';

import type { Embedder } from '@onememory/core';
import { RedactorConfigSchema } from '@onememory/security';

import { TOOL_PROFILES, type ToolProfile } from './schemas';

// ---------------------------------------------------------------------------
// Storage profile
// ---------------------------------------------------------------------------

/** PGlite embedded in this process (single owner per data dir — storage drivers' constraint). */
export const EmbeddedStorageConfigSchema = z.looseObject({
  mode: z.literal('embedded'),
  dataDir: z.string().min(1),
});
export type EmbeddedStorageConfig = z.infer<typeof EmbeddedStorageConfigSchema>;

/** Shared/server mode: one Postgres (+pgvector) URL behind a stateless HTTP server. */
export const ServerStorageConfigSchema = z.looseObject({
  mode: z.literal('server'),
  /** e.g. postgres://user:pass@host:5432/onememory — NEVER logged, never echoed back. */
  url: z.string().min(1),
});
export type ServerStorageConfig = z.infer<typeof ServerStorageConfigSchema>;

export const StorageConfigSchema = z.discriminatedUnion('mode', [
  EmbeddedStorageConfigSchema,
  ServerStorageConfigSchema,
]);
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export const OnememoryMcpConfigSchema = z.looseObject({
  /** Tool exposure profile: 8 tools (default) or 8 + the 3 curated lists. */
  profile: z.enum(TOOL_PROFILES).default('default8'),
  storage: StorageConfigSchema.default({ mode: 'embedded', dataDir: '.onememory' }),
  /**
   * Project scope for unscoped calls (memory_project_context, default scoping of stores).
   * Resolved per call as: tool input → this value → ONEMEMORY_PROJECT_ID.
   */
  projectId: z.uuid().optional(),
  /** Audited-actor suffix + stored agent_id (default "onememory-mcp"). */
  agentId: z.string().min(1).max(120).default('onememory-mcp'),
  /** Secret redaction groups/patterns (ADR-0007; defaults are on and not removable). */
  redactor: RedactorConfigSchema.optional(),
  /** Session-start context budget (retrieval's sessionContext.budget default is 750). */
  sessionContextBudget: z.number().int().min(1).max(4000).optional(),
  /** Default max_tokens for memory_search when the caller does not supply one. */
  searchMaxTokens: z.number().int().min(1).max(4000).optional(),
  /** Override the server instructions (≤ 512 chars, enforced by the description-length tests). */
  instructions: z.string().max(2048).optional(),
});
export type OnememoryMcpConfig = z.infer<typeof OnememoryMcpConfigSchema>;
export type OnememoryMcpConfigInput = z.input<typeof OnememoryMcpConfigSchema>;

/** Build the effective config (defaults applied, validated). Throws z.ZodError on bad input. */
export function resolveMcpConfig(input: OnememoryMcpConfigInput = {}): OnememoryMcpConfig {
  return OnememoryMcpConfigSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Environment → config (the stdio bin + the adapters' `onemem init` configs use this)
// ---------------------------------------------------------------------------

export interface McpEnv {
  /** Tool profile override (`default8` | `full11`). */
  ONEMEMORY_MCP_PROFILE?: string;
  /** Embedded data dir (default: `.onememory` under the launch dir). */
  ONEMEMORY_DATA_DIR?: string;
  /** Server Postgres URL — switches the storage profile to `server`. */
  ONEMEMORY_PG_URL?: string;
  /** Project id scope for unscoped calls. */
  ONEMEMORY_PROJECT_ID?: string;
  /** agent_id / audited actor for MCP writes. */
  ONEMEMORY_MCP_AGENT_ID?: string;
  /**
   * Claude Code sets this to the launch dir for stdio servers. onememory records it as a
   * workspace hint in write provenance; mapping a path to a project id needs a storage
   * lookup-by-path primitive (coordinator follow-up — see mission-5.md).
   */
  CLAUDE_PROJECT_DIR?: string;
  [key: string]: string | undefined;
}

/**
 * Resolve configuration from an environment (typically `process.env`). Empty/absent values fall
 * back to defaults; an invalid explicit value throws (config errors must be loud at boot, never
 * silently ignored — AGENTS.md rule 3).
 */
export function mcpConfigFromEnv(env: McpEnv = {}): OnememoryMcpConfig {
  const input: OnememoryMcpConfigInput = {};

  if (env.ONEMEMORY_MCP_PROFILE !== undefined && env.ONEMEMORY_MCP_PROFILE !== '') {
    if (!(TOOL_PROFILES as readonly string[]).includes(env.ONEMEMORY_MCP_PROFILE)) {
      throw new Error(
        `ONEMEMORY_MCP_PROFILE must be one of ${TOOL_PROFILES.join(' | ')} (got ${JSON.stringify(env.ONEMEMORY_MCP_PROFILE)})`,
      );
    }
    input.profile = env.ONEMEMORY_MCP_PROFILE as ToolProfile;
  }

  if (env.ONEMEMORY_PG_URL !== undefined && env.ONEMEMORY_PG_URL !== '') {
    input.storage = { mode: 'server', url: env.ONEMEMORY_PG_URL };
  } else if (env.ONEMEMORY_DATA_DIR !== undefined && env.ONEMEMORY_DATA_DIR !== '') {
    input.storage = { mode: 'embedded', dataDir: env.ONEMEMORY_DATA_DIR };
  }

  if (env.ONEMEMORY_PROJECT_ID !== undefined && env.ONEMEMORY_PROJECT_ID !== '') {
    input.projectId = env.ONEMEMORY_PROJECT_ID;
  }
  if (env.ONEMEMORY_MCP_AGENT_ID !== undefined && env.ONEMEMORY_MCP_AGENT_ID !== '') {
    input.agentId = env.ONEMEMORY_MCP_AGENT_ID;
  }

  return resolveMcpConfig(input);
}
