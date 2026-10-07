# Mission M11b-quality report — full memory-quality eval (Phase 5)

**Branch:** `mission/11b-memory-quality` (worktree `/Users/apple/Desktop/AI_Coding/onememory-m11bq`, based on `main` `7251c5a`)
**Mission:** phased-plan Phase 5 row M11b — "retrieval precision/recall, token efficiency, memory
pollution; published results in `benchmarks/results/`" — plus the M11b-quality definition in
`docs/backlog/issues.md` (quality dashboard data: duplicates/stale/conflicts).
**Scope delivered:** three new CI-gated metric families on top of the M11a harness and the M11b
consolidation-gate baseline, four new golden datasets, three published per-metric result files with
a documented schema, and this report. Nothing outside `benchmarks/**` and this report was touched.

---

## 1. Acceptance criteria — delivered

| AC | Delivered |
|---|---|
| 1. Retrieval precision/recall per query type with CIs over a fixed N runs, CI thresholds per type | `benchmarks/eval/src/metrics/precision-recall.ts` (pure), typed `query_type` queries in three new golden datasets (`procedural-queries`, `decision-queries`, `failure-queries`), six per-type gates. The quality-gate test pins determinism across **N = 3 fixed runs** and pools the observations; the 95% interval is the normal approximation over the per-query sample. |
| 2. Token efficiency: `used ≤ budget` on all three query types + the oracle-gap metric, CI-gated | `benchmarks/eval/src/metrics/token-efficiency.ts` (pure). Per-type budget compliance (three gates at 1.0 — the packer's hard invariant, now asserted per type) and `used / oracle_min_tokens` gated at ≤ 2.5 (measured 2.1418). The oracle is `Σ estimateTokens(deriveLabel(title, content))` over the golden expected facts — the engine's own estimator and label derivation, i.e. the packer's titles-only representation of exactly the golden answer. |
| 3. Memory pollution: stale / duplicate / contradicted-unmarked counts, honest CI thresholds | `benchmarks/eval/src/metrics/pollution.ts` (pure). Stale = `status = 'archived'` with `last_accessed_at` inside 30 days (the audit reads the settled post-run corpus, after the fire-and-forget REINFORCE drains). Duplicates = surfaced pairs with cosine ≥ 0.97 over deterministic local trigram vectors, same type + same project (mirroring the M14 merge gate's scope rule and threshold, via the repo's own `cosineSimilarity`). Unresolved contradictions = golden-declared sides whose post-run status is neither `superseded` nor `disputed`. Three count gates, one per detector. |
| 4. Published results: `<metric>.<iso-date>.json` per metric + schema/gating README | `benchmarks/results/{retrieval-quality,token-efficiency,memory-pollution}.2026-10-06.json` (written by `bench:run` alongside the regenerated `baseline.{json,md}`) and `benchmarks/results/README.md` (file schemas, CI gating logic, threshold table, honest notes). |
| 5. Thresholds defined, recorded, reported — honest first baselines | All thirteen new thresholds were **measured first, then encoded** in `DEFAULT_GATE_THRESHOLDS` and reported by every gate evaluation; the values and their headroom rationale are in §3 and the results README. |
| 6. This report | AC table, measured baselines, thresholds, validation counts, test counts. |

## 2. What shipped

| Area | Files |
|---|---|
| Metric modules (NEW `src/metrics/`) | `precision-recall.ts`, `token-efficiency.ts`, `pollution.ts` — each a pure function over a harness-output view + a typed golden set; no storage, no engine (the M11a `metrics.ts` pattern) |
| Harness (additive) | `src/harness.ts` — typed outcomes by query id, oracle recomputation + annotation drift guard, per-dataset quality records, benchmark-level pooling over raw per-query views (never averages of averages); `src/runtime.ts` — `CorpusMemory.title` (optional) + `finalMemories()` (settled post-run corpus read; drains in-flight reinforces first) |
| Gates (additive) | `src/gates.ts` — 13 new thresholds/checks on top of the untouched M11a/M11b eight; `AggregateMetrics` gains the three records |
| Datasets (NEW) | `decision-queries.json` (5 decisions, 5 queries), `procedural-queries.json` (4 explicit procedures + 1 recurring command, 5 queries), `failure-queries.json` (3 failure-then-resolution pairs, 3 queries), `pollution-quality.json` (60-day-old corpus, decay opt-in at `archiveThreshold: 0.2`, 3 probes). Typed queries carry `query_type` + the committed `oracle_min_tokens` annotation |
| Dataset schema (additive) | `src/dataset.ts` — two optional query fields (`query_type`, `oracle_min_tokens`) with cross-field validation; all pre-existing datasets parse byte-identically |
| Report/CLI (additive) | `src/report.ts` renders the new metric lines; `src/cli.ts` writes the three dated per-metric result files |
| Tests (NEW/extended) | `src/metrics/{precision-recall,token-efficiency,pollution}.test.ts` (pure math, 23 tests), `src/metrics/quality-gate.test.ts` (real-engine gate: 3 fixed runs, token budget, pollution fixtures), `src/gates.test.ts` +7 breach tests |
| Results | `benchmarks/results/` — regenerated `baseline.{json,md}`, three dated metric files, `README.md` |

**Reuse before build (cited):** the per-query precision/recall formulas reuse the M11a
`computeRetrievalMetrics` definitions; the oracle reuses `estimateTokens` (`@onememory-ai/core`) and
`deriveLabel` (`@onememory-ai/retrieval`) — the exact estimator and label path the packer's titles-only
line uses; duplicate cosine reuses `cosineSimilarity` from `@onememory-ai/storage`; the 0.97 threshold
mirrors the M14 `DEFAULT_CONSOLIDATION_CONFIG.nearDuplicate.cosineThreshold`; the pollution fixture's
decay uses the existing `consolidation_pass` config knob. No new runner was invented — everything
runs through the existing `runDataset`/`runBenchmark`/`evaluateGates` pipeline and the existing
`bench:run` CLI.

## 3. First-measured baseline (2026-10-06, offline default, 0 network attempts)

| Gate | Measured | Threshold (dir) | Where it landed and why |
|---|---:|---:|---|
| retrieval_precision_procedural | **0.69** | ≥ 0.6 | The broad `ci-order` query matches all five sibling procedures (2 of 5 queries return 4–5 results); one honest step below the measured mean |
| retrieval_precision_decision | **1.0** | ≥ 0.9 | Clean corpus; a single miss drops one query to 0 → mean 0.8, under the gate |
| retrieval_precision_failure | **0.4444** | ≥ 0.4 | Structural, not a fixture defect: failure queries co-surface sibling failures (the known-failures shortcut) and the failing commands' recurring procedurals |
| retrieval_recall_{procedural,decision,failure} | **1.0 / 1.0 / 1.0** | ≥ 0.9 each | Every expected fact surfaces; any single query losing its fact fails its type's gate |
| token_budget_compliance_{procedural,decision,failure} | **1.0** each | = 1.0 each | The packer's hard invariant, now asserted per type |
| token_oracle_gap_mean (recall-satisfied) | **2.1418** | ≤ 2.5 | Decision queries sit near the oracle (1.0267); procedural/failure carry the co-surfaced siblings (2.76 / 2.97). Max single-query gap 6.8 (the `ci-order` query) — reported, not gated |
| stale_cited_memories | **1** | ≤ 1 | The `pollution-quality` fixture: decay archived a 60-day-old version fact that a point-in-time probe then served and cited (`last_accessed_at` = dataset clock) |
| duplicate_surfaced_pairs | **1** | ≤ 1 | The deliberate case-variant procedural pair (cosine 1.0 offline); with an embedder wired the M14 merge collapses it → 0, an improvement that still passes |
| unresolved_contradicted_memories | **1** | ≤ 1 | The cross-phrasing pair in the `contradictions` dataset (the documented template-detector gap; M14 follow-up: LLM conflict detector) |

**Pre-existing gates (M11a + M11b, thresholds untouched):** temporal_accuracy 1, retrieval_precision@k
0.7479 (≥ 0.7), retrieval_recall@k 1, token_budget_compliance 1, cross_project_top1_rate 0,
irrelevant_leakage_rate 0.1111, contradiction_accuracy 0.8333, consolidation_quality 0.3333 — all
pass. The aggregate precision drifted 0.7963 → 0.7479 because the typed queries widened the
aggregate query set (9 → 24 retrieval queries); the gate holds with headroom and the drift is
documented in the results README.

**Confidence intervals (AC 1):** procedural precision 0.69 with 95% CI [0.3176, 1]; decision 1.0
[1, 1]; failure 0.4444 [0.3356, 0.5533]. Offline the engine is deterministic — the quality-gate test
pins byte-identical per-type records across its 3 fixed runs — so the interval reflects the fixed
query sample (3–5 per type), and the same math captures real run variance the moment a
non-deterministic tier (embedder, LLM router) is wired.

## 4. Findings worth a coordinator's eyes (benchmarks-only mission; no `packages/**` changes)

1. **Archive-vs-citation tension (real, pipeline-produced).** Decay archives on prominence alone and
   does not consider `last_accessed_at`; a point-in-time probe still serves the archived memory and
   reinforces it, producing exactly the "archived but cited in the last 30 days" state. The pollution
   audit now measures it (count 1, gated ≤ 1). A decay pass that skips recently-cited memories would
   drop the count to 0 — a `packages/consolidation` follow-up, deliberately not touched here.
2. **Offline duplicate ceiling.** Without an embedder the M14 near-duplicate merge skips, so a
   case-variant pair (ingest dedupes only exact content hashes) survives and surfaces. The audit
   detects it (count 1); wiring an embedder to the bench runtime would let the merge collapse it.
3. **Failure-query precision is structurally low offline.** Failure-intent queries co-surface sibling
   failures via the known-failures shortcut and the failing commands' recurring procedurals. Recall
   (the must-return side) is 1.0; precision 0.4444 is the honest shape of the offline corpus, not a
   fixture defect — encoded at 0.4 with the rationale recorded in the gate comment.
4. **Schema file touched outside the strict lane list.** `src/dataset.ts` (the golden-dataset schema)
   had to gain two optional query fields (`query_type`, `oracle_min_tokens`) because Zod `strictObject`
   rejects the annotations the datasets must carry. The change is additive (all pre-existing datasets
   parse byte-identically) and flagged here for conscious coordinator review.
5. **`index.ts` re-exports not extended.** The three new metric modules are internal to the harness
   (imported by `harness.ts`/`gates.ts`); extending `src/index.ts`'s public surface is a one-line
   coordinator choice, not required by anything.

## 5. Validation

- `bun test benchmarks/eval`: **124 pass, 0 fail** (11 files). New tests: 26 in the `src/metrics/`
  suite (23 pure + 3 real-engine) + 7 new gate-breach tests in `gates.test.ts` = **33 new tests**.
- `tsc --noEmit` (benchmarks package): clean.
- Full repo `bun test --timeout=15000 --reporter=dots`: **1763 pass, 42 skip, 0 fail** (1805 tests,
  147 files).
- `bench:run` with the network guard: all 21 gates pass, **0 outbound network attempts** (local-first
  invariant preserved — no embedder, no router, PGlite embedded only).

## 6. Commits

1. `feat(benchmarks): land the M11b-quality metric modules` — `src/metrics/{precision-recall,token-efficiency,pollution}.ts` + pure tests.
2. `feat(benchmarks): add the typed query and pollution golden datasets` — 4 datasets + the additive `dataset.ts` schema fields.
3. `feat(benchmarks): wire the M11b-quality metrics into the harness and gates` — `harness.ts`, `runtime.ts`, `gates.ts`, `report.ts`, `cli.ts`, test updates, `quality-gate.test.ts`.
4. `docs(benchmarks): publish the M11b-quality baseline results` — regenerated baseline + three dated metric files + the results README.
5. `docs: report mission 11b memory quality` — this report.

## 7. The question the coordinator asked

**"Do today's M11b-quality benchmarks fail the pipeline when any of precision/recall /
token-efficiency / pollution go below the threshold?" — Yes.** `evaluateGates` folds all 21 checks
into one `passed` boolean; `harness.test.ts` asserts it on every `bun test` run (the CI workflow's
single `bun test` step), and `bench:run` exits non-zero on the same evaluation. Each of the thirteen
new checks is proven non-decorative: the `gates.test.ts` breach tests and the `quality-gate.test.ts`
decoration checks fail the evaluation when a single family is breached (per-type precision, per-type
recall, per-type budget compliance, oracle gap, and each pollution count).
