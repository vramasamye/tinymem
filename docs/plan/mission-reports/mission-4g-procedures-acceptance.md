# Mission 4g: procedures-with-code-refs acceptance test (the last Phase 2 DoD check)

Branch: `mission/4g-procedures-acceptance` · Base: `cb0cb20` · phased-plan.md Phase 2 DoD:
"How does authentication work?" returns procedures with code refs.

**Verdict: the Phase 2 DoD is NOT met — only partially demonstrated.** The query does return a
procedural answer through the real pipeline, but the retrieval search response does not expose
persisted code refs (finding F5, asserted over the actual search result): no consumer of the
query response can receive the refs. This mission's test demonstrates the partial state honestly
and pins it; closing the gap needs a retrieval-surface change that is outside this mission's
new-files-only scope.

## Delivered scope

Two files, no edits to any pre-existing file:

- **`apps/api/src/runtime/procedures-acceptance.test.ts`** — the acceptance test for the last
  undemonstrated Phase 2 DoD line (the digest half shipped with M4f). It runs the REAL pipeline
  end to end — real PGlite embedded storage, a real fixture Git repository, the real
  `document.added`/`conversation.message`/`git.commit`/`explicit.remember`/`terminal.output`
  event stream, the real extract-job handler (`createExtractHandler` over the real heuristic
  extractor + classifier), the real `CodeMemoryStore` write port, and the real retrieval engine —
  under `@onememory-ai/security`'s network guard (zero model calls, zero network, local-first
  invariant intact).

The test is deliberately **two-phased so it demonstrates the DoD without contriving it**:

1. **Phase 1 — the honest gap, asserted.** A realistic auth module (`src/auth/login.ts`,
   `src/auth/session.ts`, `src/auth/middleware.ts`, `src/auth/auth.test.ts`) is committed to a
   real Git repo; the session that reads it emits `document.added` events carrying the REAL file
   text plus the conversation that asks and answers "how does authentication work". All of it
   runs through the real extract job: 8 events processed, 0 `needs_review`, and at least one
   episodic stack memory extracted from the code text — **asserted by tying its evidence
   locator to the exact `document.added` event that carried the file text**, so the result
   below is proven to be a procedural gap, not a broken pipeline — and **zero procedural
   memories** result. That is the product gap, pinned by an explicit assertion so it can
   neither silently regress nor silently "fix" itself.
