/**
 * Per-page controller test (M10 acceptance 3): the provenance drill-down and the
 * sources index render only API values — source, evidence quotes, typed payload,
 * redactions — and group only what the search response actually reported.
 */

import { describe, expect, test } from 'bun:test';

import { createApiClient } from '../../api/client';
import type { InspectResponse } from '../../api/schemas';
import type { MemorySearchResponse } from '../../api/schemas';
import {
  MEMORY_ID_ALPHA,
  MEMORY_ID_BETA,
  MEMORY_ID_PURGED,
  PROJECT_ID,
  defaultStubRoutes,
  fixtureEmptySearchResponse,
  fixtureInspectResponse,
  fixtureSearchResponse,
  stubApi,
} from '../../test/fixtures';
import {
  describePayload,
  loadMemoryDetail,
  loadSources,
} from './controller';

describe('describePayload discriminates the typed payload by shape', () => {
  test('a decision payload is recognized with its alternatives and rationale', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadMemoryDetail(api, PROJECT_ID, MEMORY_ID_ALPHA);
    expect(vm.payloadDisplay).not.toBeNull();
    expect(vm.payloadDisplay?.kind).toBe('decision');
    if (vm.payloadDisplay?.kind !== 'decision') return;
    expect(vm.payloadDisplay.payload.decision).toBe(
      'embedded mode stores memories in PGlite under .onememory/',
    );
    expect(vm.payloadDisplay.payload.alternatives[0]?.option).toBe('Docker Postgres + pgvector');
    expect(vm.payloadDisplay.payload.rationale).toBe(
      'fixture rationale: keeps the default install fully offline',
    );
    expect(vm.payloadDisplay.payload.participants).toEqual(['alice', 'bob']);
  });

  test('a shape the schemas reject renders as no payload (never a guessed one)', () => {
    expect(describePayload({ unknown: 'shape' })).toBeNull();
    expect(describePayload(undefined)).toBeNull();
  });
});

describe('loadMemoryDetail: every drill-down field is the API response', () => {
  test('source, evidence, redactions, entities, edges, audit pass through untouched', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadMemoryDetail(api, PROJECT_ID, MEMORY_ID_ALPHA);
    const fixture = fixtureInspectResponse() as unknown as InspectResponse;

    expect(vm.memory).toEqual(fixture.memory);
    expect(vm.memory.provenance.source.uri).toBe('session://fixture-session/183');
    expect(vm.memory.provenance.source.title).toBe('fixture session 2026-10-01');
    // Evidence quotes verbatim (the excerpt the engine extracted).
    expect(vm.memory.provenance.evidence[0]?.excerpt).toBe(
      'we will store memories in PGlite for the embedded profile',
    );
    expect(vm.memory.provenance.evidence[0]?.locator).toBe('session.jsonl:183');
    expect(vm.memory.provenance.extraction.method).toBe('heuristic');
    expect(vm.memory.provenance.extraction.prompt_version).toBe('extract-v3');
    expect(vm.redactions).toEqual(fixture.redactions);
    expect(vm.edges).toEqual(fixture.edges);
    expect(vm.audit).toEqual(fixture.audit);
  });

  test('a purged memory surfaces the API 404 envelope', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    try {
      await loadMemoryDetail(api, PROJECT_ID, MEMORY_ID_PURGED);
      throw new Error('expected loadMemoryDetail to throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('not_found');
      expect((error as { message: string }).message).toBe('memory not found (fixture purge)');
    }
  });
});

describe('loadSources: groups mirror the provenance the API reported', () => {
  test('rows group by source kind + uri; the title comes from the bounded inspect', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadSources(api, PROJECT_ID, '', 'fixture-project');
    const fixture = fixtureSearchResponse() as unknown as MemorySearchResponse;

    expect(vm.querySent).toBe('fixture-project');
    expect(vm.groups.length).toBe(2);
    const first = vm.groups[0];
    expect(first?.kind).toBe('conversation');
    expect(first?.uri).toBe('session://fixture-session/183');
    expect(first?.title).toBe('fixture session 2026-10-01'); // from inspect, not invented
    expect(first?.memories).toEqual(fixture.memories.slice(0, 1));
    const second = vm.groups[1];
    expect(second?.kind).toBe('terminal');
    expect(second?.uri).toBeNull(); // the API reported no source_uri for that row
    expect(second?.title).toBeNull(); // its inspect has no stub route → honestly null
    expect(vm.inspectFailures).toEqual([MEMORY_ID_BETA]);
    expect(vm.tokens).toEqual(fixture.tokens);
  });

  test('an empty search response yields zero groups, no fallback group', async () => {
    const api = createApiClient({
      fetchImpl: stubApi({
        [`POST /v1/projects/${PROJECT_ID}/search`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadSources(api, PROJECT_ID, 'q', 'fallback');
    expect(vm.querySent).toBe('q');
    expect(vm.groups).toEqual([]);
    expect(vm.inspectFailures).toEqual([]);
  });
});
