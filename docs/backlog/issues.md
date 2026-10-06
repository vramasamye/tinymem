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

Status: ✅ Completed 2026-10-06 (merged `2dd3c9f`). Mission report at
`docs/plan/mission-reports/mission-8-cursor.md`. New package
`@onememory/adapter-cursor` (35 files), 14 new conformance tests in
`benchmarks/eval/src/adapter-conformance/`. Conexts cursor to the
shared 10-fact canonical session via a real-engine pipeline; byte-identical
to Claude, with one pre-existing Codex normalization gap pinned by a
test so it cannot grow silently. Cursor-specific limits (no exit code
on `postToolUseFailure`, undocumented transcript) are documented
honestly rather than fabricated.

## M9 — Pi + OpenCode adapters [P4] [integration]
Branch: `mission/9-pi-opencode` · pi extension/config; opencode.json MCP + skills; conformance green.

Status: ✅ Completed 2026-10-06 (merged `d95efc4`). Mission report at
`docs/plan/mission-reports/mission-9-pi-opencode.md`. New packages
`@onememory/adapter-pi` (Pi extension adapter, 96 tests) and
`@onememory/adapter-opencode` (OpenCode plugin adapter, 147 tests).
The shared 5-runtime conformance suite now runs Claude + Cursor + Codex +
Pi + OpenCode: byte-identical memory results across the canonical
10-fact session (with one pinned edit-line-count landscape
[Claude=2/3, Cursor=1/2, Codex=none, Pi/OpenCode=Claude]). Secrets
test fixture (`b.repeat(40)` runtime assembly, no literal `sk-ant-`
pattern in source) — Droid-Shield unblocked.

## M10 — Web UI [P6] [epic] [ui]
Branch: `mission/10-web-ui` · Deps: REST API · App: `apps/web`

Status: ✅ Completed 2026-10-06 (merged to main). Mission report at
`docs/plan/mission-reports/mission-10-web-ui.md`. New `apps/web` workspace
package (Vite + React): memories search/filter + full-text search, timeline
(status history), graph view (entity graph from retrieval ports), projects,
decisions, failures, skills, sources/provenance drill-down, quality
dashboard. 73 tests pass / 0 fail. Every UI claim is fetched from
`apps/api` REST — no client-side truth (per AGENTS.md mission discipline).

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
5. ~~**stdio bin embedded-owner guard**~~ ✅ Completed by M13c (merged `911c58a`, 2026-10-06,
   mission report: `docs/plan/mission-reports/mission-13c-install-robustness.md`): the standalone
   `onemem-mcp` bin now probes the daemon lock for both real embedded data-dir layouts and
   refuses to open embedded storage (PGlite) while a live daemon still owns the data dir. Server
   profile (`ONEMEMORY_PG_URL`) is unaffected — Postgres is multi-process-safe by design. The probe
   is the same shared `@onememory/config` seam the daemon writes, so the lock schema and discovery
   stay in lockstep.
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
9. ~~**Published hook invocation contract**~~ ✅ Completed by M13c (merged `911c58a`, 2026-10-06,
   mission report: `docs/plan/mission-reports/mission-13c-install-robustness.md`): Claude hooks
   now use the published `node_modules/.bin/onemem-claude-hook` link (shebang present, exec form,
   `args: []`); Codex hooks use `exec "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"/node_modules/.bin/onemem-codex-capture`
   (run-time root resolution, no PATH-only assumption); the Codex stdio MCP block points at
   `./node_modules/.bin/onemem-mcp`. Old configs migrate idempotently via token-based inspection
   (the merge keeps replacing stale handlers, never duplicates), user overrides (`command`/`args` on
   Claude, `captureCommand`/`mcpCommand` on Codex) are preserved verbatim. The two new
   `scaffold-published.test.ts` files spawn every generated command in a clean temp install
   (module symlink via `node_modules/.bin`, real PGlite boot, real TOML parse, real session-end
   payload) — none of them reference `src/*.ts`, a monorepo path, or rely on bare-PATH
   resolution. POSIX-only posture preserved (Windows stays unsupported per Phase-1).
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
the answer's code refs can be persisted against real repository blobs. Item 1 below is the
Phase 2 blocker that M4g2 closed; the remaining items are honest residuals.

