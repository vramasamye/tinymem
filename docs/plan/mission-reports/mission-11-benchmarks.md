# Mission 11a report — benchmarks v1 (golden dataset + metric harness + CI gates)

**Branch:** `mission/11-benchmarks` (worktree `/Users/apple/Desktop/AI_Coding/onememory-m11`, based on `main` `5c20159`)
**Scope delivered:** the new `benchmarks/` workspace package `@onememory/benchmarks` (loader, real-engine
runtime, pure metric math, gate evaluation, markdown report, `bench:run` CLI), five committed golden
datasets, a committed baseline run, and this report. Nothing outside `benchmarks/**` and this report
was touched.
**Backlog item:** M11.1 + M11.2 — "Golden dataset (repeated facts, contradictory facts, outdated
facts (Node 20→22→24), project-specific vs cross-project, procedural knowledge, failure/solution
pairs); metrics harness (retrieval precision/recall, token efficiency, pollution, temporal accuracy,
contradiction accuracy, consolidation quality); CI thresholds; results committed to
`benchmarks/results/`."

---

## 1. What shipped

| Area | Delivered |
|---|---|
| Workspace package | `benchmarks/eval` → `@onememory/benchmarks` (mirrors the existing package.json / tsconfig / `typecheck` conventions; root workspaces glob already covered `benchmarks/*`) |
| Datasets | `benchmarks/datasets/golden/*.json` — 5 datasets, 19 fact matchers, 17 declared queries + 1 contradiction probe; Zod-validated loader with cross-field reference checks |
| Harness | `src/runtime.ts` composes the real `storage` + `extraction` + `retrieval` packages; `src/harness.ts` runs datasets and aggregates metrics |
| Metrics | `src/metrics.ts` — pure, unit-tested math for all six metric families |
| Gates | `src/gates.ts` — thresholds + `evaluateGates`; `src/harness.test.ts` is the `bun test` CI gate |
| Results | `benchmarks/results/baseline.json` + `baseline.md` (committed baseline run) |
| Script | `bench:run` (in `benchmarks/eval/package.json`) writes the results; exits non-zero on a gate failure |
| Docs | `benchmarks/eval/README.md` + this report |

**Explicitly out of scope / not delivered:** nightly drift reporting (M11.2 mentions it; the repo's
existing `.github/workflows/ci.yaml` runs `bun test` on push/PR, which includes the gate test, but
there is no scheduled job yet — see follow-up 4), and the full M11b eval (retrieval precision/recall
and token efficiency *are* delivered here; the separate "full memory-quality eval" mission M11b
remains open per the phased plan).

## 2. Driving the real engine (design decision)

`benchmarks/eval/src/runtime.ts` composes the workspace packages **directly** rather than depending
on `@onememory/api/runtime`:

- the dependency direction is one-way (`apps` depend on `packages`, never the reverse —
  `docs/architecture/repository-structure.md` rule 1), and a benchmark must not reach into an
  application;
- the pieces are exactly the ones `apps/api/src/runtime/composition.ts` wires for the offline
  default: `createEmbeddedDb` (PGlite + committed migrations), `createHeuristicExtractor` +
  `createHeuristicClassifier` + `createExtractHandler` (the no-LLM baseline), and
  `createRetrievalEngine`.

No mocks: the store, extractor, classifier and search engine are the production implementations.
The runtime is offline by construction — **no embedder and no model router are wired**, so retrieval
runs the documented lexical + graph default and extraction is heuristic-only. `bench:run` installs
the M12 network guard (`@onememory/security`) for the duration of the run and records the outbound
attempt count; the committed baseline reports **0 network attempts**. The guard is process-global, so
the `bun test` gate leaves it off (the runtime is still structurally incapable of an outbound call).

**Supersession:** automatic contradiction detection/authority resolution is M14. The harness therefore
applies the dataset's declared supersession pairs through the real, audited
`Store.updateMemoryStatus(loser, 'superseded', { valid_until, superseded_by_id, actor, reason })`
primitive — the same mechanism the engine supports today and the same shape
`apps/api/src/runtime/extraction-temporal.test.ts` exercises via `Store.supersede`.

## 3. Dataset design

