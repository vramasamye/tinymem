# Phased implementation plan

Status: draft for architecture review · Implements spec §35–§36
Companion: `docs/backlog/issues.md` (issue-ready entries, one section per mission/branch)

Rules of execution (from AGENTS.md): one mission = one branch = one bounded scope; tests with
every core component; no placeholder implementations; ADRs before code. Phase N+1 does not start
until Phase N's definition of done is verified. Missions within a phase run in **parallel** where
their file sets don't overlap.

---

## Phase 0 — Architecture review (this mission, nearly complete)

Deliverables: research (`docs/research/`), ADRs 0001–0011, memory model, event/memory schemas,
database schema, retrieval design, repo structure, phased plan + backlog, risks.
**Gate: user approves the architecture review. No production code before this gate.**

## Phase 1 — Core (target: first usable system)

Goal: Claude Code and Codex can store and retrieve memories, 100% locally, offline.

| Mission | Branch | Scope | Key deps |
|---|---|---|---|
| M1 Core storage & schema | `mission/1-core-storage` | `packages/core` (Zod schemas, model, ports), `packages/storage` (PGlite + Postgres, migrations, repositories, jobs) | ADR-0002, ADR-0003 |
| M2 Retrieval engine | `mission/2-retrieval` | `packages/retrieval`: lexical + vector + graph channels, RRF fusion, weighted scoring, token packing, explain | M1 (ports only) |
| M3 Memory extraction | `mission/3-extraction` | `packages/extraction` (heuristic extractor + classifier + future-value gate), `packages/llm` model router, `packages/embeddings` (transformers.js local, ollama, openai-compatible) | M1 |
| M13 CLI + API | `mission/13-cli-api` | `apps/cli` (`init serve doctor search remember forget inspect stats`), `apps/api` (REST `/v1/*`), `packages/config` | M1, M2 |
| M5 MCP server | `mission/5-mcp` | `packages/mcp`: stdio (`serveStdio`) + stateless Streamable HTTP, ADR-0010 surface (8-tool default exposure covering all 11 capabilities), progressive disclosure, session context assembly | M1, M2 |
| M6 Claude Code adapter | `mission/6-claude` | `packages/adapters/claude`: hooks → events, `.mcp.json` scaffold, skills wiring, compact-context injection | M5, M13 |
| M7 Codex adapter | `mission/7-codex` | `packages/adapters/codex`: config.toml MCP, AGENTS.md bootstrap, session capture | M5, M13 |
| M12 Security core | `mission/12-security` | `packages/security`: secret detection/redaction at ingest, path exclusions, privacy mode | M1 (ingest path) |

Definition of done (Phase 1):
- [x] `onemem init` scaffolds config + embedded storage and, with explicit consent, detects/configures Claude Code + Codex. Verified from a fresh project with both flags; all project-scoped files were created.
- [x] `onemem doctor` validates storage, local-mode guard, and wired runtimes. Fresh-project and live-daemon checks reported both runtimes `pass`, the network guard `pass` with 0 attempts, and no failures. The default profile has no embedder, so doctor honestly warns that vector search is unavailable.
- [x] Roundtrip: explicit CLI remember → token-budgeted CLI search returned the memory with provenance and explain; MCP `memory_store` without `project_id` → MCP search and CLI search returned the same project memory. Search stayed within a 120-token budget.
- [x] `bun test` green; integration tests pass on BOTH embedded (PGlite) and Postgres targets. Full repo suite: 878 pass, 0 fail, 16 environment-gated skips; Postgres 17 storage parity: 35 pass, 0 fail.
- [x] Combined e2e: `apps/api/src/runtime/extraction-temporal.test.ts` ingests the golden transcript, extracts decision/failure memories with source and evidence, explicitly supersedes extracted Node 20 with an extracted Node 22 candidate through the audited storage transaction, and verifies current, point-in-time, and historical retrieval. Automatic contradiction detection/authority resolution remains M14 scope.
- [x] 100% local: default-profile remember/search passed with the enforced network guard recording 0 calls; the taint integration test also asserts zero outbound calls during the real redact/ingest/query path.

**Gate status:** Phase 1 is complete against the criteria above. Its temporal acceptance uses explicit supersession; automatic contradiction detection, authority resolution, and consolidation remain Phase 3 / M14 work.

## Phase 2 — Coding memory

| Mission | Branch | Scope |
|---|---|---|
| M4 Git/code memory | `mission/4-codememory` | `packages/codememory`: repository fingerprints (`last_ingested_commit` checkpoint), file_fingerprints (blob SHAs), drift detection (llm-wiki-loop-style, rename-aware), tree-sitter symbol extraction, `memory_code_refs` staleness, minimal re-index, architecture digest |
| M3b Decision/failure capture | (extends `mission/3-extraction`) | decision extraction (alternatives/rationale), failure signature extraction from error/terminal/test events |

