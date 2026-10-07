/**
 * Shared fixtures for the M4f re-index tests (not exported from the package index — test-only).
 * `reindex.test.ts` and `orchestration.fixture.test.ts` exercise the same shapes, so one
 * candidate builder, one scripted extractor, one classifier, and one empty symbol table live
 * here instead of drifting apart in two files.
 */

import type {
  ExtractedMemory,
  ExtractionInput,
  ExtractionResult,
  Extractor,
} from '@onememory-ai/core';

import type { ReindexClassification } from './reindex';
import type { SkippedSymbolFile, SymbolTable } from './schema';

/** A candidate whose evidence rides the synthetic event (what the re-index hands extractors). */
export function candidate(
  input: ExtractionInput,
  content: string,
  options: {
    type?: ExtractedMemory['type'];
    importance?: number;
    confidence?: number;
    rationale?: string;
  } = {},
): ExtractedMemory {
  return {
    type: options.type ?? 'semantic_candidate',
    content,
    importance: options.importance ?? 0.8,
    confidence: options.confidence ?? 0.9,
    entities: [],
    evidence: [{ source_id: input.source.id, kind: 'event', locator: `event:${input.event.id}`, excerpt: content }],
    ...(options.rationale === undefined ? {} : { future_value_rationale: options.rationale }),
  };
}

/** An extractor that derives candidates from the synthetic document inputs. */
export function scriptedExtractor(
  script: (input: ExtractionInput) => ExtractedMemory[],
): Extractor {
  return {
    async extract(inputs: ExtractionInput[]): Promise<ExtractionResult> {
      return {
        memories: inputs.flatMap((input) => script(input)),
        working: [],
        extraction_meta: { method: 'heuristic', prompt_version: 'test-v1' },
      };
    },
  };
}

/** Classify every candidate as one durable type (the composition's classifier stand-in). */
export function classifyAs(durableType: ReindexClassification['durable_type']): () => ReindexClassification {
  return () => ({ durable_type: durableType, awaiting_consolidation: false });
}

/** A symbol table whose files parse cleanly but declare nothing (the symbol pass's no-op shape). */
export function emptySymbolTable(
  root: string,
  paths: readonly string[],
  extractedAt = '2026-10-09T00:00:00.000Z',
): SymbolTable {
  return {
    version: 1,
    root_path: root,
    extracted_at: extractedAt,
    files: paths.map((path) => ({
      path,
      language: 'typescript',
      symbols: [],
      symbols_hash: 'd'.repeat(64),
      parse_errors: 0,
    })),
    skipped: [] as SkippedSymbolFile[],
    warnings: [],
  };
}
