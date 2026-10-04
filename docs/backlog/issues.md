# Issue backlog (pre-GitHub)

Status: draft for architecture review · These map 1:1 to GitHub issues/milestones once the repo
is published (labels in brackets; `P<n>` = milestone). Branch names follow AGENTS.md mission
discipline. Every issue's acceptance criteria include tests — no placeholder implementations.

Milestones: `P1 Core`, `P2 Coding memory`, `P3 Intelligent memory`, `P4 Universal agents`,
`P5 Self improvement`, `P6 UI`.

---

## M1 — Core storage & schema [P1] [epic] [foundation]
Branch: `mission/1-core-storage` · Deps: ADR-0002, ADR-0003 · Package: `packages/core`, `packages/storage`

Issues:
1. **Zod schema library** — canonical event envelope, all event payloads, memory record, extraction
   result, retrieval request/response (mirror `event-memory-schemas.md`; exported types; strict
   validation; unknown-kind tolerance). AC: schema unit tests incl. malformed-envelope dead-letter path.
2. **Memory model + lifecycle ports** — memory types, status transitions with `memory_events` audit,
   scoring fields; `Store`, `Searcher`, `Embedder`, `Extractor`, `Reranker`, `EntityResolver`,
   `DriftWatcher`, `Redactor` interfaces. AC: unit tests for status transition rules + audit rows.
3. **Storage on PGlite** — embedded driver bootstrap, migrations, repositories, `jobs` table +
   worker loop. AC: integration test on PGlite; migration idempotency test.
4. **Storage on Postgres+pgvector** — same repositories, HNSW index, advisory-lock migrations,
   docker compose (`docker/compose.yaml`) with init script. AC: same integration suite green on
   Postgres (CI matrix `embedded`/`postgres`).
5. **GATE-1 resolution: pgvector-in-PGlite verification** — if unavailable: `float8[]` fallback
   behind `EmbeddingIndex` port + brute-force KNN benchmark (must stay <50ms p50 @ 10⁵ rows).
   AC: decision recorded in ADR-0002 appendix; benchmark checked in.

## M2 — Retrieval engine [P1] [epic] [performance]
Branch: `mission/2-retrieval` · Deps: M1 · Package: `packages/retrieval`

Issues:
1. Lexical channel (tsquery + ts_rank), entity/graph channel (bindings + 1–2 hop), vector channel
   via `Embedder` port. AC: per-channel unit tests with fixtures.
2. RRF fusion + weighted scoring with configurable weights; type-affinity matrix.
3. Token budget packer (summaries → content upgrades → titles-only overflow; never over budget,
   never mid-sentence truncation). AC: property test: `used ≤ budget` for random fixtures.
4. Explain assembly from scoring contributions. AC: golden explain output snapshot tests.
5. Degraded modes + `warnings` (no-vector, no-rerank). AC: tests assert degradation reported, not
   silent.
6. Query cache + embedding cache with write invalidation. AC: invalidation test.

## M3 — Memory extraction [P1] [epic] [ai]
Branch: `mission/3-extraction` · Deps: M1 · Packages: `packages/extraction`, `packages/llm`, `packages/embeddings`

Issues:
1. Model router (`packages/llm`): per-operation provider routing, OpenAI-compatible base URL,
   structured JSON output with schema-validated retries; no-provider → router unavailable, callers
   fall back. AC: fake-provider unit tests; retry-on-invalid-JSON test.
2. Embedding providers: local transformers.js (default model), ollama, openai-compatible
   (LM Studio/llama.cpp/vLLM); model registry + dim bookkeeping. AC: each provider behind `Embedder`
   fake in CI; real-model test optional env-gated.
3. Heuristic extractor (no LLM): preference/decision language patterns, error+resolution pairs,
   recurring commands, versions, stack names; future-value gate. AC: fixture transcripts → expected
   candidates.
4. LLM extractor (optional): batch prompt with schema output (spec §6 JSON), evidence span binding,
   `semantic_candidate` gating (never direct semantic). AC: fake-LLM tests + schema validation.
5. Classifier: type + subtype assignment, working-vs-durable routing.

## M4 — Git/code memory [P2] [epic]
Branch: `mission/4-codememory` · Deps: M1, M2 · Package: `packages/codememory`

Issues:
1. Repository registry + fingerprint checkpoint (`last_ingested_commit`), diff enumeration
   (`git diff --name-status -M last..HEAD`), rename handling.
2. `file_fingerprints` (blob SHA, committed/worktree tiers) + content-hash fallback outside git.
3. Drift oracle: zero-token freshness check (`onemem check` equivalent internal API); maps changed
   paths → `memory_code_refs` → marks affected memories `stale` (audit-logged).
4. Symbol extraction via tree-sitter (TS/JS/Python/Go/Rust first); `code_symbols` + span hashes.
5. Minimal re-index job: re-embed/re-extract only changed files' knowledge.
6. Architecture digest rollup (modules → responsibilities → entry points) under token budget.