Each dataset runs in its own fresh embedded database, so projects cannot bleed between datasets.

| Dataset | M11.1 bucket | Contents |
|---|---|---|
| `temporal-node-versions` | outdated facts | Node 20 → 22 → 24, chained by explicit supersession; current / three point-in-time / history probes |
| `retrieval-precision` | project-scoped, procedural, failure/solution | one project, six memories (decision, two preferences, resolved failure, recurring terraform procedure, recurring `bun test`) |
| `pollution-cross-project` | project-specific vs cross-project | two projects with competing database decisions + one user-global (`project_id NULL`) preference |
| `contradictions` | contradictory facts | two mutually exclusive database decisions, ingested without supersession |
| `consolidation-repeats` | repeated facts, repeated failures | identical repeats, paraphrases, and the same failure twice |

Expected memories are referenced by a stable **fact key** with a matcher (`type` / `subtype` /
`project` / `content_equals` / `content_contains`) — never by generated uuid. The harness resolves
keys to ids after extraction and **fails loudly** when a key resolves to zero or more than one memory,
so a fixture that stops being produced cannot silently shrink the benchmark. The loader also rejects
dangling references, duplicate keys, unidentifiable matchers, and clocks that place events after the
engine's `now`. Datasets contain no secrets (AGENTS.md rule 6).

## 4. Metric definitions and their source

The originating **"spec §25" does not exist as a file in this repository** (it is referenced by
`docs/architecture/repository-structure.md`, `docs/adr/0004-retrieval.md` and
`docs/backlog/issues.md`, but no spec document is present under `docs/`). The metric definitions are
therefore derived from the architecture docs, as the mission instructed:

| Metric | Definition | Source |
|---|---|---|
| retrieval precision@5 / recall@5 / MRR | macro-average over `kind: retrieval` queries with an expected set; precision@5 over the top 5 returned, recall over the expected set, MRR from the first expected hit | ADR-0004; `docs/architecture/retrieval.md` §1 |
| tokens-per-answer | `tokens.used` from the response; budget compliance is the fraction with `used ≤ budget`; tokens/expected-fact is a density proxy | `retrieval.md` §7; ADR-0004 point 5 |
| pollution | cross-project top-1 rate (hard invariant), cross-project leakage rate (diagnostic), declared-distractor leakage rate | ADR-0004 consequences ("pollution"); `memory-model.md` §2/§8 |
| temporal accuracy | fraction of `kind: temporal` probes where every expected fact is present **and** no forbidden fact is; bucketed current / point-in-time / history | `memory-model.md` §4–§5; `retrieval.md` §3 |
| contradiction accuracy | fraction of contradiction groups where the authority fact is returned and no contradicted fact is; plus `authority_top1` and `silent_conflicts` diagnostics | `memory-model.md` §9 authority order |
| consolidation quality | mean over repetition groups of `1 − distinct_memories / observations`, clamped to [0,1] | `memory-model.md` §9 (episodic→semantic, near-dup merge) |

## 5. Baseline numbers, thresholds and headroom

Committed baseline: `benchmarks/results/baseline.json` / `baseline.md`. Runtime: embedded PGlite, no
embedder (lexical + graph), heuristic extraction, default `max_tokens` 800, 5 datasets, 18 query
outcomes (9 retrieval queries with expectations, 5 temporal probes, 3 pollution probes, 1
contradiction probe), 0 network attempts.

### Gated

| Metric | Baseline | Gate | Headroom | Rationale |
|---|---:|---:|---:|---|
| `temporal_accuracy` | 1.0000 (5/5) | ≥ 1.0 | 0 | correctness invariant — one miss is a real regression |
| `retrieval_precision_at_k` (k=5) | 0.7963 | ≥ 0.7 | ~0.10 | ranking noise ceiling |
| `retrieval_recall_at_k` (k=5) | 1.0000 | ≥ 0.9 | ~0.10 | |
| `token_budget_compliance` | 1.0000 | ≥ 1.0 | 0 | the packer's hard invariant (`used ≤ budget`) |
| `cross_project_top1_rate` | 0.0000 | ≤ 0.0 | 0 | the best result for a scoped query must be that project's (or global) |
| `irrelevant_leakage_rate` | 0.1111 | ≤ 0.2 | ~0.09 | declared-distractor leakage ceiling |

