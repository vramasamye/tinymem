/**
 * The project digest rollup — the PURE assembly (backlog M14.5; retrieval.md §2 "projects.digest:
 * the consolidation-built rollup"). The project's top accepted decisions, known failures, and
 * current procedures become ONE token-bounded `project_context` digest candidate:
 *
 * - the one-liner semantics are the session-context contract's (retrieval.md §2): decisions as
 *   `summary — rationale`, failures as `problem → solution`, procedures by `title ?? summary ??
 *   content`; the READS that feed this live in `run.ts` and are the same search-repo shortcuts
 *   the `memory_project_context` tool surface uses — the digest and the session context agree on
 *   what "top" means;
 * - budget discipline is the retrieval layer's: whole lines are packed or dropped (never a
 *   mid-sentence cut), `used ≤ budget` holds BY CONSTRUCTION (each line's cost reserves its
 *   joining newline, so the sum of line costs is an upper bound of the assembled text's cost),
 *   and `truncated` reports the drops;
 * - section allowances split the budget 5:3:2 (decisions:failures:procedures) — the same
 *   proportions as retrieval.md §2's 250/150/100 digest-section quotas, rescaled so the digest's
 *   own budget is fully usable — with unused allowance rolling forward to later sections, the
 *   same roll-forward discipline as `buildSessionContext`.
 *
 * The candidate carries TWO projections of one assembly: the durable memory `text` (header +
 * bulleted sections) and the renderable `entries` (one `decision_01`-style key per packed
 * one-liner) that the storage digest repo merges into `projects.digest` — the column the existing
 * `memory_project_context` tool already renders.
 *
 * Reuse (the candidate shaping factors through the derivation helpers, never a second
 * implementation): `mergeSourceOf` builds the source views, `unionEvidence` caps the evidence
 * union, `derivedTemporals` sets observed-at-newest / valid-since-oldest, and `derivedScores`
 * corroboration-scores the digest over its cited sources.
 */

import {
  estimateTokens,
  memoryContentHash,
  DEFAULT_PROJECT_DIGEST_BUDGET_TOKENS,
  PROJECT_DIGEST_KIND,
  PROJECT_DIGEST_SUBTYPE,
  PROJECT_DIGEST_TAG,
  projectDigestEntriesOf,
  type MemoryRecord,
  type NewMemory,
  type ProjectDigestCandidate,
  type ProjectDigestSections,
} from '@onememory-ai/core';

import { derivedScores, derivedTemporals, mergeSourceOf, unionEvidence, type MergeSourceView } from '../derive';

/** The provenance version recorded on a digest memory's extraction meta. */
export const PROJECT_DIGEST_PROMPT_VERSION = 'consolidation/project-digest-1';

/** One packed line reserves its joining newline, so Σ line costs ≥ the assembled text's cost. */
function costOf(line: string): number {
  return estimateTokens(`${line}\n`);
}

/**
 * Word-boundary clamp — the retrieval layer's `truncateAtWordBoundary` twin (not exported from
 * `@onememory-ai/core`; mirrored here so the digest never cuts mid-word).
 */
