# onememory benchmark baseline

Generated: 2026-10-06T06:45:15.277Z

Runtime: embedded PGlite · no embedder (lexical + graph default) · heuristic extraction (no-LLM) · default max_tokens 800

Outbound network attempts during the run: 0 — local-first invariant (AGENTS.md rule 4).

## Gated metrics

| Metric | Value | Gate | Direction | Result |
| --- | ---: | ---: | :---: | :---: |
| temporal_accuracy | 1 | 1 | min | pass |
| retrieval_precision_at_k | 0.7479 | 0.7 | min | pass |
| retrieval_recall_at_k | 1 | 0.9 | min | pass |
| token_budget_compliance | 1 | 1 | min | pass |
| cross_project_top1_rate | 0 | 0 | max | pass |
| irrelevant_leakage_rate | 0.1111 | 0.2 | max | pass |
| contradiction_accuracy | 0.8333 | 0.8 | min | pass |
| consolidation_quality | 0.3333 | 0.3 | min | pass |
| retrieval_precision_procedural | 0.69 | 0.6 | min | pass |
| retrieval_recall_procedural | 1 | 0.9 | min | pass |
| retrieval_precision_decision | 1 | 0.9 | min | pass |
| retrieval_recall_decision | 1 | 0.9 | min | pass |
| retrieval_precision_failure | 0.4444 | 0.4 | min | pass |
| retrieval_recall_failure | 1 | 0.9 | min | pass |
| token_budget_compliance_procedural | 1 | 1 | min | pass |
| token_budget_compliance_decision | 1 | 1 | min | pass |
| token_budget_compliance_failure | 1 | 1 | min | pass |
| token_oracle_gap_mean | 2.1418 | 2.5 | max | pass |
| stale_cited_memories | 1 | 1 | max | pass |
| duplicate_surfaced_pairs | 1 | 1 | max | pass |
| unresolved_contradicted_memories | 1 | 1 | max | pass |

Overall: **PASS**

## Full metrics

- retrieval: precision@5 0.7479, recall@5 1, precision(full) 0.7479, recall(full) 1, MRR 0.8889 over 24 queries
- tokens: budget compliance 100.0%, mean 25.56, p95 61, max 68, mean tokens/expected-fact 24.04
- pollution: cross-project top-1 0.0%, cross-project leakage 3.1% (2/65 returned), declared-distractor leakage 11.1%
- temporal: accuracy 100.0% (6/6) — current 1/1, point-in-time 4/4, history 1/1
- contradiction: accuracy 83.3% (5/6), authority top-1 3, silent conflicts 1
- consolidation: quality 33.3%, fully consolidated 2/3
- procedural: precision@5 0.69 [0.3176, 1] (5 samples), recall@5 1 [1, 1] over 5 queries/run × 1 run(s)
- decision: precision@5 1 [1, 1] (5 samples), recall@5 1 [1, 1] over 5 queries/run × 1 run(s)
- failure: precision@5 0.4444 [0.3356, 0.5533] (3 samples), recall@5 1 [1, 1] over 3 queries/run × 1 run(s)
- token efficiency: typed budget compliance 100.0%, oracle gap mean 2.1418 (satisfied-only 2.1418, max 6.8) over 13 typed queries
- pollution audit: stale-cited 1 (window 30d), duplicate pairs 1 (cosine ≥ 0.97), unresolved contradicted 1

## Datasets

| Dataset | Memories | Superseded | Extraction inserted | Queries |
| --- | ---: | ---: | ---: | ---: |
| consolidation-repeats | 5 | 0 | 5 | 3 |
| contradictions | 12 | 0 | 12 | 7 |
| decision-queries | 5 | 0 | 5 | 5 |
| failure-queries | 6 | 0 | 6 | 3 |
| pollution-cross-project | 3 | 0 | 3 | 3 |
| pollution-quality | 4 | 0 | 4 | 3 |
| procedural-queries | 5 | 0 | 5 | 5 |
| retrieval-precision | 6 | 0 | 6 | 5 |
| temporal-node-versions | 3 | 2 | 3 | 5 |

## Automatic consolidation pass (M14, dataset opt-in)

| Dataset | Pairs | Resolved | Disputed | Merged | Derived | Archived |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| consolidation-repeats | 0 | 0 | 0 | 0 | 0 | 0 |
| contradictions | 5 | 4 | 1 | 0 | 0 | 0 |
| pollution-quality | 0 | 0 | 0 | 0 | 0 | 1 |

Offline default: no embedder is wired, so the vector-gated passes (episodic→semantic derivation, near-duplicate merge) skip with recorded warnings — contradiction resolution and decay are the passes with an effect in this baseline.

## Scenario coverage (backlog M11.1)

- **contradictory** (12): contradictions/postgres-decision, contradictions/mysql-decision, contradictions/gateway-port-explicit, contradictions/gateway-port-decision, contradictions/port-standard-decision, contradictions/port-standard-semantic, contradictions/pool-cap-20, contradictions/pool-cap-50, contradictions/retention-30, contradictions/retention-90, contradictions/rate-limit-100, contradictions/rate-limit-1000
- **cross-project** (2): pollution-cross-project/beta-mysql, pollution-cross-project/global-tabs
- **failure-solution** (4): failure-queries/module-failure, failure-queries/docker-port-failure, failure-queries/terraform-provider-failure, retrieval-precision/module-resolution-failure
- **other** (5): decision-queries/trunk-based-decision, decision-queries/release-cadence-decision, decision-queries/approvals-decision, decision-queries/api-versioning-decision, retrieval-precision/test-runner-preference
- **outdated** (4): pollution-quality/stale-node-18, temporal-node-versions/node-20, temporal-node-versions/node-22, temporal-node-versions/node-24
- **procedural** (8): pollution-quality/migrations-before-deploy, procedural-queries/install-first, procedural-queries/deploy-api, procedural-queries/fixtures-schema, procedural-queries/lint-commit, procedural-queries/icons-command, retrieval-precision/ci-order-preference, retrieval-precision/terraform-procedure
- **project-scoped** (3): decision-queries/database-decision, pollution-cross-project/alpha-postgres, retrieval-precision/database-decision
- **repeated** (8): consolidation-repeats/postgres-repeat-a, consolidation-repeats/postgres-repeat-b, consolidation-repeats/redis-decision-a, consolidation-repeats/redis-decision-b, consolidation-repeats/failure-repeat-a, consolidation-repeats/failure-repeat-b, pollution-quality/install-first-a, pollution-quality/install-first-b
