/**
 * M7b's verified scope cut: response_item output loses MCP isError in Codex's serializer.
 * Exercise the real adapter and M3c extractor together without fabricating a failure envelope.
 */
import { expect, test } from 'bun:test';

import { translateRolloutSession } from '@onememory/adapter-codex';
import { FIXTURE_PROJECT_ID, mcpToolResultsRollout } from '@onememory/adapter-codex/testing';
import { createHeuristicExtractor, failureIncidentOf, normalizeEvent } from '@onememory/extraction';
import type { ExtractionInput, SourceRef } from '@onememory/core';

test('named Codex opaque results reach M3c without invented failure incidents', async () => {
  const translated = translateRolloutSession(mcpToolResultsRollout(), {
    projectId: FIXTURE_PROJECT_ID,
    sessionId: 'sanitized-m7b',
    now: new Date('2026-10-03T10:00:00.000Z'),
  });
  const source: SourceRef = {
    id: '019a7c0e-5b1f-7000-8000-00000000e003',
    kind: 'conversation',
    uri: 'session/sanitized-m7b',
  };
  const inputs: ExtractionInput[] = translated.events.map((event) => ({ event, source }));
  const results = inputs.filter((input) => input.event.kind === 'conversation.tool_result');
  expect(results).toHaveLength(3);
  expect(results.map((input) => normalizeEvent(input).tool_result?.tool)).toEqual([
    'mcp__search__query',
    'mcp__files__read_file',
    'mcp__linter__lint',
  ]);
  for (const input of results) {
    expect(failureIncidentOf(normalizeEvent(input))).toBeUndefined();
  }
  const extracted = await createHeuristicExtractor().extract(inputs);
  expect(extracted.memories.filter((memory) => memory.type === 'failure')).toEqual([]);
  expect(extracted.memories.some((memory) => memory.failure_signature !== undefined)).toBe(false);
});
