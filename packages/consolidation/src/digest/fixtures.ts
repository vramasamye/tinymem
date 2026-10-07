/**
 * ⚠️ TEST-ONLY — the digest suites' fixture world (never exported from the package index): a
 * real embedded PGlite (temp dir) seeded with a coherent project the way the pipeline would:
 * accepted + rejected decisions (with `decisions` payload rows), open + solved failures (with
 * `failures` payload rows), two procedures, and distractor memories (episodic, preference) the
 * digest must NEVER cite. A second, empty project pins the skipped outcome.
 *
 * All timestamps are FIXED so every assertion is deterministic. The `derived_from` targets and
 * the rollup text below are what the run/e2e suites assert against.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NewMemory } from '@onememory-ai/core';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory-ai/storage';

export const WORLD_NOW = () => new Date('2026-10-05T12:00:00.000Z');

export interface DigestWorld {
  storage: OnememoryStorage;
  dataDir: string;
  projectId: string;
  /** An existing project with NO digest sources — pins the `skipped` outcome. */
  emptyProjectId: string;
  sourceId: string;
  /** The memories the digest SHOULD cite (assertion targets). */
  cited: {
    decisionB: MemoryRef;
    decisionA: MemoryRef;
    failureOpen: MemoryRef;
    failureSolved: MemoryRef;
    procedureA: MemoryRef;
    procedureB: MemoryRef;
  };
  /** Distractors the digest must never cite. */
  distractors: { rejectedDecision: MemoryRef; episodic: MemoryRef; preference: MemoryRef };
  close(): Promise<void>;
}

export interface MemoryRef {
  id: string;
  /** The one-liner the rollup should carry for this source. */
  line: string;
}

export interface SeedDigestWorldOptions {
  /**
   * Seed a FOREIGN `projects.digest` key (a manual `summary`) alongside the rollup — pins the
   * owned-namespace merge's key preservation. Off by default: a fresh project starts with an
   * empty digest column, the state where `memory_project_context` warns "project digest not yet
   * built (consolidation pending)" — the before/after transition the e2e suite demonstrates.
   */
  foreignDigest?: boolean;
}

