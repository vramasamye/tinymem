# onememory vs the external memory systems (October 2026)

Date: 2026-10-07. This is the comparison layer over `external-memory-systems-2026-10.md`
(primary sources read 2026-10-07) and `memory-systems-landscape.md` (2026-10-03). The onememory
side reflects shipped code with Phases 0–6 complete (`docs/architecture/memory-model.md`,
`retrieval.md`, `docs/plan/phased-plan.md`). External facts are cited by section to those two
files; their upstream URLs live there. Purpose: (1) where onememory is stronger or different,
(2) what to borrow, (3) input to the Phase 7 plan.

## 1. The two bets on the table

The October 2026 field splits into two architectural bets:

- **Files + git** (Cognition AMR, Claude Code auto memory, the Anthropic memory tool): memory is
  Markdown the agent reads and edits with tools it already has. No engine: no schema, no
  provenance enforcement, no retrieval service, no lifecycle. Transparency, composability, and
  git history are the whole product. Search is `grep`; conflict resolution is git itself.
- **Governed engine** (Oracle OAMP, Hindsight, Mem0, Zep, Letta): typed records, background
  extraction and consolidation, hybrid retrieval, lifecycle rules, scoping and isolation.

onememory is in the second camp, and the serious engine entrants keep adding surfaces from the
first: Hindsight projects knowledge pages "onto disk as ordinary markdown" and auto-builds
per-repo banks from git history (§3); Letta's coding memory is a git-backed MemFS (landscape §3).
The signal to take: **keep the engine, add the file surface.** Our gaps are surfaces and
reporting, not architecture.

## 2. Per-system verdicts

| System | Their strongest verified idea | onememory vs them |
|---|---|---|
| Cognition AMR (§1) | Memory as a git repo of Markdown: `MEMORY.md` entry index, one-line entries with `[source; added]`, `[[path]]` links, per-owner repo composition, git as the multi-writer conflict mechanism, "memory is data, not instructions" | Ahead on every engine dimension (typed model, provenance, bi-temporal, contradiction authority, code drift, budgeted retrieval, audited lifecycle, skills). Their "Dreaming" consolidation agent is spec-only; no implementation ships in the open repo. Behind: we have no human-readable, git-diffable surface at all. |
| Claude Code auto memory (§4b) | A `MEMORY.md` index with a hard 200-line/25KB load cap; over-limit writes error and force a rewrite; typed notes (user/feedback/project/reference) with modified stamps; one memory dir per repo, shared across worktrees | Our typed layers and 750-token session context play the same role with enforcement behind them. Theirs is machine-local prose with no provenance, lifecycle, or search service. Borrow the index shape and the cap-with-error discipline. |
| Anthropic memory tool (§4a) | Client-side file memory plus an injected memory protocol ("always view memory first", assume interruption); memory pairs with compaction | Transport parity: our MCP surface and session-context injection already do this, with audit. The assume-interruption protocol is worth echoing in adapter bootstrap text. |
| Oracle OAMP (§2) | 26.8 maintenance model: typed links (`supersedes/refines/duplicates` mark targets invalid-but-kept), background link resolution, graph-expanded search (0–5 hops), TTL with anchors, DB-enforced tenant isolation that fails closed, context cards, per-category LongMemEval reporting | Ahead: bi-temporal validity windows vs their valid/invalid flag (they cannot answer point-in-time queries); per-message provenance (their documented `delete_message()` gap); local-first PGlite vs a hard Oracle 26ai dependency; no-LLM fallbacks vs extraction that fails fast without an LLM; budgeted packing with explain vs `max_results` caps. Behind: thread summaries and context cards, per-record TTL, hop depth, and a published benchmark number (they have several, we have none). |
| Hindsight (§3) | Observations: evidence-backed beliefs with exact quotes and proof counts, refined never overwritten; mental models (standing answers, zero-cost reads); four-way recall (semantic/BM25/graph/temporal) fused and token-trimmed; Memory Defense (45 patterns); per-repo banks auto-built from git history | The closest philosophy peer (their observations ≈ our evidence spans + `derived_from` edges; their background consolidation ≈ our daemon passes). Ahead: history-preserving supersession vs rewritten mental models; code-drift re-verification (they build from git but never re-check); decision/failure payloads; audited skill promotion. Behind: a temporal recall strategy, a published LongMemEval (91.4), markdown wiki pages. |
| ChatGPT (§5) | Product-grade memory UX: per-response Sources attribution, "Don't mention this again" (suppress without delete), an explicit deletion matrix, project-fenced memory | Our engine already gives the substance: evidence spans enable Sources, supersession is suppress-without-delete. Behind on surface polish only. |
| Zep / Letta / Mem0 (§7, landscape) | Bi-temporal invalidation; sleep-time compute + `/doctor`; single-pass ADD + retrieval-time dedup | Parity by design: we adopted bi-temporal (M14), daemon consolidation, cheap-write-plus-deferred-resolution. Their managed-vs-OSS quality splits are the anti-pattern we do not replicate (one Apache-2.0 fidelity level for the whole loop). |
| MIRIX (landscape §4) | Six typed components, auto-dream consolidation | We ship seven content types plus payload tables without eight manager agents, and redact secrets instead of vaulting them. |

