# ADR-0010: MCP-first protocol surface + universal adapters

Status: Accepted · Date: 2026-10-03

## Context

Spec §15/§16: expose memory to agents via MCP (11 named tools), plus per-runtime adapters
(Claude Code, Codex, Cursor, Pi, OpenCode); the engine never knows about runtimes. Research
(`docs/research/mcp-memory-implementations.md`) surfaced hard constraints: MCP 2026-07-28 is a
stateless rewrite; the TS SDK v2 (`@modelcontextprotocol/server`) supports Bun with `serveStdio`
+ a stateless `createMcpHandler`; Claude Code truncates tool descriptions at 2,048 chars and
lazily loads tools (ToolSearch default ON); Pi defaults tools to codemode; Codex enforces
per-tool `output_token_limit`; the most successful memory server (claude-mem, 95k★) wins on
hook-based capture + progressive disclosure (~10× token savings), not on tool count.

## Decision

1. **SDK & transports**: official TS SDK v2 split packages. **stdio primary** (`serveStdio`) —
   supported by all five runtimes, zero network surface. Optional **stateless Streamable HTTP**
   (`createMcpHandler`) for a shared local server and the hosted mode. **No SSE.** Do not depend
   on deprecated Roots/Sampling/Logging: workspace comes from `CLAUDE_PROJECT_DIR`/launch dir;
   consolidation runs in onememory's own worker (claude-mem pattern).
2. **Tool surface — capabilities × exposure (resolves D3)**: the handler layer implements all 11
   spec capabilities; the default exposure is **8 tools** with the three curated lists as
   `kind` filters:
   - `memory_search(query, {kind: "decision"|"failure"|"skill"|type, …})` — one search surface;
     `GET /v1/projects/:id/decisions|failures` remain first-class REST endpoints regardless.
   - `memory_get`, `memory_store`, `memory_update`, `memory_delete`, `memory_forget`,
     `memory_related`, `memory_project_context`.
   - The full 11-tool exposure (`memory_decisions`, `memory_failures`, `memory_skills` as
     dedicated tools) is a config profile for runtimes/evals that prefer it — evidence says
     flat 11 dilutes tool selection and description budget.
3. **Progressive disclosure (the token-efficiency contract)**: `memory_search` returns an
   ID-index (title + one-line summary + token estimate, ~50–100 tokens per result) honoring
   `max_tokens`; `memory_get`/`memory_related` return full records (with provenance + explain)
   only for selected IDs. Every tool ships `outputSchema` + `structuredContent` (typed JSON) plus
   human-readable `content`; `token_estimate` in results protects Codex `output_token_limit`
   users. Opaque IDs only.
4. **Write-path semantics**: `memory_store` returns `{id, outcome: new|merged|superseded}` —
   dedupe is never silent (doobidoo `memory_resolve` + Mem0 consolidation lessons).
   `memory_update` is revision-checked (optimistic concurrency, basic-memory pattern) and owns
   `valid_from`/`valid_until` transitions. Errors are `isError: true` results, never exceptions.
5. **forget ≠ delete**: `memory_forget` = soft, recoverable expiry (`status` tombstone + audit);
   `memory_delete` = hard purge. First sentence of each description states the difference; both
   carry `destructiveHint: true` annotations. `memory_store`/`memory_update` carry
   `idempotentHint` where true.
6. **Injection beats polling**: `memory_project_context` is the session-start channel; adapters
   install **hooks** (SessionStart → compact context injection; Stop/PostToolUse → transcript
   deltas) for Claude Code, Codex, Cursor (hook shapes are cross-compatible), the tool for
   non-hook runtimes (OpenCode plugins, Pi extensions). `onemem init` emits per-runtime configs
   with per-runtime env syntax (`.mcp.json`, `config.toml`, `.cursor/mcp.json`, `opencode.json`,
   `.pi/mcp.json`) + a short on-ramp skill; server `instructions` self-contained in 512 chars.
7. **Interop, not competition**: Claude Code's auto-memory (`MEMORY.md`) and AGENTS.md
   convergence are treated as ingest sources and pointer targets — onememory writes a compact
   generated index, never a hand-maintained duplicate. Codex's `memories.disable_on_external_context`
   — which excludes MCP chats from native extraction only when the user enables it; it **defaults
   to false** (corrected 2026-10-04: verified against the Codex source in mission 7) — is
   documented in the adapter README with the recommended division of labor.
