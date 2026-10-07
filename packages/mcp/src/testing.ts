/**
 * ⚠️ TEST-ONLY helpers — never imported by production paths (exported via the `./testing`
 * subpath, mirroring @onememory-ai/retrieval's convention).
 *
 * `openMcpTestServer`: an isolated embedded-PGlite world (fresh temp dir) + the deterministic
 * hash-axis embedder from @onememory-ai/retrieval/testing + the retrieval engine + a full MCP
 * server context — everything the test suites need, with per-test cleanup and fixed clocks.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Embedder } from '@onememory-ai/core';
import { createTestEmbedder, type TestEmbedder } from '@onememory-ai/retrieval/testing';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory-ai/storage';

import { createOnememoryMcpContext, type OnememoryMcpContext } from './context';
import type { ToolProfile } from './schemas';

/** A deterministic "today" for fixtures (all fact timestamps in tests are before this). */
export const MCP_TEST_NOW = '2027-01-15T00:00:00.000Z';

export interface McpTestWorld {
  storage: OnememoryStorage;
  embedder: TestEmbedder;
  context: OnememoryMcpContext;
  /** The ids every test uses (project + explicit source, created up front). */
  ids: { projectId: string; sourceId: string };
  dataDir: string;
  close(): Promise<void>;
}

export interface McpTestWorldOptions {
  profile?: ToolProfile;
  /** Extra env (e.g. CLAUDE_PROJECT_DIR) for the context. */
  env?: Record<string, string>;
  /** Per-test config overrides; `projectId: null` forces an UNCONFIGURED server. */
  config?: {
    projectId?: string | null;
    agentId?: string;
    searchMaxTokens?: number;
    sessionContextBudget?: number;
  };
  /** Inject a custom embedder (omit → the deterministic test embedder; pass null → NO embedder). */
  embedder?: Embedder | null;
  /** Override the fixed clock. */
  now?: () => Date;
}

/**
 * Open the test world: fresh embedded PGlite (temp dir, vector dim matched to the embedder),
 * a project + explicit source seeded, and the MCP context wired to it.
 */
export async function openMcpTestWorld(options: McpTestWorldOptions = {}): Promise<McpTestWorld> {
  const embedder: Embedder | undefined = options.embedder === null ? undefined : options.embedder ?? createTestEmbedder();
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-mcp-test-'));
  const storage = await createEmbeddedDb(dataDir, {
    vector: embedder !== undefined ? { dim: embedder.dim, model: embedder.model } : undefined,
  });

  const project = await storage.store.createProject({
    name: 'mcp-fixture-project',
    root_path: '/dev/mcp-fixture',
    description: 'The MCP test fixture project',
    digest: { summary: 'MCP fixture app', stack: ['typescript', 'postgres'], conventions: 'conventional commits' },
  });
  const source = await storage.store.createSource({
    kind: 'explicit',
    uri: 'mcp-test://fixture-source',
    title: 'MCP fixture source',
    project_id: project.id,
  });

  const context = await createOnememoryMcpContext({
    storage,
    embedder,
    profile: options.profile ?? 'default8',
    // `null` deliberately leaves the server UNCONFIGURED (the project_required paths).
    ...(options.config?.projectId !== null ? { projectId: options.config?.projectId ?? project.id } : {}),
    ...(options.config?.agentId !== undefined ? { agentId: options.config.agentId } : {}),
    ...(options.config?.searchMaxTokens !== undefined ? { searchMaxTokens: options.config.searchMaxTokens } : {}),
    ...(options.config?.sessionContextBudget !== undefined
      ? { sessionContextBudget: options.config.sessionContextBudget }
      : {}),
    env: options.env ?? {},
    now: options.now ?? (() => new Date(MCP_TEST_NOW)),
  });

  return {
    storage,
    embedder: embedder === undefined ? (undefined as unknown as TestEmbedder) : (embedder as TestEmbedder),
    context,
    ids: { projectId: project.id, sourceId: source.id },
    dataDir,
    async close(): Promise<void> {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Insert a fixture memory directly through the Store port (bypasses the MCP layer — for seeding
 * search/related/context fixtures). Evidence + source are the fixture's.
 */
export async function seedFixtureMemory(
  world: McpTestWorld,
  input: {
    type: 'episodic' | 'semantic' | 'procedural' | 'decision' | 'failure' | 'preference';
    content: string;
    title?: string;
    importance?: number;
    confidence?: number;
    observedAt: string;
    tags?: string[];
    embed?: boolean;
  },
): Promise<string> {
  const { store } = world.storage;
  const sourceId = world.ids.sourceId;
  const written = await store.insertMemory({
    type: input.type,
    ...(input.title !== undefined ? { title: input.title } : {}),
    content: input.content,
    importance: input.importance ?? 0.7,
    confidence: input.confidence ?? 0.8,
    observed_at: input.observedAt,
    project_id: world.ids.projectId,
    source_id: sourceId,
    evidence: [
      { source_id: sourceId, kind: 'message', locator: 'fixture:1', excerpt: input.content.slice(0, 80) },
    ],
    extraction: { method: 'heuristic', prompt_version: 'mcp-fixture-v1' },
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
  });
  if (input.embed !== false && world.embedder !== undefined) {
    const [vector] = await world.embedder.embed([input.content]);
    if (vector !== undefined) await world.storage.vectors.upsert(written.memory.id, vector);
  }
  return written.memory.id;
}
