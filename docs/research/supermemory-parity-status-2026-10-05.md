# Supermemory parity status — onememory vs the market bar (2026-10-05)

Memo date: 2026-10-05 · Research cutoff: 2026-10-05 · Scope: what an agent-memory product comparable to
Supermemory needs today, and where onememory (main @ `accd63a`) actually stands against it.

Method: Supermemory claims come **only from primary sources** — the official docs (machine index at
<https://supermemory.ai/docs/llms.txt>), the live OpenAPI spec, official integration pages, and the
`supermemoryai` GitHub org. Load-bearing pages were re-fetched 2026-10-04/05; pages marked "10-03" were
verified on that date for the companion deep-dive (`docs/research/supermemory.md`) and not changed in the
index since. onememory claims come from this repository's code, phased plan, and mission reports — features
are called absent only after checking the tree. Supermemory's own benchmark numbers are self-reported and
cited as claims, not facts.

---

## 1. Executive verdict

**onememory is not yet a comparable product to Supermemory, but the gap is concentrated, not broad.**
The storage/retrieval/protocol core that Supermemory sells as "the Memory API" largely exists here in a
shape that is in places *stronger on paper*: typed layers with mandatory provenance, point-in-time and
historical queries, audited supersession/forget/purge, token-budget packing with explain, drift-aware code
memory (git fingerprints + tree-sitter symbols, with the Phase-2 DoD keystone test green), and a
hard local-first posture. What is missing is the **closed loop that makes memory feel intelligent** — the
things Supermemory's "dreaming" phase does automatically (contradiction resolution, dedup/merge, derived
facts, decay/forgetting), the always-on **profile** read path, **two more agent runtimes**, and **any
published eval numbers**. Those four, plus two small install-robustness fixes, are the difference between
"working engine" and "comparable product."

Two fresh facts sharpen the comparison as of the cutoff:

1. **Supermemory's local binary is now disclosed as closed.** On 2026-10-04 the repo landed "docs: disclose
   current self-hosted security and telemetry behavior" (PR #1711): the self-hosted server binary "is built
   from a separate, non-public codebase", is "free within its lite license limit", **collects telemetry by
   default** (`SUPERMEMORY_DISABLE_TELEMETRY=1` to disable), and URL ingestion "uses a hosted reader
   service" ([S10], [S14]). The repo description still says "can be run fully locally" — true for the
   process, no longer open for the engine. The SDKs, plugins, MCP server, and MemoryBench remain OSS (MIT)
   ([S13]). This widens onememory's only durable structural advantage: fully-open, zero-telemetry,
   enforced-offline-by-default memory.
2. **Their coding-agent story is hooks-plus-plugins, exactly our shape** — Claude Code reasoned recall +
   auto-capture + separate team/personal memory ([S11]); Codex `UserPromptSubmit` recall + `Stop` flush,
   incremental capture every N turns, hashed git identity for user/project scopes ([S12]). onememory's
   Claude/Codex adapters already implement the same hook seams (with stricter honesty about what the wire
   can prove — M7b). The competition at the agent surface is UX quality, not architecture.

**Recommended posture:** target *agent-experience parity*, not deployment-model parity. Do not chase
connectors, SaaS tenancy, billing, or 20+ framework wrappers; do close the dreaming/consolidation loop,
finish code-memory orchestration, ship Cursor/OpenCode, and publish a minimal benchmark. Local-first +
Apache-2.0 + provenance is the wedge Supermemory structurally cannot copy without reopening their binary.

---

## 2. What the bar is — Supermemory's shipped agent-memory surface (primary sources)

What a coding agent gets from Supermemory today:

1. **Two-plane memory + async pipeline.** Raw documents → chunks (RAG grounding); extracted atomic facts →
   a temporal vector-graph; per-container **profiles** synthesized from facts. Pipeline runs
   `queued → extracting → chunking (type-aware; code via AST) → embedding → indexing → done`, async, with
   `customId`-stable identity for updates ([S2], [S13]).