1. ~~**Expose code refs on retrieval responses**~~ ✅ Closed by M4g2 (merged 2026-10-06,
   mission report: `docs/plan/mission-reports/mission-4g2-retrieval-code-refs.md`).
   `MemorySearchResponse` now carries a non-optional `codeRefs: CodeRefEntry[]` on every result
   (Zod-validated `{repoId, commitSha, path, symbol?, evidence?}`), hydrated through a single
   batched `Storage.listCodeRefsForMemories` call and shape-trimmed against a per-config
   `codeRefs.maxPerMemory` budget. The M4g acceptance test flipped from "refs absent" to "refs
   present and correct" (`apps/api/src/runtime/procedures-acceptance.test.ts`).
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

---

## Cross-mission follow-ups — raised by M4g2 (retrieval code-ref surfacing)

Merged 2026-10-06, mission report: `docs/plan/mission-reports/mission-4g2-retrieval-code-refs.md`.
Code refs now travel on the wire (P1 closed). Honest residual items below.

1. **`codeRefs.maxPerMemory` is a config knob** [P3] — the field exists and is honored, but the
   default (`Phased-plan`'s token-budget discipline) needs a documented policy in
   `docs/architecture/retrieval.md`: shape-trim summary vs. drop-the-overflow vs. paginate.
   Open as a coordinator ADR amendment.
2. **Code-ref evidence overflow on big repos** [P3] — when a procedure gathers dozens of
   distinct code refs (`maxPerMemory` cascades), the consumer still sees the full list but the
   per-memory token budget shrinks the memory body further. Add a runtime warning when this
   triggers, mirroring `degradedSearch`.
3. **MCP `memory_search` and REST `/v1/projects/:id/search` already pass through, but
   `memory_get`** [P3] — when a caller has already received `codeRefs` on a search result and asks
   `memory_get` for the same row, the response should *not* re-emit the same refs (would double
   tokens). Confirm / fix at the API surface.
4. **Heuristic procedure extractor** is still a separate item (M4g item 2 above) — M4g2 only
   surfaces refs; it does not generate them.

---

## Cross-mission follow-ups — raised by M13c (install robustness)

Merged `911c58a` (mission report: `docs/plan/mission-reports/mission-13c-install-robustness.md`,
2026-10-06). Both P1 backlog cross-follow-ups #5 and #9 above are now closed by this mission;
remaining items below are honest residual risk or doc follow-ups.

1. **pnpm isolated layouts do not link transitive bins into `node_modules/.bin`** [P3, doc] —
   npm/bun/yarn hoist, so the published `onemem` CLI's adapter/MCP dependencies get root `.bin`
   links and the generated commands resolve. With pnpm's default strict layout, only DIRECT
   dependencies receive `.bin` links; a user installing `onemem` (not the adapter packages) under
   pnpm would not get `onemem-claude-hook`/`onemem-mcp` links. Coordinator-owned decision:
   either document direct installation of the adapter packages, or publish a
   `pnpm.public-hoist-pattern[]=@onememory/*` note in `README.md`.
2. **Doctor cannot flag a stale-but-wired invocation form** [P3] — `hooks.json`/`settings.json`
   written by an older `onemem init` still reports `complete`. Token-based recognition is
   deliberate (mirrors Claude's behavior, no sudden warnings), so only a re-run of `onemem init`
   migrates. If we want the doctor to suggest a re-run on stale forms, add an inspection detail
   that reports the invocation form.
3. **User-scope runtime wiring** (`~/.claude`, `~/.codex`) [P2] (also cross-follow-up #11 above)
   — init/doctor remain project-scope; the Codex stdio `cwd`/`mcpCommand` overrides are the
   existing escape hatch. Reopen only with explicit consent + safe-merge tests.
4. **Windows is out of scope** — bun shebangs and the Codex shell command are POSIX-only,
   consistent with Phase 1's posture (`docs/research/dependency-verification.md` §10 pins argv-array
   spawning; no Windows CI). Cleaner to keep this documented than a partial port.
5. **`bun.lock` drift on merge** — the `@onememory/config` workspace edge added in `e0b879a`
   needs a `bun install` on the merge destination before the MCP suite can find the new link.
   Worker documented it; re-incur if a sibling mission changes the same edge again. Capture in
   `AGENTS.md` contributor notes if it becomes routine.
6. **Cold-boot acceptance runtime cost** [P3] — the two PGlite-boot tests in the adapter suites
   add ~25s (~8–12s each) to a clean run. Ceilings are bounded (60s); the tests don't share
   fixtures. Mark a slow tier when the project's test-runner tiering is set up; do not shorten
   the ceilings.

---

## Cross-mission follow-ups — raised by M8 (Cursor adapter)

Merged `2dd3c9f` (mission report: `docs/plan/mission-reports/mission-8-cursor.md`, 2026-10-06).
Cursor passes conformance today (byte-identical memory results vs Claude, with one pre-existing
Codex normalization gap pinned). Honest remaining items below.

1. **Hoist the remember-clause extractor into a shared adapter kit** [P2] — `packages/adapters/cursor/src/remember.ts`
   is documented as byte-identical to Claude's. Either factor it into a `packages/adapters/_shared/`
   module reused by claude/codex/cursor, or accept the duplication once the conformance gap closes
   on the Codex side. Keep AC: conformance must stay bit-identical.
2. **Codex: strip the `explicit.remember` trailing punctuation** [P2, other mission's lane] — the
   pinned normalization gap (Codex keeps the trailing period) closes with one tiny edit. M9's
   OpenCode adapter should land the same fix; if M9 captures it, coordinate a back-port.
3. **Map an exit code if Cursor ever documents one for failed Shell** [P3] — Cursor's
   `postToolUseFailure` currently carries only `error_message`/`failure_type`, so the suite asserts
   `exit_code: null`. Adopt the real field the day Cursor ships it.
4. **Add `--transcript` backfill once Cursor documents the transcript file format** [P3] — refusing
   to parse an undocumented `transcript_path` is the right call today; revisit when Cursor publishes
   the schema.
5. **Add a vector-channel conformance variant when an offline embedder lands** [P3] — the suite
   currently runs lexical+graph only; the warning is recorded in the runner. No silent fallback.
6. **Cursor user-scope (`~/.cursor`) global scaffold** [P2] — project-scope only today; the user
   cross-follow-up #11 already covers Claude/Codex. Open with explicit consent + safe-merge tests
   the same way.
7. **`bun.lock` drift on merge** (same recurrence as M13c item 5) — the cursor package added a new
   workspace edge. `bun install` after merge is part of the merge dance; consider encoding it in
   the contributor notes the next time two workspace edges land in the same wave.

---

## Cross-mission follow-ups — raised by M9 (Pi + OpenCode adapters)

Merged 2026-10-06 as `d95efc4` (mission report: `docs/plan/mission-reports/mission-9-pi-opencode.md`).
Pi and OpenCode pass conformance today (byte-identical to Claude across the canonical session).
Honest residual items below.

1. **Codex: strip `explicit.remember` trailing punctuation** [P2, other mission's lane] — the
   pinned normalization gap (Codex keeps the trailing period). Identical finding to M8 item 2;
   the back-port is one tiny edit on the Codex package. Reopen when M7b / a Codex polish mission
   has bandwidth.
2. **Edit line-count landscape unification** [P3] — Claude=2/3, Cursor=1/2, Codex=none, Pi and
   OpenCode=Claude. Pick the Claude baseline (the canonical edit pattern in `scenario.ts`),
   back-port Cursor to match, and document the choice. Today's pinned test landscape is honest
   but the lack of a single baseline is brittle.
3. **Hoist `remember.ts` into a shared adapter kit** [P2] — `packages/adapters/pi/src/remember.ts`
   and `packages/adapters/cursor/src/remember.ts` are documented as byte-identical. Consolidate
   into a `packages/adapters/_shared/remember.ts` once the Codex trailing-period fix lands (so
   the shared extraction has exactly one customer per variant).
4. **User-scope runtime wiring** (`~/.pi`, `~/.opencode`) [P2] (cross-listed under #11 above) —
   project-scope only today; reopen only with explicit consent + safe-merge tests.
5. **Conformance currently lexical + graph only** [P3] — vector channel awaits an offline
   embedder in `packages/embeddings` (mirrors M8 item 5). When that lands, extend
   `pipeline.ts` to assert vector-channel agreement across runtimes.
6. **`bun.lock` drift on merge** — the same recurrence as M13c item 5 / M8 item 7. Rebase + `bun
   install` before the merge is part of the dance; three workspace edges in three missions
   confirms it. Coordinator candidate to encode in `AGENTS.md` contributor notes.

---

## Cross-mission follow-ups — raised by M14.5 + M14.6 (digest rollup + events compaction)

Both missions landed 2026-10-06 onto `main` (M14.5: `1b6559b`; M14.6: fast-forwarded onto
main). Mission reports at `docs/plan/mission-reports/mission-{14e,14f}-*.md`. Phase 3 backlog
is now fully closed. Honest residual items below — read with a generous eye: the digest and
compaction passes are deliberately narrow and the next two items are about tightening their
windows, not about their correctness.

### M14.5 — project digest rollup

1. **Digest windowing policy** [P3, coordinator ADR] — `runProjectDigest` defaults are honest
   but undecided: which sources count toward the budget (`memory.kind ∈ {decision, failure,
   procedure}` only — declared today; document it in `docs/architecture/retrieval.md` §2
   alongside `projects.digest`), how often the digest may re-fire without thrashing, and how
   parameter sets survive across config migrations. Propose ADR amendment in the report; do
   not write the ADR here — coordinator-owned.
2. **Digest wiring into the existing `memory_project_context` tool** [P3] — the tool surface
   exists; the digest pass writes the underlying memory. Confirm via `onemem digest` →
   `mcp memory_project_context` round trip (no schema change, no new endpoint). Capture any
   token-budget deviation in either direction.
3. **M14.5 + M8 shared remember-clause overlap** [P2 back-port] — the `remember-clause
   extractor` is documented as byte-identical between Claude and Cursor; M14.5's digest might
   want to reuse the same extractor for the decision line of the same. Decide during a
   shared-adapter-kit follow-up; not blocking.

### M14.6 — events compaction

1. **Retention window default** [P3, coordinator ADR] — `runEventsCompaction` accepts a
   `--retention-window` flag; the default is intentionally 0 (keep forever) so a fresh
   install doesn't surprise. Choose a sensible per-install default in `onememory.config.yaml`
   via an M16 follow-up; document the choice in `docs/architecture/memory-model.md` §13.
2. **`memory_events_digest` table growth** [P3] — summarized events live forever; the
   compaction pass keeps `memory_events` bounded but the digest table itself is unbounded.
   Add a separate retention window or a per-project ceiling in a future mission; not
   blocking today.
3. **`sources` lineage across summaries** [P3] — the invariant test asserts every memory
   still has its full provenance. Today this is via the original event id; if a memory is
   further compacted (decay/archive decision), the link must not break. Verify at the next
   consolidation run; defer.

---

## Cross-mission follow-ups — raised by M10 (web UI)

Merged 2026-10-06 (mission report: `docs/plan/mission-reports/mission-10-web-ui.md`). Phase 6
DoD met: developer can visually verify every claim the engine makes about a memory.
Honest residual items below.

1. **API endpoints the UI needs but `apps/api` does not yet expose** [P2] — list them
   concretely in the mission report and triage as coordinator follow-ups. Add one the UI
   needs (depends on which feature surfaced the gap) at the next opportunity.
2. ~~**`--profile web` compose profile**~~ ✅ Closed (2026-10-06): `docker/compose.yaml` now
   carries a `web` profile — `docker compose --profile web up` brings up Postgres + the daemon
   (`memory-api`, 7331) + the built explorer (`web`, 4173), with `docker/api-config.yaml` as the
   container's server-mode config and `docker/api.Dockerfile` / `docker/web.Dockerfile` as the
   images. Verified end to end: `/v1/health` through the preview proxy reports
   `storage.profile: server` on pgvector. The default `docker compose up` still starts Postgres
   alone, so the env-gated integration suite is unchanged.
3. **Quality dashboard data wiring** [P3] — the dashboard panel renders from API endpoints,
   but some duplicate/stale/conflict counts require the upcoming M5b-quality metrics. When
   M5b-quality lands, extend the dashboard to consume them directly.
4. **Pagination on memories list** [P3] — current list scrolls; add keyed pagination using
   cursor + page-size from the API once `apps/api` exposes it.

---

## Cross-mission follow-ups — raised by M5b (MCP hardening)

Merged 2026-10-06 (mission report: `docs/plan/mission-reports/mission-5b-mcp-hardening.md`).
Streamable-HTTP transport + OAuth 2.1 PKCE + 5-runtime conformance extension + zero-outbound
network-guard assertion. Honest residual items below.

1. ~~**OAuth deployment story**~~ ✅ Closed by ADR-0012 (2026-10-06, `docs/adr/0012-oauth-deployment-posture.md`):
   the per-deployment-mode posture is codified (local loopback / hosted OIDC /
   SaaS proxy), the network-guard allowlist is config-driven, the conformance
   unit test against a fake OIDC server pins the contract, and the SaaS proxy
   pattern delegates OAuth rather than double-running it.
2. **`session.idle → session.end` mapping for OpenCode in Streamable-HTTP form** [P3] — the
   stdio conformance runner pinned the rule; the streamable-http conformance runner must
   too. The behavior landed today (covered by conformance); the explicit pin test is the
   remaining gap.
3. ~~**`onemem auth` UX**~~ ✅ Closed (2026-10-06): `onemem auth` is now the
   `login | status | logout` group ADR-0012 documents. The parent carries no options (so
   Commander 15 does not swallow the leaves' `--cwd`/`--config`/`--json`), and `status` is
   the default subcommand, so bare `onemem auth` still reports the stored credential. The
   CLI surface — dispatch, config-dir resolution, io rendering, exit codes — is pinned end
   to end in `apps/cli/src/auth-command.test.ts`: a real loopback login against a fake
   authorization server (discovery → DCR → PKCE → redirect → exchange), 0600 persistence,
   `status`, idempotent `logout`, and fail-closed `login` with no target. This also closes
   the M5b report's "`onemem auth` has no test file" gap.
4. **MCP proxy / aggregate-server** [P3] — for hosted deployments, the canonical pattern is
   to gate the MCP server behind a reverse proxy. Reference deployment config is in
   `benchmarks/eval/src/mcp-conformance/` for tests; production deploy guidance belongs in
   `docs/architecture/security.md`.

---

## Cross-mission follow-ups — raised by M15 (skill generation)

Merged 2026-10-06 (mission report: `docs/plan/mission-reports/mission-15-skills.md`).
Signature recurrence matching → SKILL.md candidates → review/promote flow → MCP
`memory_skills` + filesystem serving all live. Honest residual items below.

1. **Skill promotion-gating in CI** [P3] — the local flow (`onemem skills review` →
   `promote`) audits the flip via `memory_events`. The CI gating story (reviewer role,
   audit-trace verification in CI, no auto-promotion from a fresh install) is currently
   not codified. Add a tool-call fixture that asserts the audit row exists when a skill
   goes `candidate → verified`.
2. **Skill freshness over time** [P3] — `signature recurrence matcher` will recompute
   candidates based on new failures; an existing verified skill becomes stale when its
   underlying signature no longer matches recent failures. Add a "skill validity / decay"
   pass that flips verified skills back to candidate-or-archived when their match count
   drops below a threshold.
3. **Skill missions→AGENTS.md / SKILL.md write surface** [P3] — Claude Code and OpenCode
   both consume `SKILL.md` files from a project-local or global path. The filesystem
   write is correct today; the canonical *location* and `manifest.json` (per the runtime's
   discovery rules) is currently a fixed default. Make it configurable per runtime.
4. **Skill content review UI in `apps/web`** [P3] — M10's web dashboard currently shows
   the skills list. Add a dedicated `/skills/:id/review` route that renders the SKILL.md
   body and exposes the `approve | reject` action surface directly (no CLI-only).

---

## Post-1.0 follow-ups (still out of scope until 1.0 ships)

The post-1.0 list from the phased plan is unchanged; we crossed the 1.0 line:
all six shipped phases closed in 2026-10-06 against the AC criteria. Open-core gating
is still deferred.

- SaaS/multi-tenant mode (orgs, API keys, RLS, hosted control plane per ADR-0011).
- IDE plugins (VS Code, JetBrains).
- Additional embedding/reranker providers.
- Doc-site polish.
