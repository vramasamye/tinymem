# onememory benchmarks

Memory-quality evaluation harness (backlog **M11**; the originating "spec §25" is not present as a
file in this repository, so every metric below cites the architecture doc it is derived from).

The harness drives the **real engine** — `@onememory-ai/storage` (embedded PGlite), `@onememory-ai/extraction`
(heuristic, no-LLM), `@onememory-ai/retrieval` and, for datasets that opt in, `@onememory-ai/consolidation`
(the M14 automatic lifecycle) — over committed golden datasets. It never mocks the store, the
extractor, the search engine or the consolidation passes. It runs offline and deterministically:
no embedder, no model router, no network (AGENTS.md rule 4).

## Layout

```text
benchmarks/
├── datasets/golden/   # committed JSON fixtures (backlog M11.1), Zod-validated
├── eval/              # the harness package (@onememory-ai/benchmarks)
│   └── src/
│       ├── dataset.ts  # schemas + loader
│       ├── runtime.ts  # composes the real packages into one embedded runtime
│       ├── metrics.ts  # pure metric math
│       ├── harness.ts  # run datasets → aggregate metrics
│       ├── gates.ts    # thresholds + gate evaluation
│       ├── report.ts   # markdown rendering
│       └── cli.ts      # bench:run
└── results/           # committed baseline (baseline.json + baseline.md)
```

## Run it

```bash
# from the repository root
bun run --cwd benchmarks/eval bench:run          # writes benchmarks/results/baseline.{json,md}
bun run --cwd benchmarks/eval bench:run --json-only
bun run --cwd benchmarks/eval typecheck
bun test benchmarks/eval                          # the gate test (see below)
```

`.github/workflows/ci.yaml` runs `bun test` on every push to `main` and every pull request, so the
gate test in `src/harness.test.ts` re-checks the thresholds on every push. `bench:run` exits non-zero
when a gate fails, so it is also usable directly as a CI step (e.g. from a scheduled nightly job that
refreshes `benchmarks/results/`).

## Metrics

| Metric | Source | Gated |
| --- | --- | :---: |
| retrieval precision@5 / recall@5, MRR | ADR-0004, `docs/architecture/retrieval.md` §1 | yes |
| tokens-per-answer, budget compliance | `docs/architecture/retrieval.md` §7 | yes |
| pollution (cross-project top-1, declared-distractor leakage) | ADR-0004 consequences; `memory-model.md` §2/§8 | yes |
| temporal accuracy (current / point-in-time / history) | `memory-model.md` §4–§5, `retrieval.md` §3 | yes |
| contradiction accuracy | `memory-model.md` §9 authority order | yes (post-M14) |
| consolidation quality | `memory-model.md` §9 | yes (post-M14) |

Contradiction accuracy and consolidation quality were gated when M14 (automatic contradiction
resolution + consolidation) merged: datasets opt in via `consolidation_pass`, so their
contradiction groups measure the automatic authority resolution (explicit > decision > newer >
confidence; a full tie marks both sides disputed) instead of declared supersessions. Both gates
are set from the measured post-M14 offline baseline, and both baselines are honest but bounded:

- **contradiction accuracy** 0.8333 (5/6 groups): the attribute-template heuristic cannot detect
  cross-phrasing contradictions (the dataset carries one deliberately), so the gate tolerates
  exactly the measured miss (threshold 0.8). Raising the metric needs the M14 follow-up LLM
  conflict detector — the gate then rises with a fresh baseline. That detector now ships
  (`packages/consolidation/src/conflict.ts`): when the router has a `conflict` route, semantic
  proximity supplies cross-phrasing candidates and the model adjudicates them, so the
  PostgreSQL/pgvector-vs-MySQL miss resolves. The gate is unchanged because the benchmark runs
  the offline default (no `conflict` route) and stays byte-identical; the tier is measured only
  when a `conflict` route is wired.
- **consolidation quality** 0.3333: the offline default wires no embedder, so the vector-gated
  passes (episodic→semantic derivation, near-duplicate merge) skip with recorded warnings and
  only ingest-time exact dedupe collapses repeats (threshold 0.3). The paraphrase pair in
  `consolidation-repeats` documents that ceiling.

## Gates

Thresholds are derived from the committed baseline with documented headroom (see
`benchmarks/results/baseline.md` and `src/gates.ts`). Temporal accuracy, token-budget compliance and
cross-project top-1 are correctness invariants (thresholds 1.0 / 1.0 / 0.0); retrieval
precision/recall and declared-distractor leakage carry ~0.10 headroom; the two post-M14 gates
(contradiction accuracy ≥ 0.8, consolidation quality ≥ 0.3) sit one 0.05 step below their measured
baselines, so any single passing group regressing (4/6 = 0.6667) fails the gate.

## Adding a dataset

Add a `*.json` file to `benchmarks/datasets/golden/`. Expected memories are referenced by a stable
`fact` key with a matcher (never by generated uuid). The loader rejects dangling references, and the
harness fails loudly when a fact key stops resolving to exactly one extracted memory, so a stale
fixture cannot silently shrink the benchmark. See any committed dataset for the shape.

Datasets that should exercise the M14 automatic lifecycle (contradiction groups resolving by
authority, decay) opt in with `"consolidation_pass": {}`; the pass runs after extraction and any
declared supersessions, with the dataset's deterministic clock. Datasets without the field keep the
declared-supersession-only behavior. Note the offline default wires no embedder: the vector-gated
passes (derivation, near-duplicate merge) always skip with recorded warnings.
