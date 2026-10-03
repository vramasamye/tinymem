# Risks & unresolved architectural decisions

Status: draft for architecture review · Updated as research lands; entries marked ⏳ await a
specific research report. Each risk carries its mitigation and owner-mission.

## A. Technical risks

| # | Risk | Impact | Mitigation | Owner |
|---|---|---|---|---|
| R1 | **PGlite + pgvector unavailable or immature** (GATE-1) | embedded mode loses vector channel | Fallback pre-designed: `float8[]` + in-process cosine behind the `EmbeddingIndex` port; brute-force KNN is fine at ≤10⁵ rows | M1 |
| R2 | **PGlite single-connection model**: CLI, MCP server, and API can't all open the same embedded file at once | embedded mode process architecture is the #1 unresolved design question (see D1) | Daemon-owns-storage pattern; `onemem serve` as local coordinator; server mode for concurrent use | M13, M1 |
| R3 | **transformers.js ONNX runtime under Bun** (local embeddings) | default offline embedding model may not load | Verify in dep research; fallbacks: ollama (if present), Node sub-process worker, or sqlite-vec-classic hashing indexer as last resort | M3 |
| R4 | **Heuristic extractor recall/precision without any LLM** | no-LLM mode stores less / noisier | Heuristic patterns first-class + benchmarks measure both modes; LLM optional config; never silently lower quality without reporting | M3, M11 |
| R5 | **Entity resolution collisions** ("Pi" the agent vs the fruit; "Vercel" vs "Vertex") | wrong graph linkage | Project-scoped entities, confidence scoring, unresolved-entity staging for later merge, never auto-merge below threshold | M14 |
| R6 | **Agent transcript noise pollutes durable memory** | memory bloat, pollution metric fails | Future-value gate at extraction, importance thresholds, redaction before extract, retention/compaction, quality dashboard | M3, M12 |
| R7 | **MCP protocol churn** (2025-06-18 → 2026 revisions) | adapter breakage | Pin SDK minor versions; conformance suite; additive-only envelope policy | M5 |
| R8 | **Runtime hook/capture capability variance** (Codex/Cursor offer less than Claude Code) | uneven ingestion across runtimes | Adapter capability tiers documented in doctor; adapters degrade gracefully (explicit-memories + MCP tools still work everywhere) | M6–M9 |
| R9 | **Embedding model swap invalidates vectors** | retrieval quality drop mid-life | `memory_vectors.model` recorded; `re_embed` job; dim change = migration + re-index offline | M1, M14 |
| R10 | **Token estimate inaccuracy** (chars/4 heuristic vs real tokenizer) | budget overruns | Conservative estimator + optional exact tokenizer; benchmarks assert `used ≤ budget` | M2, M11 |
| R11 | **SaaS retro-fit breaking local-first** | two codebases / open-core rot | Single schema + scope columns from day 1; tenancy is API-layer + additive migration (ADR-0011); CI runs the no-network test forever | all |
| R12 | **Performance targets on weak hardware** (300ms with vector; rerank +50–300ms) | interactive UX suffers in embedded mode | Reranker OFF by default embedded; benchmarks gate on reference hardware; degradation is config, not code | M2 |
| R13 | **Graph/edge growth unbounded** (traversal cost, consolidation loops) | slow queries | Unique edges, 2-hop traversal caps, edge validity windows, archived memories excluded from expansion | M2, M14 |
| R14 | **Two-dialect drift** if sqlite-vec fallback ever becomes needed | double maintenance burden | Chosen design (one Postgres dialect) exists precisely to avoid this; fallback is an escape hatch behind one port, not a supported second stack | M1 |

## B. Unresolved architectural decisions (decide before/at review)

| # | Decision | Status / resolution |
|---|---|---|
| D1 | **Embedded-mode process model** | ✅ Resolved by ADR-0002: embedded storage has exactly ONE owner process — a local `onemem serve` daemon owns PGlite; CLI and MCP stdio speak HTTP to it. Concurrent multi-agent use routes to the `server` profile (documented limitation, not hidden). Driver: PGlite is single-owner-process (concurrent init SIGSEGV report); dep-research §1. |
| D2 | **Default embedding model** | ✅ Resolved by ADR-0006: Ollama native `/api/embed` preferred when present; else transformers.js v4 + pinned `bge-small-en-v1.5` (384-d) behind a Bun×OS×backend matrix gate, with Node worker-process fallback; last resort = lexical+graph retrieval with explicit warning. Never silently degrades without reporting. |
| D3 | **MCP tool surface finalization** | ✅ Resolved by ADR-0010: all 11 capabilities implemented; default exposure is 8 tools with `memory_search(kind=...)` covering decisions/failures/skills; full 11-tool exposure is a config profile. Progressive disclosure + token estimates on every read; `forget` (soft) vs `delete` (hard) stated in first sentence of each description. |
| D4 | **Raw event payload retention** default before compaction to sources | ✅ Resolved (user, 2026-10-03): default **30 days**, configurable, 0 = keep forever. Compaction job summarizes payloads into `sources` then purges raw events. |
| D5 | **Phase 1 extractor default** | ✅ Resolved (ADR-0006): heuristic extractor is the shipped default (correctness baseline, zero network); LLM extractor activates via config when a provider is set. |
| D6 | **FTS config**: `simple` vs `english` stemming | Open. Leaning: `simple` + query-side normalization; revisit on M11 recall results. |
| D7 | **Skill auto-promotion** | ✅ Resolved by ADR-0009: `auto_promote_skills = false` default; candidates + `onemem skills review` flow. |
| D8 | **Working memory MCP exposure** | ✅ Resolved by M5 (2026-10-03): no dedicated `memory_working` tool — working memory is reachable read-only through `memory_search { session_id }` (retrieval's session-scoped channel), which covers the need without a second surface. A dedicated list tool stays out until ingest adapters (M6/M7) define the session lifecycle it would list. |
| D9 | **GitHub publication** | ✅ Resolved (user, 2026-10-03): repo **`vramasamye/tinymem`**, pushed via the personal SSH alias (`github.com-personal` → `~/.ssh/id_ed25519_personal`). The `gh` CLI is authenticated as `vikirams` and must NOT be used for account-scoped operations on this repo (creation, issues, settings) — issue import needs vramasamye-authenticated gh or a PAT. |

## C. Process risks

- **Parallel-mission integration seams** (M13/M5 consume M1/M2 APIs): mitigated by ports-first
  design + SDK-level contracts landing before adapters start.
- **Spec scope is enormous** (10 layers, 14 lifecycle stages, 5 runtimes, SaaS): phased plan is
  the contract; "done" per phase is enforced by definition-of-done gates, not calendar pressure.
- **Research-to-code drift**: every ADR cites the research file that informed it; code reviews
  check ADR consistency (AGENTS.md rule 1).

## D. Anti-goals (explicitly out of scope until 1.0)

- Real-time multi-user collaboration semantics in embedded mode.
- A second SQL dialect as a supported target (escape hatch only, R14).
- Auto-promoting unverified skills (D7).
- Cloud-only features (nothing in the open-source version is crippled — spec §34).
