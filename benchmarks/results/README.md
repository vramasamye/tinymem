# Committed benchmark results

Every metric the harness measures is published here in two shapes:

- `baseline.{json,md}` — the full report: per-dataset runs, every metric, every gate check. Regenerated
  wholesale by `bench:run`; its `metrics` + `gates` blocks are the diffable drift signal.
- `<metric>.<iso-date>.json` — one dated file per M11b-quality metric family
  (`retrieval-quality`, `token-efficiency`, `memory-pollution`). The date stamp is the run's UTC
  date; the newest stamp per metric is the current baseline, older stamps are history. Per-run
  uuids never appear in committed results — findings identify memories by content prefix.

## The metric files

### `retrieval-quality.<date>.json` — per-query-type precision/recall

```jsonc
{
  "schema_version": "1",
  "metric": "retrieval_quality",
  "generated_at": "<iso>",
  "engine": { "profile": "embedded", "embedder": "…", "extraction": "…" },
  "runs": 1,                    // runs the estimate pools over (see "Fixed N runs")
  "k": 5,
  "by_type": [
    {
      "query_type": "procedural | decision | failure",
      "queries_per_run": 5,
      "precision_at_k": { "mean": 0.69, "ci95_low": 0.3176, "ci95_high": 1, "samples": 5 },
      "recall_at_k":    { "mean": 1,    "ci95_low": 1,     "ci95_high": 1, "samples": 5 }
    }
  ],
  "gates": [ /* the per-type gate checks from the run */ ]
}
```

`precision@k = |expected ∩ top-k| / |top-k|` and `recall@k = |expected ∩ top-k| / |expected|` — the
same per-query formulas the aggregate `retrieval` metric uses. Estimates pool one observation per
(run, query); the interval is the normal approximation `mean ± z·σ/√n` clamped to [0, 1].

### `token-efficiency.<date>.json` — budget compliance + the oracle gap

```jsonc
{
  "metric": "token_efficiency",
  "budget_compliance": 1,                     // fraction of typed queries with used ≤ budget
  "by_type": [ { "query_type": "…", "queries": 5, "budget_compliance": 1,
                 "oracle_gap": 2.76, "oracle_gap_when_satisfied": 2.76 } ],
  "oracle_gap_mean": 2.1418,
  "oracle_gap_max": 6.8,
  "oracle_gap_mean_when_satisfied": 2.1418,   // the GATED value
  "gates": [ /* token_* checks */ ]
}
```

The oracle is the token cost of the packer's most compact representation of exactly the golden
answer set: `Σ estimateTokens(deriveLabel(title, content))` over the expected facts, computed with
the engine's own estimator (`@onememory-ai/core`) and label derivation (`@onememory-ai/retrieval`) — the
same path the titles-only overflow line uses. `oracle_gap = used / oracle_min_tokens`; 1.0 means
the response was exactly the golden answer at its tightest packing. The dataset files carry the
committed oracle annotation (`oracle_min_tokens` per typed query); the harness recomputes it on
every run and fails loudly on drift. The gated mean covers only recall-satisfied queries — a
recall miss returns fewer tokens and must not fake efficiency.

### `memory-pollution.<date>.json` — stale / duplicate / unresolved counts

```jsonc
{
  "metric": "memory_pollution",
  "stale_cited": {
    "window_days": 30, "count": 1,
    "memories": [ { "label": "Version: Node 18", "status": "archived",
                    "last_accessed_at": "<iso>", "access_count": 1 } ]
  },
  "duplicates": {
    "cosine_threshold": 0.97, "count": 1,
    "pairs": [ { "a": "<label>", "b": "<label>", "type": "procedural", "cosine": 1 } ]
  },
  "unresolved_contradictions": {
    "count": 1,
    "memories": [ { "label": "<label>", "status": "active", "expected_mark": "superseded" } ]
  },
  "gates": [ /* stale_cited_memories, duplicate_surfaced_pairs, unresolved_contradicted_memories */ ]
}
```

- **stale** — `status = 'archived'` while `last_accessed_at` is within `window_days` (30) of the
  dataset clock. Decay archives on prominence alone; a point-in-time probe that still serves the
  memory afterwards REINFORCES it, which is exactly the archive-vs-citation tension the count
  surfaces.