## M5 — MCP server [P1] [epic] [protocol]
Branch: `mission/5-mcp` · Deps: M1, M2 · Package: `packages/mcp`

Issues:
1. stdio transport (`serveStdio`) implementing the ADR-0010 surface: 8 tools by default —
   `memory_search` (with `kind=` covering decisions/failures/skills), `memory_get`, `memory_store`
   (returns dedup outcome: new|merged|superseded), `memory_update` (revision-checked),
   `memory_delete`, `memory_forget`, `memory_related`, `memory_project_context`; the full
   11-tool exposure (`memory_decisions`, `memory_failures`, `memory_skills`) is a config profile.
   Progressive disclosure: search returns an ID-index with token estimates, `memory_get` returns
   full records; `outputSchema` + `structuredContent` everywhere; annotations (`destructiveHint`,
   `idempotentHint`); descriptions ≤ 2,048 chars (length-tested).
2. Streamable HTTP transport (server mode) with session management.
3. Compact-context session tool (`memory_project_context` ≤ 750 tokens default).
4. MCP conformance test suite (reused by every adapter, M6–M9).
5. (P4) OAuth 2.1 for hosted deployments.

## M13 — CLI + API [P1] [epic] [dx]
Branch: `mission/13-cli-api` · Deps: M1, M2 · Apps: `apps/cli`, `apps/api`

Issues:
1. CLI: `init` (scaffold + storage bootstrap + runtime detection), `doctor` (storage, embedding
   model, runtimes, docker, local-mode verification), `serve`, `search`, `remember`, `forget`,
   `inspect`, `stats`, `migrate`, `compact`, `consolidate`, `project context/decisions/failures`.
2. `npx onememory init` one-command UX incl. non-interactive mode.
3. REST API `/v1/*` (spec §20 surface) with OpenAPI generation + auth via API key in server mode.
4. `onemem doctor` detection matrix: Claude Code, Codex, Cursor, Pi, OpenCode, Ollama, Docker,
   Postgres; writes runtime configs with user consent flags.
5. Compose profiles: default (api+postgres), `--profile web`, `--profile ollama`.

## M6 — Claude Code adapter [P1] [epic] [integration]
Branch: `mission/6-claude` · Deps: M5, M13 · Package: `packages/adapters/claude`

Issues:
1. Hooks: SessionStart → context injection; Pre/PostToolUse → tool events; Stop/SessionEnd →
   session end + working-memory sweep; transcript → conversation events.
2. `.mcp.json` + `.claude/settings.json` scaffolding; skills directory wiring (read engine-generated
   skills).
3. Redaction before emit (never trust runtime transcripts to be clean).
4. Conformance suite green (M5.4).

## M7 — Codex adapter [P1] [integration]
Branch: `mission/7-codex` · Deps: M5, M13 · Package: `packages/adapters/codex`

Issues:
1. `~/.codex/config.toml` MCP registration; AGENTS.md bootstrap pointing at compact context.
2. Session capture → events; redaction; conformance suite green.

## M8 — Cursor adapter [P4] [integration]
Branch: `mission/8-cursor` · `.cursor/mcp.json` + rules; conformance green.

## M9 — Pi + OpenCode adapters [P4] [integration]
Branch: `mission/9-pi-opencode` · pi extension/config; opencode.json MCP + skills; conformance green.

## M10 — Web UI [P6] [epic] [ui]
Branch: `mission/10-web-ui` · Deps: REST API · App: `apps/web`

Issues: memories search/filter; timeline (status history via `memory_events`); graph view; projects;
decisions; failures; skills; sources/provenance drill-down; quality dashboard (duplicates, stale,
conflicts, unused, low-confidence). AC: every UI claim backed by API data, no client-side truth.

## M11 — Benchmarks & evaluation [P3] [epic] [quality]
Branch: `mission/11-benchmarks` · Dir: `benchmarks/`

Issues:
1. Golden dataset: repeated facts, contradictory facts, outdated facts (Node 20→22→24),
   project-specific vs cross-project, procedural knowledge, failure/solution pairs.
2. Metrics harness: retrieval precision/recall, token efficiency, pollution, temporal accuracy,
   contradiction accuracy, consolidation quality (spec §25). CI thresholds; results committed to
   `benchmarks/results/`; nightly drift report.

## M12 — Security [P1] [epic] [security]
Branch: `mission/12-security` · Package: `packages/security`

Issues:
1. Secret detection + redaction at ingest (api keys, passwords, tokens, private keys, connection
   strings); `.env`/key-file path exclusion defaults; configurable exclusions.
2. Redaction invariant test: secrets never in DB, logs, or prompts (taint tests).
3. Project isolation + user isolation at storage layer (scope enforcement tests).
4. Privacy mode (100% local): outbound-call gate asserting zero network in default config.
5. (P3) ACLs at memory level; (SaaS) org isolation via RLS.

