/**
 * `@onememory/consolidation` — the CONSOLIDATE / DECAY stages (memory-model.md §7–§9, §12–§14;
 * ADR-0003): the "memory keeps itself accurate" loop.
 *
 *   1. near-duplicate merge — same scope + type, cosine ≥ 0.97 → one survivor, `merged` audit
 *   2. contradiction detection + authority resolution — explicit > decision > newer >
 *      confidence; a tie marks both `disputed` (never a silent pick); the winner supersedes the
 *      loser through the audited supersession fields
 *   3. episodic → semantic derivation — ≥ 3 corroborated episodes of one entity → one semantic
 *      memory with `derived_from` edges to every source (LLM merge optional via the model
 *      router; templated offline merge otherwise — zero network by default)
 *   4. decay / archive — prominence below threshold → audited `archived` (archive, never delete)
 *
 * Plus the project digest rollup (backlog M14.5): one token-bounded `project_context` digest
 * memory per project, summarizing the top decisions / failures / procedures and feeding the
 * `memory_project_context` tool surface through `projects.digest` (retrieval.md §2).
 *
 * `runConsolidation` is the callable entry over the existing `Store` port; the `onemem
 * consolidate` CLI command and the (future) daemon-side scheduler both call it. All mutations
 * go through audited store paths with provenance (AGENTS.md rule 8).
 */

// The library entry
export { runConsolidation, type ConsolidationInput } from './run';

// Authority resolution (pure — the ordering matrix memory-model.md §9)
export {
  authorityViewOf,
  compareAuthority,
  mergeKeeperOrder,
  winnerOf,
  type AuthorityComparison,
  type AuthorityView,
} from './authority';

// Contradiction detection (pure heuristic + the resolution pass)
export {
  contradictionTemplate,
  contradictsHeuristically,
  numericValues,
  supersessionValidUntil,
  runContradictionPass,
  temporalOverlap,
  type ContradictionDetector,
  type ContradictionPassResult,
} from './contradiction';

// The shared clustering primitives (pair keys, scope keys, connected components)
export { pairKey } from './cluster';

// Near-duplicate merge (the pass over the vector channel)
export { runMergePass, type MergePassResult } from './merge';

// Episodic → semantic derivation (pure builders + the pass)
export {
  buildDerivedMemory,
  buildDerivationPrompt,
  derivedScores,
  derivedTemporals,
  DERIVATION_LLM_PROMPT_VERSION,
  DERIVATION_SYSTEM_PROMPT,
  DERIVATION_TEMPLATE_VERSION,
  LlmMergeSchema,
  MAX_DERIVATION_EVIDENCE,
  mergeClusterContent,
  mergeSourceOf,
  representativeSource,
  runDerivationPass,
  templatedMerge,
  unionEvidence,
  type DerivationPassResult,
  type LlmMerge,
  type MergeContentResult,
  type MergeSourceView,
} from './derive';

// Decay (pure formula + the archive pass)
export {
  effectiveImportance,
  isDecayResistant,
  prominence,
  recencySignal,
  runDecayPass,
  shouldArchive,
  type DecayPassResult,
} from './decay';

// Project digest rollup (M14.5 — one token-bounded `project_context` digest per project,
// feeding the `memory_project_context` tool surface through `projects.digest`)
export {
  clampAtWordBoundary,
  buildProjectDigest,
  decisionLineOf,
  digestMemoryOf,
  failureLineOf,
  procedureLineOf,
  PROJECT_DIGEST_PROMPT_VERSION,
  type DigestDecisionInput,
  type DigestFailureInput,
  type DigestProcedureInput,
  type ProjectDigestBuildInput,
} from './digest/rollup';
export {
  DEFAULT_PROJECT_DIGEST_COUNTS,
  isCurrentProjectDigest,
  PROJECT_DIGEST_ACTOR,
  PROJECT_DIGEST_SUPERSEDE_REASON,
  runDigest,
  runProjectDigest,
  type ProjectDigestInput,
  type ProjectDigestPassInput,
  type ProjectDigestPassResult,
  type ProjectDigestLikeMemory,
} from './digest/run';

// Configuration + the run report
export {
  CONSOLIDATION_HALF_LIFE_DAYS,
  DEFAULT_CONSOLIDATION_ACTOR,
  DEFAULT_CONSOLIDATION_CONFIG,
  MIN_DERIVATION_CLUSTER_SIZE,
  MIN_NEAR_DUPLICATE_COSINE,
  resolveConsolidationConfig,
  ConsolidationConfigSchema,
  type ArchiveRecord,
  type ConsolidationConfig,
  type ConsolidationConfigInput,
  type ConsolidationReport,
  type ConsolidationScope,
  type ContradictionRecord,
  type ContradictionSkip,
  type DerivationRecord,
  type DerivationSkip,
  type MergeRecord,
} from './types';
