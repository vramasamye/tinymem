/**
 * M14a acceptance: the session-end working-memory lifecycle.
 *
 * The Phase-2 definition of done (docs/plan/phased-plan.md) is "session end sweeps working memory
 * with promotion filter" (memory-model.md §10; parity memo §5 Tier A item 1). These tests drive
 * the real ingest path - no mocks, embedded PGlite in a temp dir, worker off, so the async
 * extraction pipeline stays parked while the synchronous session-end pass runs - and assert the
 * promotion filter, the sweep, and idempotency against real storage.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  eventContentHash,
  estimateTokens,
  uuidv7,
  type EvidenceSpan,
  type WorkingMemoryKind,
  type WorkingMemoryRecord,
} from '@onememory-ai/core';
import { renderDefaultConfigYaml } from '@onememory-ai/config';

import { openRuntime, type OnememoryRuntime } from './index';
import { ingestEvents } from './memory-service';
import {
  PROMOTION_IMPORTANCE_THRESHOLD,
  SESSION_SWEEP_PROMPT_VERSION,
  promotionDecision,
  runSessionEndLifecycle,
} from './session-lifecycle';

/** Far enough in the future that no test row can expire while a pass runs. */
const LIVE_EXPIRES_AT = '2027-01-01T00:00:00.000Z';
/** Far enough in the past that every "expired" fixture row is expired for any clock. */
const EXPIRED_AT = '2020-01-01T00:00:00.000Z';

let runtime: OnememoryRuntime;
let projectId: string;
let root: string;

beforeAll(async () => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-session-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(root, '.onememory'), { recursive: true });
  writeFileSync(join(root, '.onememory', 'onememory.yaml'), renderDefaultConfigYaml(), 'utf8');
  runtime = await openRuntime({ cwd: root, env: {}, startWorker: false });
  const project = await runtime.storage.store.createProject({
    name: 'session-lifecycle-test',
    root_path: root,
  });
  projectId = project.id;
});

