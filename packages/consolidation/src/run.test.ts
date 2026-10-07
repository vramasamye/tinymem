/**
 * The `stages` restriction on `runConsolidation`: the `decay` job kind drives only the terminal
 * decay/archive pass (memory-model.md §8 stage 13), while the default runs all four passes. A
 * restricted run reports its zeroed sections honestly and never runs the skipped passes.
 *
 * Real embedded storage: the store, the transition machine, and the audit trail are the real ones.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateTokens, type MemoryRecord, type NewMemory } from '@onememory-ai/core';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory-ai/storage';

import { runConsolidation } from './run';

const NOW = new Date('2026-10-01T00:00:00.000Z');

interface World {
  storage: OnememoryStorage;
  dataDir: string;
  projectId: string;
  sourceId: string;
  faded: MemoryRecord;
  version20: MemoryRecord;
  version22: MemoryRecord;
}

let world: World;

async function insert(storage: OnememoryStorage, projectId: string, sourceId: string, candidate: NewMemory): Promise<MemoryRecord> {
  const write = await storage.store.insertMemory(candidate);
  expect(write.outcome).toBe('inserted');
  return write.memory;
}

function memoryOf(
  projectId: string,
  sourceId: string,
  content: string,
  observed_at: string,
  extra: Partial<NewMemory> = {},
): NewMemory {
  return {
    type: 'episodic',
    content,
    importance: 0.65,
    confidence: 0.7,
    observed_at,
    project_id: projectId,
    source_id: sourceId,
    evidence: [{ source_id: sourceId, kind: 'message', locator: `session.jsonl:${content}`, excerpt: content }],
    extraction: { method: 'heuristic', prompt_version: 'fixture-v1', adapter: 'extraction' },
    tags: ['extracted'],
    token_estimate: estimateTokens(content),
    ...extra,
  };
}

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-stages-'));
  const storage = await createEmbeddedDb(dataDir);
  const project = await storage.store.createProject({ name: 'stages-fixture', root_path: dataDir });
  const source = await storage.store.createSource({
    kind: 'conversation',
    uri: 'session/stages-fixture',
    title: 'stages fixture',
    project_id: project.id,
  });
  // A faded episodic note (decay will archive it) and a template contradiction (only the
  // contradiction pass resolves it) — each proves a pass ran or did not. The version rows are
  // decisions so decay (which runs in both tests) does not archive them first.
  const faded = await insert(storage, project.id, source.id, memoryOf(project.id, source.id, 'Wrote notes about the migration plan', '2024-01-01T00:00:00.000Z', { importance: 0.2, confidence: 0.4 }));
  const version20 = await insert(storage, project.id, source.id, memoryOf(project.id, source.id, 'Version: Node 20', '2026-01-10T00:00:00.000Z', { type: 'decision', importance: 0.9 }));
  const version22 = await insert(storage, project.id, source.id, memoryOf(project.id, source.id, 'Version: Node 22', '2026-06-10T00:00:00.000Z', { type: 'decision', importance: 0.9 }));
  world = { storage, dataDir, projectId: project.id, sourceId: source.id, faded, version20, version22 };
});

afterAll(async () => {
  await world.storage.close();
  await rm(world.dataDir, { recursive: true, force: true });
});

describe('runConsolidation stages', () => {
  test("stages: ['decay'] runs only decay — the contradiction pass never touches the version pair", async () => {
    const report = await runConsolidation({
      store: world.storage.store,
      scope: { project_id: world.projectId },
      actor: 'test:stages',
      now: () => NOW,
      stages: ['decay'],
    });

    // The decay pass ran: the faded note is archived.
    expect(report.decay.archived).toBeGreaterThanOrEqual(1);
    expect(report.decay.records.some((record) => record.id === world.faded.id)).toBeTrue();

    // The skipped passes report zeros and mutated nothing: the contradiction is still live.
    expect(report.contradictions).toEqual({ pairs: 0, resolved: 0, disputed_pairs: 0, records: [], skipped: [] });
    expect(report.merge.clusters).toBe(0);
    expect(report.derivations.derived).toBe(0);
    const stillActive = await world.storage.store.getMemory(world.version20.id);
    expect(stillActive?.status).toBe('active');
  });

  test('the default (no stages) runs the contradiction pass', async () => {
    const report = await runConsolidation({
      store: world.storage.store,
      scope: { project_id: world.projectId },
      actor: 'test:stages',
      now: () => NOW,
    });
    expect(report.contradictions.resolved).toBe(1);
    const superseded = await world.storage.store.getMemory(world.version20.id);
    expect(superseded?.status).toBe('superseded');
    expect(superseded?.superseded_by).toBe(world.version22.id);
  });
});
