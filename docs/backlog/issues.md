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
5. Project digest rollup + working-memory promotion sweep (the sweep half landed as mission 14a,
   merged 2026-10-05 — see the M14a cross-follow-ups below; the digest rollup remains M14 scope).
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
8. ~~**Combined transcript-to-temporal acceptance**~~ Resolved: the API cross-package acceptance
   test ingests the golden transcript, checks extracted decision/failure provenance, explicitly
   supersedes extracted version facts, and verifies current/as-of/history answers through the real
   retrieval engine. This does not implement automatic matching or authority resolution; M14 still
   owns those stages and must exercise them end to end.
9. **Published hook invocation contract** [P1] — generated Claude hooks assume a project-local
   `node_modules` path and the Claude bin lacks a shebang; Codex capture assumes its executable is
   on `PATH`. AC: a clean external project using the published package can run every generated
   hook without repository-local paths.
10. **Per-runtime identity over daemon MCP** [P2] — Phase 1 HTTP clients share the registered
    project identity; decide whether later runtimes need a query parameter or authenticated
    headers before multi-agent attribution is required. AC: ADR and transport tests define how
    identity is conveyed and validated.
11. **User-scope runtime wiring** [P2] — init/doctor currently write and inspect project scope
    only, not `~/.claude.json` or `~/.codex/config.toml`. AC: add user scope only with explicit
    consent and safe merge tests, or document project-scope-only support as the permanent contract.
12. ~~**Doctor summary includes daemon checks**~~ ✅ Resolved (coordinator, 2026-10-04): summary/
    status/exit_code now derive in one place — `finalizeDoctorReport` in the apps/api runtime, which
    `inspectRuntime` and the failed-to-open fallback also route through. The CLI appends its
    daemon/worker mode check and finalizes before both output paths (JSON emit + printed report), so
    counts always match the checks listed; exit-code semantics unchanged (`warn` stays degraded/0).
    Landed as `mission/13b-doctor-summary` (`fa99f0f`), merged to main.

Raised by M3 (extraction): worker-process ONNX isolation (daemon event-loop) — folded into M13's
brief as a documented decision; consolidation (M14) consumes `semantic_candidate`-tagged memories;
LLM-prompt tuning belongs to M11 benchmarks.

Raised by M3b (decision/failure capture) — landed with the fields on candidates and in durable
`content`; M3d persists the signatures for recurrence matching, while counting and consolidation
remain future work.

1. ~~**STORE wiring of `decisions`/`failures` payload rows**~~ Resolved by M3d: typed decision and
   failure payloads are persisted in the existing tables in the memory/audit transaction and
   hydrated on get/list/current/point-in-time/history reads. The heuristic and LLM paths share the
   same event-backed mapping; decision evidence is echoed from memory provenance, and failures are
   written only when a cited event reproduces the engine signature. Acceptance covers both
   extractors and the embedded/server storage matrix. Recurrence counting and search-result payload
   hydration remain separate follow-ups.
2. ~~**Tool-result failures as incidents**~~ Resolved by M3c (`35bf338`): normalized tool results
   preserve an optional validated tool name; `ok: false` produces a failure incident with
   `origin: 'tool'`. Both extractors compute identical signatures, and same-tool successes can
   resolve failures.
3. **Adapter tool-result failure emission** [P2] — M7b preserves the correlated call name on Codex
   generic rollout results (omitting absent or overlength names), but Codex's
   `function_call_output` serializer discards its internal success flag, including MCP `isError`.
   Its legacy `ok: true` is not proof of success; adapters must not infer failures from output
   text. Next producer seams: upstream serializer support (preferred), verified consumption of
   `event_msg` `mcp_tool_call_end`, or a future hook schema with explicit status. AC: a captured
   runtime failure reaches extraction with its call name and source-backed `ok: false`, while
   successful results remain non-incidents.
   The M7b redaction follow-up is resolved by the security boundary fix (`a23fedc`): known
   credential prefixes embedded after `_`/`-` in tool-name strings are now redacted without
   blanket-redacting useful tool identifiers.

---

## Cross-mission follow-ups — raised by M14a (session-end working-memory sweep)