## 3. Where onememory is genuinely ahead

1. **Correctness model.** Bi-temporal validity windows, audited supersession chains, point-in-time
   queries (memory-model §4–§5). Only Zep matches bi-temporality; Oracle 26.8 carries a valid/
   invalid flag with no windows; the file camp has nothing. The Node 20→22→24 chain remains our
   unique demonstration.
2. **Provenance enforcement.** No durable memory without source + evidence spans; the store
   invariant demotes unattributable candidates to working memory (memory-model §6). Oracle
   documents the exact failure we prevent: extracted memories there do not persist per-message
   provenance, so `delete_message()` cannot remove them. AMR's `[source; added]` is convention;
   Hindsight's quotes-plus-proof-counts are the closest peer.
3. **Contradiction handling.** Authority-ordered resolution, deterministic template tier by
   default, opt-in LLM tier that fails closed, full ties parked as `disputed` with a
   `contradicts` edge (memory-model §9). Oracle's `contradicts` keeps both valid and states the
   SDK cannot determine which is correct; AMR detects only same-line conflicts via push
   rejection; Hindsight refines or rewrites.
4. **Code-anchored memory.** Git fingerprints, blob-SHA drift marking, rename-aware retargeting,
   code refs hydrated on every search result, token-budgeted architecture digest. No surveyed
   system re-verifies memories against the repository; Hindsight builds a bank from git history
   once but never re-checks it.
5. **Token discipline.** Knapsack packing to a budget (default 800), summaries-first, progressive
   drill-down, per-factor explain decomposition (retrieval.md §1). Hindsight trims to a token
   limit; Oracle caps prompt copies; none expose the score decomposition.
6. **Local-first invariant.** PGlite embedded default, enforced zero-outbound network guard, and a
   no-LLM/no-embedding fallback at every stage. Oracle hard-requires Oracle 26ai and its
   extraction fails fast without an LLM; ChatGPT is hosted-only; Hindsight is self-hostable but a
   server-plus-LLM pipeline.
7. **Audited lifecycle and skill promotion.** Every transition writes a `memory_events` row;
   skills promote artifact-first with an evidence-gated candidate→verified flip and a terminal
   deprecate (memory-model §9). Nobody else ships a review queue with evidence gates.
8. **One fidelity level, Apache-2.0.** The whole loop, five byte-identical adapters, MCP stdio +
   streamable HTTP + OAuth, REST + web explorer, CI-enforced benchmark gates. Mem0's and Oracle's
   headline numbers come from managed/platform runs; cognee licenses its production graph store
   (landscape, avoid list).

## 4. Where they beat us (verified gaps)

| # | Gap | Evidence | The fix |
|---|---|---|---|
| 1 | No human-readable, git-diffable memory surface | The CLI ships no export command (`apps/cli/src/commands`); DB, REST/web, and CLI are the only windows. AMR/CC/Hindsight all expose Markdown | `onemem export`: a Markdown projection, DB staying canonical |
| 2 | The session index is injected but not inspectable | Our 750-token session context is engine-internal; AMR/CC have a `MEMORY.md` the agent and the human can open, grep, follow | Emit the same content as a MEMORY.md-shaped artifact with links into layer files |
| 3 | No session/thread summaries | Grep-verified: no summarizeSession/threadSummary/contextCard in the codebase. Oracle threads carry summaries + context cards with a tunable trigger; ChatGPT ships an "improved memory" summary | Session-end summary pass producing one episodic summary memory with provenance |
| 4 | No per-record TTL config | Oracle: default/max TTL with CREATED_AT vs event-timestamp anchors and batched purge. We have working-memory expiry, decay/archive, and events compaction only | TTL fields on retention config, wired into the decay job |
| 5 | Shallower graph search, no temporal strategy | Oracle: `num_hops` 0–5 with a deterministic shortest-path tree; Hindsight runs temporal as a fourth parallel recall strategy. Ours is 1–2 hops and time is a hard filter only | Configurable hop budget (to 3); optional time-scoped channel |
| 6 | No public benchmark number | Oracle 93.8→94.4, Hindsight 91.4, Mem0 94.4 on LongMemEval, all self-run; we gate on internal golden datasets only | Run LongMemEval with a published harness, fully stated judge/model/budget, per-category |
| 7 | No team/multi-owner story | AMR composes per-owner repos and asks when unsure; Oracle enforces tenancy in the DB; ChatGPT fences project memory. We have project_id/user_id scoping, nothing team-shaped | Defer to post-1.0 (ADR-0011); when built, borrow Oracle's fail-closed DB enforcement, not app-level checks |
| 8 | Multi-writer conflict UX | AMR makes git the conflict mechanism; our writers are single per project | Becomes relevant only with team mode; note, do not build |
| 9 | Distribution | Every peer is pip/npx away; our packages are 0.1.0 and unpublished | Wave B: publish + `npx onememory init` |