export function clampAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > maxChars * 0.5 ? lastSpace : maxChars;
  return `${cut.slice(0, boundary).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Source views (structural, so the search-repo candidates pass straight through)
// ---------------------------------------------------------------------------

/** The decision projection: an accepted decision with its rationale (a `decisions` row join). */
export interface DigestDecisionInput {
  memory: MemoryRecord;
  decided_at: string;
  rationale: string | null;
}

/** The failure projection: recurrence-ranked problem → solution (a `failures` row join). */
export interface DigestFailureInput {
  memory: MemoryRecord;
  problem: string;
  solution: string | null;
  failure_status: string;
  occurrence_count: number;
}

/**
 * The procedure projection: a current procedural memory (importance-ordered upstream by
 * `listCurrentMemories`, which returns bare records — no payload join, no wrapper).
 */
export type DigestProcedureInput = MemoryRecord;

/** One line's source association — packing keeps line and citation together. */
interface PackableLine {
  line: string;
  sourceId: string;
  view: MergeSourceView;
}

/** A decision one-liner: `summary — rationale` (the session-context's decisions shape). */
export function decisionLineOf(decision: DigestDecisionInput): string {
  const memory = decision.memory;
  const statement = memory.content_summary ?? memory.title ?? memory.content;
  const rationale = decision.rationale !== null ? ` — ${decision.rationale}` : '';
  return `${statement}${rationale}`;
}

/** A failure one-liner: `problem → solution`, or `problem (status)` when unsolved. */
export function failureLineOf(failure: DigestFailureInput): string {
  const resolution = failure.solution !== null ? ` → ${failure.solution}` : ` (${failure.failure_status})`;
  return `${clampAtWordBoundary(failure.problem, 120)}${clampAtWordBoundary(resolution, 120)}`;
}

/** A procedure one-liner: `title ?? summary ?? clamped content` (the session-context's shape). */
export function procedureLineOf(procedure: DigestProcedureInput): string {
  return procedure.title ?? procedure.content_summary ?? clampAtWordBoundary(procedure.content, 120);
}

// ---------------------------------------------------------------------------
// The rollup header
// ---------------------------------------------------------------------------

const IDENTITY_PREFIX = 'project: ';

/**
 * The identity line, always kept, clamped to fit ANY budget (the one line a hard cut is allowed
 * on: an over-budget digest is worse than a clipped project name). Word-boundary first; a hard
 * slice when the word clamp's ellipsis overflows; a degenerate budget (below the `project: `
 * prefix) degrades to the name alone.
 */
function identityLine(projectName: string, budget: number): string {
  const full = `${IDENTITY_PREFIX}${projectName}`;
  if (costOf(full) <= budget) return full;
  // `- 1` reserves the joining newline inside the cost.
  const available = budget * 4 - IDENTITY_PREFIX.length - 1;
  if (available < 4) return projectName.slice(0, Math.max(0, budget * 4 - 1)).trimEnd();
  const clamped = `${IDENTITY_PREFIX}${clampAtWordBoundary(projectName, available)}`;
  if (costOf(clamped) <= budget) return clamped;
  return `${IDENTITY_PREFIX}${projectName.slice(0, available - 1).trimEnd()}`;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export interface ProjectDigestBuildInput {
  project_id: string;
  project_name: string | null;
  description?: string | null;
  /** Top accepted decisions, newest decided first (the read caps "top"; the packer bounds it). */
  decisions: readonly DigestDecisionInput[];
  /** Known failures, most recurring first. */
  failures: readonly DigestFailureInput[];
  /** Current procedures, importance-ordered. */
  procedures: readonly DigestProcedureInput[];
  budget?: number;
  /** The clock's ISO stamp — the temporal fallback when nothing was packed. */
  now_iso: string;
}

/** The section headers, in rollup priority order (concrete literals — exact under strict checks). */
const SECTION_TITLES = {
  decisions: 'top decisions:',
  failures: 'known failures:',
  procedures: 'procedures:',
} as const;

/** The 5:3:2 allowance split (decisions : failures : procedures). */
const SECTION_SHARES = { decisions: 0.5, failures: 0.3, procedures: 0.2 } as const;

/**
 * Build the digest candidate. Pure: same inputs ⇒ byte-identical `text` ⇒ same content hash ⇒
 * idempotent persistence (the unchanged probe keys on it). `used ≤ budget` by construction; a
 * section with no fitting line emits no header line (never a dangling header).
 */
export function buildProjectDigest(input: ProjectDigestBuildInput): ProjectDigestCandidate {
  const budget = Math.max(1, Math.floor(input.budget ?? DEFAULT_PROJECT_DIGEST_BUDGET_TOKENS));
  const name = input.project_name !== null && input.project_name !== '' ? input.project_name : 'unnamed project';

  const sections: ProjectDigestSections = { decisions: [], failures: [], procedures: [] };
  // One explicit spec per section (no dynamic key indexing): each carries its own packed-lines
  // target, title, and allowance share — the loop stays type-tight under strict index checks.
  const sectionsInput = [
    {
      title: SECTION_TITLES.decisions,
      share: SECTION_SHARES.decisions,
      into: sections.decisions,
      lines: input.decisions.map((decision) => ({
        line: decisionLineOf(decision),
        sourceId: decision.memory.id,
        view: mergeSourceOf(decision.memory),
      })),
    },
    {
      title: SECTION_TITLES.failures,
      share: SECTION_SHARES.failures,
      into: sections.failures,
      lines: input.failures.map((failure) => ({
        line: failureLineOf(failure),
        sourceId: failure.memory.id,
        view: mergeSourceOf(failure.memory),
      })),
    },
    {
      title: SECTION_TITLES.procedures,
      share: SECTION_SHARES.procedures,
      into: sections.procedures,
      lines: input.procedures.map((procedure) => ({
        line: procedureLineOf(procedure),
        sourceId: procedure.id,
        view: mergeSourceOf(procedure),
      })),
    },
  ] as const;

  const packedLines: string[] = [identityLine(name, budget)];
  let truncated = false;

  const description =
    input.description !== null && input.description !== undefined && input.description !== ''
      ? `description: ${clampAtWordBoundary(input.description, 200)}`
      : null;
  // The identity line's own cost is the consumed floor; the description packs only into what
  // remains, and the section allowances are bounded by the remainder after both.
  let consumed = costOf(packedLines[0]!);
  if (description !== null) {
    if (consumed + costOf(description) <= budget) {
      packedLines.push(description);
      consumed += costOf(description);
    } else {
      truncated = true;
    }
  }

  const cited: PackableLine[] = [];
  let carried = 0;

  for (const section of sectionsInput) {
    const allowance = Math.min(budget - consumed, Math.floor(budget * section.share) + carried);
    if (section.lines.length === 0) {
      carried = allowance; // nothing to spend — the whole allowance rolls forward
      continue;
    }
    const header = section.title;
    const headerCost = costOf(header);
    if (headerCost > allowance) {
      truncated = true; // cannot even afford the section header — whole section dropped
      carried = allowance;
      continue;
    }
    const sectionPacked: string[] = [];
    let sectionUsed = headerCost;
    for (const entry of section.lines) {
      const cost = costOf(`- ${entry.line}`);
      if (sectionUsed + cost > allowance) {
        truncated = true; // drop the line whole — never a mid-sentence cut
        continue;
      }
      sectionPacked.push(`- ${entry.line}`);
      section.into.push(entry.line);
      cited.push(entry);
      sectionUsed += cost;
    }
    if (sectionPacked.length === 0) {
      truncated = true; // the header fit but no line did — no dangling header, allowance carries
      carried = allowance;
      continue;
    }
    packedLines.push(header, ...sectionPacked);
    consumed += sectionUsed;
    carried = Math.max(0, allowance - sectionUsed);
  }

  const text = packedLines.join('\n');
  const used = estimateTokens(text); // the honest assembled cost (≤ Σ costOf by construction)
  const citedViews = cited.map((entry) => entry.view);
  const scores =
    citedViews.length === 0
      ? { importance: 0.7, confidence: 0.8 }
      : derivedScores(citedViews);
  const temporals =
    citedViews.length === 0
      ? { observed_at: input.now_iso, valid_from: input.now_iso }
      : derivedTemporals(citedViews);

  return {
    kind: PROJECT_DIGEST_KIND,
    project_id: input.project_id,
    project_name: input.project_name,
    budget,
    used,
    truncated,
    text,
    sections,
    entries: projectDigestEntriesOf(sections),
    source_ids: cited.map((entry) => entry.sourceId),
    evidence: citedViews.length === 0 ? [] : unionEvidence(citedViews),
    importance: scores.importance,
    confidence: scores.confidence,
    observed_at: temporals.observed_at,
    valid_from: temporals.valid_from,
    content_hash: memoryContentHash(text),
    sources: {
      decisions: input.decisions.length,
      failures: input.failures.length,
      procedures: input.procedures.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The durable-memory shaping
// ---------------------------------------------------------------------------

/** Assemble the digest `NewMemory` (semantic / `project_context`) — the derivation builder's twin. */
export function digestMemoryOf(
  candidate: ProjectDigestCandidate,
  provenance: { source_id: string; observed_at: string },
): NewMemory {
  if (candidate.evidence.length === 0) {
    // Unreachable for a persisted digest (the pass skips candidates that cite nothing) — kept as
    // a hard invariant: a durable memory without evidence never reaches the Store.
    throw new Error('project digest: the rollup carries no evidence spans — nothing to persist');
  }
  return {
    type: 'semantic',
    subtype: PROJECT_DIGEST_SUBTYPE,
    title: 'project context digest',
    content: candidate.text,
    content_summary: clampAtWordBoundary(candidate.text, 159),
    importance: candidate.importance,
    confidence: candidate.confidence,
    observed_at: provenance.observed_at,
    valid_from: candidate.valid_from,
    project_id: candidate.project_id,
    source_id: provenance.source_id,
    evidence: candidate.evidence,
    extraction: {
      method: 'heuristic',
      prompt_version: PROJECT_DIGEST_PROMPT_VERSION,
      adapter: 'consolidation',
    },
    tags: [PROJECT_DIGEST_TAG, PROJECT_DIGEST_SUBTYPE],
    token_estimate: candidate.used,
  };
}
