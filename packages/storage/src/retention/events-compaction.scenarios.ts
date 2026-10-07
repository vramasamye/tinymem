/**
 * Retention / events-compaction repository scenarios — the M14.6 SQL layer, runnable against
 * BOTH deployment profiles (embedded PGlite always; Postgres server when `ONEMEMORY_PG_URL` is
 * provided — the ADR-0002 CI matrix). Every scenario seeds its own project with per-run unique
 * fixtures, so the server-target suite is re-runnable against a shared database.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { uuidv7, type NewEventDigest } from '@onememory-ai/core';

import { isUniqueViolation } from '../drivers/client';
import type { OnememoryStorage } from '../drivers/types';
import { makeEvent, seedProjectAndSource, uniqueId, type StorageHandle } from '../integration/harness';
import { ValidationError } from '../repositories/util';

import {
  applyCompaction,
  countRawEvents,
  digestedEventIds,
  getEventDigest,
  listCompactableEvents,
  sourcesForEvents,
} from './events-compaction';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const DAY_MS = 86_400_000;
const at = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

/** A digest fixture for one seeded event (the row's own columns, a bounded summary). */
function digestOf(
  event: { id: string; kind: string; content_hash: string; occurred_at: string; ingested_at: string; project_id?: string },
  overrides: Partial<NewEventDigest> = {},
): NewEventDigest {
  return {
    event_id: event.id,
    kind: event.kind,
    runtime: 'claude-code',
    adapter_version: '1.0.0',
    ...(event.project_id === undefined ? {} : { project_id: event.project_id }),
    content_hash: event.content_hash,
    occurred_at: event.occurred_at,
    ingested_at: event.ingested_at,
    summary: 'fixture digest summary',
    payload_bytes: 128,
    redactions_count: 0,
    source_ids: [],
    ...overrides,
  };
}

/** Seed one event into a project, returning the stored row shape the digest builder needs. */
async function seedEvent(
  storage: OnememoryStorage,
  projectId: string,
  daysAgo: number,
  index: number,
): Promise<{ id: string; kind: string; content_hash: string; occurred_at: string; ingested_at: string; project_id: string }> {
  // `as const` keeps `kind`/`role` as literals: the event payload is a discriminated union, so
  // an inferred `string` here is not assignable to the `conversation.message` member.
  const payload = {
    kind: 'conversation.message',
    role: 'user',
    content: `retention fixture ${uniqueId()}`,
  } as const;
  const event = makeEvent({
    kind: 'conversation.message',
    payload,
    scope: { project_id: projectId },
    occurred_at: at(daysAgo),
    ingested_at: at(daysAgo),
  });
  const stored = await storage.store.ingestEvent(event);
  expect(stored.status).toBe('stored');
  return {
    id: stored.event_id,
    kind: event.kind,
    content_hash: event.content_hash,
    occurred_at: event.occurred_at,
    ingested_at: event.ingested_at,
    project_id: projectId,
  };
}

