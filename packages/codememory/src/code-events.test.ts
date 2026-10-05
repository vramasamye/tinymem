/**
 * The synthetic `document.added` bridge (M4f): a re-read file must flow through the REAL
 * extraction pipeline (`@onememory/extraction`'s heuristic extractor — composed, never edited),
 * offline, with zero model calls. If the pipeline rejects the synthetic envelope or extracts
 * nothing from real source prose, the re-index is a placeholder, not a feature.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHeuristicExtractor } from '@onememory/extraction';
import { installNetworkGuard } from '@onememory/security';
import { validateOnememoryEvent, type ExtractionInput, type SourceRef } from '@onememory/core';

import { buildCodeDocumentEvent, fileEvidence, MAX_DOCUMENT_CHARS, pathFromLocator } from './code-events';

let guard: ReturnType<typeof installNetworkGuard>;

beforeEach(() => {
  guard = installNetworkGuard();
});

afterEach(() => {
  guard.restore();
});

const source: SourceRef = { id: '019a5000-0000-7000-8000-000000000001', kind: 'explicit', uri: 'file:src/architecture.md', title: 'src/architecture.md' };

describe('buildCodeDocumentEvent', () => {
  test('produces a schema-valid document.added envelope carrying the file text', () => {
    const event = buildCodeDocumentEvent({
      project_id: '019a5000-0000-7000-8000-000000000002',
      path: 'src/architecture.md',
      text: 'We decided to use PGlite over SQLite for embedded storage.',
      occurred_at: '2026-10-09T00:00:00.000Z',
    });
    expect(event.kind).toBe('document.added');
    expect(event.payload.content_digest).toBe('We decided to use PGlite over SQLite for embedded storage.');
    const validated = validateOnememoryEvent(event);
    expect(validated.ok).toBe(true);
  });

  test('truncates oversized file text to the payload schema max (an honest bound, not a partial read)', () => {
    const big = 'x'.repeat(MAX_DOCUMENT_CHARS + 500);
    const event = buildCodeDocumentEvent({
      project_id: '019a5000-0000-7000-8000-000000000002',
      path: 'big.ts',
      text: big,
      occurred_at: '2026-10-09T00:00:00.000Z',
    });
    expect((event.payload.content_digest as string).length).toBe(MAX_DOCUMENT_CHARS);
  });
});

describe('the synthetic event through the real heuristic extractor', () => {
  test('extracts a decision candidate from source prose, offline', async () => {
    const extractor = createHeuristicExtractor();
    const event = buildCodeDocumentEvent({
      project_id: '019a5000-0000-7000-8000-000000000002',
      path: 'src/architecture.md',
      text: 'We decided to use PGlite over SQLite for embedded storage because PGlite runs Postgres in-process.',
      occurred_at: '2026-10-09T00:00:00.000Z',
    });
    const result = await extractor.extract([{ source, event } as ExtractionInput]);
    const decision = result.memories.find((memory) => memory.type === 'decision');
    expect(decision).toBeDefined();
    expect(decision?.content).toContain('PGlite');
    expect(decision?.evidence[0]?.source_id).toBe(source.id);
  }, 15_000);
});

describe('fileEvidence', () => {
  test('names the FILE as the durable source of truth with a file: locator', () => {
    const evidence = fileEvidence(source.id, 'src/architecture.md', '  We decided to use PGlite.  ');
    expect(evidence.kind).toBe('line');
    expect(evidence.locator).toBe('file:src/architecture.md');
    expect(evidence.excerpt).toBe('We decided to use PGlite.');
    expect(pathFromLocator(evidence.locator)).toBe('src/architecture.md');
    expect(pathFromLocator('event:123')).toBeNull();
  });

  test('bounds the excerpt so re-index evidence cannot blow token budgets', () => {
    const evidence = fileEvidence(source.id, 'big.ts', 'y'.repeat(500));
    expect(evidence.excerpt.length).toBeLessThanOrEqual(200);
  });
});