Merged `642787e` (mission report: `docs/plan/mission-reports/mission-14a-session-sweep.md`, which
numbers the follow-ups below). The pass runs inline in `ingestEvents` on stored or duplicate
`session.end` events, is idempotent, and rides `IngestResult.warnings` for its summaries.

1. **Async-extraction lag (same-batch rows)** [P1] — the pass runs before the async extract
   handler produces working rows from the same ingest batch, so last-moment rows promote only on a
   later end event (duplicate ends heal, but no adapter contract guarantees one). Structural fix:
   fire from the extract handler on a `session.end` group, or add a job kind.
2. ~~**`createSession` upsert wipes the recorded end**~~ ✅ Resolved (coordinator, 2026-10-05,
   `4460cd3`): `ended_at`/`summary` now coalesce newest-non-null-wins on conflict (a later explicit
   end overwrites; a start-only upsert never erases); asserted in the embedded + Postgres storage
   matrix.
3. **"Explicitly flagged" promotion arm** [P2] — memory-model.md §10 specifies `importance ≥ 0.5`
   OR explicitly flagged; working rows carry no flag field, so only the threshold arm is enforced.
   Needs a schema field (with migration) or the doc arm should be retired.
4. **`IngestResult` lifecycle field** [P3] — summaries ride `warnings`; a dedicated field needs
   `types.ts` + OpenAPI + `IngestResponseSchema` changes.
5. **`user_id`/`agent_id` not carried onto promoted memories** [P3] — working rows hold neither;
   promoted memories are project-scoped via the ingest endpoint's authoritative project.
6. **Session-scoped sweep** [P3] — `sweepWorking` is global by storage design; the pass labels the
   purge as a global TTL sweep. A session filter or `getSession` read port would tighten this.
7. **`sessions.stats` not updated** [P3] — no writer reads it today; revisit alongside a future
   capture-health ledger.

---

## Cross-mission follow-ups — raised by M11a (benchmarks v1)

Merged 2026-10-05 (mission report: `docs/plan/mission-reports/mission-11-benchmarks.md`).
`benchmarks/eval` composes the real engine offline (no embedder, heuristic extraction, network
guard asserting 0 attempts); five golden datasets; committed baseline
(`benchmarks/results/baseline.{json,md}`).

1. **Nightly `bench:run` + results commit** [P2] — CI (`.github/workflows/ci.yaml`) already runs
   `bun test`, which includes the gate test on every push. The remaining piece is a scheduled
   nightly job that runs `bench:run` and commits refreshed results; the diffable drift signal is
   the `metrics` + `gates` blocks, because `baseline.json` embeds per-run timestamps and uuidv7
   ids (see item 3).
2. ~~**Thin contradiction coverage** [P2]~~ ✅ Completed by M11b (merged 2026-10-05): six
   groups cover the authority order, a disputed full tie, and a cross-phrasing detector miss.
3. **Deterministic baseline snapshot** [P3] — strip or freeze per-run timestamps/uuids from the
   committed baseline so a raw file diff shows real drift (small M11b change).
4. ~~**Hard project scoping in retrieval**~~ ✅ Declined by design review (2026-10-05): project
   scope is intentionally a scoring weight, not a candidate filter — `retrieval.md` specifies
   `w_proj` (1.0 same-project / 0.7 cross-project / 0.4 user-global) and `project_id IS NULL`
   means cross-project/user-level by design ("one memory across every agent"). The benchmark
   correctly gates what the design calls correct — top-1 cross-project rate held at 0. If
   pollution complaints ever arrive, the lever is `w_proj` tuning, not a hard filter.
5. ~~**Post-M14 gate flip** [P1]~~ ✅ Completed by M11b (merged 2026-10-05): fresh baseline gates
   `contradiction_accuracy ≥ 0.8` (measured 0.8333, 5/6 groups) and
   `consolidation_quality ≥ 0.3` (measured 0.3333). The cross-phrasing miss and offline
   consolidation ceiling remain visible in the benchmark report; the deterministic-baseline
   snapshot remains open under item 3.

---

## Cross-mission follow-ups — raised by M14 (consolidation core)

Merged 2026-10-05 as `bc8bf24` (mission report:
`docs/plan/mission-reports/mission-14-consolidation.md`). `packages/consolidation` + the
`onemem consolidate` CLI; pass order contradiction → derivation → merge → decay; no migration
(the schema already carried every status, edge relation, and audit action).