## M14 — Consolidation & intelligence [P3] [epic]
Branch: `mission/14-consolidation` · Deps: M3, M4 · Package: `packages/consolidation`

Issues:
1. Episodic→semantic derivation (cluster ≥3, same project+entity, no contradictions; LLM merge or
   templated fallback) with `derived_from` edges.
2. Near-duplicate merge (≥0.97 cosine, same scope) + evidence union.
3. Contradiction detection + authority resolution (explicit > decision > newer > confidence; tie →
   `disputed`) + supersession (`valid_until`, `superseded_by`).
4. Decay/archive scheduler (prominence formula; decisions/verified procedures decay-resistant).
5. Project digest rollup + working-memory promotion sweep.
6. Events compaction (summarize → `sources`, purge raw payload after retention window).

## M15 — Skill generation [P5] [epic]
Branch: `mission/15-skills` · Deps: M14 · Package: `packages/consolidation` (skills module)

Issues:
1. Failure signature recurrence matching; verified-solution pattern extraction.
2. SKILL.md generation (when-to-use, prerequisites, procedure, commands, validation, known failure
   modes) — candidate by default, `onemem skills review` promotion flow.
3. Skill serving: MCP `memory_skills` + filesystem for runtime-native skill loading.
4. Usage tracking (success_rate) from follow-up session signals.

## M16 — Config & doctor [P1] [dx]
Branch: `mission/16-config-doctor` · Package: `packages/config`

Issues:
1. `onememory.config.yaml` discovery + Zod validation (embedding/extraction/reranker providers,
   budgets, decay, privacy mode, exclusions).
2. `onemem doctor` checks as a shared library (used by CLI + adapters + MCP).
3. Profile defaults: `local` (no external calls), `hybrid` (optional hosted LLM), `server`
   (Postgres + HTTP MCP).

---

## Cross-mission follow-ups (from merged mission reports)

Raised by M5 (MCP) — storage-owned; none block M6/M7. Note: M13 shipped `packages/config` per the
phased plan; M16's remaining unique scope is doctor-as-a-shared-library + profile-default
formalization, to be folded rather than run as written.

1. ~~**`Store.deleteMemory` (hard purge)**~~ ✅ Resolved (coordinator, 2026-10-03): the primitive landed —
   one transaction deletes the memories row (vectors/bindings/edges/payload rows cascade), clears
   the two non-cascading references (`superseded_by`, `promoted_memory_id`) so FKs never block, and
   appends a surviving `'purged'` audit row. Exposed on every surface: `packages/mcp`
   `memory_delete`, the CLI (`onemem forget <id> --purge --revision <rev>`, fail-closed without the
   revision token), REST (`POST /v1/projects/:id/memories/:id/purge`), and the `OnememoryBackend`
   port (local + HTTP). The `purge_unavailable` error code is retired. A purge scenario runs in the
   both-profile integration matrix (embedded + env-gated Postgres).
2. **Storage field-update primitive** (or a blessed metadata sidecar) [P2] — unlocks metadata-only
   `memory_update` (today honestly rejected: identical-content supersede collides on
   `content_hash`).
3. **Project lookup by path** (`cwd` → project id) [P2] — lets `CLAUDE_PROJECT_DIR` scope
   automatically instead of riding provenance metadata.
4. **Injectable clock for `memory_events.at`** [P3] — audit rows are DB-clock-stamped; uniform
   time-travel tests want the injected `now`.
5. **stdio bin embedded-owner guard** [P1] (from the ADR-0010 amendment, 2026-10-04) — the
   standalone `onemem-mcp` bin can still open embedded storage (`ONEMEMORY_DATA_DIR`) while a
   daemon is alive: a second PGlite owner of the same data dir, exactly what ADR-0002 forbids.
   `onemem init` never scaffolds that combination (it points at the daemon's `/mcp`), but the bin
   itself should probe the daemon lock and refuse loudly, pointing at the running daemon's MCP
   endpoint.
6. **Shared wire-schema package** (`project.json` / `daemon.json`) [P3] — the Claude Code adapter
   re-declares cross-process wire records owned by `@onememory/config` / `apps/api`; strict schemas
   fail loud on drift, but a format change needs two edits (mission-6 §5.3).
7. **Doctor: adapter state + capture health** [P3] — surface `.onememory/adapters/*.json` cursor
   state with a reset offer (mission-6 §5.4) and a structured delivery ledger for capture hooks,
   which needs a small daemon-side counters endpoint (mission-7 §6).

Raised by M3 (extraction): worker-process ONNX isolation (daemon event-loop) — folded into M13's
brief as a documented decision; consolidation (M14) consumes `semantic_candidate`-tagged memories;
LLM-prompt tuning belongs to M11 benchmarks.
