# Mission 5 report — MCP server

**Branch:** `mission/5-mcp-server` (worktree `onemem-m5`, base `8a88e1d`)
**Scope delivered:** `@onememory/mcp` (CLI bin `onemem-mcp`), the model-facing protocol surface of
ADR-0010: 8-tool default profile + `full11`, stdio primary, optional stateless Streamable HTTP,
progressive disclosure, never-silent write outcomes, redaction-on-write, unit + wire-level e2e
tests, this report. No ADR, root-config, or architecture-doc changes.

**Commits**

| Commit | Summary |
|---|---|
| `375f48a` | `feat(mcp)`: MCP server package — 11-tool surface, stdio primary, stateless HTTP opt-in |
| `c63dd32` | `test(mcp)`: handler contract, wire-level e2e, HTTP handler, budgets, config |
| (this) | `docs`: mission-5 report |

---

## 1. What changed

### `packages/mcp` (new package)

Depends on `@modelcontextprotocol/server` **2.3.0** (the v2 split package, verified against the
published tarball — see `docs/research/dependency-verification.md`), plus the workspace packages
`core`, `storage`, `retrieval`, `security`, and `zod`. Dev: `@modelcontextprotocol/client` 2.3.0
(wire tests only). Exports: `.` and `./testing`. No SQL here (rule 5), no embedder construction
(rule 2), no SDK reimplementation — the package is orchestration + wire contract only.

