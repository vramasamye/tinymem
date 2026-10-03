/**
 * Test harness: opens an isolated storage instance per test (embedded = fresh temp dir; server =
 * caller-provided Postgres) and provides fixture builders with per-run-unique values so the
 * server-target suite is re-runnable against a shared database.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  eventContentHash,
  uuidv7,
  validateOnememoryEvent,
} from '@onememory/core';
import type {
  NewMemory,
  NewSession,
  NewSource,
  NewWorkingMemory,
  OnememoryEvent,
} from '@onememory/core';

import { createEmbeddedDb } from '../drivers/embedded';
import type { OnememoryStorage } from '../drivers/types';

export interface StorageHandle {
  storage: OnememoryStorage;
  dataDir: string | null;
  close(): Promise<void>;
}

export async function openEmbeddedStorage(
  options?: Parameters<typeof createEmbeddedDb>[1],
): Promise<StorageHandle> {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-test-'));
  const storage = await createEmbeddedDb(dataDir, options);
  return {
    storage,
    dataDir,
    close: async () => {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Reopen an embedded database on the same dataDir (persistence tests). */
export async function reopenEmbeddedStorage(
  dataDir: string,
  options?: Parameters<typeof createEmbeddedDb>[1],
): Promise<OnememoryStorage> {
  return createEmbeddedDb(dataDir, options);
}

// ---------------------------------------------------------------------------
// Fixtures (unique per run — server-target parity without cross-run collisions)
// ---------------------------------------------------------------------------

export function uniqueId(): string {
  return uuidv7();
}

export interface FixtureContext {
  projectId: string;
  sourceId: string;
}

export async function seedProjectAndSource(
  storage: OnememoryStorage,
  name = 'fixture-project',
): Promise<FixtureContext> {
  const project = await storage.store.createProject({
    name: `${name}-${uniqueId().slice(0, 8)}`,
    root_path: '/tmp/fixture',
  });
  const source = await storage.store.createSource({
    kind: 'explicit',
    uri: `conversation/session/${uniqueId()}`,
    title: 'fixture source',
    project_id: project.id,
  });
  return { projectId: project.id, sourceId: source.id };
}

export function makeMemory(
  ctx: FixtureContext,
  overrides: Partial<NewMemory> & Pick<NewMemory, 'content'>,
): NewMemory {
  return {
    type: 'semantic',
    importance: 0.7,
    confidence: 0.8,
    observed_at: '2025-06-01T00:00:00.000Z',
    source_id: ctx.sourceId,
    evidence: [
      {
        source_id: ctx.sourceId,
        kind: 'message',
        locator: 'session.jsonl:183',
        excerpt: overrides.content.slice(0, 80),
      },
    ],
    extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
    project_id: ctx.projectId,
    ...overrides,
  };
}

export function makeEvent(
  overrides: Partial<OnememoryEvent> & Pick<OnememoryEvent, 'payload' | 'kind'>,
): OnememoryEvent {
  const candidate = {
    id: uuidv7(),
    occurred_at: '2026-10-03T12:00:00.000Z',
    ingested_at: '2026-10-03T12:00:01.000Z',
    source: { runtime: 'claude-code' as const, adapter_version: '1.0.0' },
    scope: {},
    content_hash: eventContentHash(overrides.payload),
    redactions: [],
    ...overrides,
  };
  const result = validateOnememoryEvent(candidate);
  if (!result.ok) {
    throw new Error(`fixture event failed validation: ${JSON.stringify(result.dead_letter.issues)}`);
  }
  return result.value;
}

export function makeSource(overrides: Partial<NewSource> & Pick<NewSource, 'kind'>): NewSource {
  return { uri: `document://${uniqueId()}`, ...overrides };
}

export function makeSession(overrides: Partial<NewSession> = {}): NewSession {
  return {
    id: `sess-${uniqueId()}`,
    runtime: 'claude-code',
    started_at: '2026-10-03T12:00:00.000Z',
    ...overrides,
  };
}

export function makeWorking(
  sessionId: string,
  overrides: Partial<NewWorkingMemory> & Pick<NewWorkingMemory, 'kind' | 'content'>,
): NewWorkingMemory {
  return {
    session_id: sessionId,
    expires_at: '2026-10-03T13:00:00.000Z',
    ...overrides,
  };
}