2. **"Dreaming" = async consolidation.** A second phase extracts facts, links relations, resolves
   contradictions, and produces `derives` facts never stated in one place. Default `dynamic` groups related
   documents and "may continue after `status: done`"; extraction keeps fresh content queryable in the
   meantime ([S2], [S3]).
3. **Typed relations + version chains.** `updates` (new fact replaces old for search; `isLatest` keeps
   history), `extends` (both valid), `derives` (inferred). Search exposes `version`, `rootMemoryId`, and
   `context.parents/children/related` with relative version distance ([S3], [S5]).
4. **Automatic forgetting.** Time-based expiry (`forgetAfter`), contradiction (updates win), noise
   filtering; forgotten memories recoverable via `include.forgottenMemories` ([S3], [S4]).
5. **Single-call search.** `POST /v4/search`, `searchMode: memories|documents|hybrid`, `threshold`,
   `rerank` (~+100ms), `rewriteQuery` (~+400ms), AND/OR metadata filters, `include` extras, and
   `aggregate` — multiple memories synthesized into one result slot (`isAggregated`) ([S4], [S5]).
6. **Memory CRUD + safe destructive ops (v4).** Direct create (1–100, ≤10k chars, `isStatic`), versioned
   update, soft forget (by id or content, `forgetReason`), and agentic bulk forget with `dryRun` →
   exact-`ids` apply, `threshold`/`maxForget` bounds, `forgetBatchId` traceability ([S6]).
7. **Inference review queue.** `isInference` facts are down-weighted until `approve|decline|undo`
   (`decline` soft-forgets); queue ≤50 ordered by `parentCount` ([S7]).
8. **Profiles.** Per-container static + dynamic facts plus topic **buckets**, one call (~50ms claimed),
   filterable; facts that must ride along regardless of query ([S8], [S13]).
9. **Coding-agent plugins (OSS).** Claude Code: reasoned recall, auto-capture, team memory separate from
   personal, `/supermemory:index` codebase-architecture indexing, signal-keyword extraction config
   ([S11]). Codex: recall-before-prompt + flush-on-stop hooks, incremental capture every 3 turns,
   `<private>` redaction, user tag = hash(git email), project tag = hash(git common dir), worktree isolation
   flag, explicit skills ([S12]). Cursor/OpenCode/Muse/OpenClaw/Hermes plugins also exist ([S13]); Cursor
   et al. share one repo container tag `repo_<name>__<hash(normalized git remote)>` with an `sm_scope`
   metadata discriminator (verified 10-03, [S15]).
10. **MCP + CLI + SDKs.** Remote MCP (`mcp.supermemory.ai`) with OAuth, spaces, 8 tools + widgets
    (10-03, [S16]); `npx supermemory` CLI (`setup`, `add`, `search`, `profile`, `docs`, `tags`, `config`,
    `whoami`, `help --json`); official TS/Python SDKs; framework wrappers under `@supermemory/tools`
    ([S13], [S17]).
11. **Local/self-host.** One binary, port 6767, embedded graph engine, local embeddings
    (`Xenova/bge-base-en-v1.5`), BYO LLM incl. Ollama, full Memory API — but **closed binary, lite
    license, telemetry on by default**, and without connectors, managed MCP endpoints, or the tuned
    extraction model ([S10], [S13]).
12. **Benchmarks as marketing.** Self-reported #1 on LongMemEval/LoCoMo/ConvoMem; "95% Recall@15 with ~720
    tokens (99.4% context reduction)"; SMFS token claims (3.0× Claude, 1.75× Codex on xAFS); plus the
    open-source **MemoryBench** harness and an agent skill (`npx skills add supermemoryai/memorybench`)
    explicitly for benchmarking competitors ([S13]).

---

## 3. Feature comparison

Priority key: **P0** = beta blocker · **P1** = next (high) · **P2** = parity polish · **P3** = later
expansion. "Shipped" means verified in this tree at `accd63a`.