| Module | Contents |
|---|---|
| `server.ts` | `buildOnememoryServer(context)` — ONE factory for both transports and both protocol eras (SDK `serveStdio` pins one instance per connection; the HTTP handler builds a server per request over the same context). Deterministic registration order, per-tool `inputSchema` + `outputSchema` + `annotations`, instructions on initialize. No Roots/Sampling/Logging dependencies (deprecated per SEP-2577): the workspace hint is read from `CLAUDE_PROJECT_DIR` at context build, consolidation never runs through Sampling, logs go to stderr — never stdout (stdout is the stdio wire). |
| `schemas.ts` | The wire contract: all 11 input/output Zod schemas (also handed to the SDK directly — one source of truth), `TOOL_SCHEMAS` registry, `DEFAULT_TOOLS` / `FULL11_EXTRA_TOOLS` / `TOOL_PROFILES`, `SEARCH_KINDS` + `typesForKind` (kind → core memory types), the shared `MemoryIndexEntry` (progressive-disclosure row), `ToolErrorPayload`. |
| `handlers.ts` | All 11 handlers + shared helpers (redaction of every write path, revision check, evidence→spans, entity binding, embedding upsert + search-cache invalidation). `TOOL_HANDLERS` registry. |
| `results.ts` | `okResult` (validates `structuredContent` against the tool's own outputSchema before it leaves — belt and suspenders over the SDK's check), `errorResult` (typed `isError` envelope), `makeToolCallback` (the `registerTool` wrapper: catches every throw → `asToolError` → `isError` result), per-tool text renderers for the human-readable `content` channel. |
| `errors.ts` | `ToolError` taxonomy, 11 codes (below), `asToolError` (unknown → `internal`, never a stack trace). |
| `descriptions.ts` | The maintained artifact: 11 tool descriptions (each self-contained — no "use tool X instead" cross-references; budgeted ≤ 2048 chars hard / ~1200 target), `SERVER_INSTRUCTIONS` (505 chars), `TOOL_ANNOTATIONS` (delete/forget `destructiveHint: true`, store `idempotentHint: true`, all read tools `readOnlyHint: true`), `TOOL_TITLES`. |
| `config.ts` | `OnememoryMcpConfig` (profile, storage mode, project scope, agent id, redactor, budgets, instructions override) + `mcpConfigFromEnv` (below). Config errors are loud at boot (throw), never silently ignored. |
| `context.ts` | `createOnememoryMcpContext`: opens storage (embedded PGlite with vector dimension matched to the injected embedder, or server Postgres), wires `createRetrievalEngine`, the redactor (security), the audited actor, and the post-write cache invalidation. Storage can be injected (tests, M13) or built from `storageConfig`. |
| `stdio.ts` / `bin.ts` | `serveOnememoryStdio` + the env-only `onemem-mcp` bin (signal handling; diagnostics on stderr). |
| `http.ts` | `createOnememoryStreamableHttpHandler` (SDK `createMcpHandler`, stateless shared-server mode — one server per request, no sessions, no `Mcp-Session-Id`) + `createOnememoryHttpServer` (Bun `Bun.serve` wrapper). |
| `testing.ts` | `@onememory/mcp/testing`: `openMcpTestWorld` (fresh real PGlite in a temp dir per test + retrieval's deterministic test embedder + fixed clock `MCP_TEST_NOW` = 2027-01-15, `projectId: null` = explicitly unconfigured) and `seedFixtureMemory`. |

### Error taxonomy (`structuredContent.error = { code, message, … }`, always `isError: true`)

`invalid_input` · `not_found` · `revision_conflict` (retryable — carries `current_revision`) ·
`provenance_required` · `project_required` · `no_change` · `metadata_only_update_unsupported` ·
`invalid_window` · `invalid_transition` · `purge_unavailable` · `internal`

Protocol-level errors (input-schema violations) never reach a handler — the SDK rejects them first
(the v2 client then widens the rejection into an `isError` result, verified by a wire test).

---

## 2. The tool surface (what an agent sees)

**default8:** `memory_search`, `memory_get`, `memory_store`, `memory_update`, `memory_delete`,
`memory_forget`, `memory_related`, `memory_project_context`
**full11 adds:** `memory_decisions`, `memory_failures`, `memory_skills`

| Tool | Contract highlights |
|---|---|
| `memory_search` | Progressive disclosure: returns a compact **ID-index** (`results[]`: `id, type, subtype?, title?, summary, relevance 0–1, status?, token_estimate`) — no content bodies. `kind` filter (`decision`/`failure`/`skill` or a durable type), `max_tokens` (default 800, cap 4000) + `max_memories`, `entities`, `as_of` / `temporal_mode` / `include`, `session_id` (session-scoped working memory rides the same tool), `explain`. Output adds `tokens { budget, used, packing }`, `query_understanding`, `warnings[]`. |
| `memory_get` | The full record (`memory`: core `MemoryRecordSchema` — content, provenance/evidence, temporal window, status, importance/confidence), `token_estimate`, optional `history[]` (full supersession chain, oldest first) and `audit[]` (append-only trail). |
| `memory_store` | Redact-before-persist → provenance gate (≥ 1 evidence span, else `provenance_required` and nothing written) → scope resolve → source create → dedupe/supersede → entity bind → embedding upsert → cache invalidate. **Never silent:** `outcome: new \| merged \| superseded` with `existing_id` / `superseded_id`. `redactions[]` reports `{kind, location ($.…), length}` — never values. |
| `memory_update` | Revision-checked (`expected_revision` = the `updated_at` you read; stale → `revision_conflict` + `current_revision`). Append-mostly: mints a NEW revision and supersedes the old one (kept as history, `superseded_by` forward). Output: `{id: new, previous_id, outcome: "superseded", revision}`. Content must change (see deviation 2). |
| `memory_delete` | Hard purge. Currently **fails loudly `purge_unavailable`** and deletes nothing — the storage primitive doesn't exist yet (deviation 1). `expected_revision` mandatory (purges are never accidental). |
| `memory_forget` | Soft tombstone ≠ delete: `archived` ↔ `active` (`recover: true`), every transition audited (`action: archived \| restored`, from/to, actor, at); the reason is redacted before it reaches the audit trail; `recoverable: true` in every result. |
| `memory_related` | Entity graph: `relations[]` (core edge relations), `direction`, `include_expired`, `max`. Returns full `memory` records + `relation` + `direction`. |
| `memory_project_context` | `buildSessionContext` (retrieval) under a token budget (default 750, cap 4000): `text` ready to inject, `sections[] { kind, tokens, text }`, `used ≤ budget`, `warnings[]`. |
| `memory_decisions` / `memory_failures` / `memory_skills` | Curated project views, same ID-index rows plus typed extras: `decided_at` + `rationale`; `failure_status` + `solution?` + `occurrence_count` + `last_seen_at` (ranked by recurrence); skills = procedural know-how with optional kebab `name`. |

Wire examples (store, then forget):

```jsonc
// memory_store result
{ "id": "0194…", "outcome": "new", "redactions": [], "warnings": [], "token_estimate": 14 }
// memory_forget result
{ "id": "0194…", "status": "archived", "action": "archived", "recoverable": true,
  "audit": { "action": "archived", "from_status": "active", "to_status": "archived",
             "actor": "agent:onememory-mcp", "at": "2027-01-15T00:00:00.000Z" },
  "redactions": [], "token_estimate": 0 }
// every failure
{ "isError": true,
  "structuredContent": { "error": { "code": "revision_conflict", "message": "…",
                                     "current_revision": "2027-01-15T00:00:00.000Z" } } }
```

---

## 3. Tests

`bun test` from the worktree root: **354 pass / 0 fail / 14 skip** (368 tests, 26 files, 7,126
expect calls). Base was 260 pass / 0 fail / 14 skip — this mission adds **94 tests / 0 regressions**
(the 14 skips are the env-gated Postgres-server leg, by design). `bunx tsc --noEmit` is clean in
all five packages (`core`, `storage`, `retrieval`, `security`, `mcp`; the repo has no root
tsconfig — per-package typecheck is the pattern).

| Suite | Tests | Against |
|---|---|---|
| `handlers.test.ts` | 56 | real embedded PGlite per test — progressive disclosure + budgets, kind filters, provenance gate (row-count check: nothing written), redaction-on-write with taint assertions (marker present in row, value absent from the raw `jsonb::text`), outcomes new/merged/superseded, revision conflicts, no-change rejection, forget/recover state machine + audit, related graph, project context, curated lists, project scoping + `project_required`, workspace hint in provenance, unknown-throw → `internal` |
| `server.test.ts` | 8 | **genuine wire e2e**: SDK `Client` ↔ `InMemoryTransport` ↔ `buildOnememoryServer` — tools/list per profile (exactly 8 / 11, titles, annotations, outputSchema), store→search→get→forget→recover round-trip, isError taxonomy over the wire, input-schema rejection, human-readable content channel, fixed clock |
| `http.test.ts` | 5 | real `Request`→`Response` through the stateless Streamable HTTP handler — initialize (instructions + capabilities), sessionless tools/list, tools/call round-trip with `structuredContent`, isError parity, per-request statelessness |
| `descriptions.test.ts` | 14 | description budgets (every tool ≤ 2048 chars; shipped default ≤ ~1200 target), instructions ≤ 512, annotations table, no cross-tool references, all 11 names resolve |
| `config.test.ts` | 11 | profile/storage defaults, env resolution, loud failure on invalid `ONEMEMORY_MCP_PROFILE` / URLs |

Also verified by hand (not a test): the `onemem-mcp` bin boots from env alone and serves stdio —
driven as a subprocess through `initialize` + `tools/list` it advertised exactly 8 tools
(default) and 11 with `ONEMEMORY_MCP_PROFILE=full11`.

SDK behaviors the wire tests documented (relevant to M6/M7 and any client work):
- the v2 client **widens protocol-level rejections into `isError` tool results** (compat widening), so even input-schema violations surface as `isError`, never as a thrown exception in `client.callTool`;
- Streamable HTTP POST responses arrive SSE-framed (`event: message`, one frame) and require `Accept: application/json, text/event-stream`;
- stdio transport aborts in-flight responses at stdin EOF (a client that expects responses keeps stdin open — SDK-documented, re-verified here).

---

## 4. Deviations from ADR-0010 / adjacent docs (with reasons)

1. **`memory_delete` fails `purge_unavailable`** instead of purging. The store port has no
   hard-purge primitive for durable memories (only vector removal and working-memory TTL delete
   exist). Faking success would violate the never-silent rule; silently downgrading to
   `memory_forget` would contradict the ADR's delete semantics. The output schema (`purged: true`
   + a `'purged'` audit row) is pinned in `schemas.ts` so the wire contract is already stable —
   the handler fills it in the moment storage ships `Store.deleteMemory`. Nothing is deleted today.
