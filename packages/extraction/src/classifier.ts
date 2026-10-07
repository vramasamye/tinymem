/**
 * Stage 5 CLASSIFY (memory-model.md §8): type/subtype assignment and the working-vs-durable
 * routing decision.
 *
 * Two rules matter for correctness:
 * 1. **`semantic_candidate` is never stored as `semantic`** (ADR-0003 rule 7) — a single
 *    observation becomes an episodic memory tagged as awaiting consolidation. The one exception
 *    memory-model.md §9 allows is an explicit user statement (`onemem remember …`), which the
 *    heuristic extractor marks with subtype `semantic.explicit`.
 * 2. **Session-scoped signals route to working memory**, not durable memory: an unresolved error
 *    is a `current_error` note, an edited file is a `current_file` note. Working memory is
 *    TTL-swept and never appears in default retrieval, so this is where low-future-value context
 *    belongs (memory-model.md §10).
 */

import {
  WORKING_MEMORY_KINDS,
  type ExtractedMemory,
  type ExtractedMemoryType,
  type WorkingCandidate,
  type WorkingMemoryKind,
} from '@onememory-ai/core';

import type { ClassifiedMemory } from './types';

/** Session-scoped signals the heuristic extractor recognizes. */
export type WorkingSignal =
  | 'unresolved_error'
  | 'edited_file'
  | 'stated_task'
  | 'stated_hypothesis'
  | 'open_question'
  | 'temp_decision';

export interface WorkingSignalInput {
  signal: WorkingSignal;
  content: string;
  session_id?: string;
}

export interface Classifier {
  classify(candidate: ExtractedMemory): ClassifiedMemory;
  /** Turn a session-scoped signal into a working candidate; `null` when it cannot be bound. */
  routeWorking(input: WorkingSignalInput): WorkingCandidate | null;
  /** Validate/repair a working candidate emitted by an extractor; `null` when unusable. */
  normalizeWorking(candidate: WorkingCandidate): WorkingCandidate | null;
}

const WORKING_KIND_BY_SIGNAL: Record<WorkingSignal, WorkingMemoryKind> = {
  unresolved_error: 'current_error',
  edited_file: 'current_file',
  stated_task: 'task',
  stated_hypothesis: 'hypothesis',
  open_question: 'open_question',
  temp_decision: 'temp_decision',
};

const WORKING_KIND_SET = new Set<string>(WORKING_MEMORY_KINDS);

/** Explicit-user-statement semantic candidate marker (see module doc). */
export const EXPLICIT_SEMANTIC_SUBTYPE = 'semantic.explicit';

function inferSubtype(candidate: ExtractedMemory): string {
  switch (candidate.type) {
    case 'decision':
      return /\bover\b|\balternativ/i.test(candidate.content)
        ? 'decision.choice'
        : 'decision.statement';
    case 'preference':
      return 'preference.statement';
    case 'procedural':
      return /\brun|execut|install|deploy|migrat|test/i.test(candidate.content)
        ? 'procedural.command'
        : 'procedural.sequence';
    case 'failure':
      return 'failure.observed';
    case 'semantic_candidate':
      return 'semantic.candidate';
    case 'episodic':
    default:
      return 'episodic.observation';
  }
}

export function createHeuristicClassifier(): Classifier {
  return {
    classify(candidate: ExtractedMemory): ClassifiedMemory {
      // Defensive: the schema forbids `semantic` here, but a loosened LLM schema must not leak it.
      const type: ExtractedMemoryType =
        (candidate.type as string) === 'semantic' ? 'semantic_candidate' : candidate.type;
      const subtype = candidate.subtype ?? inferSubtype({ ...candidate, type });

      if (type === 'semantic_candidate') {
        const explicit = subtype === EXPLICIT_SEMANTIC_SUBTYPE;
        return {
          type,
          subtype,
          durable_type: explicit ? 'semantic' : 'episodic',
          awaiting_consolidation: !explicit,
        };
      }
      return { type, subtype, durable_type: type, awaiting_consolidation: false };
    },

    routeWorking(input: WorkingSignalInput): WorkingCandidate | null {
      const sessionId = input.session_id?.trim();
      if (!sessionId) return null;
      const content = input.content.replace(/\s+/g, ' ').trim();
      if (content.length === 0) return null;
      return {
        kind: WORKING_KIND_BY_SIGNAL[input.signal],
        content: content.length > 300 ? content.slice(0, 299) : content,
        session_id: sessionId,
      };
    },

    normalizeWorking(candidate: WorkingCandidate): WorkingCandidate | null {
      const sessionId = candidate.session_id?.trim();
      const content = candidate.content.replace(/\s+/g, ' ').trim();
      if (!sessionId || content.length === 0) return null;
      if (!WORKING_KIND_SET.has(candidate.kind)) return null;
      return {
        kind: candidate.kind,
        content: content.length > 300 ? content.slice(0, 299) : content,
        session_id: sessionId,
      };
    },
  };
}
