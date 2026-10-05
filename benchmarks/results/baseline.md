# onememory benchmark baseline

Generated: 2026-10-05T11:36:54.437Z

Runtime: embedded PGlite · no embedder (lexical + graph default) · heuristic extraction (no-LLM) · default max_tokens 800

Outbound network attempts during the run: 0 — local-first invariant (AGENTS.md rule 4).

## Gated metrics

| Metric | Value | Gate | Direction | Result |
| --- | ---: | ---: | :---: | :---: |
| temporal_accuracy | 1 | 1 | min | pass |
| retrieval_precision_at_k | 0.7963 | 0.7 | min | pass |
| retrieval_recall_at_k | 1 | 0.9 | min | pass |
| token_budget_compliance | 1 | 1 | min | pass |
| cross_project_top1_rate | 0 | 0 | max | pass |
| irrelevant_leakage_rate | 0.1111 | 0.2 | max | pass |
| contradiction_accuracy | 0.8333 | 0.8 | min | pass |
| consolidation_quality | 0.3333 | 0.3 | min | pass |

Overall: **PASS**

## Full metrics

- retrieval: precision@5 0.7963, recall@5 1, precision(full) 0.7963, recall(full) 1, MRR 0.8333 over 9 queries
- tokens: budget compliance 100.0%, mean 23.13, p95 54, max 54, mean tokens/expected-fact 21.2
- pollution: cross-project top-1 0.0%, cross-project leakage 6.3% (2/32 returned), declared-distractor leakage 11.1%
- temporal: accuracy 100.0% (5/5) — current 1/1, point-in-time 3/3, history 1/1
- contradiction: accuracy 83.3% (5/6), authority top-1 3, silent conflicts 1
- consolidation: quality 33.3%, fully consolidated 2/3

## Datasets

| Dataset | Memories | Superseded | Extraction inserted | Queries |
| --- | ---: | ---: | ---: | ---: |
| consolidation-repeats | 5 | 0 | 5 | 3 |
| contradictions | 12 | 0 | 12 | 7 |
| pollution-cross-project | 3 | 0 | 3 | 3 |
| retrieval-precision | 6 | 0 | 6 | 5 |
| temporal-node-versions | 3 | 2 | 3 | 5 |

## Automatic consolidation pass (M14, dataset opt-in)

| Dataset | Pairs | Resolved | Disputed | Merged | Derived | Archived |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| consolidation-repeats | 0 | 0 | 0 | 0 | 0 | 0 |
| contradictions | 5 | 4 | 1 | 0 | 0 | 0 |

Offline default: no embedder is wired, so the vector-gated passes (episodic→semantic derivation, near-duplicate merge) skip with recorded warnings — contradiction resolution and decay are the passes with an effect in this baseline.

## Scenario coverage (backlog M11.1)

- **contradictory** (12): contradictions/postgres-decision, contradictions/mysql-decision, contradictions/gateway-port-explicit, contradictions/gateway-port-decision, contradictions/port-standard-decision, contradictions/port-standard-semantic, contradictions/pool-cap-20, contradictions/pool-cap-50, contradictions/retention-30, contradictions/retention-90, contradictions/rate-limit-100, contradictions/rate-limit-1000
- **cross-project** (2): pollution-cross-project/beta-mysql, pollution-cross-project/global-tabs
- **failure-solution** (1): retrieval-precision/module-resolution-failure
- **other** (1): retrieval-precision/test-runner-preference
- **outdated** (3): temporal-node-versions/node-20, temporal-node-versions/node-22, temporal-node-versions/node-24
- **procedural** (2): retrieval-precision/ci-order-preference, retrieval-precision/terraform-procedure
- **project-scoped** (2): pollution-cross-project/alpha-postgres, retrieval-precision/database-decision
- **repeated** (6): consolidation-repeats/postgres-repeat-a, consolidation-repeats/postgres-repeat-b, consolidation-repeats/redis-decision-a, consolidation-repeats/redis-decision-b, consolidation-repeats/failure-repeat-a, consolidation-repeats/failure-repeat-b
