/**
 * The future-value gate (event-memory-schemas.md §3): "the extractor's first decision is the
 * spec's gate: does this have future value? Anything the extractor can't justify (no
 * `future_value_rationale`, low importance) is discarded, not stored."
 *
 * Applied to both extractors — the heuristic baseline and the LLM path — so an LLM's enthusiasm
 * cannot bypass the pollution guard (risk R6). Also de-duplicates within a batch and enforces the
 * per-batch caps.
 */

import type { ExtractedMemory, ExtractionResult, WorkingCandidate } from '@onememory-ai/core';

import { DEFAULT_THRESHOLDS, type ExtractionThresholds } from './types';

export interface GateDecision {
  keep: boolean;
  reason?: string;
}

export interface FutureValueGate {
  /** Decide one candidate. */
  evaluate(candidate: ExtractedMemory): GateDecision;
  /** Filter + de-duplicate + cap a full extraction result. */
  apply(result: ExtractionResult): { result: ExtractionResult; discarded: number };
}

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '')
    .trim();
}

function dedupeKey(candidate: ExtractedMemory): string {
  return `${candidate.type}::${normalizeContent(candidate.content)}`;
}

/** Merge two candidates for the same statement: keep the stronger, union the evidence. */
function mergeCandidates(a: ExtractedMemory, b: ExtractedMemory): ExtractedMemory {
  const stronger = a.importance >= b.importance ? a : b;
  const weaker = stronger === a ? b : a;
  const seen = new Set<string>();
  const evidence = [...stronger.evidence, ...weaker.evidence].filter((span) => {
    const key = `${span.source_id}|${span.kind}|${span.locator}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const confidence = Math.max(a.confidence, b.confidence);
  const entities = [...new Set([...a.entities, ...b.entities])];
  return {
    ...stronger,
    confidence,
    entities,
    evidence,
    valid_from: stronger.valid_from ?? weaker.valid_from,
    valid_until: stronger.valid_until ?? weaker.valid_until,
  };
}

export function createFutureValueGate(
  options: { thresholds?: Partial<ExtractionThresholds> } = {},
): FutureValueGate {
  const thresholds: ExtractionThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };

  function evaluate(candidate: ExtractedMemory): GateDecision {
    if (candidate.evidence.length === 0) {
      return { keep: false, reason: 'no evidence span (provenance is mandatory)' };
    }
    const rationale = candidate.future_value_rationale?.trim() ?? '';
    if (rationale.length === 0) {
      return { keep: false, reason: 'no future_value_rationale' };
    }
    if (candidate.content.trim().length < 8) {
      return { keep: false, reason: 'content too short to be self-contained' };
    }
    if (candidate.importance < thresholds.min_importance) {
      return {
        keep: false,
        reason: `importance ${candidate.importance} below floor ${thresholds.min_importance}`,
      };
    }
    if (candidate.type === 'semantic_candidate' && candidate.confidence < thresholds.min_confidence) {
      return {
        keep: false,
        reason: `semantic candidate confidence ${candidate.confidence} below floor ${thresholds.min_confidence}`,
      };
    }
    return { keep: true };
  }

  return {
    evaluate,

    apply(result: ExtractionResult) {
      const merged = new Map<string, ExtractedMemory>();
      let discarded = 0;
      for (const candidate of result.memories) {
        if (!evaluate(candidate).keep) {
          discarded += 1;
          continue;
        }
        const key = dedupeKey(candidate);
        const existing = merged.get(key);
        merged.set(key, existing ? mergeCandidates(existing, candidate) : candidate);
      }

      const memories = [...merged.values()]
        .sort((a, b) => b.importance - a.importance || a.content.localeCompare(b.content))
        .slice(0, thresholds.max_memories);
      discarded += Math.max(0, merged.size - memories.length);

      const workingSeen = new Set<string>();
      const working: WorkingCandidate[] = [];
      for (const candidate of result.working) {
        const key = `${candidate.kind}::${normalizeContent(candidate.content)}`;
        if (workingSeen.has(key)) continue;
        workingSeen.add(key);
        if (working.length >= thresholds.max_working) {
          discarded += 1;
          continue;
        }
        working.push(candidate);
      }

      return {
        result: { ...result, memories, working },
        discarded,
      };
    },
  };
}