### Reported, not gated (M14 dependencies — the coordinator flips these on after M14 merges)

| Metric | Baseline | Why not gated yet |
|---|---:|---|
| `contradiction_accuracy` | 0.0000 (0/1); `authority_top1` 0, `silent_conflicts` 1 | automatic contradiction detection + authority resolution is M14; pre-M14 the engine returns both sides with no conflict signal |
| `consolidation_quality` | 0.3333; fully consolidated 2/3 (exact repeat 0.5, paraphrase 0.0, repeated failure 0.5) | episodic→semantic derivation and near-duplicate merge are M14; today only exact content-hash dedupe collapses repeats |

Supporting detail from the baseline: retrieval `precision_full` 0.7963, `recall_full` 1.0, MRR
0.8333; tokens mean 22.83, p95 54, max 54, mean tokens/expected-fact 20.47; pollution
cross-project leakage 6.3% (2/32 returned) — see the finding below.

## 6. Findings worth surfacing to the coordinator

1. **Project scope is a soft ranking signal, not a hard filter.** The retrieval engine builds its
   candidate filter without `project_id` (`packages/retrieval/src/engine.ts` stage 2) and applies
   project scope only through the `w_project` scoring weight (ADR-0004: 1.0 same / 0.7 cross / 0.4
   global). Consequence: for a project-scoped query the *top* result is always the right project
   (baseline `cross_project_top1_rate` 0.0), but a competing memory from another project can still
   appear in the lower ranks (baseline cross-project leakage 2/32 = 6.3%). This is by design in the
   ADR, but it means "pollution" cannot be gated at zero on the full result set today. The gated
   pollution metrics are top-1 (0.0) and declared-distractor leakage (≤ 0.2); the full-set leakage
   rate is published as a diagnostic. If the coordinator wants zero cross-project leakage, that is a
   retrieval-design change (a hard scope filter), not a benchmark change.
2. **Lexical precision on broad queries is the main precision driver.** `which test runner do we
   prefer` returns four lexically-matching memories (the preference, the CI-order preference, the
   resolved `bun test` failure, and the recurring-command procedure), giving precision@5 0.25 on that
   query. That is the honest behaviour of OR-ed `plainto_tsquery` on the embedding-free default; the
   aggregate precision gate carries the headroom for it.
3. **The committed baseline is the honest no-LLM, no-embedding default** — exactly the mode
   `docs/research/supermemory-parity-status-2026-10-05.md` §4 says must be published with numbers
   instead of adjectives, and the same configuration `onemem doctor` must pass.

## 7. Files

```text
benchmarks/
├── datasets/golden/{temporal-node-versions,retrieval-precision,pollution-cross-project,
│                    contradictions,consolidation-repeats}.json
├── eval/
│   ├── package.json, tsconfig.json, README.md
│   └── src/{index,dataset,runtime,metrics,harness,gates,report,cli}.ts
│       src/{dataset,metrics,gates,harness}.test.ts
└── results/{baseline.json,baseline.md}
docs/plan/mission-reports/mission-11-benchmarks.md   (this report)
bun.lock                                             (regenerated for the new workspace package)
```

## 8. Validation evidence

- `bun run --cwd benchmarks/eval typecheck` — clean (tsc --noEmit, 0 errors).
- `bun test benchmarks/eval` — **37 pass, 0 fail** (4 files; 112 expect calls; ~10 s). Includes the
  full harness run over all five datasets (~7.5 s), the breach proof, and a determinism check (two
  runs of the temporal dataset produce byte-identical metrics).
- `bun test` at the repository root — **1091 pass, 22 skip, 0 fail** (85 files; 10362 expect calls;
  ~316 s). The 22 skips are the Postgres-server-gated integration tests (no `ONEMEMORY_PG_URL`), as
  expected. CI (`.github/workflows/ci.yaml`) runs this same command on push/PR.
- `bench:run` — all six gates pass; writes `benchmarks/results/baseline.{json,md}`; `network attempts: 0`.
- **Gate-failure proof:** `retrieval_precision_at_k` was temporarily lowered from 0.7 to 0.99; the
  gate test then failed (`report.gates.passed` false) and the threshold was restored to 0.7. The
  durable form of this proof is the in-test breach assertion in `src/harness.test.ts`.