afterAll(async () => {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** The session row + provenance anchor the working rows need (FK sessions, FK sources). */
async function seedSession(sessionId: string): Promise<{ id: string }> {
  const store = runtime.storage.store;
  await store.createSession({
    id: sessionId,
    project_id: projectId,
    runtime: 'claude-code',
    started_at: '2026-10-05T10:00:00.000Z',
  });
  const source = await store.createSource({
    kind: 'conversation',
    uri: `session/${sessionId}`,
    title: `agent session ${sessionId}`,
    project_id: projectId,
  });
  return { id: source.id };
}

function span(sourceId: string, locator = 'event:seed'): EvidenceSpan {
  return {
    source_id: sourceId,
    kind: 'message',
    locator,
    excerpt: 'the session transcript said so',
  };
}

interface WorkingSeed {
  kind: WorkingMemoryKind;
  content: string;
  importance?: number;
  confidence?: number;
  /** Default true: the row carries the seed source as its provenance anchor. */
  withSource?: boolean;
  /** Default true: the row carries one evidence span citing the seed source. */
  withEvidence?: boolean;
  expires_at?: string;
}

async function seedWorking(
  sessionId: string,
  source: { id: string },
  seed: WorkingSeed,
): Promise<WorkingMemoryRecord> {
  return runtime.storage.store.insertWorking({
    session_id: sessionId,
    kind: seed.kind,
    content: seed.content,
    importance: seed.importance ?? 0.8,
    confidence: seed.confidence ?? 0.7,
    ...(seed.withSource === false ? {} : { source_id: source.id }),
    evidence: seed.withEvidence === false ? [] : [span(source.id)],
    expires_at: seed.expires_at ?? LIVE_EXPIRES_AT,
  });
}

/**
 * A complete `session.end` envelope exactly as an adapter mints one. The summary varies with the
 * session: event dedupe keys on (project, kind, content_hash) and the hash covers the payload, so
 * two sessions ending with byte-identical payloads would collapse onto one event otherwise.
 */
function sessionEndEvent(
  sessionId: string | null,
  options: { summary?: string; ended_at?: string } = {},
) {
  const payload = {
    kind: 'session.end' as const,
    cwd: root,
    ended_at: options.ended_at ?? '2026-10-05T12:00:00.000Z',
    summary: options.summary ?? `claude-code session end (${sessionId ?? 'sessionless'})`,
  };
  return {
    id: uuidv7(),
    kind: 'session.end' as const,
    occurred_at: '2026-10-05T12:00:00.000Z',
    ingested_at: '2026-10-05T12:00:01.000Z',
    source: { runtime: 'claude-code' as const, adapter_version: '0.1.0' },
    scope:
      sessionId === null
        ? { project_id: projectId }
        : { project_id: projectId, session_id: sessionId },
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
  };
}

async function workingRow(sessionId: string, content: string): Promise<WorkingMemoryRecord> {
  const row = (await runtime.storage.store.listWorking(sessionId)).find(
    (candidate) => candidate.content === content,
  );
  if (row === undefined) throw new Error(`no working row holds ${JSON.stringify(content)}`);
  return row;
}

async function durableMemories(content: string) {
  return (await runtime.storage.store.queryCurrent({ project_id: projectId })).filter(
    (memory) => memory.content === content,
  );
}

// ---------------------------------------------------------------------------
// the promotion filter (pure, deterministic)
// ---------------------------------------------------------------------------

describe('the session-end promotion filter', () => {
  const ROW_ID = '0192f3c0-0000-7000-8000-000000000001';
  const SOURCE_ID = '0192f3c0-0000-7000-8000-000000000002';

  function row(overrides: Partial<WorkingMemoryRecord>): WorkingMemoryRecord {
    return {
      id: ROW_ID,
      session_id: 'sess-filter',
      kind: 'task',
      content: 'refactor the store port',
      importance: 0.8,
      confidence: 0.7,
      source_id: SOURCE_ID,
      evidence: [span(SOURCE_ID)],
      promoted_memory_id: null,
      expires_at: LIVE_EXPIRES_AT,
      created_at: '2026-10-05T10:30:00.000Z',
      ...overrides,
    };
  }

  test('promotes provenance-complete rows at or above the documented importance threshold', () => {
    expect(promotionDecision(row({})).eligible).toBeTrue();
    expect(
      promotionDecision(row({ importance: PROMOTION_IMPORTANCE_THRESHOLD })).eligible,
    ).toBeTrue();
    expect(promotionDecision(row({ confidence: 0.1 })).eligible).toBeTrue();
  });

  test('never promotes below the threshold, without provenance, or twice', () => {
    expect(promotionDecision(row({ importance: 0.49 })).eligible).toBeFalse();
    expect(promotionDecision(row({ evidence: [] })).eligible).toBeFalse();
    expect(promotionDecision(row({ source_id: null })).eligible).toBeFalse();
    expect(
      promotionDecision(row({ promoted_memory_id: '0192f3c0-0000-7000-8000-000000000003' })).eligible,
    ).toBeFalse();
  });
});

// ---------------------------------------------------------------------------
// the lifecycle pass, observed through the ingest pipeline
// ---------------------------------------------------------------------------

describe('a session end observed through ingest', () => {
  test('promotes provenance-complete important rows into durable episodic memories', async () => {
    const sessionId = 'sess-promote';
    const source = await seedSession(sessionId);
    const important = await seedWorking(sessionId, source, {
      kind: 'task',
      content: 'Ship the session sweep before the beta.',
      importance: 0.8,
    });
    await seedWorking(sessionId, source, {
      kind: 'hypothesis',
      content: 'Maybe the flake is the clock.',
      importance: 0.3,
    });
    await seedWorking(sessionId, source, {
      kind: 'open_question',
      content: 'Which runner does Pi use?',
      importance: 0.9,
      withEvidence: false,
    });
    await seedWorking(sessionId, source, {
      kind: 'temp_decision',
      content: 'A decision with no source anchor.',
      importance: 0.9,
      withSource: false,
    });

    const result = await ingestEvents(runtime, projectId, [sessionEndEvent(sessionId)]);
    expect(result.stored).toBe(1);
    expect(result.dead_lettered).toBe(0);
    expect(
      result.warnings.some((warning) =>
        warning.includes(`session-end lifecycle for session ${sessionId}`),
      ),
    ).toBeTrue();

    // Exactly one durable memory, created through the audited path with carried provenance.
    const promotedMemories = await durableMemories(important.content);
    expect(promotedMemories).toHaveLength(1);
    const promoted = promotedMemories[0]!;
    expect(promoted.type).toBe('episodic');
    expect(promoted.importance).toBe(0.8);
    expect(promoted.confidence).toBe(0.7);
    expect(promoted.observed_at).toBe(important.created_at);
    expect(promoted.project_id).toBe(projectId);
    expect(promoted.provenance.source.id).toBe(source.id);
    expect(promoted.provenance.evidence).toEqual([span(source.id)]);
    expect(promoted.provenance.extraction.prompt_version).toBe(SESSION_SWEEP_PROMPT_VERSION);
    expect(promoted.tags).toContain('promoted');
    expect(promoted.tags).toContain('working:task');
    const audit = await runtime.storage.store.listMemoryEvents(promoted.id);
    expect(audit.some((event) => event.action === 'created')).toBeTrue();

    // The promoted row is marked; every filtered row stays working, unpromoted and unpurged.
    expect((await workingRow(sessionId, important.content)).promoted_memory_id).toBe(promoted.id);
    const survivors = await runtime.storage.store.listWorking(sessionId);
    expect(survivors).toHaveLength(4);
    for (const survivor of survivors.filter((row) => row.id !== important.id)) {
      expect(survivor.promoted_memory_id).toBeNull();
    }
  });

  test('reprocessing the same session end never duplicates promotions or purges promoted rows', async () => {
    const sessionId = 'sess-idempotent';
    const source = await seedSession(sessionId);
    const eligible = await seedWorking(sessionId, source, {
      kind: 'task',
      content: 'Idempotency is the sweep contract.',
      importance: 0.6,
    });
    await seedWorking(sessionId, source, {
      kind: 'hypothesis',
      content: 'A low-importance note.',
      importance: 0.1,
    });

    const event = sessionEndEvent(sessionId);
    const first = await ingestEvents(runtime, projectId, [event]);
    expect(first.stored).toBe(1);
    const promotedId = (await workingRow(sessionId, eligible.content)).promoted_memory_id;
    expect(promotedId).not.toBeNull();

    // The exact same envelope again: a duplicate event that deliberately re-runs the pass.
    const again = await ingestEvents(runtime, projectId, [event]);
    expect(again.stored).toBe(0);
    expect(again.duplicates).toBe(1);

    // A different end event for the same session (new payload hash) re-runs the pass too.
    const second = await ingestEvents(runtime, projectId, [
      sessionEndEvent(sessionId, { summary: 'claude-code session end (reason: clear)' }),
    ]);
    expect(second.stored).toBe(1);

    expect(await durableMemories(eligible.content)).toHaveLength(1);
    expect((await workingRow(sessionId, eligible.content)).promoted_memory_id).toBe(promotedId);
    const survivors = await runtime.storage.store.listWorking(sessionId);
    expect(survivors).toHaveLength(2); // the promoted row survived every sweep
    expect(
      survivors.find((row) => row.content === 'A low-importance note.')?.promoted_memory_id,
    ).toBeNull();
  });

  test('the sweep purges expired unpromoted rows while promoted rows survive it', async () => {
    const sessionId = 'sess-sweep';
    const source = await seedSession(sessionId);
    const promotedButExpired = await seedWorking(sessionId, source, {
      kind: 'task',
      content: 'Important enough to survive its own expiry.',
      importance: 0.9,
      expires_at: EXPIRED_AT,
    });
    await seedWorking(sessionId, source, {
      kind: 'current_file',
      content: 'src/scratch.ts',
      importance: 0.2,
      expires_at: EXPIRED_AT,
    });

    const result = await ingestEvents(runtime, projectId, [sessionEndEvent(sessionId)]);
    expect(result.stored).toBe(1);
    const summary = result.warnings.find((warning) =>
      warning.includes(`session-end lifecycle for session ${sessionId}`),
    );
    expect(summary).toBeDefined();
    expect(summary).toContain('promoted 1');
    expect(summary).toContain('expired_purged 1');

    const survivors = await runtime.storage.store.listWorking(sessionId);
    expect(survivors.map((row) => row.content)).toEqual([promotedButExpired.content]);
    expect(survivors[0]?.promoted_memory_id).not.toBeNull();
    expect(await durableMemories(promotedButExpired.content)).toHaveLength(1);
  });

  test('a session.end without scope.session_id warns and runs no pass', async () => {
    const sessionId = 'sess-sessionless';
    const source = await seedSession(sessionId);
    await seedWorking(sessionId, source, {
      kind: 'task',
      content: 'An eligible row a sessionless end must not touch.',
      importance: 0.9,
    });
    await seedWorking(sessionId, source, {
      kind: 'current_error',
      content: 'an expired error nobody promoted',
      importance: 0.2,
      expires_at: EXPIRED_AT,
    });

    const result = await ingestEvents(runtime, projectId, [sessionEndEvent(null)]);
    expect(result.stored).toBe(1);
    expect(
      result.warnings.some((warning) => warning.includes('no scope.session_id')),
    ).toBeTrue();
    expect(
      result.warnings.some((warning) => warning.includes('session-end lifecycle for session')),
    ).toBeFalse();

    // No pass ran: nothing was promoted and the global sweep never fired.
    expect(await runtime.storage.store.listWorking(sessionId)).toHaveLength(2);
  });

  test('one batch ending two sessions runs one pass per session', async () => {
    const sessionA = 'sess-batch-a';
    const sessionB = 'sess-batch-b';
    const sourceA = await seedSession(sessionA);
    const sourceB = await seedSession(sessionB);
    await seedWorking(sessionA, sourceA, {
      kind: 'task',
      content: 'Batch session A task.',
      importance: 0.7,
    });
    await seedWorking(sessionB, sourceB, {
      kind: 'task',
      content: 'Batch session B task.',
      importance: 0.7,
    });

    const result = await ingestEvents(runtime, projectId, [
      sessionEndEvent(sessionA),
      sessionEndEvent(sessionB),
    ]);
    expect(result.stored).toBe(2);
    const summaries = result.warnings.filter((warning) =>
      warning.includes('session-end lifecycle for session'),
    );
    expect(summaries).toHaveLength(2);

    for (const sessionId of [sessionA, sessionB]) {
      const rows = await runtime.storage.store.listWorking(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.promoted_memory_id).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// the pass invoked directly (unit seams the ingest response cannot reach)
// ---------------------------------------------------------------------------

describe('runSessionEndLifecycle (direct)', () => {
  test('records the session end and links identical content onto the existing durable memory', async () => {
    const sessionId = 'sess-existing';
    const source = await seedSession(sessionId);
    const content = 'This exact statement already exists durably.';
    const preexisting = await runtime.storage.store.insertMemory({
      type: 'episodic',
      content,
      importance: 0.9,
      confidence: 0.9,
      observed_at: '2026-10-05T10:15:00.000Z',
      project_id: projectId,
      source_id: source.id,
      evidence: [span(source.id)],
      extraction: { method: 'heuristic', prompt_version: 'fixture' },
      token_estimate: estimateTokens(content),
    });
    expect(preexisting.outcome).toBe('inserted');
    const eligible = await seedWorking(sessionId, source, {
      kind: 'task',
      content,
      importance: 0.9,
    });

    const result = await runSessionEndLifecycle(runtime, projectId, {
      session_id: sessionId,
      runtime: 'claude-code',
      ended_at: '2026-10-05T12:30:00.000Z',
      summary: 'claude-code session end (reason: logout)',
    });

    // The session end is recorded on the sessions row (createSession is an upsert that returns it).
    expect(result.session.id).toBe(sessionId);
    expect(result.session.ended_at).toBe('2026-10-05T12:30:00.000Z');
    expect(result.session.summary).toBe('claude-code session end (reason: logout)');
    // The upsert must not rewrite the session's original start.
    expect(result.session.started_at).toBe('2026-10-05T10:00:00.000Z');

    // The row is linked to the existing memory, not duplicated.
    expect(result.considered).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.linked_existing).toBe(1);
    expect(result.failed).toBe(0);
    expect((await workingRow(sessionId, content)).promoted_memory_id).toBe(preexisting.memory.id);
    expect(await durableMemories(content)).toHaveLength(1);
  });

  test('the pass reports the skip-reason breakdown and the expired purge count', async () => {
    const sessionId = 'sess-breakdown';
    const source = await seedSession(sessionId);
    await seedWorking(sessionId, source, {
      kind: 'task',
      content: 'The one row that passes every gate.',
      importance: 0.9,
    });
    await seedWorking(sessionId, source, {
      kind: 'hypothesis',
      content: 'Too unimportant to keep.',
      importance: 0.2,
    });
    await seedWorking(sessionId, source, {
      kind: 'open_question',
      content: 'Asked without any evidence.',
      importance: 0.9,
      withEvidence: false,
    });
    await seedWorking(sessionId, source, {
      kind: 'temp_decision',
      content: 'Decided without a source anchor.',
      importance: 0.9,
      withSource: false,
    });
    // An expired low-importance row: skipped by the filter AND purge fodder for the sweep.
    await seedWorking(sessionId, source, {
      kind: 'current_file',
      content: 'src/expired.ts',
      importance: 0.2,
      expires_at: EXPIRED_AT,
    });
    // A row promoted before the pass: skipped as already promoted (never re-promoted).
    const previouslyPromoted = await seedWorking(sessionId, source, {
      kind: 'task',
      content: 'Promoted in an earlier pass.',
      importance: 0.9,
    });
    const earlierMemory = await runtime.storage.store.insertMemory({
      type: 'episodic',
      content: 'Promoted in an earlier pass.',
      importance: 0.9,
      confidence: 0.9,
      observed_at: '2026-10-05T10:45:00.000Z',
      project_id: projectId,
      source_id: source.id,
      evidence: [span(source.id)],
      extraction: { method: 'heuristic', prompt_version: 'fixture' },
      token_estimate: 7,
    });
    await runtime.storage.store.markWorkingPromoted(
      previouslyPromoted.id,
      earlierMemory.memory.id,
    );

    const result = await runSessionEndLifecycle(runtime, projectId, {
      session_id: sessionId,
      runtime: 'claude-code',
      ended_at: '2026-10-05T13:00:00.000Z',
    });

    expect(result.considered).toBe(6);
    expect(result.inserted).toBe(1);
    expect(result.linked_existing).toBe(0);
    expect(result.promoted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped.already_promoted).toBe(1);
    expect(result.skipped.below_importance_threshold).toBe(2);
    expect(result.skipped.no_evidence).toBe(1);
    expect(result.skipped.no_source).toBe(1);
    // The sweep is global (sweepWorking has no session parameter), so the count is a lower bound
    // across sessions; the row-level contract below is the exact assertion.
    expect(result.expired_purged).toBeGreaterThanOrEqual(1);

    const survivors = await runtime.storage.store.listWorking(sessionId);
    expect(survivors.map((row) => row.content)).not.toContain('src/expired.ts');
    expect(
      survivors.find((row) => row.content === 'Promoted in an earlier pass.')?.promoted_memory_id,
    ).toBe(earlierMemory.memory.id);
    expect(
      survivors.find((row) => row.content === 'The one row that passes every gate.')
        ?.promoted_memory_id,
    ).not.toBeNull();
    for (const content of [
      'Too unimportant to keep.',
      'Asked without any evidence.',
      'Decided without a source anchor.',
    ]) {
      expect(survivors.find((row) => row.content === content)?.promoted_memory_id).toBeNull();
    }
  });
});
