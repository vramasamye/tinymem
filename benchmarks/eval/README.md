# onememory benchmarks

Memory-quality evaluation harness (backlog **M11**; the originating "spec §25" is not present as a
file in this repository, so every metric below cites the architecture doc it is derived from).

The harness drives the **real engine** — `@onememory/storage` (embedded PGlite), `@onememory/extraction`
(heuristic, no-LLM) and `@onememory/retrieval` — over committed golden datasets. It never mocks the
store, the extractor or the search engine. It runs offline and deterministically: no embedder, no
model router, no network (AGENTS.md rule 4).

## Layout

```text
benchmarks/
├── datasets/golden/   # committed JSON fixtures (backlog M11.1), Zod-validated
├── eval/              # the harness package (@onememory/benchmarks)
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
| contradiction accuracy | `memory-model.md` §9 authority order | reported (M14) |
| consolidation quality | `memory-model.md` §9 | reported (M14) |

Contradiction accuracy and consolidation quality depend on **M14** (automatic contradiction
resolution + consolidation). They are measured and published now; the coordinator flips those two
gates on after M14 merges. The gated subset is exactly what the engine supports end-to-end today.

## Gates

Thresholds are derived from the committed baseline with documented headroom (see
`benchmarks/results/baseline.md` and `src/gates.ts`). Temporal accuracy, token-budget compliance and
cross-project top-1 are correctness invariants (thresholds 1.0 / 1.0 / 0.0); retrieval
precision/recall and declared-distractor leakage carry ~0.10 headroom.

## Adding a dataset

Add a `*.json` file to `benchmarks/datasets/golden/`. Expected memories are referenced by a stable
`fact` key with a matcher (never by generated uuid). The loader rejects dangling references, and the
harness fails loudly when a fact key stops resolving to exactly one extracted memory, so a stale
fixture cannot silently shrink the benchmark. See any committed dataset for the shape.
