/**
 * `@onememory/benchmarks` — the memory-quality evaluation harness (spec §25 subset, backlog M11).
 *
 * Public surface: the Zod-validated golden-dataset loader, the harness that drives the real engine,
 * the pure metric math, and the CI gate evaluation. See `benchmarks/eval/README.md` for how to run
 * it and `benchmarks/results/baseline.md` for the committed baseline.
 */

export {
  GoldenDatasetSchema,
  GLOBAL_PROJECT_KEY,
  loadDatasets,
  parseDataset,
  type ConsolidationGroup,
  type ConsolidationPass,
  type ContradictionGroup,
  type DatasetEvent,
  type DatasetFact,
  type DatasetQuery,
  type GoldenDataset,
  type MemoryMatcher,
  type SupersessionFixture,
} from './dataset';

export {
  buildEvent,
  matchMemories,
  memoryMatches,
  openBenchRuntime,
  type BenchRuntime,
  type BenchRuntimeOptions,
  type ConsolidationPassSummary,
  type CorpusMemory,
  type ResolvedFact,
} from './runtime';

export {
  computeConsolidationMetrics,
  computeContradictionMetrics,
  computePollutionMetrics,
  computeRetrievalMetrics,
  computeTemporalMetrics,
  computeTokenMetrics,
  temporalBucketFor,
  type ConsolidationMetrics,
  type ContradictionMetrics,
  type PollutionMetrics,
  type QueryKind,
  type QueryOutcome,
  type RetrievalMetrics,
  type TemporalBucket,
  type TemporalMetrics,
  type TokenMetrics,
} from './metrics';

export {
  runBenchmark,
  runDataset,
  type BenchmarkReport,
  type DatasetRunReport,
  type RunBenchmarkOptions,
} from './harness';

export {
  DEFAULT_GATE_THRESHOLDS,
  evaluateGates,
  type AggregateMetrics,
  type GateCheck,
  type GateEvaluation,
  type GateThresholds,
} from './gates';

export { renderMarkdown } from './report';

// Skill generation quality (M15: golden failure→fix dataset graded against the canonical
// SKILL.md contract — every gate a deterministic 1.0 correctness invariant)
export {
  SKILLS_GOLDEN_DATASET,
  SKILL_MD_CHAR_BOUND,
  type SkillsContentProbe,
  type SkillsExpectedBlocked,
  type SkillsExpectedCandidate,
  type SkillsFixtureCase,
  type SkillsFixtureFailure,
  type SkillsGoldenDataset,
} from './skills/fixtures';
export {
  evaluateSkillGates,
  evaluateSkills,
  renderSkillsReport,
  type SkillsGateEvaluation,
  type SkillsMetrics,
} from './skills/evaluate';
