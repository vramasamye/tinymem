/**
 * The Markdown export renderer (ADR-0013): the store stays canonical, `onemem export` renders a
 * one-way, deterministic Markdown projection — a capped `MEMORY.md` session index (the Claude
 * Code 200-line / 25KB load discipline), one per-type index, and one provenance-bearing file per
 * durable memory.
 *
 * Pinned here: the exact layout, byte-identical determinism (input order must not matter and no
 * wall-clock may leak into the bytes), the trim order under the cap (procedures first, then
 * failures, then decisions, with a visible overflow line), fail-closed behaviour when even the
 * digest header cannot fit, status grouping, and that `working` rows never export.
 */

import { describe, expect, test } from 'bun:test';

import type { MemoryRecord } from '../schema/memory';
import {
  EXPORT_MEMORY_INDEX_BYTE_CAP,
  EXPORT_MEMORY_INDEX_LINE_CAP,
  EXPORT_OWNERSHIP_MARKER,
  ExportCapExceededError,
  renderProjectExport,
} from './export';

const BASE_TIME = '2026-10-06T14:03:11.000Z';

function memory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'type'>): MemoryRecord {
  return {
    content: 'canonical content',
    status: 'active',
    importance: 0.5,
    confidence: 0.7,
    access_count: 0,
    observed_at: BASE_TIME,
    valid_from: BASE_TIME,
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    provenance: {
      source: { id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', kind: 'conversation', uri: 'session://abc' },
      evidence: [],
      extraction: { method: 'heuristic', prompt_version: 'v1' },
    },
    entities: [],
    tags: [],
    token_estimate: 8,
    ...overrides,
  };
}

const FIXTURE_DIGEST = {
  summary: 'Invoice REST API in TypeScript',
  stack: ['typescript', 'postgres'],
  decision_01: 'Adopt pgvector for similarity search.',
  failure_01: 'OOM on deploy → raise the memory limit',
  procedure_01: 'Run migrations before serve',
};

function fixtureMemories(): MemoryRecord[] {
  return [
    memory({
      id: '018f3f2a-b4d1-7a2e-9c3d-000000000001',
      type: 'decision',
      title: 'Adopt pgvector for similarity search',
      content: 'Use pgvector for the vector channel on the server profile.',
      tags: ['postgres', 'search'],
      payload: {
        title: 'Adopt pgvector for similarity search',
        decision: 'Use pgvector for the vector channel on the server profile.',
        alternatives: [{ option: 'pgvector' }, { option: 'Qdrant', why_rejected: 'a second system to run' }],
        rationale: 'One store, one dialect (ADR-0002).',
        participants: ['the architecture review'],
        decided_at: BASE_TIME,
        status: 'accepted',
        evidence: [],
      },
      provenance: {
        source: { id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', kind: 'conversation', uri: 'session://abc' },
        evidence: [
          { source_id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', kind: 'message', locator: 'session.jsonl:183', excerpt: 'we decided to adopt pgvector' },
        ],
        extraction: { method: 'heuristic', prompt_version: 'v1' },
      },
    }),
    memory({
      id: '018f3f2a-b4d1-7a2e-9c3d-000000000002',
      type: 'failure',
      title: 'OOM on deploy',
      content: 'Deploys OOMed in the 2GB container until the memory limit was raised.',
      payload: {
        problem: 'Deploys OOMed in the 2GB container.',
        context: 'Docker deploy, 2GB memory limit.',
        root_cause: 'The container memory limit was below the indexer peak.',
        solution: 'Raise the container memory limit to 4GB.',
        verification: 'Deploy succeeded and the indexer stayed under the limit.',
        status: 'solved',
        signature_hash: 'sha256:oom-deploy',
        first_seen_at: BASE_TIME,
        last_seen_at: BASE_TIME,
        occurrence_count: 3,
      },
    }),
    memory({
      id: '018f3f2a-b4d1-7a2e-9c3d-000000000003',
      type: 'procedural',
      content: 'Run migrations before serve.',
    }),
  ];
}

function pathsOf(files: { path: string }[]): string[] {
  return files.map((file) => file.path);
}

describe('renderProjectExport', () => {
  test('renders the full ADR-0013 layout: index, per-type files, one file per memory', () => {
    const files = renderProjectExport({ project_name: 'invoice-api', digest: FIXTURE_DIGEST, memories: fixtureMemories() });

    expect(pathsOf(files)).toEqual([
      'MEMORY.md',
      'decisions.md',
      'failures.md',
      'memories/decision/018f3f2a-b4d1-7a2e-9c3d-000000000001.md',
      'memories/failure/018f3f2a-b4d1-7a2e-9c3d-000000000002.md',
      'memories/procedural/018f3f2a-b4d1-7a2e-9c3d-000000000003.md',
      'procedural.md',
    ]);

    const index = files.find((file) => file.path === 'MEMORY.md')!.content;
    expect(index).toContain(EXPORT_OWNERSHIP_MARKER);
    expect(index).toContain('# invoice-api memory');
    expect(index).toContain('## Project');
    expect(index).toContain('summary: Invoice REST API in TypeScript');
    expect(index).toContain('stack: typescript, postgres');
    expect(index).toContain('## Settled decisions');
    expect(index).toContain('- Adopt pgvector for similarity search.');
    expect(index).toContain('## Known failures');
    expect(index).toContain('- OOM on deploy → raise the memory limit');
    expect(index).toContain('## Procedures');
    expect(index).toContain('- Run migrations before serve');
    expect(index).toContain('## Index');
    expect(index).toContain('- [decisions (1)](decisions.md)');

    const typeIndex = files.find((file) => file.path === 'decisions.md')!.content;
    expect(typeIndex).toContain('## Active');
    expect(typeIndex).toContain(
      '[Adopt pgvector for similarity search](memories/decision/018f3f2a-b4d1-7a2e-9c3d-000000000001.md) [status: active; observed: 2026-10-06]',
    );

    const decisionFile = files.find((file) => file.path === 'memories/decision/018f3f2a-b4d1-7a2e-9c3d-000000000001.md')!.content;
    expect(decisionFile).toContain(EXPORT_OWNERSHIP_MARKER);
    expect(decisionFile).toContain('id: 018f3f2a-b4d1-7a2e-9c3d-000000000001');
    expect(decisionFile).toContain('type: decision');
    expect(decisionFile).toContain('status: active');
    expect(decisionFile).toContain('tags: postgres, search');
    expect(decisionFile).toContain('source: "session://abc"');
    expect(decisionFile).toContain('## Decision');
    expect(decisionFile).toContain('Use pgvector for the vector channel on the server profile.');
    expect(decisionFile).toContain('## Alternatives');
    expect(decisionFile).toContain('- pgvector');
    expect(decisionFile).toContain('- Qdrant (rejected: a second system to run)');
    expect(decisionFile).toContain('## Rationale');
    expect(decisionFile).toContain('## Status');
    expect(decisionFile).toContain('accepted');
    expect(decisionFile).toContain('## Evidence');
    expect(decisionFile).toContain('"we decided to adopt pgvector" (message, session.jsonl:183)');

    const failureFile = files.find((file) => file.path === 'memories/failure/018f3f2a-b4d1-7a2e-9c3d-000000000002.md')!.content;
    expect(failureFile).toContain('## Problem');
    expect(failureFile).toContain('## Root cause');
    expect(failureFile).toContain('## Solution');
    expect(failureFile).toContain('## Verification');
    expect(failureFile).toContain('## Occurrences');
    expect(failureFile).toContain('3');

    // Every relative link resolves inside the exported set, and every file is owned.
    for (const file of files) {
      expect(file.content).toContain(EXPORT_OWNERSHIP_MARKER);
      for (const link of file.content.matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)) {
        if (link[1]!.startsWith('http')) continue;
        expect(pathsOf(files)).toContain(link[1]!.replace(/^\.?\//, ''));
      }
    }
  });

  test('is byte-identical across renders and independent of input order', () => {
    const memories = fixtureMemories();
    const first = renderProjectExport({ project_name: 'invoice-api', digest: FIXTURE_DIGEST, memories });
    const second = renderProjectExport({ project_name: 'invoice-api', digest: FIXTURE_DIGEST, memories: [...memories].reverse() });

    expect(second).toEqual(first);
    // Sorted output: walking the array is walking the tree in a stable order.
    expect(pathsOf(first)).toEqual([...pathsOf(first)].sort());
  });

  test('groups statuses in the per-type index and never exports working rows', () => {
    const memories = [
      memory({ id: '018f3f2a-b4d1-7a2e-9c3d-000000000004', type: 'episodic', content: 'Shipped the invoice export.' }),
      memory({
        id: '018f3f2a-b4d1-7a2e-9c3d-000000000005',
        type: 'episodic',
        content: 'Used MySQL in the prototype.',
        status: 'superseded',
        superseded_by: '018f3f2a-b4d1-7a2e-9c3d-000000000004',
      }),
      memory({ id: '018f3f2a-b4d1-7a2e-9c3d-000000000006', type: 'working', content: 'scratch' }),
    ];
    const files = renderProjectExport({ project_name: 'invoice-api', digest: null, memories });

    const episodic = files.find((file) => file.path === 'episodic.md')!.content;
    expect(episodic.indexOf('## Active')).toBeLessThan(episodic.indexOf('## Superseded'));
    expect(episodic).toContain('[status: superseded; observed: 2026-10-06]');

    const supersededFile = files.find((file) => file.path === 'memories/episodic/018f3f2a-b4d1-7a2e-9c3d-000000000005.md')!.content;
    expect(supersededFile).toContain('status: superseded');
    expect(supersededFile).toContain('superseded_by: 018f3f2a-b4d1-7a2e-9c3d-000000000004');

    // The working row never lands anywhere in the export.
    expect(files.some((file) => file.content.includes('scratch'))).toBe(false);
    expect(pathsOf(files)).not.toContain('memories/working/018f3f2a-b4d1-7a2e-9c3d-000000000006.md');
  });

  test('keeps MEMORY.md under the line and byte caps, trimming procedures first', () => {
    // Section sizes respect the digest contract (two-digit keys, at most 99 per section) and
    // together overflow the 200-line cap by more than one section can absorb.
    const digest: Record<string, unknown> = {
      summary: 'Many entries project',
      ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`decision_${String(index + 1).padStart(2, '0')}`, `decision line ${index + 1}`])),
      ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`failure_${String(index + 1).padStart(2, '0')}`, `failure line ${index + 1}`])),
      ...Object.fromEntries(Array.from({ length: 99 }, (_, index) => [`procedure_${String(index + 1).padStart(2, '0')}`, `procedure line ${index + 1}`])),
    };
    const files = renderProjectExport({ project_name: 'capped', digest, memories: [] });
    const index = files.find((file) => file.path === 'MEMORY.md')!.content;

    expect(index.split('\n').length).toBeLessThanOrEqual(EXPORT_MEMORY_INDEX_LINE_CAP);
    expect(new TextEncoder().encode(index).length).toBeLessThanOrEqual(EXPORT_MEMORY_INDEX_BYTE_CAP);
    // The overflow is visible and points at the full per-type file; procedures trim from the
    // end first, so every decision and failure line survives.
    expect(index).toMatch(/\(\+\d+ more, see \[procedures\]\(procedural\.md\)\)/);
    expect(index).toContain('- procedure line 1');
    expect(index).toContain('- decision line 80');
    expect(index).toContain('- failure line 60');
    expect(index).not.toContain('- procedure line 99');

    // Byte-cap arm: short line count, but each procedure line is ~1KB.
    const wide: Record<string, unknown> = {
      summary: 'Wide entries project',
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`procedure_${String(index + 1).padStart(2, '0')}`, `${'x'.repeat(1000)} ${index}`])),
    };
    const wideFiles = renderProjectExport({ project_name: 'capped', digest: wide, memories: [] });
    const wideIndex = wideFiles.find((file) => file.path === 'MEMORY.md')!.content;
    expect(new TextEncoder().encode(wideIndex).length).toBeLessThanOrEqual(EXPORT_MEMORY_INDEX_BYTE_CAP);
    expect(wideIndex).toMatch(/\(\+\d+ more, see \[procedures\]\(procedural\.md\)\)/);
  });

  test('fails closed when the digest header alone cannot fit the cap', () => {
    const digest = { summary: 'y'.repeat(40_000) };
    expect(() => renderProjectExport({ project_name: 'capped', digest, memories: [] })).toThrow(ExportCapExceededError);
  });
});