/** Seed a fresh world per suite (each test that mutates state opens its own). */
export async function seedDigestWorld(options: SeedDigestWorldOptions = {}): Promise<DigestWorld> {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-digest-test-'));
  const storage = await createEmbeddedDb(dataDir);
  const { store } = storage;

  const project = await store.createProject({
    name: 'acme-api',
    root_path: '/dev/acme-api',
    description: 'Invoice API for Acme',
    digest: options.foreignDigest === true ? { summary: 'Invoice REST API in TypeScript' } : {},
  });
  const emptyProject = await store.createProject({ name: 'empty-app', root_path: '/dev/empty-app' });
  const source = await store.createSource({
    kind: 'conversation',
    uri: 'conversation/digest-fixture',
    title: 'digest fixture conversation',
    project_id: project.id,
  });

  const memory = (input: {
    type: NewMemory['type'];
    content: string;
    title?: string;
    summary?: string;
    importance?: number;
    observedAt: string;
    payload?: NewMemory['payload'];
  }): NewMemory => ({
    type: input.type,
    content: input.content,
    importance: input.importance ?? 0.8,
    confidence: 0.9,
    observed_at: input.observedAt,
    valid_from: input.observedAt,
    project_id: project.id,
    source_id: source.id,
    evidence: [
      {
        source_id: source.id,
        kind: 'message',
        locator: `conversation/digest-fixture:${input.content.length}`,
        excerpt: input.content.slice(0, 80),
      },
    ],
    extraction: { method: 'heuristic', prompt_version: 'digest-fixture-v1' },
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.summary === undefined ? {} : { content_summary: input.summary }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });

  const insert = async (candidate: NewMemory): Promise<string> => {
    const write = await store.insertMemory(candidate);
    if (write.outcome !== 'inserted') throw new Error(`fixture insert was a ${write.outcome}`);
    return write.memory.id;
  };

  const ref = (id: string, line: string): MemoryRef => ({ id, line });

  // Decisions: B decided later (newest first in the rollup), A earlier; the rejected one excluded.
  const decisionA = await insert(
    memory({
      type: 'decision',
      title: 'Use PostgreSQL as the primary database',
      summary: 'Use PostgreSQL as the primary database for the invoice API.',
      content: 'Use PostgreSQL as the primary database for the invoice API. We chose it for operational maturity.',
      observedAt: '2026-08-01T00:00:00.000Z',
      payload: {
        title: 'Use PostgreSQL as the primary database',
        decision: 'PostgreSQL is the primary database for the invoice API',
        alternatives: [{ option: 'SQLite', why_rejected: 'No operational track record' }],
        rationale: 'Operational maturity and rich extensions',
        participants: ['team-lead'],
        decided_at: '2026-08-01T00:00:00.000Z',
        status: 'accepted',
      },
    }),
  );
  const decisionB = await insert(
    memory({
      type: 'decision',
      title: 'Adopt Bun for the runtime',
      summary: 'Adopt Bun for install, test and dev.',
      content: 'Adopt Bun for install, test and dev. One runtime for everything.',
      observedAt: '2026-09-01T00:00:00.000Z',
      payload: {
        title: 'Adopt Bun for the runtime',
        decision: 'Bun is the runtime for install, test and dev',
        alternatives: [],
        rationale: 'Single toolchain, fast installs',
        participants: ['team-lead'],
        decided_at: '2026-09-01T00:00:00.000Z',
        status: 'accepted',
      },
    }),
  );
  const rejectedDecision = await insert(
    memory({
      type: 'decision',
      title: 'SQLite for local dev',
      summary: 'SQLite for local development.',
      content: 'SQLite for local development was considered and rejected.',
      observedAt: '2026-07-01T00:00:00.000Z',
      payload: {
        title: 'SQLite for local dev',
        decision: 'SQLite for local development',
        alternatives: [],
        participants: [],
        decided_at: '2026-07-01T00:00:00.000Z',
        status: 'rejected',
      },
    }),
  );

  // Failures: the recurring open one outranks the solved one (occurrence, then recency).
  const failureOpen = await insert(
    memory({
      type: 'failure',
      title: 'Cloud Run deploys OOM',
      content: 'Cloud Run deploys fail with OOM when the container exceeds its memory limit during migrations.',
      observedAt: '2026-09-20T00:00:00.000Z',
      payload: {
        problem: 'Cloud Run deploys fail with OOM',
        context: 'gcloud run deploy, migrations step',
        solution: 'Raise the container memory limit to 1GiB for deploys',
        status: 'open',
        signature_hash: 'fixture-sig-oom',
        first_seen_at: '2026-09-01T00:00:00.000Z',
        last_seen_at: '2026-09-20T00:00:00.000Z',
        occurrence_count: 3,
      },
    }),
  );
  const failureSolved = await insert(
    memory({
      type: 'failure',
      title: 'Connection limit exhausted',
      content: 'PostgreSQL connections were exhausted during migrations; fixed via pooling.',
      observedAt: '2026-03-10T00:00:00.000Z',
      payload: {
        problem: 'PostgreSQL connection limit exhausted during migrations',
        context: 'migration scripts against the primary',
        solution: 'Raise max_connections and add pooling',
        status: 'solved',
        signature_hash: 'fixture-sig-connlimit',
        first_seen_at: '2026-03-10T00:00:00.000Z',
        last_seen_at: '2026-03-12T00:00:00.000Z',
        occurrence_count: 2,
      },
    }),
  );

  // Procedures: importance-ordered (A outranks B).
  const procedureA = await insert(
    memory({
      type: 'procedural',
      title: 'Run migrations before serve',
      content: 'Run migrations before the service starts, every deploy.',
      importance: 0.9,
      observedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
  const procedureB = await insert(
    memory({
      type: 'procedural',
      title: 'Ship behind the API gateway',
      content: 'Ship new endpoints behind the API gateway with an allow-list.',
      importance: 0.5,
      observedAt: '2026-09-16T00:00:00.000Z',
    }),
  );

  // Distractors: durable types the digest never reads.
  const episodic = await insert(
    memory({
      type: 'episodic',
      content: 'Today we pair-programmed the invoice rounding fix.',
      observedAt: '2026-09-18T00:00:00.000Z',
    }),
  );
  const preference = await insert(
    memory({
      type: 'preference',
      content: 'Prefer tabs over spaces in this repository.',
      observedAt: '2026-09-19T00:00:00.000Z',
    }),
  );

  return {
    storage,
    dataDir,
    projectId: project.id,
    emptyProjectId: emptyProject.id,
    sourceId: source.id,
    cited: {
      decisionB: ref(
        decisionB,
        'Adopt Bun for install, test and dev. — Single toolchain, fast installs',
      ),
      decisionA: ref(
        decisionA,
        'Use PostgreSQL as the primary database for the invoice API. — Operational maturity and rich extensions',
      ),
      failureOpen: ref(failureOpen, 'Cloud Run deploys fail with OOM → Raise the container memory limit to 1GiB for deploys'),
      failureSolved: ref(
        failureSolved,
        'PostgreSQL connection limit exhausted during migrations → Raise max_connections and add pooling',
      ),
      procedureA: ref(procedureA, 'Run migrations before serve'),
      procedureB: ref(procedureB, 'Ship behind the API gateway'),
    },
    distractors: {
      rejectedDecision: ref(rejectedDecision, 'SQLite for local development.'),
      episodic: ref(episodic, 'Today we pair-programmed the invoice rounding fix.'),
      preference: ref(preference, 'Prefer tabs over spaces in this repository.'),
    },
    close: async () => {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