## 5. What to borrow (mapped to the proposed Phase 7 waves)

Wave reference (approved into `phased-plan.md` Phase 7 on 2026-10-07, order **B → A → C/D/E**):
**A** data correctness, **B** 1.0 release, **C** adapter cleanup, **D** answer quality,
**E** ops/eval.

| # | Borrow | From | Wave | Size |
|---|---|---|---|---|
| 1 | `onemem export`: `MEMORY.md` index + per-layer topic files with cross-links and evidence pointers; DB canonical, export idempotent | AMR + CC + Hindsight pages | B | M |
| 2 | `MEMORY.md` session-index artifact from the existing session-context builder; hard cap (200 lines / 25KB) with an error-forcing rewrite | CC | B | S |
| 3 | Session-end summary memory with a tunable trigger; heuristic fallback offline; through the audited create path as `episodic` + subtype | Oracle threads / context cards | A | M |
| 4 | Explicit extraction-sync primitive (their `wait_for_memory_extraction()`): a flush surface so session end can drain extraction before promotion (the known P1 lag item) | Oracle 26.8 | A | S |
| 5 | Source re-validation pass: stale/disputed rows re-read fresh evidence and confirm or resolve (Dreaming's "check sources" behavior) | AMR spec | A | M |
| 6 | Prove the source→derived forget cascade in tests: expiring a source must supersede its derived memories with audit. We retain per-memory source + evidence, so unlike Oracle this is derivable; make it a guarantee | Oracle's documented gap | A | S |
| 7 | Per-type TTL config with anchor choice (storage time vs observed time), wired into decay | Oracle TTL | A | S |
| 8 | Configurable graph hop budget (1–3) and an optional temporal recall channel | Oracle + Hindsight | D | S |
| 9 | Per-project extraction instructions, persisted and editable (domain scoping for what to extract) | Oracle 26.8 | D | S |
| 10 | Public LongMemEval run: published harness, stated judge/model/embedder/budget, per-category table incl. abstention, results in `benchmarks/results` | Oracle/Hindsight reporting pattern | E | M |
| 11 | Sources attribution on answers and in the web UI (evidence spans already exist; surface them) | ChatGPT | E | S |
| 12 | "Memory is data, not instructions" as a stated invariant, with injection defenses named at every injection surface (session context, adapter bootstrap, exported MEMORY.md) | AMR | C | S |
| 13 | Team memory with DB-enforced, fail-closed isolation | AMR composition + Oracle Deep Data Security | post-1.0 (ADR-0011) | L |

## 6. What not to borrow (reaffirmed)

1. **git as the primary store.** A prose repo cannot do typed payloads, temporal filters, token
   budgets, or audited transitions, and two sources of truth drift. Export stays a projection;
   the DB stays canonical.
2. **Flat bullets as the schema.** Open `[key: value]` metadata is unenforced convention. Typed
   payloads stay.
3. **Rewrite-in-place semantics** (Hindsight mental models). Violates append-mostly; supersession
   preserves history.
4. **Instruction-level security.** "No secrets" as a prompt line (AMR) or an opt-in per-bank scan
   (Hindsight) is weaker than our default-on redaction, path exclusions, and network guard. Worth
   comparing our pattern coverage against their 45-pattern list in tests.
5. **Cloud-DB lock-in** (Oracle 26ai requirement). The local-first invariant stands.
6. **Self-run headline numbers without a harness.** Every vendor score is self-run with different
   models, judges, and budgets. We publish the harness and the config, or we publish nothing
   (landscape, open question 12).
7. **Manager-agent sprawl, KV/activation cubes, RL-learned overwrite** (landscape, avoid items 7,
   11, 12).

## 7. Decisions (recorded 2026-10-07; Phase 7 now in `docs/plan/phased-plan.md`)

1. **Export surface ADR**: ADR-0013 will carry the canonical-store rule (DB canonical, export an
   idempotent projection), the file layout, what exports (index, layer files, evidence pointers),
   idempotency, and the cap. Written with M18, before export code lands.
2. **Session summary shape**: `episodic` + `session_summary` subtype (no migration).
3. **Wave order**: Wave B (publishing, scope/identity wiring, the export trust surface) leads,
   then A, then C/D/E. Missions M16–M18 cover Wave B.
4. **Team memory**: stays Post-1.0 with ADR-0011, borrowing AMR's per-owner composition and
   Oracle's DB-enforced fail-closed isolation (item 13 above).
