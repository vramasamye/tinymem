/**
 * The project digest rollup contract (backlog M14.5; retrieval.md §2 "projects.digest — the
 * consolidation-built rollup"; ADR-0010 §6 — `memory_project_context` is the session-start
 * channel this rollup feeds).
 *
 * Two artifacts, one assembly:
 *
 * - the DURABLE DIGEST MEMORY — one `semantic` / `project_context` row per project (subtype
 *   {@link PROJECT_DIGEST_SUBTYPE}, tag {@link PROJECT_DIGEST_TAG}), supersession-managed like
 *   every durable memory (audited `supersede` when the rollup changed, `unchanged` when the
 *   content hash did not);
 * - the RENDERABLE DIGEST RECORD — the `projects.digest` JSONB entries the existing
 *   `memory_project_context` tool surface already renders (session-context.ts reads the column),
 *   one entry per rolled-up one-liner so the tool's line-level packing can drop whole entries,
 *   never cut one mid-sentence.
 *
 * The entry key namespace (`decision_NN` / `failure_NN` / `procedure_NN`, zero-padded) is OWNED
 * by the digest pass: the storage merge preserves every other key (manual `summary`/`stack`
 * entries and the M4f architecture-digest fields stay untouched) and replaces only this
 * namespace. Zero padding keeps `decision_02` sorting before `decision_10` under jsonb's
 * (length, bytewise) key order.
 */

import { z } from 'zod';

import type { EvidenceSpan } from '../schema/extraction';

// ---------------------------------------------------------------------------
// Identity + budget
// ---------------------------------------------------------------------------

/** The digest candidate's discriminator (the typed candidate carries `kind: 'project_context'`). */
export const PROJECT_DIGEST_KIND = 'project_context' as const;

/** The durable digest memory's `subtype` (the way `project_digest` marks the M4f architecture digest). */
export const PROJECT_DIGEST_SUBTYPE = 'project_context' as const;

/** The stable tag every digest memory carries (lookup + retrieval filtering). */
export const PROJECT_DIGEST_TAG = 'project_digest' as const;

/**
 * The default digest budget: 750 tokens — the `memory_project_context` tool budget (the
 * retrieval `sessionContext.budget` default). The digest must fit inside what the tool would
 * inject, so the durable rollup and the session-start context agree on size.
 */
export const DEFAULT_PROJECT_DIGEST_BUDGET_TOKENS = 750;

// ---------------------------------------------------------------------------
// Sections + the renderable record
// ---------------------------------------------------------------------------

/**
 * The rolled-up one-liners, packed under the digest budget: `decisions` first (top accepted
 * decisions, newest first), then `failures` (problem → solution, most recurring first), then
 * `procedures` (importance-ordered). Each entry is one whole line — never a mid-sentence cut.
 */
export const ProjectDigestSectionsSchema = z.looseObject({
  decisions: z.array(z.string()),
  failures: z.array(z.string()),
  procedures: z.array(z.string()),
});
export type ProjectDigestSections = z.infer<typeof ProjectDigestSectionsSchema>;

/** The entry keys the digest pass owns inside `projects.digest` (`decision_01`, `failure_02`, …). */
export const PROJECT_DIGEST_ENTRY_KEY = /^(decision|failure|procedure)_(\d{2})$/;

/**
 * The write boundary of the renderable digest record: every key must be an owned
 * `decision_NN` / `failure_NN` / `procedure_NN` entry and every value its one-liner. Storage
 * validates this shape before the merge (AGENTS.md: Zod validates every external boundary).
 */
export const ProjectDigestEntriesSchema = z
  .record(z.string(), z.string())
  .refine(
    (entries) => Object.keys(entries).every((key) => PROJECT_DIGEST_ENTRY_KEY.test(key)),
    'project digest entries must use the owned key namespace: decision_NN | failure_NN | procedure_NN (zero-padded two digits)',
  );
export type ProjectDigestEntries = z.infer<typeof ProjectDigestEntriesSchema>;

/**
 * Project the packed sections into the renderable `projects.digest` record: one
 * `decision_01`-style key per one-liner, sections in rollup priority order. The inverse of the
 * renderer's `label: value` lines — session-context.ts turns `decision_01` into `decision 1: …`.
 */
export function projectDigestEntriesOf(sections: ProjectDigestSections): ProjectDigestEntries {
  const entries: Record<string, string> = {};
  const write = (prefix: 'decision' | 'failure' | 'procedure', lines: readonly string[]): void => {
    for (let index = 0; index < lines.length && index < 99; index += 1) {
      entries[`${prefix}_${String(index + 1).padStart(2, '0')}`] = lines[index]!;
    }
  };
  write('decision', sections.decisions);
  write('failure', sections.failures);
  write('procedure', sections.procedures);
  return entries;
}

// ---------------------------------------------------------------------------
// The typed digest-memory candidate
// ---------------------------------------------------------------------------

/**
 * What `runProjectDigest` returns: the complete, token-bounded digest candidate — everything the
 * persisting pass needs to shape ONE digest memory (`used ≤ budget` enforced by construction),
 * plus the renderable record for `projects.digest`. A plain interface like
 * `ConsolidationReport`: an output document, produced by the library, consumed by the pass,
 * the CLI, and (later) the daemon scheduler.
 */
export interface ProjectDigestCandidate {
  kind: typeof PROJECT_DIGEST_KIND;
  project_id: string;
  /** The project's name (the rollup header anchors the digest in its project). */
  project_name: string | null;
  /** The digest token budget (`used ≤ budget` by construction; default 750). */
  budget: number;
  /** The estimated tokens of `text` (the shared estimator, chars/4 rounded up). */
  used: number;
  /** True when one-liners were dropped to fit the budget (honesty over a silent partial rollup). */
  truncated: boolean;
  /** The durable digest content: header + the three packed sections. */
  text: string;
  sections: ProjectDigestSections;
  /** The renderable `projects.digest` entries (the `memory_project_context` projection). */
  entries: ProjectDigestEntries;
  /** The ids of every summarized memory whose one-liner was packed (the `derived_from` edge targets). */
  source_ids: string[];
  /** The union of the cited sources' evidence spans (capped) — the digest's provenance. */
  evidence: EvidenceSpan[];
  /**
   * Corroboration scores over the cited sources (the derivation helper's formula: max source
   * importance +0.05 / confidence +0.1, capped at 0.95) — a digest of high-authority rows ranks
   * high; a digest of weak rows stays weak.
   */
  importance: number;
  confidence: number;
  /** The digest was observed at the newest source and valid since the oldest. */
  observed_at: string;
  valid_from: string;
  /** The content hash of `text` — the unchanged probe's key (idempotency). */
  content_hash: string;
  /** How many memories each section read (pre-packing counts). */
  sources: { decisions: number; failures: number; procedures: number };
}