### 8.1 Post-review fixes

Coordinator review (Standards + Spec) fix list, applied after the first four commits:

| # | Fix | Where |
|---|---|---|
| 1 | Replaced the dead `void supersession` no-op loop with real validation: a supersession whose loser and winner matchers are identical is rejected at load time (a memory cannot supersede itself). Added `matcherKey` + two tests. | `src/dataset.ts`, `src/dataset.test.ts` |
| 2 | Extracted one shared probe-runner (`runProbe` + `ProbeSpec`); the declared-query loop and the contradiction loop now both call it instead of repeating the build-ids → search → push-outcome shape. | `src/harness.ts` |
| 3 | Reused the pass-condition helper in `computeContradictionMetrics` and renamed `satisfies` → `meetsExpectations`. | `src/metrics.ts` |
| 4 | Removed unused `max_memories` (schema + `searchRequest` plumbing) and the unused `BenchRuntimeOptions.dataDir` (the runtime now always owns a fresh temp data dir). | `src/dataset.ts`, `src/harness.ts`, `src/runtime.ts` |
| 5 | Made `harness.test.ts` order-independent: the order-coupled second test was merged into the harness test, which shares one run for the live assertions and the breach proof; no shared mutable state remains. | `src/harness.test.ts` |
| 6 | Corrected the CI claim: `.github/workflows/ci.yaml` exists and runs `bun test` on push/PR (this file's gate test is already CI-enforced); the real follow-up is a scheduled `bench:run`; added the n=1 contradiction-coverage caveat. | this report, `benchmarks/eval/README.md`, `src/harness.test.ts` docstring |

The fixes are refactors plus one genuine new validation; re-running `bench:run` after them produced
**byte-identical `metrics` and `gates`** (only `generated_at` and per-run uuids changed), so the
committed baseline is unchanged.

## 9. Follow-ups

1. **M14 merge:** flip `contradiction_accuracy` and `consolidation_quality` from reported to gated
   once automatic contradiction resolution and consolidation land. The baseline to beat is
   0.0 contradiction accuracy (1 silent conflict) and 0.3333 consolidation quality (2/3 groups fully
   consolidated). The gate thresholds should be set from the post-M14 baseline.
2. **M11b:** extend with the full memory-quality eval (nightly drift report, larger judged query set,
   optional embedder/reranker tiers).
3. **Retrieval-design decision (coordinator):** whether project scope should become a hard filter for
   scoped queries. If yes, `cross_project_leakage_rate` can be gated at 0 and the pollution dataset's
   forbidden facts become hard invariants.
4. **CI:** `.github/workflows/ci.yaml` (pre-existing, on push to `main` and every PR) already runs
   `bun test`, which includes the gate test in `src/harness.test.ts` — so every push re-checks the
   thresholds. The remaining work is a *scheduled* job: a nightly `bun run --cwd benchmarks/eval
   bench:run` (exits non-zero on a gate failure). Note when wiring it: the committed
   `baseline.json` embeds per-run values (`generated_at`, uuidv7 `projectId`/`memory_id`), so a raw
   file diff always shows churn — the drift signal to compare/commit is the `metrics` + `gates`
   blocks, not the whole file.
5. **Contradiction coverage is thin (n=1 group).** The reported `contradiction_accuracy` is measured
   over a single contradiction pair, which is enough to prove the metric and the pre-M14 baseline but
   not enough to gate on. Fold more contradiction groups into the M11b larger dataset (follow-up 2)
   so the post-M14 gate flip has statistically meaningful coverage.

## 10. Dependencies and assumptions

- Depends on `@onememory/{core,extraction,retrieval,security,storage}` (all `workspace:*`); no new
  external dependency was introduced.
- Assumes the embedded PGlite profile is the benchmark target (local-first default). Server-profile
  benchmarking is out of scope for M11a.
- The benchmark's numbers are tied to the heuristic extractor's exact output; the fact-resolution
  contract fails the suite if extraction output changes, which is intentional (it makes extractor
  regressions visible) but means extractor changes require dataset matcher updates.