8. **Defer 2026-07-28-only features** (MRTR `input_required`, `server/discover`, `ttlMs`
   caching, per-request `_meta`) until runtime adoption is verified — noted as the natural fit
   for a future `memory_resolve` clarification loop; not shipped first.

## Consequences

- Tool descriptions are a maintained artifact with length tests (≤ 2,048 chars) — the model's
  UX depends on them as much as on results.
- Naming collisions in multi-memory setups (`mcp__onememory__memory_search` vs others) are
  accepted for now; server name `onememory` is distinctive (open question 9 in the research —
  revisit only with evidence).
- Conformance suite (backlog M5.4) pins the JSON contract for all five runtimes; Pi's extension
  API gets the deepest adapter (registerTool/registerMcpServer), basic-memory's Pi package as
  precedent.

## References

`docs/research/mcp-memory-implementations.md` (protocol facts, per-runtime matrix, server
survey, recommended surface); spec §15/§16; `docs/architecture/event-memory-schemas.md` §6;
backlog M5–M9.

## Amendment (2026-10-04): daemon-backed MCP for the embedded profile

ADR-0002's process model gives embedded storage exactly one owner process — `onemem serve` — and
already states that MCP stdio servers should "speak HTTP to it". Made concrete:

- **The daemon mounts the MCP surface.** `onemem serve` builds ONE `OnememoryMcpContext` from its
  runtime — the same storage, the same retrieval engine, the same redaction config, the same
  embedder — and mounts the stateless Streamable HTTP handler (§1) at `/mcp` on its loopback
  port. Per §1's stateless design the handler is created once at boot; each request gets a fresh
  `McpServer` against the shared context.
- **One cache domain.** REST `/v1` and MCP `/mcp` are two views of one memory and one result
  cache: `createOnememoryMcpContext` accepts an injected engine alongside injected storage
  (engine injection requires storage injection — the shared engine must ride the storage the
  context writes through). An MCP `memory_store` invalidates the same cache a REST search reads
  (retrieval.md §5), and REST writes invalidate it for MCP searches.
- **Embedded-profile scaffolds point at the daemon.** `onemem init` emits HTTP-transport entries
  (Claude `.mcp.json` `type: "http"`, Codex `config.toml` `url`) targeting
  `http://127.0.0.1:<daemon-port>/mcp`. The standalone stdio bin remains the surface for the
  `server` profile (multi-process Postgres is safe there) and for daemon-less direct use.
- **Known gap (backlog):** the stdio bin opening embedded storage while a daemon is alive would be
  a second owner of the same data dir. `onemem init` never scaffolds that combination; a
  lock/probe guard in the bin closes the hazard.

## Amendment (2026-10-07): per-runtime identity and cwd→project resolution (M17)

Two wiring decisions behind the embedded-profile entry (`mission/17-scope-identity`):

- **Per-runtime identity rides the wired URL.** The scaffolded entry for each runtime targets
  `http://127.0.0.1:<daemon-port>/mcp?agent=<runtime-id>`, where the ids are
  `RUNTIME_AGENT_IDS` (`apps/api/src/runtime/runtime-scaffolds.ts`): `onemem-claude-code`,
  `onemem-codex`, `onemem-cursor`, `onemem-pi`, `onemem-opencode`. The server reads the parameter
  per request (`packages/mcp/src/http.ts`), clones the shared context with `config.agentId` and
  actor `agent:<id>` for that request only, and answers `400` on a malformed id — so the audit
  trail names the runtime that wrote each memory with no per-client env var. Without the
  parameter the default `onememory-mcp` identity stands, so already-wired clients keep working.
- **cwd→project resolution.** A client may launch from a nested directory. The MCP context
  resolves the workspace hint (`CLAUDE_PROJECT_DIR`) through `store.findProjectByPath`: deepest
  registered root wins, containment is segment-precise (`/a/bc` never matches `/a/b`), and no
  registered root resolves to no project — never a guess. An explicit `project_id` argument, then
  the configured `projectId`, still outrank the workspace hint; the CLI mirrors the chain
  (`resolveProjectIdForCwd`: `--project` → direct-mode path lookup → init pointer → error).