Definition of done (Phase 2):
- Change one file → only memories referencing it are marked `stale`; unchanged files cost zero re-index tokens; rename moves references via git rename detection.
- "How does authentication work?" returns procedures with code refs; project digest answers "what is this project" in < 300 tokens.
- Session lifecycle: session start injects compact context; session end sweeps working memory with promotion filter.

**Status (2026-10-06):** session-end promotion + sweep shipped (`mission/14a-session-sweep`, merged
`642787e`; semantics synced in `docs/architecture/memory-model.md` §10). Drift marking, the
zero-token oracle, rename retargeting, and code-symbol staleness shipped with M4a–4e; re-index
orchestration (drift-scan scheduling, drifted-path-only reindex) and the <300-token architecture
digest shipped with `mission/4f-reindex-digest` (merged `56d67f2`). M4g added an end-to-end
acceptance test (`docs/plan/mission-reports/mission-4g-procedures-acceptance.md`) that proves
the real pipeline returns a procedural answer and stores code refs against real fixture blobs.
M4g2 (`mission/4g2-retrieval-code-refs`, merged 2026-10-06, mission report
`docs/plan/mission-reports/mission-4g2-retrieval-code-refs.md`) closed the residual blocker:
`MemorySearchResponse` now carries a non-optional `codeRefs: CodeRefEntry[]` on every result,
hydrated through a single batched storage query. The
"How does authentication work? → procedures with code refs" DoD line is now
demonstrated end to end; only the heuristic procedure extractor (M4g item 2) remains open as
non-blocking backlog scope.

## Phase 3 — Intelligent memory

| Mission | Branch | Scope |
|---|---|---|
| M14 Consolidation | `mission/14-consolidation` | episodic→semantic derivation, near-dup merges, contradiction detection + authority resolution, temporal supersession end-to-end, decay/archive, project digest rollups |
| M11a Benchmarks v1 | `mission/11-benchmarks` | golden dataset + harness: temporal accuracy, contradiction accuracy, consolidation quality (§25 subset), CI regression gates |

Definition of done (Phase 3): Node 20→22→24 scenario answers current vs. historical correctly;
contradictions become `disputed` or supersede with authority rules; repeated facts consolidate to
one semantic memory; benchmark thresholds enforced in CI.

**Status (2026-10-05):** Phase 3 DoD met. M11a shipped the golden datasets, metrics harness, and
CI-enforced thresholds (`mission/11-benchmarks`). M14 shipped the consolidation core —
authority-ordered contradiction resolution with audited supersession (full ties `disputed`),
episodic→semantic derivation with `derived_from` edges, keeper-gated near-dup merge, and
decay/archive — plus the Node 20→22→24 anchor scenario (`mission/14-consolidation`, merged
`bc8bf24`; semantics synced in `docs/architecture/memory-model.md` §9). M11b (`mission/11-benchmarks-consolidation-gates`,
merged `e0f504e`) closed the M11a-raised backlog item 5: the harness now runs real consolidation
for opted-in datasets, and both dependent metrics are CI-gated
(`contradiction_accuracy ≥ 0.8`, measured 0.8333, 5/6 groups;
`consolidation_quality ≥ 0.3`, measured 0.3333 — the cross-phrasing
detector miss is documented and tracked as a follow-up). M14.5 (`mission/14e-digest-rollup`, merged 2026-10-06) and
M14.6 (`mission/14f-events-compaction`, fast-forwarded onto main 2026-10-06) closed the two
Phase 3 follow-ups: `onemem digest` produces a token-budgeted `memory_project_context`
(default 750) and `onemem compact` preserves the audit trail + sources while honoring the
retention window. All Phase 3 backlog items are now closed; only the M14-onward items flagged
as P3 (cross-phrasing detector miss, config wiring) remain as open scope.

## Phase 4 — Universal agents

| Mission | Branch | Scope |
|---|---|---|
| M8 Cursor adapter | `mission/8-cursor` | `.cursor/mcp.json`, rules bootstrap |
| M9 Pi + OpenCode adapters | `mission/9-pi-opencode` | pi extension/config, opencode.json MCP + skills |
| M5b MCP hardening | (extends M5) | Streamable HTTP + OAuth for server mode; adapter conformance suite (same events, same tools, same results) |

Definition of done (Phase 4): all five runtimes pass the conformance suite; `onemem doctor`
auto-configures any of them in a fresh project.

**Status (2026-10-06):** Phase 4 complete and DoD met.

- M6 (Claude Code adapter, `mission/6-claude`, merged 2024-era) — Phase 1.
- M7 (Codex adapter, `mission/7-codex`, merged Phase 1).
- M8 (`mission/8-cursor`, merged `2dd3c9f`) — Cursor adapter; see `mission-8-cursor.md`.
- M9 (`mission/9-pi-opencode`, merged `d95efc4`) — Pi extension adapter (`@onememory/adapter-pi`,
  96 tests) + OpenCode plugin adapter (`@onememory/adapter-opencode`, 147 tests). Both byte-identical
  to the Claude conformance baseline. Mission report: `mission-9-pi-opencode.md`.