| # | Capability | onememory today | Supermemory surface | Gap | Pri |
|---|---|---|---|---|---|
| 1 | Typed memory model | **Shipped**: 10 typed layers (episodic, semantic, procedural, working, project, entity, decision, failure, preference, source), status lifecycle with audited `memory_events` transitions, scoring fields (`packages/core`) | Atomic extracted facts + relations in an opaque "temporal vector-graph"; memory types: facts/preferences/episodes ([S3]) | None structural — our model is more explicit than theirs; their internals unpublished | — |
| 2 | Temporal truth | **Shipped**: `valid_from`/`valid_until`, explicit supersession (winner+loser one tx), point-in-time + history reads (`queryCurrent`/`queryAsOf`/`historyOf`); payload rows hydrated per version (M3d) | `updates` relation + `isLatest` + version chains (`rootMemoryId`, parents/children) set automatically by dreaming ([S3], [S5]) | **Automatic** contradiction detection + authority resolution (M14). Ours is audited and PIT-correct but currently manual | **P0** |
| 3 | Consolidation ("dreaming") | **Not shipped**: no `packages/consolidation`; near-dup merge, episodic→semantic derivation, decay/archive, contradiction resolution all pending (M14); `sweepWorking` primitive exists but nothing calls it | Async dreaming: fact extraction, linking, contradiction resolution, derived facts; fresh content stays queryable while it catches up ([S2], [S3]) | The single biggest agent-experience gap: memories accumulate stale duplicates without it | **P0** |
| 4 | Forgetting & decay | **Shipped**: soft forget + `restore`, revision-gated hard purge, audited; drift-based `stale` marking | `forgetAfter` expiry, contradiction wins, noise filtering, forgotten recoverable in search; bulk forget `dryRun`→`ids`, `maxForget`, `forgetBatchId` ([S3], [S4], [S6]) | Decay scheduler, expiry-on-facts, bulk/semantic forget with dryRun (M14-adjacent) | **P1** |
| 5 | Inference review queue | **Partial**: LLM `semantic_candidate` gating (never direct semantic), confidence/scoring fields; no review flow | `isInference` down-weighted until approve/decline/undo; queue ≤50 by `parentCount` ([S7]) | Review/approve flow for derived memories once M14 derives | **P1** |
| 6 | Profiles / always-on context | **Partial**: `memory_project_context` ≤750-token compact session context (MCP + REST `/context`); working memory surfaced via context endpoint; **no entity profile path** | Static+dynamic profile + topic buckets, one call, filterable, rides along without a query ([S8], [S13]) | Project digest rollup (M4.6/M14.5) covers the project case; entity/user profile path is a design decision, not yet built | **P1** |
| 7 | Search surface | **Shipped**: lexical (ts_rank) + vector + 1–2-hop graph channels, RRF k=60 fusion, type-affinity weights, threshold, token-budget packer, explain, degraded-mode warnings, caches (`packages/retrieval`) | Single call; `memories\|documents\|hybrid`, `rerank`, `rewriteQuery`, AND/OR metadata filters, `include` extras, `aggregate` synthesis ([S4], [S5]) | Reranker provider (port exists, degraded mode only), query rewriting, arbitrary metadata filter language, result payload hydration (M3d cut) | **P2** |
| 8 | Token efficiency | **Shipped** (mechanism): budget packer never over-budget/mid-sentence, progressive disclosure (ID-index + estimates → `memory_get`), ≤750-token context; **no published numbers** | Claimed ~10 tokens/fact, aggregate slots, 99.4% context reduction, SMFS 3.0×/1.75× — self-reported ([S13]) | Mechanism parity is good; credibility gap only — publish measurements (M11) | **P0** (claims) |
| 9 | Capture from coding agents | **Shipped (2 runtimes)**: Claude Code hooks (SessionStart context injection, PostToolUse terminal/file/git events, PostToolUseFailure errors, Stop transcript-delta capture, SessionEnd) + `.mcp.json` scaffold; Codex rollout backfill with `call_id`-correlated tool names and *honest* status (no fabricated failures, M7b) | Claude Code plugin: reasoned recall, auto-capture, signal extraction; Codex: `UserPromptSubmit` recall + `Stop` flush, every-3-turns capture, `<private>` redaction ([S11], [S12]) | Rough parity for 2/5 runtimes; our capture is provenance-strict, theirs is broader but unverified-status | — |
| 10 | Runtime coverage | **Shipped**: Claude Code, Codex (project scope; `init --with-claude --with-codex`); MCP for everything else | Plugins: Claude Code, Cursor, Codex, OpenCode, Muse, OpenClaw, Hermes (+ MCP) ([S13]) | Cursor (M8), OpenCode + Pi (M9); user-scope wiring follow-up | **P1** |
| 11 | Explicit memory tools (MCP) | **Shipped**: 8 tools default (search/get/store/update/forget/delete/related/project_context) + 3 profile tools (decisions/failures/skills); stdio + stateless Streamable HTTP at `/mcp`; `outputSchema`, annotations, descriptions ≤2048 | Consumer MCP: 8 tools + widgets + resources + prompt (10-03, [S16]); docs MCP + agent skill for builders ([S17]) | Tool-count parity; no client-specific widgets (fine) | — |
| 12 | Provenance / evidence | **Shipped, mandatory**: no durable memory without source + evidence; decisions echo provenance; failures written only when a cited event reproduces the engine signature | Memories carry metadata + source document linkage; inferred facts flagged — but provenance granularity is theirs to claim, not verify ([S5], [S7]) | **Our advantage** — keep it load-bearing in all new surfaces | — |
| 13 | Code memory | **Shipped**: repo registry + fingerprint checkpoints, blob-SHA file tiers, zero-token drift oracle, rename-aware detection, tree-sitter symbols (TS/JS/Py/Go/Rust, span hashes), drift apply (audited stale + exact-move retarget + CAS checkpoint); DoD fixture green (M4a–4e) | AST-aware code chunking (`code-chunk`, OSS); `/supermemory:index` codebase-architecture indexing ([S13], [S11]) | We exceed on drift/staleness; they expose an *index command* to users — we expose nothing yet | **P0** (expose) |
| 14 | Code-memory orchestration | **Not shipped**: re-index of stale memories (re-extract/re-embed only drifted paths), `drift_scan` scheduling, architecture digest, CLI/doctor/MCP exposure — primitives exist, orchestrator doesn't (M4 out-of-scope lists) | `dreaming` runs automatically; indexing is a user command ([S2], [S11]) | Stale memories currently stay stale until future work refreshes them | **P0** |
| 15 | Skills from failures | **Not shipped**: `memory_skills` serves promoted procedural memories only; no recurrence counting, SKILL.md generation, or review flow (M15) | No equivalent shipped product (explicit skills commands only, [S12]) | **Our differentiator**; failure payloads + signatures already persisted (M3d) | **P1** (differentiator, not parity) |
| 16 | Storage & deployment | **Shipped**: PGlite embedded + Postgres 17/pgvector server, same repositories/migrations, real transactions on both (M3d driver fix), scoped dedupe, atomic payload writes; REST `/v1/*` + OpenAPI | One closed binary w/ embedded engine (lite license, telemetry default-on), or hosted SaaS; same API both ([S10], [S13]) | **Our advantage** (open, dialect-pure, 3 deployment modes). Their zero-ops binary UX is the thing to envy operationally | — |
| 17 | Security / privacy | **Shipped**: ingest redaction (incl. tool-name-embedded secrets), path exclusions, taint tests, enforced zero-network default profile, secrets never in DB/logs/prompts | SOC 2 / GDPR / HIPAA on platform; self-host collects telemetry by default, URL fetch is a hosted service ([S10], [S14]) | None for the coding-agent beta; enterprise compliance is later | — |
| 18 | Multi-tenancy / scoped keys | **Partial**: project+user isolation enforced at storage layer (tests); SaaS/org mode explicitly post-1.0 (ADR-0011) | `containerTag` hard boundary, 403-not-filter scoped keys, org roles, tag merge/delete ([S9], [S18]-10-03) | Deliberately deferred; not needed for beta | **P3** |
| 19 | Observability | **Partial**: `doctor` (storage, local-mode guard, runtimes, daemon summary — M13b), `stats`, `inspect`; **no capture-health ledger / adapter-state view yet** (cross-follow-up #7) | Console, analytics/usage endpoints, plugin status commands ([S11], [S12]) | Capture-delivery visibility is a beta-quality item for long sessions | **P1** |
| 20 | Eval & benchmarks | **Not shipped**: no `benchmarks/` directory exists | MemoryBench OSS harness + agent skill + self-reported #1s ([S13]) | Without any published numbers we cannot claim comparability; theirs are self-reported but contestable via their own harness | **P0** (for claims) |
| 21 | Connectors / multimodal ingest | **Not shipped, out of local-first scope** | Drive/Gmail/Notion/OneDrive/S3/GitHub/Web Crawler with webhooks; PDF/OCR/audio/video ([S13]) | Deliberate non-goal for beta; a git-repo docs connector is the only one that touches our users | **P3** |
| 22 | Session-end working-memory sweep | **Primitive only**: `sweepWorking` (TTL purge, promoted-row retention) exists in storage; **nothing invokes it** (no callers outside one scenario) | Codex `Stop` flush hook guarantees capture ([S12]) | Wire the sweep to session end (M14.5) so working memory promotes/expires | **P0** |

---

## 4. Major uncertainty and tradeoff: hosted-first vs local-first

- **The deployment models are genuinely different products.** Supermemory is a hosted memory API whose
  local binary is an on-ramp (closed engine, lite license, telemetry default-on, hosted URL reader) — the
  platform is "where the full product lives" ([S10]). onememory is local-first by invariant: no account,
  no telemetry, enforced zero-network default, Apache-2.0, same schema from PGlite to hosted Postgres
  (AGENTS.md). **Parity must be defined at the agent experience layer** — what the agent captures, how
  correct and how cheap its recall is, how trustworthy its memory feels — not by replicating SaaS
  plumbing. Chasing containerTag-style org tenancy, connectors, or billing now would copy their cost
  structure without their moat.
- **Their moat is a proprietary extraction model; ours must be verifiable structure.** Their docs say the
  hosted differentiator is "proprietary models, purpose-tuned for long-horizon data understanding" and
  that self-host extraction is strictly worse ("your model, your key") ([S10]). We cannot and should not
  compete on a secret model; we compete on mandatory provenance, audited transitions, PIT truth, and an
  honest no-LLM default — which is also why our eval harness (M11) must publish numbers instead of
  adjectives.
- **Uncertainties to keep honest:** (a) Supermemory's internals (storage engine, fusion, dedup rules,
  extraction prompts) are unpublished — treat "temporal vector-graph" and "learning model" as marketing
  labels; (b) their benchmark figures are self-reported through their own harness and judge, and the two
  LongMemEval numbers in circulation (95% Recall@15 vs 97% Recall@20) are different configs — never cite
  them as one number; (c) their API carries parallel `/v3`+`/v4` surfaces and deprecated flags
  (`include.chunks`) — their surface moves, so date-stamp every comparison; (d) their plugin capture
  assumes success signals we have *proven absent* on the Codex rollout wire (M7b) — their plugins may
  silently trust `ok:true`; that is an honesty gap on their side we should not imitate.
