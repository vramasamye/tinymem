/**
 * M11b-quality: memory-pollution audit (phased-plan Phase 5 row M11b; ADR-0004 consequence
 * "pollution"; `docs/architecture/memory-model.md` §2/§7/§9).
 *
 * Three pollution states, each detected from what the run actually produced (never declared by
 * the fixture — the fixture creates the conditions, the audit measures the outcome):
 *
 * 1. **Stale** — `status = 'archived'` while the memory was still cited in the last 30 days
 *    (`last_accessed_at` inside the window, bumped by the engine's REINFORCE stage). Decay
 *    archives on prominence alone; a point-in-time probe that still serves the memory afterwards
 *    is exactly the archive-vs-citation tension this metric exists to surface.
 *
 * 2. **Duplicate** — two memories that both surfaced in retrieval with cosine ≥ 0.97 over
 *    deterministic local vectors, same type and same project (mirroring the M14 near-duplicate
 *    merge gate's scope rule). Offline there is no embedder, so the vectors are lowercased
 *    character-trigram term counts — a lexical proxy for the embedder cosine, computed with the
 *    repository's own `cosineSimilarity` (`@onememory/storage`). Same-content memories cannot
 *    exist (ingest dedupes on content hash), so a pair here means near-identical wording the
 *    merge pass left behind (its vector-gated offline skip, or a true miss with an embedder).
 *
 * 3. **Contradicted but not marked** — a golden-declared contradiction side whose post-run
 *    status is neither `superseded` (resolved, the winner's mark) nor `disputed` (full-tie mark):
 *    the contradiction surfaced unresolved. Ground truth comes from the declared groups —
 *    "these two memories contradict" is semantic knowledge the engine itself may not have.
 *
 * Pure math over harness views; counts only, with content-derived labels (committed results
 * never carry per-run uuids).
 */

import { cosineSimilarity } from '@onememory/storage';

/** The duplicate-detection cosine gate — the M14 near-duplicate merge default (`run.ts`). */
export const POLLUTION_DUPLICATE_COSINE = 0.97;

/** The stale-citation window (days) — the task's "cited in last 30 days". */
export const STALE_CITATION_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** One memory's post-run state — what the audit needs (from the settled corpus). */
export interface PollutionMemoryView {
  id: string;
  type: string;
  content: string;
  project_id: string | null;
  status: string;
  access_count: number;
  last_accessed_at: string | null;
}

/** A golden-declared contradiction group, fact keys already resolved to memory ids. */
export interface DeclaredContradictionView {
  authority_id: string | null;
  contradicted_ids: readonly string[];
  outcome: 'resolved' | 'disputed';
}

export interface PollutionAuditInput {
  /** The dataset's deterministic clock. */
  now: string;
  memories: readonly PollutionMemoryView[];
  /** Memory ids that surfaced in any probe's response (the retrieval union). */
  surfacedIds: Iterable<string>;
  contradictionGroups: readonly DeclaredContradictionView[];
  citationWindowDays?: number;
  cosineThreshold?: number;
}

export interface StaleCitedFinding {
  label: string;
  status: string;
  last_accessed_at: string;
  access_count: number;
}

export interface DuplicatePairFinding {
  a: string;
  b: string;
  type: string;
  cosine: number;
}

export interface UnresolvedContradictionFinding {
  label: string;
  status: string;
  expected_mark: 'superseded' | 'disputed';
}