2. **Phase 2 — the DoD substance through the real procedural input channels.** The two channels
   the heuristic extractor actually mines procedures from — an `explicit.remember`
   (`type: procedural`, the user explicitly asking the engine to remember the auth procedure)
   and a recurring command (`bun test src/auth/` run twice in the session) — run through the
   SAME real extract job and DO produce exactly the two procedural memories: the auth-flow
   procedure (`procedural.sequence`, the user's own wording) and the recurring auth-test
   command (`procedural.command`, "Recurring command: `bun test src/auth/` (used 2 times)"),
   with full provenance (`method: heuristic`) and evidence locators citing the exact events each
   was derived from.
3. **Phase 3 — code refs against the real repository.** `captureSnapshot` fingerprints the real
   fixture repo (worktree-tier blob SHAs), `ensureRepository` + `saveSnapshot` register it, and
   both procedures get refs recorded through the real `recordCodeRefs` port — the same linkage
   the drift/re-index path performs for its winners. The flow procedure carries the three auth
   files; the command procedure carries the auth test file; every recorded `blob_sha` equals
   the real captured snapshot's worktree-tier blob for that path.
4. **Phase 4 — the DoD query through the real retrieval engine, partial and asserted as
   such.** "How does authentication work?" plus two paraphrases ("What is the procedure for
   authentication?", "How can I protect a route?"), under the DEFAULT token budget (no
   `max_tokens` in the request): each classifies `how_to`, returns the auth-flow procedural
   memory as the TOP result with its full content and `explicit` provenance, shows the intent×type
   affinity boost in `explain` (`intent 'how_to' favors type 'procedural'`, weight 0.15 — the
   matrix's largest cell), and stays within budget (`used ≤ budget = 800`). **Asserted over the
   ACTUAL search result: the response does NOT expose the persisted code refs** — no code-ref
   field exists on a returned memory item, and the persisted ref blob SHAs appear nowhere in the
   serialized response — so the DoD's "with code refs" half is NOT met at the retrieval surface
   (F5). A separate, explicitly labeled STORAGE-LEVEL check (not returned refs) verifies that
   the top procedure's persisted refs point at the fixture's real auth files with the real
   captured worktree blobs, reachable only through the separate `CodeMemoryStore.listCodeRefs`
   read.

## Honest findings (the test asserts F1 and the F5 limitation; the report records the rest)

F5 is the finding that decides the DoD line's true status — procedures are returned, code refs
are not.

- **F1 — the heuristic extractor cannot mine procedures from code.** Real auth-module text
  flowing through the real pipeline as `document.added` events (plus the conversation asking
  and answering the very question) yields ZERO procedural memories. Procedures enter durable
  memory only via explicit user intent (`explicit.remember`) or recurring commands
  (`terminal.output`). The DoD query is answered today because those two realistic input
  channels exist — not because the extractor reads code. Consequence: without a user
  explicitly remembering it, an agent that only reads the auth code builds no procedural
  memory of it. Closing this needs a procedure-mining rule for code/documents (or the LLM
  extraction tier behind the model router) — a product decision, deliberately not attempted
  here (a heuristic rule that guesses procedures from code text risks polluting durable
  memory; the extractor's own patterns are intentionally narrow).
- **F2 — fresh extraction has no automatic code-ref linkage.** The pipeline links
  `memory_code_refs` only on the drift/re-index path (refresh/supersede re-records the winner);
  a freshly extracted memory gets its refs from the CALLER through the `recordCodeRefs` port
  (exactly what this test, and M4f's fixture before it, does). A future seam could record refs
  for memories whose evidence carries `file:<path>` locators, or when the extract group's
  session had the path open — needs an ADR before code.
- **F3 — a stale procedural memory can never be re-indexed back to health.** `reindex` supersedes
  a stale memory only with a same-type candidate extracted from the drifted file's text — and
  per F1, document text yields no procedural candidates, so a stale procedural memory always
  defers ("no reproducible knowledge of this type was extracted"). It recovers only through a
  new explicit `explicit.remember`/supersession. A direct consequence of F1 worth its own
  backlog line.
- **F4 — default-profile recall is lexical+graph, so paraphrases must share lexemes.** With no
  embedder configured (the zero-network default), the vector channel is honestly off (warned
  in the response; asserted in the test), and the `simple` FTS dictionary does no stemming. A
  paraphrase like "What are the steps to authenticate a request?" would return nothing for
  content worded "Authentication procedure…" — the test's paraphrases were chosen to share
  lexemes. Recall for true paraphrases is the embedder's job (an opt-in local transformers
  embedder already exists in `@onememory-ai/embeddings`).
- **F5 — the retrieval search response does not expose persisted code refs, so the Phase 2 DoD
  is only partially demonstrated and is NOT met by this mission.** The wire schema
  (`MemorySearchResponse` in `packages/core`) gives a returned memory item
  `id/type/title/summary/content/relevance/explain/temporal/provenance/conflicts` — no
  code-ref field — and the retrieval engine never reads the codememory tables on a search.
  Precisely: this mission demonstrates (a) the query "How does authentication work?" returns a
  procedural answer through the real pipeline, and (b) at the storage level that the answer
  memory's persisted refs point at the real fixture files with real captured blobs — but
  (c) NO consumer of the query response can receive those refs; they are reachable only
  through the separate `CodeMemoryStore.listCodeRefs` read. The test asserts (c) over the
  actual search result (no code-ref field on the returned item; the persisted ref blob SHAs
  appear nowhere in the serialized response) so the partial state is unmistakable, and keeps
  (b) as an explicitly labeled storage-level check, not a claim of returned refs. Closing this
  needs a retrieval-surface change — surfacing refs on search results (a `code_refs` field
  joined from the codememory tables, validated at the wire boundary) — which touches the core
  wire schema and the retrieval engine, and is deliberately outside this mission's
  new-files-only ownership (per AGENTS.md, a schema/response change of that weight goes through
  the coordinating session and an ADR first). This is the finding that decides the Phase 2 DoD
  line's true status: **procedures are returned; code refs are not.**

## Tests (1 new)

- `apps/api/src/runtime/procedures-acceptance.test.ts` — 1 test, 76 `expect()` calls, ~2 s,
  60 s timeout. Covers: phase-1 zero-procedural gap (with at least one episodic memory's
  evidence locator tied to the exact `document.added` event that carried the real code text);
  phase-2 exact procedural contents/subtypes/provenance/evidence locators; phase-3 code refs
  recorded and equal to the real captured blobs; phase-4 the DoD query and two paraphrases
  (intent, top result, content, explain affinity, default budget, the asserted
  code-refs-not-exposed limitation over the actual search result, the labeled storage-level
  ref accuracy check, vector-off warning).

## Validation

- Focused: `bun test apps/api/src/runtime/procedures-acceptance.test.ts` — **1 pass / 0 fail**
  (76 `expect()` calls, ~2 s).
- Full suite at the worktree root: **1230 pass / 22 skip / 0 fail, 1252 tests, 101 files**.
- Baseline re-measured at the base commit `cb0cb20` in a detached temp worktree under the same
  conditions: **1229 pass / 22 skip / 0 fail, 1251 tests, 100 files** — exactly this mission's
  one new test/file more, no regressions.
- Honesty note on two intermediate full-suite runs taken during a machine load spike (load
  average ≈ 6, suite 3668 s vs the normal ~250 s): 7 and then 5 failures, all explicit
  "timed out after 5000ms" hits in `packages/mcp/src/handlers.test.ts` and the storage
  integration leg — files this branch does not touch — with a DIFFERENT failure set each
  run. Every implicated file is green in isolation, and both the base commit and this branch
  are green at normal load (runs above), so those were environment timing flakes, not
  regressions; recorded here rather than silently discarded.
- The 22 skips are the pre-existing Postgres-server integration scenarios
  (`ONEMEMORY_PG_URL` not set — expected offline).
- Typecheck: `bun run typecheck` in `apps/api` (tsc --noEmit) — green, re-run after the
  amendment. No other package was touched.
- No new third-party dependencies. One test-only cross-package relative import
  (`packages/extraction/src/testing/transcripts`, the established pattern from
  `extraction-temporal.test.ts` — the fixture builder is intentionally not exported from the
  package index).

## Ownership

All files were inside the assigned list: the new test under `apps/api/src/runtime/` and this
report under `docs/plan/mission-reports/`. No existing file, root config, ADR, or
`docs/architecture/` file was modified.

## Out of scope / follow-ups (for the backlog)

- **F5 (the DoD-blocking one): surface code refs on the retrieval search response** — a
  `code_refs` field on returned memory items, joined from the codememory tables and validated
  at the wire boundary. Touches the core wire schema + the retrieval engine (and an ADR per
  AGENTS.md), so it is the coordinating session's work, not a mission's; until it lands, the
  Phase 2 DoD line remains only partially demonstrated.
- **F1**: procedure mining from code/document text (or making the LLM extraction tier cover
  it) — the product decision this mission's finding argues for.
- **F2**: an automatic extract→code-ref linkage seam (ADR first).
- **F3**: re-index recovery for stale procedural memories (blocked on F1 by construction).
- **F4**: default-profile vector recall for paraphrase queries (opt-in local embedder already
  exists; wiring default is a product decision).
- CLI/MCP-level demonstration of the same query (`onemem search "How does authentication
  work?"`) — the engine-level acceptance is this mission's scope; the CLI/MCP surfaces are
  already covered by their own tests (and inherit the F5 limitation until it is closed).