2. **Metadata-only `memory_update` is rejected** (`metadata_only_update_unsupported`): storage has
   no field-update path, and a supersede with identical content would just collide with the
   original's `content_hash` (winner-duplicate → `revision_conflict`), so an honest rejection is
   the only non-faking option. Tags/type/importance/confidence ride along only when content
   changes. (The tool description states this restriction inline.)
3. **D8 (working memory exposure): resolved via `memory_search`, no dedicated tool.** The leaning
   in `docs/risks.md` was a read-only `memory_working` tool, owning session only. Working memory
   is already reachable read-only through `memory_search { session_id }` (retrieval's
   session-scoped channel), which covers the need without a second surface. A dedicated
   `memory_working` list tool stays out until ingest (M3/M7) defines the session lifecycle it
   would list.
4. **No project-lookup-by-path.** `CLAUDE_PROJECT_DIR` (Claude Code) is recorded as a workspace
   hint in write provenance metadata — mapping a directory to a project id needs a storage
   lookup-by-path primitive that doesn't exist. Until then the workspace hint is metadata, never
   memory content, and project scoping uses explicit `project_id` / config / env.
5. **Skills = procedural memories.** `memory_skills` lists promoted/known procedural know-how via
   retrieval's typed shortcut; a kebab-case `name` surfaces only when the memory carries one.
   ADR-0009's auto-promotion flow (`onemem skills review`) is M13/CLI territory, not the MCP
   surface.