1. **Daemon scheduling + REST route** [P1] — job kinds `consolidate`/`decay` exist with no
   handler; `onemem consolidate` runs direct-mode only (and refuses while a daemon owns the data
   dir). Wire the job handlers, a `/v1/.../consolidate` route, and daemon-mode invocation.
2. **Evidence-append Store primitive** [P2] — near-dup merge records the evidence union on the
   `merged` audit event because the port cannot append evidence to an existing memory row.
3. **`MemoryQuery` null-scope probe** [P3] — user-scope-only passes need a null-`project_id`
   query; today's query shape requires a project.
4. **Paginated pool enumeration** [P3] — `runConsolidation` processes ≤1000-memory windows.
5. **LLM conflict detector** [P3] — cross-phrasing contradictions (attribute-template heuristic
   only today). M11b measures the current miss: PostgreSQL/pgvector vs MySQL remains unresolved,
   leaving `contradiction_accuracy` at 5/6 (0.8333).
6. **Config wiring** [P3] — consolidation thresholds/decay settings via `onememory.config.yaml`
   (M16 profile defaults).
7. **M14.5/M14.6 remain** — project digest rollup feeding `memory_project_context` and events
   compaction are still open backlog scope.

---

## Cross-mission follow-ups — raised by M4f (reindex + digest orchestration)

Merged 2026-10-05 as `56d67f2` (mission report:
`docs/plan/mission-reports/mission-4f-reindex-digest.md`). Daemon scheduler (5-minute default
drift scans, injectable timer), `drift_scan`/`reindex` job execution, drifted-path-only reindex,
and the strictly-<300-token architecture digest persisted as a `semantic/project_digest` memory
with provenance.

1. **CLI/MCP commands for manual scans** [P2] — the runtime handle
   (`runDriftScan`/`runReindex`/`status`) exists; no `onemem` command or MCP tool calls it yet.
2. **Retrieval-time digest injection** [P2] — the digest is stored and queryable; session context
   does not yet preferentially include it.
3. **`MemoryQuery` tags/subtype filter** [P2] — finding a *changed* digest's predecessor for
   supersession still uses a windowed scan at the port's 1000 limit; a deterministic tag/subtype
   filter (core + storage) removes the window (unchanged digests are already located
   deterministically via `findDuplicate`).
4. **Storage: dedupe index vs supersession** [P2] — `memories_dedupe_idx` spans superseded rows,
   so a content hash that ever existed cannot be re-inserted as a current row, and
   `supersedeMemory`'s winner-duplicate handling assumes `findDuplicate`'s `existing` row is
   current (not guaranteed). Needs a core/storage review + tests.
5. **Symbol-level drift resolution, chunked re-index for whole-repo rewrites, and server-mode
   verification of the loop** [P3].

---

## Cross-mission follow-ups — raised by M4g (procedures acceptance)

M4g added an honest end-to-end acceptance test (`docs/plan/mission-reports/mission-4g-procedures-acceptance.md`).
It proves that the real extraction and retrieval pipeline returns a procedural answer and that
the answer's code refs can be persisted against real repository blobs. The Phase 2 DoD remains
incomplete because the search response does not include those refs.

1. **Expose code refs on retrieval responses** [P1] — `MemorySearchResponse` and the retrieval
   engine do not surface persisted `memory_code_refs`; consumers cannot get the cited files with
   the answer. Review the response contract/ADR, then add a validated code-ref field and load it
   through the appropriate storage port.
2. **Procedure extraction from code/document text** [P2] — the real heuristic extractor produces
   no procedural memories from the auth-code fixture; current procedure results come from
   `explicit.remember` or recurring commands. Decide whether to add a safe heuristic or extend the
   optional model-backed extraction path.
3. **Automatic code-ref linkage for fresh extraction** [P2] — newly extracted memories only get
   refs when a caller writes them through `recordCodeRefs`; define an ADR-backed linkage seam.
4. **Re-index recovery for stale procedural memories** [P3] — re-index cannot restore a procedural
   memory when file extraction produces no same-type procedure; depends on resolving item 2.
5. **Default-profile paraphrase recall** [P3] — without an embedder, lexical search does not stem
   or resolve paraphrases that do not share key terms; assess an offline embedding profile.