- M5b (`mission/5b-mcp-hardening`, fast-forwarded onto main 2026-10-06) — Streamable HTTP
  transport (`packages/mcp/src/streamable-http/`) + OAuth 2.1 PKCE loopback
  (`packages/mcp/src/oauth/`) + 5-runtime conformance extension to streamable-http form +
  zero-outbound network-guard assertion in streamable-http startup. 131 mcp tests pass / 0
  fail. Mission report: `mission-5b-mcp-hardening.md`.

All five adapters (Claude, Cursor, Codex, Pi, OpenCode) pass conformance in both stdio and
streamable-http forms byte-for-byte against the canonical 10-fact session. `onemem doctor`
auto-detects each adapter in a fresh project; the shared pipeline at
`benchmarks/eval/src/adapter-conformance/{scenario,pipeline}.ts` is the integration substrate
that M8 / M9 / M5b all reuse. Phase 4 DoD met.

## Phase 5 — Self improvement

| Mission | Branch | Scope |
|---|---|---|
| M15 Skill generation | `mission/15-skills` | failure recurrence matching, verified solution patterns → SKILL.md candidates, review flow (`onemem skills review`), skill serving via MCP + filesystem for Claude Code/OpenCode |
| M11b Full memory-quality eval | (extends M11) | retrieval precision/recall, token efficiency, memory pollution; published results in `benchmarks/results/` |

Definition of done (Phase 5): repeated failure → verified skill → consumable `SKILL.md`; quality
dashboard data (duplicates/stale/conflicts/unused/low-confidence) computed.

**Status (2026-10-06):** Phase 5 complete.

- M11b-quality (`mission/11b-memory-quality`, merged to main 2026-10-06) — three new
  metric families in the benchmarks harness: retrieval precision/recall (procedural /
  decision / failure queries with 95% CIs over N=3 deterministic runs), token efficiency
  (budget packer invariant + oracle gap per query), memory pollution (stale-cited /
  duplicate pairs / unresolved contradicted). 13 new CI gates; first-measured baselines
  recorded in `benchmarks/results/*.2026-10-06.json`. Mission report:
  `mission-11b-memory-quality.md`.
- M15 (`mission/15-skills`, fast-forwarded onto main 2026-10-06) — `SkillStore` port,
  signature recurrence matcher, SKILL.md renderer, review queue, MCP `memory_skills`
  surface (token-budgeted at 500), CLI `onemem skills <generate|list|review|promote>`
  flow with audit-trail for promotion via `memory_events`. CI gate at
  `benchmarks/eval/src/skills/` against the golden failure→fix dataset. Mission report:
  `mission-15-skills.md`.

Phase 5 DoD met: repeated failures generate reviewed/verified SKILL.md candidates; the
quality-dashboard data is wired through M11b-quality's pollution counters and M10's
dashboard panel.

## Phase 6 — UI

| Mission | Branch | Scope |
|---|---|---|
| M10 Web UI | `mission/10-web-ui` | `apps/web`: memories search/filter, timeline, graph view, projects, decisions, failures, skills, sources/provenance, quality dashboard |

Definition of done (Phase 6): a developer can visually verify every claim the engine makes about
a memory (source, evidence, status, history, score). Compose profile `--profile web`.

**Status (2026-10-06):** Phase 6 closed. M10 (`mission/10-web-ui`, merged to main)
landed the `apps/web` Vite + React memory explorer (12 source files, 73 tests pass /
0 fail). Every claim on screen flows from `apps/api` REST endpoints — no
client-side truth. Mission report: `docs/plan/mission-reports/mission-10-web-ui.md`.
The DoD's `--profile web` compose profile landed afterwards (2026-10-06):
`docker compose --profile web up` brings up Postgres + the daemon + the explorer.

## Post-1.0 (explicitly out of scope until 1.0 ships, no open-core gating)

- SaaS/multi-tenant mode: orgs migration, API keys, RLS, hosted control plane (same engine,
  same schema — ADR-0011).
- IDE plugins (VS Code, JetBrains), additional embedding/reranker providers, doc-site polish.

## Sequencing & parallelism

```text
P0 ──▶ M1 ──┬──▶ M2 ──┬──▶ M13 ──▶ M6, M7
            ├──▶ M3 ──┤
            └──▶ M12 ─┴──▶ M5
P1 done ──▶ M4 (+M3b) ──▶ P2 done ──▶ M14, M11a ──▶ M8, M9, M5b ──▶ M15, M11b ──▶ M10
```

Missions inside a phase are file-disjoint by construction (separate packages), so they run as
parallel agent branches; M13/M5 integrate only via public SDK APIs landed by M1/M2.