6. **Store-time dedupe is exact-only** (same scope + type + content). Near-duplicate collapse
   stays where mission 2 put it — read-time, in the retrieval engine — so the MCP store outcome
   vocabulary stays `new | merged | superseded` without a second similarity threshold at the
   write path.
7. **`memory_update` races:** two updates superseding the same base are serialized by the
   revision check; a supersede that finds the winner already a duplicate (identical corrected
   content) surfaces as `revision_conflict` with the current revision rather than a confusing
   merged outcome.
8. **Custom `instructions`** may run to 2048 chars (config schema); the shipped default
   (`SERVER_INSTRUCTIONS`, 505) is asserted ≤ 512 by the description tests, per ADR-0010. The
   ADR's budget governs what we ship, not what an integrator overrides.

---

## 5. Follow-ups (coordinator / sibling missions)

- **Storage (M1 owner):** add `Store.deleteMemory` (hard purge: memories row + vectors +
  payload rows + a `'purged'` audit entry, transaction-scoped). `memory_delete` then flips from
  `purge_unavailable` to the already-pinned output schema — an MCP-side one-liner plus one test.
- **Storage:** a field-update primitive (or a blessed metadata sidecar) would unlock
  metadata-only `memory_update`; today those edits are honestly rejected.
- **Storage:** project lookup by path (`cwd` → project id) so the workspace hint can scope
  automatically instead of sitting in provenance metadata.
- **Storage:** the `memory_events` audit `at` column is stamped by the database clock, not the
  injected `now` — the forget handler passes the DB-stamped `updated_at` back as the audit time,
  so tests assert values, not the fixed test clock, on that field. Injectable clocking there
  would make time-travel tests uniform.
- **ADR-0010 §1 vs. `docs/risks.md` D8:** record the D8 resolution (this report §4.3) in the
  risks table.