export function runRetentionCompactionSuite(name: string, open: () => Promise<StorageHandle>): void {
  describe(name, () => {
    let handle: StorageHandle | null = null;
    let storage: OnememoryStorage | null = null;

    beforeAll(async () => {
      handle = await open();
      storage = handle.storage;
    });

    afterAll(async () => {
      await handle?.close();
    });

    test('the scan: olderThan filter, oldest-first order, limit, keyset cursor, scope', async () => {
      const ctx = await seedProjectAndSource(storage!, 'retention-scan');
      const other = await seedProjectAndSource(storage!, 'retention-scan-other');
      const oldest = await seedEvent(storage!, ctx.projectId, 100, 0);
      const middle = await seedEvent(storage!, ctx.projectId, 90, 1);
      const youngish = await seedEvent(storage!, ctx.projectId, 40, 2);
      await seedEvent(storage!, ctx.projectId, 1, 3); // younger than the cutoff — never listed
      await seedEvent(storage!, other.projectId, 100, 4); // another scope — never listed

      const listed = await listCompactableEvents(storage!.client, {
        olderThan: at(30),
        limit: 10,
        scope: { project_id: ctx.projectId },
      });
      expect(listed.map((event) => event.id)).toEqual([oldest.id, middle.id, youngish.id]);

      // The limit bounds the scan; the keyset cursor resumes past exactly what was visited.
      const first = await listCompactableEvents(storage!.client, {
        olderThan: at(30),
        limit: 2,
        scope: { project_id: ctx.projectId },
      });
      expect(first.map((event) => event.id)).toEqual([oldest.id, middle.id]);
      const rest = await listCompactableEvents(storage!.client, {
        olderThan: at(30),
        limit: 10,
        scope: { project_id: ctx.projectId },
        after: { occurred_at: first[1]!.occurred_at, id: first[1]!.id },
      });
      expect(rest.map((event) => event.id)).toEqual([youngish.id]);
    });

    test('applyCompaction: digests + purge share one transaction, and a purge without its digest is refused', async () => {
      const ctx = await seedProjectAndSource(storage!, 'retention-apply');
      const a = await seedEvent(storage!, ctx.projectId, 100, 0);
      const b = await seedEvent(storage!, ctx.projectId, 100, 1);
      const untouched = await seedEvent(storage!, ctx.projectId, 100, 2);
      const summarizeOnly = await seedEvent(storage!, ctx.projectId, 100, 3);

      // The EXISTS guard: purging a raw row with no digest row deletes nothing, keeps the row.
      const refused = await applyCompaction(storage!.client, {
        digests: [],
        purgeEventIds: [a.id],
      });
      expect(refused).toEqual({ summarized: 0, purged: 0 });
      expect(await countRawEvents(storage!.client, { project_id: ctx.projectId })).toBe(4);

      // Summarize + purge together: one call, one transaction.
      const applied = await applyCompaction(storage!.client, {
        digests: [digestOf(a), digestOf(b)],
        purgeEventIds: [a.id, b.id],
      });
      expect(applied).toEqual({ summarized: 2, purged: 2 });
      expect(await countRawEvents(storage!.client, { project_id: ctx.projectId })).toBe(2);

      // Summarize alone keeps the raw row; a later purge-only batch removes it (digest exists).
      const summarized = await applyCompaction(storage!.client, {
        digests: [digestOf(summarizeOnly)],
        purgeEventIds: [],
      });
      expect(summarized).toEqual({ summarized: 1, purged: 0 });
      expect(await countRawEvents(storage!.client, { project_id: ctx.projectId })).toBe(2);
      const purged = await applyCompaction(storage!.client, {
        digests: [],
        purgeEventIds: [summarizeOnly.id],
      });
      expect(purged).toEqual({ summarized: 0, purged: 1 });

      // Re-applying the same batch is a no-op on both halves (idempotency).
      const again = await applyCompaction(storage!.client, {
        digests: [digestOf(a), digestOf(b)],
        purgeEventIds: [a.id, b.id],
      });
      expect(again).toEqual({ summarized: 0, purged: 0 });
      expect(await countRawEvents(storage!.client, { project_id: ctx.projectId })).toBe(1);
      expect((await digestedEventIds(storage!.client, [a.id, b.id, untouched.id])).size).toBe(2);
    });

    test('sourcesForEvents: the evidence-span linkage from memories and edges, deduped', async () => {
      const ctx = await seedProjectAndSource(storage!, 'retention-sources');
      const anchor = await seedEvent(storage!, ctx.projectId, 100, 0);
      const edgeAnchor = await seedEvent(storage!, ctx.projectId, 100, 1);
      const irrelevant = await seedEvent(storage!, ctx.projectId, 100, 2);

      const first = await storage!.store.insertMemory({
        type: 'semantic',
        content: `retention memory one ${uniqueId().slice(0, 8)}`,
        importance: 0.6,
        confidence: 0.7,
        observed_at: anchor.occurred_at,
        source_id: ctx.sourceId,
        evidence: [
          { source_id: ctx.sourceId, kind: 'event', locator: `event:${anchor.id}`, excerpt: 'memory one' },
        ],
        extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
        project_id: ctx.projectId,
      });
      expect(first.outcome).toBe('inserted');
      const second = await storage!.store.insertMemory({
        type: 'semantic',
        content: `retention memory two ${uniqueId().slice(0, 8)}`,
        importance: 0.6,
        confidence: 0.7,
        observed_at: anchor.occurred_at,
        source_id: ctx.sourceId,
        evidence: [
          // The SAME event anchored twice on the same source, plus a commit: locator that is
          // not an event pointer — the linkage reads event: locators only, deduped.
          { source_id: ctx.sourceId, kind: 'event', locator: `event:${anchor.id}`, excerpt: 'memory two' },
          { source_id: ctx.sourceId, kind: 'commit', locator: 'commit:abc123', excerpt: 'not an event' },
        ],
        extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
        project_id: ctx.projectId,
      });
      expect(second.outcome).toBe('inserted');
      await storage!.store.addEdge({
        from_memory_id: first.memory.id,
        to_memory_id: second.memory.id,
        relation: 'related_to',
        project_id: ctx.projectId,
        evidence: [
          { source_id: ctx.sourceId, kind: 'event', locator: `event:${edgeAnchor.id}`, excerpt: 'edge evidence' },
        ],
      });

      const links = await sourcesForEvents(storage!.client, [anchor.id, edgeAnchor.id, irrelevant.id]);
      expect(links.get(anchor.id)).toEqual([ctx.sourceId]); // deduped across two memories
      expect(links.get(edgeAnchor.id)).toEqual([ctx.sourceId]); // read from edges.evidence too
      expect(links.has(irrelevant.id)).toBeFalse();
      expect(await sourcesForEvents(storage!.client, [])).toEqual(new Map());
    });

    test('getEventDigest: full readback mapping, and the event_id unique constraint holds', async () => {
      const ctx = await seedProjectAndSource(storage!, 'retention-readback');
      const event = await seedEvent(storage!, ctx.projectId, 100, 0);
      const sourceId = uniqueId();
      await applyCompaction(storage!.client, {
        digests: [digestOf(event, { summary: '[user] retention readback', payload_bytes: 256, redactions_count: 1, source_ids: [sourceId] })],
        purgeEventIds: [event.id],
      });

      const digest = await getEventDigest(storage!.client, event.id);
      expect(digest).not.toBeNull();
      expect(digest!.event_id).toBe(event.id);
      expect(digest!.kind).toBe('conversation.message');
      expect(digest!.runtime).toBe('claude-code');
      expect(digest!.adapter_version).toBe('1.0.0');
      expect(digest!.project_id).toBe(ctx.projectId);
      expect(digest!.session_id).toBeNull();
      expect(digest!.agent_id).toBeNull();
      expect(digest!.user_id).toBeNull();
      expect(digest!.content_hash).toBe(event.content_hash);
      expect(digest!.occurred_at).toBe(event.occurred_at);
      expect(digest!.ingested_at).toBe(event.ingested_at);
      expect(digest!.summary).toBe('[user] retention readback');
      expect(digest!.payload_bytes).toBe(256);
      expect(digest!.redactions_count).toBe(1);
      expect(digest!.source_ids).toEqual([sourceId]);
      expect(digest!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(await getEventDigest(storage!.client, uniqueId())).toBeNull();

      // The migration's UNIQUE(event_id) — summarize-once at the SQL level.
      let duplicate: unknown;
      try {
        await storage!.client.query(
          `INSERT INTO memory_events_digest (id, event_id, kind, runtime, adapter_version, content_hash,
             occurred_at, ingested_at, summary, payload_bytes)
           VALUES ($1::uuid, $2::uuid, 'conversation.message', 'claude-code', '1.0.0', $3,
             $4::timestamptz, $5::timestamptz, 'duplicate', 1)`,
          [uuidv7(), event.id, event.content_hash, event.occurred_at, event.ingested_at],
        );
        duplicate = 'inserted';
      } catch (error) {
        expect(isUniqueViolation(error)).toBeTrue();
        duplicate = 'rejected';
      }
      expect(duplicate).toBe('rejected');
    });

    test('the digest input is Zod-validated at the storage boundary', async () => {
      const ctx = await seedProjectAndSource(storage!, 'retention-boundary');
      const event = await seedEvent(storage!, ctx.projectId, 100, 0);
      const invalid = digestOf(event, { kind: '' });
      expect(invalid.kind).toBe('');
      let caught: unknown;
      try {
        await applyCompaction(storage!.client, { digests: [invalid], purgeEventIds: [] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ValidationError);
    });
  });
}
