/**
 * Per-tool handler suites (happy + error paths, isError results) against a REAL embedded
 * PGlite per test (the storage integration pattern) with the deterministic test embedder.
 *
 * Covers the mission-5 contract points: progressive disclosure + token budgets, redaction on
 * every write path, provenance gate, never-silent store outcomes, revision-checked updates,
 * forget ≠ delete state machine, and the isError taxonomy (never an escaping exception).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { MemoryRecord } from '@onememory/core';

import { TOOL_HANDLERS } from './handlers';
import { makeToolCallback } from './results';
import type { McpTestWorld } from './testing';
import { MCP_TEST_NOW, openMcpTestWorld, seedFixtureMemory } from './testing';

/**
 * Synthetic credential fixtures for the redaction tests — assembled at runtime exactly like
 * @onememory/security's own redact-event.test.ts (`ghp_${A(36)}`), so no credential-shaped
 * literal is ever committed to the tree. These are NOT real credentials.
 */
const A = (n: number, char = 'a'): string => char.repeat(n);
const FIXTURE_GITHUB_PAT = `ghp_${A(36, '1')}`;
const FIXTURE_ANTHROPIC_KEY = `sk-ant-${A(40, 'b')}`;
const FIXTURE_PASSWORD = `pw-${A(6, 'c')}`;

let world: McpTestWorld;

beforeEach(async () => {
  world = await openMcpTestWorld();
});

afterEach(async () => {
  await world.close();
});

/** Call a tool through the production wrapper — exactly what the SDK dispatches to. */
async function call<K extends keyof typeof TOOL_HANDLERS>(
  tool: K,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const callback = makeToolCallback(world.context, TOOL_HANDLERS[tool] as never, tool);
  return callback(args);
}

function expectOk(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function expectError(result: CallToolResult, code: string): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { error: { code: string; message: string } };
  expect(structured.error.code).toBe(code);
  // The human-readable channel carries the same story for weaker clients.
  expect(result.content[0]?.type).toBe('text');
  expect((result.content[0] as { text: string }).text).toContain(code);
  return structured as unknown as Record<string, unknown>;
}

async function storeOne(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await call('memory_store', {
    content: 'The API gateway rate limit is 100 requests per minute.',
    type: 'semantic',
    evidence: [{ excerpt: 'gateway config discussion', locator: 'session.jsonl:12' }],
    ...overrides,
  });
  const structured = expectOk(result);
  return structured.id as string;
}

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

describe('memory_search', () => {
  test('returns the progressive-disclosure ID-index: id + one-line summary + token estimate, no content body', async () => {
    await storeOne();
    const structured = expectOk(await call('memory_search', { query: 'rate limit gateway' }));

    const results = structured.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const entry of results) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.summary).toBe('string');
      expect(typeof entry.token_estimate).toBe('number');
      expect(entry.token_estimate).toBeGreaterThan(0);
      expect(entry.content).toBeUndefined(); // the index NEVER carries full content bodies
      expect(typeof entry.relevance).toBe('number');
    }
    expect(typeof structured.token_estimate).toBe('number');
    expect(structured.token_estimate as number).toBeGreaterThan(0);
  });

  test('max_tokens is honored: a tiny budget shrinks the result set and the used count', async () => {
    for (let i = 0; i < 5; i += 1) {
      await storeOne({
        content: `Service dependency ${i}: the invoice microservice uses Redis cache ${i} for sessions.`,
        type: 'semantic',
      });
    }
    const wide = expectOk(await call('memory_search', { query: 'redis cache sessions invoice', max_tokens: 2000 }));
    const narrow = expectOk(await call('memory_search', { query: 'redis cache sessions invoice', max_tokens: 40 }));

    expect((wide.results as unknown[]).length).toBeGreaterThanOrEqual((narrow.results as unknown[]).length);
    expect(narrow.tokens as { used: number }).toBeDefined();
    expect((narrow.tokens as { used: number }).used).toBeLessThanOrEqual(40);
  });

  test('kind filter maps the curated lists onto the type taxonomy (decision/failure/skill)', async () => {
    const decisionId = await seedFixtureMemory(world, {
      type: 'decision',
      content: 'We use PostgreSQL, not SQLite, for transactional storage.',
      title: 'Primary database engine',
      observedAt: '2026-01-10T00:00:00.000Z',
    });
    await seedFixtureMemory(world, {
      type: 'failure',
      content: 'Cloud Run deploys failed with OOM until memory limits were raised.',
      title: 'Deploy OOM',
      observedAt: '2026-01-11T00:00:00.000Z',
    });
    const procedureId = await seedFixtureMemory(world, {
      type: 'procedural',
      content: 'Deploy with gcloud run deploy then verify the service URL responds.',
      title: 'Deploy procedure',
      observedAt: '2026-01-12T00:00:00.000Z',
    });

    const decisions = expectOk(await call('memory_search', { query: 'database engine choice', kind: 'decision' }));
    for (const entry of decisions.results as Array<{ type: string }>) expect(entry.type).toBe('decision');
    expect((decisions.results as Array<{ id: string }>).some((entry) => entry.id === decisionId)).toBe(true);

    const failures = expectOk(await call('memory_search', { query: 'deploy failing', kind: 'failure' }));
    for (const entry of failures.results as Array<{ type: string }>) expect(entry.type).toBe('failure');

    // skill == promoted procedural know-how (memory-model.md §2/§9)
    const skills = expectOk(await call('memory_search', { query: 'how to deploy', kind: 'skill' }));
    for (const entry of skills.results as Array<{ type: string }>) expect(entry.type).toBe('procedural');
    expect((skills.results as Array<{ id: string }>).some((entry) => entry.id === procedureId)).toBe(true);
  });

  test('a healthy search carries zero warnings (degradation is never silent — the inverse holds too)', async () => {
    await storeOne();
    const structured = expectOk(await call('memory_search', { query: 'rate limit' }));
    expect(structured.warnings).toEqual([]);
  });

  test('no-embedder context still answers (lexical + graph) with an explicit warning', async () => {
    await world.close();
    world = await openMcpTestWorld({ embedder: null });
    await storeOne();
    const structured = expectOk(await call('memory_search', { query: 'rate limit' }));
    expect((structured.warnings as string[]).some((warning) => warning.includes('embedding'))).toBe(true);
  });

  test('invalid input becomes an isError result (invalid_input), never an escaping exception', async () => {
    const structured = expectError(await call('memory_search', { query: '' }), 'invalid_input');
    expect((structured.error as { message: string }).message).toContain('query');
  });

  test('bogus max_tokens shape is a schema failure at the handler boundary too', async () => {
    await expectError(await call('memory_search', { query: 'x', max_tokens: 0 }), 'invalid_input');
    await expectError(await call('memory_search', { query: 'x', kind: 'bogus' }), 'invalid_input');
  });
});