- **Tradeoff to watch:** their closed-binary disclosure (2026-10-04, [S14]) both strengthens our
  positioning and raises their incentive to re-open the engine if local-first demand grows. Our answer is
  execution speed on the loop below, not messaging.

---

## 5. What to build next (prioritized sequence)

### Tier A — true beta blockers (the "comparable agent experience" set)

1. **M14 consolidation core.** Contradiction detection + authority resolution (explicit > decision > newer
   > confidence; tie → `disputed`), near-duplicate merge (≥0.97 cosine, same scope), episodic→semantic
   derivation with `derived_from`, decay/archive scheduler, and **wire the existing `sweepWorking`
   primitive to session end** so working memory promotes or expires. This is the dreaming gap — without
   it, every long-lived project accrues the stale-duplicate swamp memory products exist to prevent.
2. **Finish M4's last mile: re-index orchestration + exposure.** Enqueue `drift_scan`/`reindex` on a
   schedule (job kinds already exist, nothing enqueues them), re-extract/re-embed only drifted paths,
   build the architecture digest under token budget, and surface drift state in `doctor`/CLI/MCP so users
   can see and trigger it. The DoD keystone (edit one file → only its memories go stale) already passes;
   today those memories *stay* stale.
3. **Install robustness P1s (cross-follow-ups #9, #5).** Published hook-invocation contract so a clean
   external project using the published package runs every generated hook without repo-local paths; stdio
   embedded-owner guard so `onemem-mcp` refuses a second PGlite owner while the daemon is alive. Both are
   small, both break real first impressions.
4. **M11a minimal eval harness + published baseline.** Golden dataset (repeated/contradictory/outdated
   facts, failure/solution pairs) + metrics (temporal accuracy, contradiction accuracy, consolidation
   quality, retrieval precision/recall, tokens-per-answer) with CI gates. Supermemory makes comparability
   claims *contestable* via MemoryBench and even ships a skill to benchmark competitors ([S13]); we
   currently have no `benchmarks/` directory at all. Functionally the engine runs without it;
   positionally, "comparable" is unevidenced without it.

### Tier B — next parity (after the loop closes)

5. **M8 Cursor + M9 OpenCode/Pi adapters** (repo's Phase 4): conformance suite already exists to reuse;
   "one memory across every agent" is untrue at 2/5 runtimes. Add user-scope runtime wiring and
   per-runtime identity (cross-follow-ups #10, #11) as part of this.
6. **Project digest as the profile analog** (M14.5 rollup feeding `memory_project_context`): a
   static/dynamic split of project facts served in one call. Decide explicitly whether an entity/user
   profile path is in scope — preference-layer memories exist; a profile read path is cheap once
   consolidation maintains them.
7. **Retrieval parity polish (P2):** optional reranker behind the existing port, query rewriting,
   search-result payload hydration (M3d follow-up #3), and a decision on an AND/OR metadata filter
   language vs the current scope filters.
8. **Trust model for derived memories (P1, rides on M14):** candidate review flow — derived/inferred
   memories down-weighted until approve/decline (decline soft-forgets), mirroring their `isInference`
   queue ([S7]) but with our provenance attached.
9. **Bulk forget with dryRun→ids and expiry** (P2, M14-adjacent): the two-phase pattern is proven safe by
   our own purge flow; copy `maxForget` bounding.
10. **Doctor capture health (P1, small):** delivery ledger for capture hooks + adapter-state surface
    (cross-follow-up #7) — long sessions are where silent capture loss hurts most.

### Tier C — later expansion / differentiators (post-beta)

11. **M15 skill generation** (our differentiator — no Supermemory equivalent): failure recurrence
    matching (signatures already persisted, counting is M14/M15), verified-solution → SKILL.md
    candidates, review flow, serving via MCP + filesystem. Failure-payload persistence (M3d) makes this
    mostly an orchestration + generation effort.
12. **M10 web UI** (verify-every-claim console), **M5b MCP OAuth for server mode**, **SaaS/multi-tenant
    mode** (ADR-0011, explicitly post-1.0), scoped credentials with 403-not-filter semantics.
13. **Deliberately do not build:** hosted proprietary extraction, connector cloud sync, SMFS-style
    filesystem mounts, diff billing, 20+ framework wrappers (MCP is the wrapper), enterprise compliance
    packaging. Each is their hosted product, not our agent experience.

---

## 6. Sources (all Supermemory claims)

Fetched and verified 2026-10-04/05 unless noted:

- **[S1]** Docs machine index: https://supermemory.ai/docs/llms.txt
- **[S2]** How Supermemory works (pipeline, dreaming, two-plane outputs, customId): https://supermemory.ai/docs/concepts/how-it-works
- **[S3]** Graph memory (updates/extends/derives, isLatest, memory types, forgetting): https://supermemory.ai/docs/concepts/graph-memory
- **[S4]** Search (modes, threshold, rerank, rewriteQuery, filters, include.forgottenMemories): https://supermemory.ai/docs/recall/search
- **[S5]** Search memory entries — live OpenAPI (`aggregate`, `isAggregated`, `version`, `rootMemoryId`, `context.parents/children/related`, deprecated `include.chunks`, threshold default 0.6): https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries · spec: https://api.supermemory.ai/v4/openapi
- **[S6]** Memory operations v4 (direct create, versioned update, forget, forget-matching dryRun/ids/maxForget/forgetBatchId): https://supermemory.ai/docs/recall/memory-operations
- **[S7]** Review inferred memories (isInference down-weighting, approve/decline/undo, queue ≤50): https://supermemory.ai/docs/recall/memory-review
- **[S8]** User profiles (static/dynamic, buckets, filters, one-call): https://supermemory.ai/docs/concepts/user-profiles
- **[S9]** Multi-tenancy (containerTag hard boundary, metadata inside tag, 403-not-filter): https://supermemory.ai/docs/concepts/multi-tenancy
- **[S10]** Supermemory local (embedded engine, local embeddings, BYO LLM, **non-public binary, lite license, telemetry default-on, hosted URL reader**, platform exclusions): https://supermemory.ai/docs/self-hosting/overview
- **[S11]** Claude Code integration (reasoned recall, auto-capture, team memory, `/supermemory:index`, settings): https://supermemory.ai/docs/integrations/claude-code
- **[S12]** Codex integration (UserPromptSubmit/Stop hooks, every-3-turns capture, hashed git scopes, skills): https://supermemory.ai/docs/integrations/codex
- **[S13]** Flagship repo README (31.1k stars, MIT; plugins list; MCP; MemoryBench + skill; benchmark claims; SMFS claims; local section): https://github.com/supermemoryai/supermemory
- **[S14]** Disclosure commit "docs: disclose current self-hosted security and telemetry behavior" (PR #1711, 2026-10-04): https://github.com/supermemoryai/supermemory/commit/7cc19fa34683a4fe74166ee5d794d271a21b5a92
- **[S15]** Cursor integration (cross-agent `repo_<name>__<hash>` tag + `sm_scope`) — verified 2026-10-03: https://supermemory.ai/docs/integrations/cursor
- **[S16]** Supermemory MCP (8 tools, widgets, resources) — verified 2026-10-03: https://supermemory.ai/docs/supermemory-mcp/mcp
- **[S17]** Agents, skills and MCP (`npx supermemory` CLI, docs MCP, agent skill) — verified 2026-10-03: https://supermemory.ai/docs/agents-and-mcp
- **[S18]** Authentication (org + scoped keys, scoped-key rate limits) — verified 2026-10-03: https://supermemory.ai/docs/authentication

Companion deep-dive with full architecture, API, pricing, and OSS-license detail (research date
2026-10-03, same cutoff window): `docs/research/supermemory.md`.

### onememory evidence (local)

- Shipped inventory: `README.md` (Phase 1 status), `docs/plan/phased-plan.md` (DoD evidence), `docs/plan/mission-reports/mission-{1,2,3,3b,3c,3d,4,4b,4c,4d,4e,5,6,7,7b,12,13,13b}.md`, `docs/backlog/issues.md` (pending + cross-follow-ups).
- Verified in code at `accd63a`: CLI commands `apps/cli/src/bin.ts` (init, serve, doctor, search, remember, forget, restore, inspect, stats); REST routes `apps/api/src/server/app.ts` (`/v1/health|doctor|projects…` events/search/decisions/failures/context/memories CRUD/forget/restore/purge/stats, `/openapi.json`, MCP at `/mcp`); MCP tool registry `packages/mcp/src/descriptions.ts` (8+3 tools); retrieval channels/RRF `packages/retrieval/src/config.ts` + snapshots; Claude hook map `packages/adapters/claude/src/translate.ts`; Codex translator `packages/adapters/codex/src/translate-rollout.ts`; working-memory sweep primitive `packages/storage/src/repositories/working-memory.ts` (no daemon caller); skills handler `packages/mcp/src/handlers.ts` (procedural-memories listing).
- Absences verified by tree inspection: no `packages/consolidation`, no `packages/adapters/{cursor,pi,opencode}`, no `benchmarks/`, no `apps/web`.
