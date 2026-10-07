/**
 * The extract-stage degradation policy (memory-model.md §8 stage 4: "LLM failure → heuristic
 * extractor; both fail → event kept, extraction retried").
 *
 * `createFallbackExtractor(primary, fallback)` tries the primary extractor and falls back on
 * *any* failure — an unavailable route, a provider that never produced valid output, or a
 * transport error. The result records which method actually ran in `extraction_meta.method`, so
 * degraded runs are visible in provenance rather than hidden.
 */

import type { ExtractionInput, ExtractionResult, Extractor } from '@onememory-ai/core';

export interface FallbackExtractorOptions {
  /** Observability hook: called with the primary's error before degrading. */
  onFallback?: (error: unknown) => void;
  /** When false, the primary's failure propagates (used to assert the failure path in tests). */
  degrade?: boolean;
}

export function createFallbackExtractor(
  primary: Extractor,
  fallback: Extractor,
  options: FallbackExtractorOptions = {},
): Extractor {
  const degrade = options.degrade ?? true;
  return {
    async extract(inputs: ExtractionInput[]): Promise<ExtractionResult> {
      try {
        return await primary.extract(inputs);
      } catch (error) {
        options.onFallback?.(error);
        if (!degrade) throw error;
        return fallback.extract(inputs);
      }
    },
  };
}