// ---------------------------------------------------------------------------
// memory_get
// ---------------------------------------------------------------------------

describe('memory_get', () => {
  test('returns the full wire record with provenance, entities, tags, and token estimate', async () => {
    const id = await storeOne({
      title: 'Gateway rate limit',
      tags: ['gateway'],
      entities: [{ name: 'API Gateway', kind: 'service' }],
    });

    const structured = expectOk(await call('memory_get', { id }));
    const memory = structured.memory as MemoryRecord;
    expect(memory.id).toBe(id);
    expect(memory.content).toContain('rate limit');
    expect(memory.provenance.source.kind).toBe('explicit');
    expect(memory.provenance.evidence.length).toBe(1);
    expect(memory.provenance.extraction.method).toBe('heuristic');
    expect(memory.provenance.extraction.prompt_version).toBe('onememory/mcp-store/v1');
    expect(memory.entities.map((entity) => entity.name)).toContain('API Gateway');
    expect(memory.tags).toContain('gateway');
    expect(typeof structured.token_estimate).toBe('number');
  });

  test('include_history returns the supersession chain; include_audit returns the audit rows', async () => {
    const id = await seedFixtureMemory(world, {
      type: 'semantic',
      content: 'Node 20 is the runtime.',
      observedAt: '2026-02-01T00:00:00.000Z',
    });

    const structured = expectOk(await call('memory_get', { id, include_history: true, include_audit: true }));
    expect((structured.history as unknown[]).length).toBe(1);
    const audit = structured.audit as Array<{ action: string }>;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.action).toBe('created');
  });

  test('unknown id → isError not_found', async () => {
    const structured = expectError(
      await call('memory_get', { id: '00000000-0000-7000-8000-000000000099' }),
      'not_found',
    );
    expect(((structured.error as { details?: { memory_id?: string } }).details ?? {}).memory_id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// memory_store — outcomes, provenance gate, redaction, scope
// ---------------------------------------------------------------------------

describe('memory_store', () => {
  test('outcome "new": fresh content is stored and is immediately retrievable', async () => {
    const structured = expectOk(
      await call('memory_store', {
        content: 'The staging environment runs on Fly.io.',
        type: 'semantic',
        evidence: [{ excerpt: 'infra discussion', locator: 'session.jsonl:40' }],
      }),
    );
    expect(structured.outcome).toBe('new');
    expect(structured.existing_id).toBeUndefined();
    expect(structured.superseded_id).toBeUndefined();
  });

  test('outcome "merged" is NEVER silent: identical (scope, type, content) reports the existing id and writes nothing', async () => {
    const first = await storeOne();
    const second = expectOk(
      await call('memory_store', {
        content: 'The API gateway rate limit is 100 requests per minute.', // identical (after normalization)
        type: 'semantic',
        evidence: [{ excerpt: 'gateway config discussion again' }],
      }),
    );
    expect(second.outcome).toBe('merged');
    expect(second.id).toBe(first);
    expect(second.existing_id).toBe(first);
    expect((second.warnings as string[]).some((warning) => warning.includes('supersedes'))).toBe(true);

    // Nothing new was written — exactly one row for this content.
    const rows = await world.storage.client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM memories WHERE content LIKE $1',
      ['%rate limit%'],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  test('same content, different type → NOT merged (the dedupe key includes type)', async () => {
    await storeOne();
    const structured = expectOk(
      await call('memory_store', {
        content: 'The API gateway rate limit is 100 requests per minute.',
        type: 'procedural',
        evidence: [{ excerpt: 'typed differently' }],
      }),
    );
    expect(structured.outcome).toBe('new');
  });

  test('outcome "superseded": supersedes replaces the target in one transaction, history preserved', async () => {
    const oldId = await seedFixtureMemory(world, {
      type: 'semantic',
      content: 'Node 20 is the runtime version.',
      observedAt: '2026-02-01T00:00:00.000Z',
    });

    const structured = expectOk(
      await call('memory_store', {
        content: 'Node 22 is the runtime version.',
        type: 'semantic',
        evidence: [{ excerpt: 'upgrade discussion', locator: 'session.jsonl:50' }],
        supersedes: oldId,
        reason: 'runtime upgraded',
      }),
    );
    expect(structured.outcome).toBe('superseded');
    expect(structured.superseded_id).toBe(oldId);
    expect(structured.id).not.toBe(oldId);

    // The loser: status superseded, valid_until closed, superseded_by pointing forward — retained.
    const loser = await world.storage.store.getMemory(oldId);
    expect(loser!.status).toBe('superseded');
    expect(loser!.superseded_by).toBe(structured.id as string);
    expect(loser!.valid_until).not.toBeNull();

    // History preserved: the chain contains both revisions.
    const chain = await world.storage.store.historyOf(oldId);
    expect(chain.map((record) => record.id)).toContain(oldId);
    expect(chain.map((record) => record.id)).toContain(structured.id as string);
  });

  test('superseding a memory with identical content → merged, target left UNCHANGED', async () => {
    const targetId = await storeOne();
    const structured = expectOk(
      await call('memory_store', {
        content: 'The API gateway rate limit is 100 requests per minute.',
        type: 'semantic',
        evidence: [{ excerpt: 'same again' }],
        supersedes: targetId,
      }),
    );
    expect(structured.outcome).toBe('merged');
    const target = await world.storage.store.getMemory(targetId);
    expect(target!.status).toBe('active'); // untouched
  });

  test('supersedes an unknown id → isError not_found', async () => {
    await expectError(
      await call('memory_store', {
        content: 'x',
        type: 'semantic',
        evidence: [{ excerpt: 'e' }],
        supersedes: '00000000-0000-7000-8000-000000000098',
      }),
      'not_found',
    );
  });

  test('PROVENANCE GATE: no evidence → isError provenance_required, nothing written (ADR-0003 rule 4)', async () => {
    const structured = expectError(
      await call('memory_store', { content: 'some fact', type: 'semantic' }),
      'provenance_required',
    );
    expect((structured.error as { message: string }).message).toContain('evidence');
    const rows = await world.storage.client.query<{ n: number }>('SELECT count(*)::int AS n FROM memories');
    expect(rows.rows[0]?.n).toBe(0);
  });

  test('REDACTION-ON-WRITE: secrets in content are stripped BEFORE persisting (taint never reaches the row)', async () => {
    const structured = expectOk(
      await call('memory_store', {
        content: `The deploy token is ${FIXTURE_GITHUB_PAT} stored in the CI vault.`,
        type: 'semantic',
        title: `CI deploy token ${FIXTURE_ANTHROPIC_KEY}`,
        evidence: [{ excerpt: `login password=${FIXTURE_PASSWORD} appeared in plaintext`, locator: 'session.jsonl:60' }],
      }),
    );

    // The result reports WHAT was redacted (kind + location + length) — never the value.
    const redactions = structured.redactions as Array<{ kind: string; location: string; length: number }>;
    expect(redactions.length).toBeGreaterThanOrEqual(3);
    for (const redaction of redactions) {
      expect(typeof redaction.kind).toBe('string');
      expect(redaction.location.startsWith('$.')).toBe(true);
      expect(redaction.length).toBeGreaterThan(0);
    }

    const memory = await world.storage.store.getMemory(structured.id as string);
    expect(memory!.content).toContain('[REDACTED:token]');
    expect(memory!.content).not.toContain(FIXTURE_GITHUB_PAT);
    expect(memory!.title).toContain('[REDACTED:api-key]');
    expect(memory!.title).not.toContain(FIXTURE_ANTHROPIC_KEY);
    const evidence = memory!.provenance.evidence[0]!;
    expect(evidence.excerpt).not.toContain(FIXTURE_PASSWORD);
    expect(evidence.excerpt).toContain('[REDACTED:password]');

    // The raw database row is clean too (jsonb text from the table itself).
    const rows = await world.storage.client.query<{ content: string; evidence: string }>(
      'SELECT content::text AS content, evidence::text AS evidence FROM memories WHERE id = $1::uuid',
      [structured.id as string],
    );
    expect(rows.rows[0]!.content).not.toContain(FIXTURE_GITHUB_PAT);
    expect(rows.rows[0]!.evidence).not.toContain(FIXTURE_PASSWORD);
  });

  test('scope: "user" stores user-scoped; "project" without a configured project → isError project_required', async () => {
    await world.close();
    world = await openMcpTestWorld({ config: { projectId: null } });

    const userScoped = expectOk(
      await call('memory_store', {
        content: 'The user prefers tabs over spaces.',
        type: 'preference',
        scope: 'user',
        evidence: [{ excerpt: 'style discussion' }],
      }),
    );
    const record = await world.storage.store.getMemory(userScoped.id as string);
    expect(record!.user_id).toBeDefined();
    expect(record!.project_id).toBeUndefined();

    await expectError(
      await call('memory_store', {
        content: 'x',
        type: 'semantic',
        scope: 'project',
        evidence: [{ excerpt: 'e' }],
      }),
      'project_required',
    );
  });

  test('unscoped write with no configured project warns honestly (never silent)', async () => {
    await world.close();
    world = await openMcpTestWorld({ config: { projectId: null } });
    const structured = expectOk(
      await call('memory_store', {
        content: 'A cross-project fact.',
        type: 'semantic',
        evidence: [{ excerpt: 'e' }],
      }),
    );
    expect((structured.warnings as string[]).some((warning) => warning.includes('project scope'))).toBe(true);
  });

  test('empty validity window → isError invalid_window', async () => {
    await expectError(
      await call('memory_store', {
        content: 'x',
        type: 'semantic',
        evidence: [{ excerpt: 'e' }],
        valid_from: '2026-01-02T00:00:00.000Z',
        valid_until: '2026-01-01T00:00:00.000Z',
      }),
      'invalid_window',
    );
  });

  test('entity names are redacted then resolved and bound (create-on-miss)', async () => {
    const structured = expectOk(
      await call('memory_store', {
        content: 'Payments service talks to Stripe.',
        type: 'semantic',
        evidence: [{ excerpt: 'e' }],
        entities: [{ name: 'Stripe' }, { name: 'Payments service', kind: 'service' }],
      }),
    );
    const memory = await world.storage.store.getMemory(structured.id as string);
    expect(memory!.entities.length).toBe(2);
    expect(memory!.entities.some((entity) => entity.name === 'Stripe')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// memory_update — revision-checked optimistic concurrency, append-mostly
// ---------------------------------------------------------------------------

describe('memory_update', () => {
  async function seedAndGet(): Promise<{ id: string; revision: string }> {
    const id = await seedFixtureMemory(world, {
      type: 'semantic',
      content: 'The queue worker uses Redis 6.',
      observedAt: '2026-03-01T00:00:00.000Z',
    });
    const record = (await world.storage.store.getMemory(id))!;
    return { id, revision: record.updated_at };
  }

  test('happy path: corrected content becomes a NEW revision; the old one is superseded, both retained', async () => {
    const { id, revision } = await seedAndGet();

    const structured = expectOk(
      await call('memory_update', {
        id,
        expected_revision: revision,
        content: 'The queue worker uses Redis 7.',
        reason: 'version bump verified in package.json',
      }),
    );
    expect(structured.outcome).toBe('superseded');
    expect(structured.previous_id).toBe(id);
    const newId = structured.id as string;
    expect(newId).not.toBe(id);
    expect(typeof structured.revision).toBe('string');

    // The old revision: superseded + window closed + superseded_by forward link.
    const old = await world.storage.store.getMemory(id);
    expect(old!.status).toBe('superseded');
    expect(old!.superseded_by).toBe(newId);

    // The new revision: active, correct content, provenance inherited from the same source.
    const updated = await world.storage.store.getMemory(newId);
    expect(updated!.content).toBe('The queue worker uses Redis 7.');
    expect(updated!.status).toBe('active');
    expect(updated!.provenance.source.id).toBe(old!.provenance.source.id);
    expect(updated!.provenance.extraction.prompt_version).toBe('onememory/mcp-update/v1');
  });

  test('temporal correctness: as_of before the update still sees the OLD revision; current sees the NEW one', async () => {
    const { id, revision } = await seedAndGet();
    await call('memory_update', { id, expected_revision: revision, content: 'The queue worker uses Redis 7.' });

    const current = expectOk(await call('memory_search', { query: 'queue worker redis version' }));
    const currentContents = (current.results as Array<{ id: string }>).map((entry) => entry.id);
    expect(currentContents).not.toContain(id);

    const historical = expectOk(
      await call('memory_search', {
        query: 'queue worker redis version',
        as_of: '2026-03-02T00:00:00.000Z',
        temporal_mode: 'historical',
      }),
    );
    expect((historical.results as Array<{ id: string }>).some((entry) => entry.id === id)).toBe(true);
  });

  test('REVISION CONFLICT: a stale expected_revision → isError with the current revision for retry', async () => {
    const { id } = await seedAndGet();
    const structured = expectError(
      await call('memory_update', { id, expected_revision: '2020-01-01T00:00:00.000Z', content: 'x content' }),
      'revision_conflict',
    );
    const details = (structured.error as { details?: { current_revision?: string } }).details ?? {};
    expect(details.current_revision).toBeDefined();
  });

  test('the revision token moves after an update: retrying with the OLD token now conflicts', async () => {
    const { id, revision } = await seedAndGet();
    await expectOk(await call('memory_update', { id, expected_revision: revision, content: 'Redis 7.' }));
    const second = await call('memory_update', { id, expected_revision: revision, content: 'Redis 8.' });
    expectError(second, 'revision_conflict');
  });

  test('metadata-only edit (content unchanged) → isError metadata_only_update_unsupported, nothing changed', async () => {
    const { id, revision } = await seedAndGet();
    const structured = expectError(
      await call('memory_update', { id, expected_revision: revision, title: 'A new title' }),
      'metadata_only_update_unsupported',
    );
    expect((structured.error as { message: string }).message).toContain('metadata-only');
    const record = await world.storage.store.getMemory(id);
    expect(record!.title).toBeUndefined(); // untouched
  });

  test('no fields at all → isError no_change', async () => {
    const { id, revision } = await seedAndGet();
    await expectError(await call('memory_update', { id, expected_revision: revision }), 'no_change');
  });

  test('new content identical to an EXISTING third memory → revision_conflict (nothing superseded)', async () => {
    const { id, revision } = await seedAndGet();
    const otherId = await seedFixtureMemory(world, {
      type: 'semantic',
      content: 'The queue worker uses Valkey 8.',
      observedAt: '2026-03-01T00:00:00.000Z',
    });
    const structured = expectError(
      await call('memory_update', {
        id,
        expected_revision: revision,
        content: 'The queue worker uses Valkey 8.',
      }),
      'revision_conflict',
    );
    expect((structured.error as { details?: { existing_id?: string } }).details?.existing_id).toBe(otherId);
    const loser = await world.storage.store.getMemory(id);
    expect(loser!.status).toBe('active'); // untouched
  });

  test('explicit observed_at before the old revision window → isError invalid_window', async () => {
    const { id, revision } = await seedAndGet(); // valid_from 2026-03-01
    await expectError(
      await call('memory_update', {
        id,
        expected_revision: revision,
        content: 'Redis 7.',
        observed_at: '2026-01-01T00:00:00.000Z',
      }),
      'invalid_window',
    );
  });

  test('unknown id → isError not_found', async () => {
    await expectError(
      await call('memory_update', {
        id: '00000000-0000-7000-8000-000000000097',
        expected_revision: 'x',
        content: 'y',
      }),
      'not_found',
    );
  });

  test('redaction runs on the new content too (secrets never persist via updates)', async () => {
    const { id, revision } = await seedAndGet();
    const structured = expectOk(
      await call('memory_update', {
        id,
        expected_revision: revision,
        content: 'The worker key is AKIAIOSFODNN7EXAMPLE rotated weekly.',
      }),
    );
    expect((structured.redactions as unknown[]).length).toBeGreaterThanOrEqual(1);
    const updated = await world.storage.store.getMemory(structured.id as string);
    expect(updated!.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(updated!.content).toContain('[REDACTED:api-key]');
  });
});

// ---------------------------------------------------------------------------
// memory_delete / memory_forget — hard purge vs soft tombstone
// ---------------------------------------------------------------------------

describe('memory_delete (hard purge)', () => {
  test('delete ≠ forget: currently fails LOUDLY with purge_unavailable (storage primitive follow-up)', async () => {
    const id = await storeOne();
    const record = (await world.storage.store.getMemory(id))!;
    const structured = expectError(
      await call('memory_delete', { id, expected_revision: record.updated_at }),
      'purge_unavailable',
    );
    expect((structured.error as { message: string }).message).toContain('memory_forget');

    // NOTHING was deleted — the row is still there.
    expect(await world.storage.store.getMemory(id)).not.toBeNull();
  });

  test('wrong revision → isError revision_conflict (a purge can never be accidental)', async () => {
    const id = await storeOne();
    await expectError(
      await call('memory_delete', { id, expected_revision: '1999-01-01T00:00:00.000Z' }),
      'revision_conflict',
    );
  });

  test('unknown id → isError not_found', async () => {
    await expectError(
      await call('memory_delete', {
        id: '00000000-0000-7000-8000-000000000096',
        expected_revision: '1999-01-01T00:00:00.000Z',
      }),
      'not_found',
    );
  });
});

describe('memory_forget (soft tombstone)', () => {
  test('forget → archived tombstone, audited, RECOVERABLE; the row is NOT deleted', async () => {
    const id = await storeOne();

    const structured = expectOk(await call('memory_forget', { id, reason: 'stale fact' }));
    expect(structured.status).toBe('archived');
    expect(structured.action).toBe('archived');
    expect(structured.recoverable).toBe(true);
    expect((structured.audit as { to_status: string }).to_status).toBe('archived');

    // Append-mostly invariant: the row survives; the audit trail records the transition.
    const record = await world.storage.store.getMemory(id);
    expect(record).not.toBeNull();
    expect(record!.status).toBe('archived');
    const events = await world.storage.store.listMemoryEvents(id);
    expect(events.some((event) => event.action === 'archived')).toBe(true);

    // Forgotten (archived) is invisible to default retrieval…
    const current = expectOk(await call('memory_search', { query: 'rate limit gateway' }));
    expect((current.results as Array<{ id: string }>).map((entry) => entry.id)).not.toContain(id);

    // …but explicit include can still surface it (recoverable ≠ deleted).
    const withArchived = expectOk(
      await call('memory_search', { query: 'rate limit gateway', include: ['archived'] }),
    );
    expect((withArchived.results as Array<{ id: string }>).some((entry) => entry.id === id)).toBe(true);
  });

  test('recover: true restores the tombstone (archived → active, audited as "restored")', async () => {
    const id = await storeOne();
    await expectOk(await call('memory_forget', { id }));
    const structured = expectOk(await call('memory_forget', { id, recover: true }));
    expect(structured.status).toBe('active');
    expect(structured.action).toBe('restored');

    const record = await world.storage.store.getMemory(id);
    expect(record!.status).toBe('active');

    // Visible to default retrieval again.
    const current = expectOk(await call('memory_search', { query: 'rate limit gateway' }));
    expect((current.results as Array<{ id: string }>).some((entry) => entry.id === id)).toBe(true);

    const events = await world.storage.store.listMemoryEvents(id);
    expect(events.some((event) => event.action === 'restored')).toBe(true);
  });

  test('forgetting an already-forgotten memory → isError invalid_transition with the recover hint', async () => {
    const id = await storeOne();
    await expectOk(await call('memory_forget', { id }));
    const structured = expectError(await call('memory_forget', { id }), 'invalid_transition');
    expect((structured.error as { message: string }).message).toContain('recover');
  });

  test('recovering a non-archived memory → isError invalid_transition', async () => {
    const id = await storeOne(); // active
    await expectError(await call('memory_forget', { id, recover: true }), 'invalid_transition');
  });

  test('optional expected_revision is enforced when supplied', async () => {
    const id = await storeOne();
    await expectError(
      await call('memory_forget', { id, expected_revision: '1999-01-01T00:00:00.000Z' }),
      'revision_conflict',
    );
  });

  test('the forget reason is redacted before it reaches the audit trail', async () => {
    const id = await storeOne();
    const structured = expectOk(
      await call('memory_forget', { id, reason: `contained ${FIXTURE_GITHUB_PAT} leak` }),
    );
    expect((structured.redactions as unknown[]).length).toBeGreaterThanOrEqual(1);
    const events = await world.storage.store.listMemoryEvents(id);
    const json = JSON.stringify(events);
    expect(json).not.toContain(FIXTURE_GITHUB_PAT);
    expect(json).toContain('[REDACTED:token]');
  });

  test('unknown id → isError not_found', async () => {
    await expectError(
      await call('memory_forget', { id: '00000000-0000-7000-8000-000000000095' }),
      'not_found',
    );
  });
});

// ---------------------------------------------------------------------------
// memory_related
// ---------------------------------------------------------------------------

describe('memory_related', () => {
  test('walks graph edges in both directions with relation + direction labels', async () => {
    const cause = await seedFixtureMemory(world, {
      type: 'failure',
      content: 'Deploys failed with connection refused.',
      observedAt: '2026-04-01T00:00:00.000Z',
    });
    const fix = await seedFixtureMemory(world, {
      type: 'procedural',
      content: 'Raising the connection pool fixed the deploys.',
      observedAt: '2026-04-02T00:00:00.000Z',
    });
    await world.storage.store.addEdge({
      from_memory_id: cause,
      to_memory_id: fix,
      relation: 'solved_by',
      project_id: world.ids.projectId,
    });

    const structured = expectOk(await call('memory_related', { id: cause }));
    const related = structured.related as Array<{ memory: { id: string }; relation: string; direction: string }>;
    expect(related.length).toBe(1);
    expect(related[0]!.memory.id).toBe(fix);
    expect(related[0]!.relation).toBe('solved_by');
    expect(related[0]!.direction).toBe('outgoing');

    const incoming = expectOk(await call('memory_related', { id: fix }));
    expect((incoming.related as Array<{ direction: string }>)[0]!.direction).toBe('incoming');
  });

  test('direction and relations filters apply', async () => {
    const a = await seedFixtureMemory(world, { type: 'semantic', content: 'A fact.', observedAt: '2026-04-01T00:00:00.000Z' });
    const b = await seedFixtureMemory(world, { type: 'semantic', content: 'B fact.', observedAt: '2026-04-01T00:00:00.000Z' });
    await world.storage.store.addEdge({
      from_memory_id: a,
      to_memory_id: b,
      relation: 'related_to',
      project_id: world.ids.projectId,
    });
    await world.storage.store.addEdge({
      from_memory_id: b,
      to_memory_id: a,
      relation: 'contradicts',
      project_id: world.ids.projectId,
    });

    const outgoing = expectOk(await call('memory_related', { id: a, direction: 'outgoing' }));
    expect((outgoing.related as unknown[]).length).toBe(1);
    expect((outgoing.related as Array<{ relation: string }>)[0]!.relation).toBe('related_to');

    const filtered = expectOk(await call('memory_related', { id: a, relations: ['contradicts'] }));
    expect((filtered.related as Array<{ direction: string }>)[0]!.direction).toBe('incoming');
  });

  test('edges whose validity window expired are skipped unless include_expired', async () => {
    const a = await seedFixtureMemory(world, { type: 'semantic', content: 'A fact.', observedAt: '2026-04-01T00:00:00.000Z' });
    const b = await seedFixtureMemory(world, { type: 'semantic', content: 'B fact.', observedAt: '2026-04-01T00:00:00.000Z' });
    await world.storage.store.addEdge({
      from_memory_id: a,
      to_memory_id: b,
      relation: 'related_to',
      project_id: world.ids.projectId,
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: '2026-06-01T00:00:00.000Z', // expired relative to the fixed test clock (2027-01-15)
    });

    const fresh = expectOk(await call('memory_related', { id: a }));
    expect((fresh.related as unknown[]).length).toBe(0);

    const withExpired = expectOk(await call('memory_related', { id: a, include_expired: true }));
    expect((withExpired.related as unknown[]).length).toBe(1);
  });

  test('unknown anchor id → isError not_found', async () => {
    await expectError(await call('memory_related', { id: '00000000-0000-7000-8000-000000000094' }), 'not_found');
  });
});

// ---------------------------------------------------------------------------
// memory_project_context
// ---------------------------------------------------------------------------

describe('memory_project_context', () => {
  test('builds the packed session-start context under the budget, with sections + warnings', async () => {
    await seedFixtureMemory(world, {
      type: 'procedural',
      content: 'Deploy via gcloud run deploy with the service account.',
      title: 'Deploy',
      observedAt: '2026-05-01T00:00:00.000Z',
    });

    const structured = expectOk(await call('memory_project_context', { budget: 400 }));
    expect(structured.project_id).toBe(world.ids.projectId);
    expect(structured.budget).toBe(400);
    expect(structured.used as number).toBeLessThanOrEqual(400);
    expect(structured.token_estimate).toBe(structured.used);
    expect(typeof structured.text).toBe('string');
    expect((structured.sections as unknown[]).length).toBeGreaterThanOrEqual(1);
    // The digest section is seeded by the fixture project's rollup.
    expect((structured.sections as Array<{ kind: string }>).some((section) => section.kind === 'digest')).toBe(true);
  });

  test('unknown project → isError not_found', async () => {
    await expectError(
      await call('memory_project_context', { project_id: '00000000-0000-7000-8000-000000000093' }),
      'not_found',
    );
  });

  test('no project resolvable at all → isError project_required (actionable message)', async () => {
    await world.close();
    world = await openMcpTestWorld({ config: { projectId: null } });
    await expectError(await call('memory_project_context', {}), 'project_required');
  });
});

// ---------------------------------------------------------------------------
// full11: the curated lists
// ---------------------------------------------------------------------------

describe('curated list tools (full11 profile)', () => {
  beforeEach(async () => {
    await world.close();
    world = await openMcpTestWorld({ profile: 'full11' });

    // Seed the decisions + failures payload tables through raw fixtures (SQL stays in storage's
    // own test path — the payload rows are M1/M7 pipeline artifacts, not MCP writes).
    const decisionId = await seedFixtureMemory(world, {
      type: 'decision',
      content: 'Use PostgreSQL for transactional storage.',
      title: 'Primary database',
      observedAt: '2026-01-10T00:00:00.000Z',
    });
    const failureId = await seedFixtureMemory(world, {
      type: 'failure',
      content: 'Cloud Run deploy failed with OOM.',
      title: 'Deploy OOM',
      observedAt: '2026-02-10T00:00:00.000Z',
    });
    await seedFixtureMemory(world, {
      type: 'procedural',
      content: 'Raise memory limits in service.yaml to fix deploy OOM.',
      title: 'Deploy fix',
      observedAt: '2026-02-11T00:00:00.000Z',
    });

    await world.storage.client.query(
      `INSERT INTO decisions (memory_id, title, decision, rationale, decided_at, status)
       VALUES ($1::uuid, 'Primary database', 'Use PostgreSQL for transactional storage.',
               'Mature, pgvector, one dialect', $2::timestamptz, 'accepted')`,
      [decisionId, '2026-01-10T00:00:00.000Z'],
    );
    await world.storage.client.query(
      `INSERT INTO failures (memory_id, problem, context, status, signature_hash, first_seen_at, last_seen_at, occurrence_count)
       VALUES ($1::uuid, 'Cloud Run deploy failed with OOM.', '2 GiB default', 'solved',
               'sig-oom', $2::timestamptz, $2::timestamptz, 3)`,
      [failureId, '2026-02-10T00:00:00.000Z'],
    );
  });

  test('memory_decisions lists accepted decisions with decided_at + rationale', async () => {
    const structured = expectOk(await call('memory_decisions', {}));
    const results = structured.results as Array<{ id: string; decided_at: string; rationale?: string }>;
    expect(results.length).toBe(1);
    expect(results[0]!.decided_at).toBe('2026-01-10T00:00:00.000Z');
    expect(results[0]!.rationale).toContain('pgvector');
    expect(typeof structured.token_estimate).toBe('number');
  });

  test('memory_failures ranks by recurrence and exposes payload status + solution', async () => {
    const structured = expectOk(await call('memory_failures', {}));
    const results = structured.results as Array<{
      failure_status: string;
      occurrence_count: number;
      solution?: string;
    }>;
    expect(results.length).toBe(1);
    expect(results[0]!.failure_status).toBe('solved');
    expect(results[0]!.occurrence_count).toBe(3);
  });

  test('memory_skills lists procedural know-how (promoted procedures)', async () => {
    const structured = expectOk(await call('memory_skills', {}));
    const results = structured.results as Array<{ type: string }>;
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const entry of results) expect(entry.type).toBe('procedural');
  });

  test('all three lists are project views: project_required when unscoped', async () => {
    await world.close();
    world = await openMcpTestWorld({ profile: 'full11', config: { projectId: null } });
    await expectError(await call('memory_decisions', {}), 'project_required');
    await expectError(await call('memory_failures', {}), 'project_required');
    await expectError(await call('memory_skills', {}), 'project_required');
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

describe('cross-cutting guarantees', () => {
  test('the workspace hint (CLAUDE_PROJECT_DIR) lands in write provenance metadata, never in memory content', async () => {
    await world.close();
    world = await openMcpTestWorld({ env: { CLAUDE_PROJECT_DIR: '/Users/dev/fixture-workspace' } });
    const structured = expectOk(
      await call('memory_store', {
        content: 'A workspace-bound fact.',
        type: 'semantic',
        evidence: [{ excerpt: 'e' }],
      }),
    );
    expect(world.context.workspaceHint).toBe('/Users/dev/fixture-workspace');
    const rows = await world.storage.client.query<{ metadata: string }>(
      'SELECT metadata::text AS metadata FROM sources ORDER BY created_at DESC LIMIT 1',
    );
    expect(rows.rows[0]!.metadata).toContain('/Users/dev/fixture-workspace');
    expect((structured.warnings as string[]).length).toBe(0);
  });

  test('every tool maps a thrown unknown error to isError internal — exceptions never escape the callback', async () => {
    const callback = makeToolCallback(
      world.context,
      async () => {
        throw new Error('boom');
      },
      'memory_get',
    );
    const result = await callback({ id: '00000000-0000-7000-8000-000000000001' });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe('internal');
  });

  test('the fixed clock is what handlers see (deterministic defaults)', () => {
    expect(world.context.now().toISOString()).toBe(MCP_TEST_NOW);
    expect(world.context.actor).toBe('agent:onememory-mcp');
  });
});