export interface PollutionAuditRecord {
  stale_cited: {
    window_days: number;
    count: number;
    memories: StaleCitedFinding[];
  };
  duplicates: {
    cosine_threshold: number;
    count: number;
    pairs: DuplicatePairFinding[];
  };
  unresolved_contradictions: {
    count: number;
    memories: UnresolvedContradictionFinding[];
  };
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Committed results carry no uuids — findings identify memories by content prefix. */
function labelOf(content: string): string {
  return content.length > 64 ? `${content.slice(0, 64)}…` : content;
}

/**
 * Deterministic local vector for the duplicate scan: lowercased character-trigram term counts
 * over alphanumeric runs. No model, no network — the offline proxy for the embedder cosine.
 */
export function contentVector(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const padded = `  ${normalized}  `;
  const counts = new Map<string, number>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    const gram = padded.slice(index, index + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Cosine between two sparse term-count vectors, via the repository's own implementation. */
export function contentCosine(a: Map<string, number>, b: Map<string, number>): number {
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const dense = (vector: Map<string, number>): number[] => keys.map((key) => vector.get(key) ?? 0);
  return cosineSimilarity(dense(a), dense(b));
}

/**
 * The audit over one dataset's post-run state. Findings are deterministic and ordered (content
 * order), so committed results diff cleanly.
 */
export function computePollutionAudit(input: PollutionAuditInput): PollutionAuditRecord {
  const windowDays = input.citationWindowDays ?? STALE_CITATION_WINDOW_DAYS;
  const cosineThreshold = input.cosineThreshold ?? POLLUTION_DUPLICATE_COSINE;
  const byId = new Map(input.memories.map((memory) => [memory.id, memory]));

  // --- stale: archived but cited inside the window -------------------------------------
  const nowMs = Date.parse(input.now);
  const stale: StaleCitedFinding[] = [];
  for (const memory of input.memories) {
    if (memory.status !== 'archived' || memory.last_accessed_at === null) continue;
    const citedMs = Date.parse(memory.last_accessed_at);
    if (Number.isNaN(citedMs)) {
      throw new Error(`pollution: memory '${memory.id}' has an unparsable last_accessed_at`);
    }
    const ageDays = (nowMs - citedMs) / DAY_MS;
    if (ageDays >= 0 && ageDays <= windowDays) {
      stale.push({
        label: labelOf(memory.content),
        status: memory.status,
        last_accessed_at: memory.last_accessed_at,
        access_count: memory.access_count,
      });
    }
  }
  stale.sort((a, b) => a.label.localeCompare(b.label));

  // --- duplicates: surfaced, same type + scope, cosine ≥ threshold ------------------------
  const surfaced = [...input.surfacedIds]
    .map((id) => byId.get(id))
    .filter((memory): memory is PollutionMemoryView => memory !== undefined);
  const vectors = new Map(surfaced.map((memory) => [memory.id, contentVector(memory.content)]));
  const pairs: DuplicatePairFinding[] = [];
  for (let i = 0; i < surfaced.length; i += 1) {
    for (let j = i + 1; j < surfaced.length; j += 1) {
      const a = surfaced[i]!;
      const b = surfaced[j]!;
      if (a.type !== b.type || a.project_id !== b.project_id) continue;
      const cosine = contentCosine(vectors.get(a.id)!, vectors.get(b.id)!);
      if (cosine >= cosineThreshold) {
        const [first, second] =
          a.content.localeCompare(b.content) <= 0 ? [a, b] : [b, a];
        pairs.push({
          a: labelOf(first.content),
          b: labelOf(second.content),
          type: a.type,
          cosine: round(cosine),
        });
      }
    }
  }
  pairs.sort((x, y) => x.a.localeCompare(y.a));

  // --- contradicted but unmarked: declared sides that resolved neither way -----------------
  const unresolved = new Map<string, UnresolvedContradictionFinding>();
  for (const group of input.contradictionGroups) {
    // A resolved group's sides must be superseded; a disputed group's sides must be disputed.
    const expectedMark = group.outcome === 'disputed' ? 'disputed' : 'superseded';
    for (const id of group.contradicted_ids) {
      const memory = byId.get(id);
      if (memory === undefined) {
        throw new Error(`pollution: contradiction side '${id}' is not in the corpus view`);
      }
      if (memory.status === 'superseded' || memory.status === 'disputed') continue;
      unresolved.set(id, {
        label: labelOf(memory.content),
        status: memory.status,
        expected_mark: expectedMark,
      });
    }
  }
  const unresolvedList = [...unresolved.values()].sort((a, b) => a.label.localeCompare(b.label));

  return {
    stale_cited: { window_days: windowDays, count: stale.length, memories: stale },
    duplicates: { cosine_threshold: cosineThreshold, count: pairs.length, pairs },
    unresolved_contradictions: { count: unresolvedList.length, memories: unresolvedList },
  };
}