---

## 6. API surface for M6 (adapters), M7 (ingest), M13 (CLI)

```ts
import {
  // server factory — both transports, both protocol eras
  buildOnememoryServer,            // (context, { profile? }) => McpServer
  serveOnememoryStdio,             // (context, options?) => Promise<OnememoryStdioHandle>
  createOnememoryStreamableHttpHandler, // (context, options?) => McpHttpHandler  (stateless; no sessions)
  createOnememoryHttpServer,       // (context, options?) => Promise<{ port; server; close() }>
  // context + config
  createOnememoryMcpContext,       // (options) => Promise<OnememoryMcpContext>
  resolveMcpConfig, mcpConfigFromEnv,
  // the wire contract (input/output types + schemas, registries)
  TOOL_SCHEMAS, TOOL_HANDLERS, DEFAULT_TOOLS, FULL11_EXTRA_TOOLS, toolsForProfile,
  typesForKind, SEARCH_KINDS,
  // result wrappers + error taxonomy (for embedding tools in other surfaces)
  okResult, errorResult, makeToolCallback, ToolError, asToolError,
  // the maintained description artifact
  SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS, TOOL_ANNOTATIONS, TOOL_TITLES,
} from '@onememory/mcp';

// context options (all optional): { config | partial config fields, storage? (injected
// OnememoryStorage), storageConfig?, embedder?, now?, serverInfo? }
const context = await createOnememoryMcpContext({
  config: { profile: 'full11', storage: { mode: 'embedded', dataDir: '.onememory' },
            projectId: '…', agentId: 'claude-code' },
  embedder,        // Embedder port — injected, never constructed here (local-first default: none)
  now,             // clock injection
});
const server = buildOnememoryServer(context);          // registerTool × profile
await serveOnememoryStdio(context);                    // the `onemem-mcp` bin does exactly this
```

**Environment (the bin and adapter-generated configs):**

| Var | Effect |
|---|---|
| `ONEMEMORY_MCP_PROFILE` | `default8` \| `full11` (invalid → boot failure, never ignored) |
| `ONEMEMORY_DATA_DIR` | embedded PGlite data dir (default `.onememory`) |
| `ONEMEMORY_PG_URL` | switches storage to server mode (Postgres + pgvector) |
| `ONEMEMORY_PROJECT_ID` | project scope for unscoped calls |
| `ONEMEMORY_MCP_AGENT_ID` | stored `agent_id` + audited-actor suffix (default `onememory-mcp`) |
| `CLAUDE_PROJECT_DIR` | workspace hint, recorded in write provenance (see deviation 4) |

**For M6 adapters** (Claude Code / Codex / Cursor / Pi / OpenCode): emit the stdio command
(`onemem-mcp`, env above) into each runtime's MCP config; `memory_search`'s ID-index +
`memory_get` pair is the progressive-disclosure flow to document in adapter READMEs, and
`memory_project_context.text` is the ready-to-inject session-start block. The wire schemas
(`TOOL_SCHEMAS[name].input/output`) are importable if an adapter wants client-side validation.

**For M7 ingest:** write through `memory_store`'s handler contract (redaction + provenance gate +
outcome vocabulary) — the handler helpers (`redactWriteFields`, evidence→spans, entity binding)
are exported from `handlers.ts` for reuse, and the `redactions[]` reporting shape is the
ingest-callers' audit surface.

**For M13 CLI:** `onemem search/get/store/update/forget/related/context/decisions/failures/skills`
map 1:1 onto the handlers via `TOOL_HANDLERS` (same Zod in/out), so the CLI inherits the wire
contract and its tests for free; `createOnememoryHttpServer` is the self-hosted shared-mode
server behind any future `onemem serve`.

**Test doubles:** `@onememory/mcp/testing` exports `openMcpTestWorld` (fresh PGlite + deterministic
embedder + fixed clock) and `seedFixtureMemory` — the pattern every suite in this package uses.