- **duplicates** — two memories that both surfaced in retrieval, same type and same project, with
  cosine ≥ 0.97 over deterministic local vectors (lowercased character-trigram term counts via the
  repository's `cosineSimilarity` — the offline proxy for the embedder cosine; same-content
  memories cannot exist because ingest dedupes on content hash). This mirrors the M14 near-duplicate
  merge gate's scope rule and threshold.
- **unresolved contradictions** — golden-declared contradiction sides whose post-run status is
  neither `superseded` (resolved) nor `disputed` (full tie). Ground truth comes from the declared
  groups: "these two contradict" is semantic knowledge the engine may not have detected.

Counts at or below the gate ceilings pass; **a count below the ceiling is an improvement** (the
fixtures demonstrate detection, so the ceiling is the honest fixture count, not a target).

## CI gating logic

The gate evaluation lives in `benchmarks/eval/src/gates.ts` (`DEFAULT_GATE_THRESHOLDS`) and runs in
two places:

1. **Every push / PR** — `.github/workflows/ci.yaml` runs `bun test`, which includes
   `benchmarks/eval/src/harness.test.ts` (the full harness over all golden datasets; all 21 gates
   must pass) and `benchmarks/eval/src/metrics/quality-gate.test.ts` (the fixed-N-run per-type
   estimates, the oracle-gap record, and the pollution fixtures).
2. **On demand / nightly** — `bun run --cwd benchmarks/eval bench:run` re-measures and rewrites
   these files; it exits non-zero when any gate fails, so a failing threshold also blocks a
   results-refresh job.

### Thresholds and headroom (first measured baseline, 2026-10-06)

| Gate | Measured | Threshold | Direction | Headroom rationale |
| --- | ---: | ---: | :---: | --- |
| retrieval_precision_procedural | 0.69 | 0.6 | min | one step below; the broad `ci-order` query matches sibling procedures |
| retrieval_precision_decision | 1.0 | 0.9 | min | clean corpus; any single miss drops a query to 0 → mean 0.8 < 0.9 |
| retrieval_precision_failure | 0.4444 | 0.4 | min | failure queries structurally co-surface sibling failures (known-failures shortcut) and the failing commands' recurring procedurals |
| retrieval_recall_{procedural,decision,failure} | 1.0 | 0.9 | min | any single query losing its expected fact fails |
| token_budget_compliance_{procedural,decision,failure} | 1.0 | 1.0 | min | the packer's hard invariant (`used ≤ budget` by construction) |
| token_oracle_gap_mean | 2.1418 | 2.5 | max | decision queries sit near the oracle (1.0267); procedural/failure carry co-surfaced siblings (2.76 / 2.97) |
| stale_cited_memories | 1 | 1 | max | the deliberate `pollution-quality` fixture (decay archived a point-in-time-cited version fact) |
| duplicate_surfaced_pairs | 1 | 1 | max | the deliberate case-variant pair (the offline merge pass is vector-gated; with an embedder wired this should drop to 0) |
| unresolved_contradicted_memories | 1 | 1 | max | the cross-phrasing pair the template heuristic cannot detect (M14 follow-up: LLM conflict detector) |

The eight pre-M11b gates (temporal accuracy, aggregate precision/recall, aggregate budget
compliance, cross-project top-1, distractor leakage, contradiction accuracy, consolidation
quality) are unchanged and still enforced — see `baseline.md` for their values. The aggregate
retrieval precision drifted from 0.7963 to 0.7479 because the new typed queries widened the
aggregate query set; its gate (0.7) still holds with headroom.

### Honest notes

- **Fixed N runs and determinism.** The offline engine is deterministic, so N runs produce
  byte-identical per-query values — the quality gate pins that (3 runs, identical records) and
  pools the observations. The interval's width is driven by the query sample, not run variance;
  the same math captures real variance the moment a non-deterministic tier (embedder, LLM router)
  is wired behind the model router.
- **Wide intervals are honest.** The fixed query sets are small (3–5 per type), so the procedural
  95% interval is wide ([0.3176, 1] at mean 0.69). The gates are on the point estimates; the
  intervals communicate sample uncertainty, and growing a type's query set tightens them.
- **Refreshing.** Run `bun run --cwd benchmarks/eval bench:run`, commit the dated files it writes,
  and — only with a conscious decision recorded in the commit message — adjust
  `DEFAULT_GATE_THRESHOLDS`. A threshold may only rise or tighten with a fresh measured baseline
  documenting why.
