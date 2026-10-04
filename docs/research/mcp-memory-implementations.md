# MCP Memory Implementations and Agent-Runtime Integration Surfaces

Research for the **onememory** (`onemem`) architecture phase. Survey of (A) MCP platform facts
as of 2026-10-03, (B) how each target runtime (Claude Code, Codex CLI, Cursor, OpenCode, Pi)
integrates MCP servers and memory, and (C) existing memory MCP servers and what their design
choices imply for onememory's planned 11-tool MCP surface.

Method: primary sources only (official spec pages, SDK docs/repos, runtime docs, project
READMEs/commit logs); every claim cites a URL; uncertain items are flagged `[UNVERIFIED]` /
`[SKIM]`. Correction to an earlier brief: Streamable HTTP, OAuth 2.1, and tool annotations
shipped in the 2025-03-26 revision (not 2025-06-18, which added elicitation, structured output,
resource links) — https://modelcontextprotocol.io/specification/2026-07-28/changelog.

---

## Summary

- The current MCP protocol revision is **2026-07-28**, a major **stateless rewrite**: no
  `initialize` handshake, no sessions/`Mcp-Session-Id`, per-request `_meta` capability
  negotiation, `server/discover`, `subscriptions/listen` replacing GET/SSE, Multi Round-Trip
  Requests, and caching hints. Roots, Sampling, Logging, and OAuth DCR are **deprecated**
  (https://modelcontextprotocol.io/specification/latest).
- The official TypeScript SDK is **v2** (`@modelcontextprotocol/server` / `@modelcontextprotocol/client`),
  explicitly supports **Bun**, and pushes a stateless, horizontally-scalable HTTP handler
  (`createMcpHandler`) with stdio via `serveStdio` (https://github.com/modelcontextprotocol/typescript-sdk,
  https://ts.sdk.modelcontextprotocol.io/).
- Every surveyed runtime supports **stdio**; Streamable HTTP support is broad but uneven; SSE is
  dead (removed from spec, rejected by Pi). Stdio is the right primary transport for onememory's
  local-first design (per-runtime cites in Findings B).
- The successful memory servers in the wild do **three things beyond raw tools**: hook-based
  capture (claude-mem, basic-memory `bm hook`, doobidoo `claude-hooks/`), session-start context
  injection (claude-mem SessionStart, Claude Code auto memory), and **progressive-disclosure
  retrieval** — compact ID-index first, full records only for selected IDs, advertising ~10x
  token savings (https://github.com/thedotmack/claude-mem).
- The planned 11-tool onememory surface is at the top of the range of what real servers ship
  (official demo: 9; OpenMemory: 4; claude-mem: 3–4 search tools). Two risks: description/token
  budgets (Claude Code truncates tool descriptions at 2,048 chars; Pi truncates tool text at
  20 KB) and tool-selection dilution. Recommendation: keep the 8 non-kind tools, fold
  decisions/failures/skills into `memory_search(kind=...)` filters, and ship
  `memory_project_context` plus hooks/skills as the session-start channel. See
  "Recommended onememory MCP surface".
- Runtimes are converging on: tool search / deferred tool exposure (Claude Code ToolSearch on by
  default; Pi codemode/deferred), per-tool output budgets (Codex `output_token_limit`), hooks that
  mirror each other across runtimes (Claude Code ⇄ Codex ⇄ Cursor compatibility), and AGENTS.md
  as an emerging cross-runtime standard file.

---

## Findings

### Part A — MCP platform facts (2026-10-03)

#### A.1 Revision history

Revisions: 2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 → **2026-07-28 (latest)**, plus a
rolling draft. Official extensions exist for Tasks, Skills over MCP, and MCP Apps.
(https://modelcontextprotocol.io/llms.txt, https://modelcontextprotocol.io/specification/latest)

What each revision added (https://modelcontextprotocol.io/specification/2026-07-28/changelog):

- **2025-03-26**: Streamable HTTP transport, tool annotations, OAuth 2.1 resource-server model.
- **2025-06-18**: elicitation, structured tool output (`outputSchema` + `structuredContent`),
  resource links; removed JSON-RPC batching.
- **2025-11-25**: icons, URL-mode elicitation, sampling-with-tools, Client ID Metadata Documents
  (CIMD), JSON Schema 2020-12 as default, experimental Tasks.
- **2026-07-28** (major, "stateless" rewrite):
  - Removed sessions and the `Mcp-Session-Id` header; removed the `initialize` handshake —
    clients now send capability/version info per-request in `_meta` (`protocolVersion`,
    `clientCapabilities`, `clientInfo`).
  - `server/discover` replaces `tools/list`-bootstrap flows; `subscriptions/listen` (POST)
    replaces the old GET + SSE subscribe; SSE resumability (`Last-Event-ID`) removed.
  - Removed `ping` and `logging/setLevel`.
  - **Multi Round-Trip Requests (MRTR)**: tools can return `resultType: "complete" |
    "input_required"` with `inputResponses`/`requestState` — i.e., an in-band agentic
    clarification loop inside one tool call.
  - Per-tool HTTP header mirroring (`x-mcp-header`); cacheable results via `ttlMs`/`cacheScope`
    on `CacheableResult`.
  - Tasks moved out of core into an official extension.
  - **Deprecated** (12-month windows): Roots, Sampling, Logging (SEP-2577) and OAuth Dynamic
    Client Registration (superseded by CIMD).

#### A.2 Tool semantics that constrain a memory server

From the current tools spec (https://modelcontextprotocol.io/specification/latest/basic/tools):

- Tool names: 1–128 chars, `[a-zA-Z0-9_-]` after an initial letter; deterministic ordering
  recommended. Clients namespace tools (`mcp__<server>__<tool>` in Claude Code and Pi).
- `outputSchema` + `structuredContent` (since 2025-06-18) let a server return typed JSON alongside
  human-readable `content`.
- Stateful handles (e.g., memory IDs, cursors) should be opaque strings, valid only within the
  server instance that issued them.
- Error taxonomy: protocol errors (JSON-RPC errors) vs. tool execution errors (`isError: true` in
  the result) — memory servers should use the latter for "not found"/"conflict", not throw.
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, since
  2025-03-26) are advisory but honored by some clients for filtering/UI.

#### A.3 TypeScript SDK v2 (the implementation onememory would build on)

- Packages split (monorepo split PR #1279): `@modelcontextprotocol/server` and
  `@modelcontextprotocol/client`, plus middleware for Node/Express/Fastify/Hono
  (`@modelcontextprotocol/node|express|fastify|hono`). Latest release 2.2.0. Runs on Node.js,
  **Bun**, and Deno; `bun add` is documented. v1 API lives on the `v1.x` branch with ≥6 months
  of fixes, and a codemod (`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`) exists.
  (https://github.com/modelcontextprotocol/typescript-sdk, https://ts.sdk.modelcontextprotocol.io/)
- v2 server API: `serveStdio(() => server)` for stdio; `server.registerTool(name,
  { description, inputSchema: z.object(...) }, handler)`; `createMcpHandler(buildServer)` builds a
  **fresh server per HTTP request** — stateless and horizontally scalable by default
  (https://ts.sdk.modelcontextprotocol.io/, https://github.com/modelcontextprotocol/typescript-sdk).
- Sessions/state/scaling guidance: stateless `createMcpHandler` is the default; the 2025-era
  sessionful transport (`NodeStreamableHTTPServerTransport`, `sessionIdGenerator`, idle
  eviction, `EventStore` for SSE resumability) is documented as the legacy pattern; cross-node
  scaling via `ServerEventBus` on `createMcpHandler(buildServer, { bus })`; auth guidance in
  `docs/serving/authorization.md`
  (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md).

Implication: onememory's stack (TypeScript + Bun + Postgres) is squarely in the SDK's happy path;
stdio server + optional stateless Streamable HTTP handler covers local-first and hosted modes with
the same `buildServer()` factory.

### Part B — Runtime integration surfaces

#### B.1 Claude Code

MCP config (https://code.claude.com/docs/en/mcp):

- `claude mcp add [--transport http|sse|stdio]`, `claude mcp add-json`, `claude mcp list`;
  config types `"http" | "streamable-http" | "sse" | "ws" | "stdio" | "sdk"`.
- Scopes: local, project (`.mcp.json`, committed), user (`~/.claude.json`); `${VAR}` env
  expansion; stdio servers get `CLAUDE_PROJECT_DIR` set to the launch directory; project-scope
  servers require workspace-trust approval; roots = launch dir + additional dirs.
- **Tool search (ToolSearch) default ON**: tools are discovered lazily by description;
  `ENABLE_TOOL_SEARCH` / `alwaysLoad` (or `"anthropic/alwaysLoad": true` in a tool's `_meta`)
  forces eager loading; discovery results are cached (`cached` status).
- Server `instructions` and tool **descriptions truncated at 2,048 chars**
  (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`); MCP prompts as `/mcp__server__prompt`; resources
  via `@server:uri` references.

Hooks (https://code.claude.com/docs/en/hooks):

- Large event surface (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop,
  SubagentStart/Stop, PreCompact/PostCompact, PermissionRequest, Elicitation, SessionEnd, …);
  handler types command, http, mcp_tool, prompt, agent; hooks can inject `additionalContext`
  (how claude-mem injects memories at SessionStart); exit code 2 blocks; `transcript_path` in
  hook input points to `~/.claude/projects/.../<session-id>.jsonl` (JSONL, async-written) —
  the raw material for memory capture.

Memory files (https://code.claude.com/docs/en/memory):

- CLAUDE.md hierarchy: managed policy → `~/.claude/CLAUDE.md` → project `CLAUDE.md` /
  `.claude/CLAUDE.md` → `CLAUDE.local.md`; loaded root-down, concatenated; `@path` imports
  (max 4 hops, 4 MiB skip); `.claude/rules/*.md` with `paths:` glob-scoped frontmatter;
  `/init` generates it. AGENTS.md is read when no CLAUDE.md exists (v2.1.277+, configurable to
  read both).
- **Auto memory**: `~/.claude/projects/<project>/memory/` with a `MEMORY.md` index — the first
  200 lines or 25 KB are loaded **every session**; topic files read on demand; `modified`
  frontmatter timestamps; `/memory` command manages it. This is a first-party memory surface
  onememory must interoperate with (not compete against naively).

Skills (https://code.claude.com/docs/en/skills):

- `.claude/skills/<name>/SKILL.md` with frontmatter (`name`, `description`,
  `disable-model-invocation`); dynamic context injection with `` !`cmd` `` expressions; skill
  listing is budgeted to **1% of the context window** (1,536-char per-description cap,
  `skillListingBudgetFraction`) — a good cheap channel for a "how to use onemem" on-ramp skill.

#### B.2 Codex CLI

MCP config (https://learn.chatgpt.com/docs/mcp, earlier https://developers.openai.com/codex/mcp):

- `~/.codex/config.toml`, `[mcp_servers.<name>]` tables: stdio (`command`, `args`, `env`,
  `env_vars`, `cwd`) or Streamable HTTP (`url`, `bearer_token_env_var`, `http_headers`,
  `env_http_headers`, `http_headers_helper`, `auth: oauth|chatgpt`).
- Per-server: `startup_timeout_sec` (10s), `tool_timeout_sec` (60s), `enabled`, `required`,
  `enabled_tools`/`disabled_tools`, `default_tools_approval_mode` (`auto|prompt|writes|approve`)
  + per-tool `approval_mode`, and **`output_token_limit`** — a per-tool token budget on tool
  output (~20% serialization allowance). The only surveyed runtime with a first-class per-tool
  output budget — a strong argument for compact, token-estimated tool results.
- Server `instructions` are read; docs recommend the first 512 chars be self-contained.
  `codex mcp add/list/login`; project-level `.codex/config.toml` for trusted projects.

AGENTS.md (https://learn.chatgpt.com/docs/agent-configuration/agents-md): `~/.codex/AGENTS.md`
global + root→cwd discovery; `AGENTS.override.md`; `project_doc_fallback_filenames`;
`project_doc_max_bytes` 32 KiB.

Hooks (https://learn.chatgpt.com/docs/hooks): mirror of Claude Code's hook system — `hooks.json`
or `[hooks]` in config.toml; events SessionStart/End, PreToolUse, PostToolUse,
PermissionRequest, UserPromptSubmit, PreCompact/PostCompact, SubagentStart/Stop, Stop,
Interrupt; handler types command and mcp_tool; trust review via `/hooks`; async hooks capped at
8 concurrent; ~2,500-token `additionalContextLimit` with spill-to-disk; transcripts at
`session-*.jsonl` / `rollout.jsonl`.

Native memories (https://learn.chatgpt.com/docs/memories): **off by default**
(`[features] memories = true`), stored in `~/.codex/memories/`, and extracted in the background.
`memories.disable_on_external_context` — which would exclude MCP/web-search chats from memory
generation — **defaults to false** (verified against the Codex source in mission 7): chats are
not skipped unless the user opts in, so onememory tools in the loop do not by themselves suppress
Codex's native extraction. `.rules` Starlark
`prefix_rule()` files are sandbox-escalation policy, unrelated to memory
(https://learn.chatgpt.com/docs/rules).

#### B.3 Cursor

MCP config (https://cursor.com/docs/mcp): `.cursor/mcp.json` (project) and
`~/.cursor/mcp.json` (global); stdio, SSE, and Streamable HTTP; `${env:VAR}` and
`${workspaceFolder}` interpolation; static OAuth via an `auth` object with fixed redirect URLs
(no dynamic flows — no DCR/CIMD story); extension API `vscode.cursor.mcp.registerServer()`;
supports Tools, Prompts, Resources, Roots, Elicitation, and the MCP Apps extension; enterprise
MCP allowlists + network controls; tool approval and Run Modes.

Rules (https://cursor.com/docs/context/rules-for-ai): `.cursor/rules/*.mdc` with frontmatter
(`description`, `globs`, `alwaysApply`); plain `.md` files are ignored; User and Team rule
levels; AGENTS.md (root + nested, merged).

Hooks (https://cursor.com/docs/agent/hooks): `.cursor/hooks.json` (project) and
`~/.cursor/hooks.json` (user); command and prompt handler types; events include
**`beforeMCPExecution` / `afterMCPExecution`** (Cursor-specific MCP interception),
`sessionStart` (with `additional_context` output), `stop` (`followup_message` loop, loop limit
5), `preCompact`; explicitly interoperates with Claude Code-style hooks (`CLAUDE_PROJECT_DIR`
alias env).

Memories: Cursor 2.x ships account-level, agent-written Memories (short notes, capped and
summarized; automations can write `MEMORIES.md`). **[UNVERIFIED]** — no official docs page found
during this research; this description is from secondary sources (release notes/blog coverage
surfaced via search), so treat specifics as low-confidence.

#### B.4 OpenCode

MCP config (https://opencode.ai/docs/mcp-servers/, https://opencode.ai/docs/config/):

- `opencode.json` (JSONC), `"mcp"` key: `"type": "local"` (`command` array, `cwd`,
  `environment`) or `"type": "remote"` (`url`, `headers`, `oauth` object or `false`); `enabled`;
  `timeout` (default 5s tool fetch). Automatic OAuth with DCR (legacy vs. CIMD — flag for
  onememory's hosted mode); `opencode mcp auth/list/logout`; tokens in
  `~/.local/share/opencode/mcp-auth.json`.
- Config precedence: remote `.well-known/opencode` → `~/.config/opencode/opencode.json` →
  `OPENCODE_CONFIG` → project `opencode.json` → `.opencode` dirs → inline → managed
  (`/Library/Application Support/opencode/`, macOS MDM `ai.opencode.managed`). `{env:NAME}` and
  `{file:path}` substitution; plugins (npm or `.opencode/plugins/`); an `instructions` option
  that can point at e.g. `.cursor/rules/*.md`; agents, commands, permissions, skills (SKILL.md).
  claude-mem's installer writes both the plugin reference and an `mcp.claude-mem` local-server
  entry into `opencode.json` (https://github.com/thedotmack/claude-mem PR #3621) — a useful
  precedent for `onemem init`.

#### B.5 Pi

Pi is the minimal harness from earendil-works (formerly badlogic/pi-mono); Pi 1.0 shipped
Oct 1, 2026 with "Pi Durable" (https://github.com/earendil-works/pi).

- **Extensions** (https://raw.githubusercontent.com/earendil-works/pi/main/docs/extensions.md):
  TypeScript modules in `~/.pi/agent/extensions/` or project `.pi/agent/extensions/`, loaded via
  jiti (no compile); `ExtensionAPI` with `pi.on()` lifecycle events (session_start/shutdown,
  tool_call, tool_result, …), `registerTool` (TypeBox schemas, `outputSchema`/`structuredContent`,
  MCP annotations honored), `registerCommand`, `registerMcpServer` — extensions can even replace
  the built-in MCP support (`pi-mcp-adapter`). Richest low-level integration surface of any
  surveyed runtime; basic-memory already ships a Pi memory package
  (https://github.com/basicmachines-co/basic-memory, commit Sep 7, 2026).
- **MCP** (https://raw.githubusercontent.com/earendil-works/pi/main/docs/mcp.md):
  `~/.pi/agent/mcp.json` + project `.pi/mcp.json` (project trust required); stdio and
  **Streamable HTTP only — SSE configs are rejected**; `pi mcp add/list/login`; CIMD OAuth.
  **Exposure model**: tools default to "codemode" (listed but called via a meta-tool), can be
  `deferred` (via tool_search), `direct`, or `hidden`, with `toolExposure` patterns per tool.
  Tool text is truncated at **20 KB**; a per-server `description` is surfaced in the system
  prompt; tools are named `mcp__<server>__<tool>` with a hash suffix on collision; MCP resources
  are exposed as two tools (`list_mcp_resources`, `read_mcp_resource`) rather than first-class
  resource refs.

#### B.6 Cross-cutting transport and discovery trade-offs

- **stdio** is universally supported (Claude Code, Codex, Cursor, OpenCode, Pi), zero network
  surface, inherits the project directory (`CLAUDE_PROJECT_DIR` in Claude Code), and fits
  local-first. Costs: one server process per runtime session; config is per-runtime; no shared
  server across concurrent agents unless the runtime reuses it.
- **Streamable HTTP** enables one shared onememory server for many agents/workspaces (and is the
  only path to the hosted/SaaS mode), and is where the 2026-07-28 spec is heading (stateless,
  per-request `_meta`). Costs: every runtime configures it differently, OAuth flows are
  inconsistent (Cursor is static-only; OpenCode uses DCR; Pi uses CIMD; Codex `oauth|chatgpt`),
  and 2025-era sessionful HTTP transports are now legacy
  (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md).
- **SSE-only transports are dead**: removed from the 2026-07-28 spec, rejected by Pi.
- Discovery: all runtimes list tools from `tools/list`/`server/discover`; exposure now varies —
  Claude Code ToolSearch (default on, `alwaysLoad` escape hatch), Pi codemode/deferred/direct,
  Codex `enabled_tools`/`disabled_tools` + approval modes, Cursor enterprise allowlists. A
  memory server cannot assume its tools are eagerly loaded; the **server `instructions` + tool
  descriptions must be self-contained and short** (Claude Code truncates descriptions at 2,048
  chars; Codex instructions 512-char guidance).
- Env-var expansion syntax differs per runtime (`${VAR}` Claude Code, `${env:VAR}` Cursor,
  `{env:NAME}` OpenCode, plain `env` tables in Codex TOML) — installers like `onemem init` must
  emit per-runtime config files.

### Part C — Existing memory MCP servers

#### C.1 `@modelcontextprotocol/server-memory` (official reference)

https://github.com/modelcontextprotocol/servers/src/memory — a deliberately minimal
knowledge-graph-in-a-JSONL-file demo: entities/relations/observations persisted to one file
(`MEMORY_FILE_PATH` env), 9 tools (`create_entities`, `create_relations`, `add_observations`,
`delete_entities`, `delete_observations`, `delete_relations`, `read_graph`, `search_nodes`,
`open_nodes`) and one resource (`memory://knowledge-graph`) with update notifications. Recent
upkeep is instructive: an in-process async mutex for concurrent mutations (#4555), deletes no
longer falsely reporting success (#4738), and structuredContent/modern McpServer API (#3015).
Limits: substring search only, whole-graph reads, no embeddings/temporal semantics/dedup,
single-user — the reference baseline onememory must clearly beat.

#### C.2 doobidoo/mcp-memory-service

https://github.com/doobidoo/mcp-memory-service — the most feature-dense open-source memory
server. Python (PyPI), v11.14.0, recently moved back to GitHub from Codeberg (fork lineage from
vlastimil-zim **[UNVERIFIED]** from primary sources). Multi-backend: SQLite (sqlite-vec),
Cloudflare, Hybrid, Milvus; ONNX local embeddings; claims ~5ms retrieval. Ships REST + MCP +
OAuth + CLI + web dashboard, plus `claude-hooks/` and `opencode/` integration directories.
Features: temporal metadata injection (`@timestamp`), deduplication with `conversation_id`
bypass, autonomous consolidation, causal knowledge graph, NLI-based contradiction detection
(RFC #732), Insight Cards, `X-Agent-ID` auto-tagging, AND/OR tag matching on `memory_search`.
MCP tools (as of v11.x; core names verified from README/handler commits): `store_memory`,
`recall_memory` (agentic retrieval), `memory_search`, `memory_resolve` (dedup/merge resolution),
`dashboard_memory`, `delete_memory_by_hash`, `get_memory_by_hash`, `get_memory_uri`,
`get_recent_memories`, `get_all_tags`, `get_tag_catalog`, `get_directories`, `get_memory_stats`,
`get_observation`(+details), plus usage/health helpers. Notable for onememory: two-step retrieval
(search → fetch details), resolve-as-a-tool for conflicts, temporal injection at store time.

#### C.3 basicmachines-co/basic-memory

https://github.com/basicmachines-co/basic-memory — 4.1k stars, AGPL-3.0, Python, v0.23.2.
Markdown-file-first: knowledge lives in human-readable notes (Obsidian-compatible) with a typed
knowledge schema (entities/observations/relations in frontmatter), indexed into SQLite (default)
or **Postgres** (added #439; pgvector compose #840); a sync layer keeps files ↔ DB consistent
(`basic-memory doctor`, `reindex`). MCP tools (~25): `search_notes`, `read_note`, `write_note`,
`edit_note`, `move_note`, `delete_note`, `view_note`, `read_content`, `recent_activity`, `build_*`,
`create_memory_project`, `delete_project`, `schema_infer`, `schema_validate`, `schema_diff`,
`search`, `fetch`, `basic_memory_diagnostics` — text output by default, `output_format="json"`
for structured. Multi-project with local/cloud routing (`--local`/`--cloud`). Design decisions
worth stealing: **`write_note` can only overwrite the revision the caller read** (optimistic
concurrency, #1642); Redis caching for QUERY/MCP reads (#1172); a "hook producer front door" for
harness capture (#1070); one-command Claude Code plugin install (#1498); a Codex plugin
`.mcp.json`; a **Pi memory package** (Sep 2026). AGPL is a licensing note for design borrowing.

#### C.4 mem0 OpenMemory

https://mem0.ai/blog/introducing-openmemory-mcp and https://github.com/mem0ai/mem0
(`openmemory/` subdirectory) — local-first, Docker-composed stack (API server + vector DB + MCP
server + dashboard UI at `localhost:3000`); SSE endpoints scoped per client+user
(`http://localhost:8765/mcp/<client>/sse/<user>`, wired via `npx install-mcp`). Deliberately tiny
MCP surface: `add_memories`, `search_memory`, `list_memories`, `delete_all_memories`. The
interesting part is the Mem0 platform pipeline (LLM extraction/consolidation) behind it, the
cross-client "memory follows the user" framing, and the browser extension — a product-level
competitor to onememory's "one memory across every agent" positioning rather than a tools-level
one.

#### C.5 thedotmack/claude-mem

https://github.com/thedotmack/claude-mem — 95.2k stars, v13.28.0, Apache-2.0, TypeScript. The
most successful Claude-Code-native memory system, and the closest existing analog to onememory's
lifecycle idea:

- **Capture via hooks** (7 hook scripts per https://docs.claude-mem.ai/architecture/hooks), not
  agent discipline: transcript/tool events are captured and queued.
- **Background Bun worker** (local HTTP API + web viewer + search endpoints) generates LLM
  "observations" (providers: claude-mem observer, Anthropic plan, OpenRouter, Gemini, any
  OpenAI-compatible endpoint), with visible operational hardening in commits (wedged-worker
  recycling #3476, provider-deprecation fallbacks #3662).
- **Storage**: SQLite (FTS5) for sessions/observations/summaries + **Chroma** vector DB for
  hybrid search (https://docs.claude-mem.ai/architecture/database,
  /architecture/search-architecture).
- **Retrieval = progressive disclosure across 3 MCP tools**: `search` (compact index with IDs,
  ~50–100 tokens/result, filters by type/date/project) → `timeline` (chronological context) →
  `get_observations` (full details for selected IDs only, ~500–1,000 tokens/result, batched) —
  advertised as **~10x token savings**. The strongest existence-proof for onememory's
  "retrieval packs a token budget with information-dense memories" thesis.
- **Injection at SessionStart** (context configuration,
  `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES`), citations by observation ID, progressive
  disclosure with token-cost visibility, cloud sync to cmem.ai, multi-harness reach (Claude Code,
  OpenClaw, Codex, Gemini, Hermes, Copilot, OpenCode via `opencode.json` registration, Cursor,
  Grok Bot via chat-log watching). The awareness pilot writes markdown memory logs
  (`memory/log/YYYY-MM.md`) for bots that re-read files from disk — a file-based fallback channel.

#### C.6 Skims (lower confidence, repo descriptions / search snippets only — `[SKIM]`)

- **CheMiguel23/MemoryMesh** (https://github.com/CheMiguel23/MemoryMesh): schema-driven knowledge
  graph — predefined node types validated via JSON Schema, relation constraints, role-based
  profiles. Precursor idea to onememory's typed layers: validate memory shape at write time.
- **alioshr/memory-bank-mcp** (https://github.com/alioshr/memory-bank-mcp): MCP server for the
  Cline "Memory Bank" pattern (structured project-doc markdown bank, remote management). The
  memory-bank family demonstrates the file-based, human-readable school of agent memory.
- **nathaniel-gordon/memcurve** (https://github.com/nathaniel-gordon/memcurve): temporal memory
  using the **Ebbinghaus forgetting curve** with MCP integration — reinforcement/decay as
  retrieval re-ranking, closest existing analog to onememory's reinforce/decay lifecycle stages.
- **NevaMind-AI/memU** (https://github.com/NevaMind-AI/memU): "memory harness for proactive AI
  agents — structured storage, intent capture, 10x token reduction", personal memory across
  agents (targets 24/7 agents like OpenClaw); the older KuchikiRenji/memU
  (https://github.com/KuchikiRenji/memU) is an agentic memory framework ingesting multi-modal
  data into structured memory with RAG + LLM-based retrieval.
- **codenamev/claude_memory** (https://github.com/codenamev/claude_memory): long-term
  self-managed memory for Claude Code using hooks + MCP tools + SQLite — the minimal
  hooks+MCP+SQLite pattern in one repo. **sdsrss/claude-mem-lite**
  (https://github.com/sdsrss/claude-mem-lite): single-SQLite MCP memory with hybrid FTS5 + TF-IDF
  search and episode batching — evidence that the claude-mem full stack has a "lite" gap.

---

## Recommended onememory MCP surface

The planned 11 tools: `memory_search`, `memory_get`, `memory_store`, `memory_update`,
`memory_delete`, `memory_forget`, `memory_related`, `memory_project_context`,
`memory_decisions`, `memory_failures`, `memory_skills`. Assessment against observed reality:

1. **Split the surface into core verbs + kind filters.** Real servers cluster at 3–9 tools
   (claude-mem 3–4, OpenMemory 4, official demo 9, doobidoo 15+; basic-memory ships ~25 but had
   to run a dedicated audit of model-facing text to fix contract errors). Eleven flat tools
   dilute tool selection and spend description budget (Claude Code truncates descriptions at
   2,048 chars and loads tools lazily via ToolSearch; Pi defaults tools to codemode).
   Recommendation: keep `memory_search/get/store/update/delete/forget/related/project_context`
   (8) and fold **decisions/failures/skills into `memory_search(kind=...)`** — matching claude-mem
   `search(type="bugfix")` and Claude Code skills' kind-like discoverability. If distinct tools
   win internal evals, keep the 11 but mark the curated four `deferred`/searchable rather than
   eagerly loaded.
2. **Make `memory_project_context` the session-start tool and pair it with hooks.** The winning
   pattern is injection, not polling: claude-mem injects at SessionStart via hooks; Claude Code
   auto memory loads 200 lines/25 KB every session; basic-memory has a hook producer front door.
   `onemem init` should install hook handlers (SessionStart → inject packed context;
   Stop/PostToolUse → capture transcript deltas) for Claude Code, Codex, Cursor (hook shapes are
   now cross-compatible), with the tool as fallback for non-hook runtimes.
3. **Progressive disclosure with token budgets on every read tool.** Copy claude-mem's
   three-layer economics: `memory_search` returns an ID-index (one line + token estimate per
   memory, ~50–100 tokens), `memory_get`/`memory_related` return full records for selected IDs
   only. Include `token_estimate` in `structuredContent` and honor a `max_tokens` hint — Codex
   enforces `output_token_limit` per tool, so predictable output sizes directly protect users.
4. **Merge or clearly separate delete vs. forget.** To a model they look identical. Either
   differentiate hard — `forget` = soft expiry/decay (`valid_until`, archive, recoverable),
   `delete` = hard removal — and say so in each description's first sentence, or ship one tool
   with a `mode` parameter. Mark both `destructiveHint: true`; mark `memory_store`/`memory_update`
   `idempotentHint` where true (https://modelcontextprotocol.io/specification/latest/basic/tools).
5. **Write-path semantics to adopt from peers.** `memory_store` returns the stored ID plus a
   dedup outcome (new | merged | superseded; cf. doobidoo `memory_resolve`, mem0 consolidation)
   rather than silently merging; `memory_update` requires the revision the caller read
   (basic-memory #1642) and manages `valid_from`/`valid_until` transitions. Return conflicts as
   `isError: true` results, not exceptions.
6. **Structured output everywhere**: `outputSchema` + `structuredContent` (spec since 2025-06-18)
   with human-readable `content` for weaker clients; keep handles (IDs, cursors) opaque and
   per-instance (https://modelcontextprotocol.io/specification/latest/basic/tools).
7. **Transport plan**: stdio primary (all five runtimes, zero network config, inherits project
   dir) via `serveStdio` on TS SDK v2 (Bun-supported); optional Streamable HTTP via
   `createMcpHandler` for a shared/hosted server — stateless by design, matching the 2026-07-28
   direction. No SSE. No dependence on deprecated Roots/Sampling/Logging (SEP-2577): infer
   workspace from `CLAUDE_PROJECT_DIR`/launch dir; run consolidation in onemem's own worker
   (like claude-mem's Bun worker), not via Sampling.
8. **Defer 2026-07-28-only features** (MRTR `input_required`, `ttlMs`/`cacheScope`,
   `server/discover`, per-request `_meta`) until client adoption is confirmed — none of the five
   runtimes' docs document them yet [UNVERIFIED]. MRTR is the natural fit for a future
   `memory_resolve`-style clarification loop; note it in the ADR, don't ship it first.
9. **Ship the discovery artifacts beyond tools**: short server `instructions` (self-contained in
   the first 512 chars for Codex, <2,048 total for Claude Code); a Claude Code skill + `.mdc`/
   `.pi` equivalents describing when to use memory; `onemem init` emitting per-runtime config
   (`.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, `opencode.json`, `.pi/mcp.json`) with
   the correct per-runtime env expansion syntax.

## Per-runtime integration matrix

| Runtime | MCP config (file/CLI) | Transports | Scopes / trust | Tool exposure & budgets | Hooks for capture/injection | Native memory surface | Gotchas for onemem |
|---|---|---|---|---|---|---|---|
| Claude Code | `claude mcp add*`, `.mcp.json` (project), `~/.claude.json` (user) | stdio, http, sse, ws, sdk | workspace trust + per-project server approval | ToolSearch default ON; `alwaysLoad`; descriptions truncated 2,048 chars; prompts `/mcp__s__p`; `@s:uri` | Richest set (SessionStart/PreToolUse/PostToolUse/Stop/…); `transcript_path` JSONL; `additionalContext` injection | CLAUDE.md/rules hierarchy + **auto memory** `MEMORY.md` (200 lines/25KB auto-loaded) + skills (1% listing budget) | `${VAR}` expansion; `CLAUDE_PROJECT_DIR` for stdio; tool names `mcp__server__tool` |
| Codex CLI | `~/.codex/config.toml` `[mcp_servers.n]`; `codex mcp add` | stdio, Streamable HTTP (+`oauth|chatgpt`) | per-project `.codex/config.toml` for trusted projects | `enabled_tools`/`disabled_tools`; per-tool `approval_mode`; **per-tool `output_token_limit`**; 10s startup/60s tool timeouts | Claude Code-mirrored hooks (hooks.json / `[hooks]`); ~2,500-token `additionalContextLimit`; `rollout.jsonl` transcripts | AGENTS.md (root→cwd, 32 KiB cap); memories **off by default**; `disable_on_external_context` defaults **false** | instructions: first 512 chars self-contained; TOML env tables; native-memory/MCP exclusion is opt-in, not default |
| Cursor | `.cursor/mcp.json` + `~/.cursor/mcp.json` | stdio, SSE, Streamable HTTP | enterprise allowlists + network controls | MCP Apps, Elicitation supported; Run Modes/tool approval | `.cursor/hooks.json`; **`beforeMCPExecution`/`afterMCPExecution`**; `sessionStart` additional_context; `stop` loop (limit 5) | `.cursor/rules/*.mdc` (plain .md ignored), AGENTS.md; Memories 2.x `[UNVERIFIED details]` | `${env:VAR}` syntax; static-OAuth only (no DCR/CIMD) for remote servers |
| OpenCode | `opencode.json` `"mcp"` key; `opencode mcp auth/list/logout` | local (stdio), remote (HTTP) | precedence chain incl. managed MDM config | `enabled`, `timeout` (5s default) | plugins (`.opencode/plugins/`) + agent `instructions` option | SKILL.md skills, agents, commands, permissions; AGENTS.md via instructions | `{env:NAME}`/`{file:path}` substitution; DCR-era OAuth (token store `mcp-auth.json`) |
| Pi | `~/.pi/agent/mcp.json` + `.pi/mcp.json` (project trust); `pi mcp add/list/login` | stdio, **Streamable HTTP only (SSE rejected)** | project `.pi/mcp.json` requires trust approval | codemode default; `deferred` via tool_search; `direct`; `hidden`; `toolExposure` patterns; 20 KB tool-text truncation; annotations honored | **Extensions API** (`pi.on()` session/tool lifecycle, `registerTool`, `registerCommand`, `registerMcpServer`) — deepest integration surface | none built in (harness is minimal); basic-memory ships a Pi package as precedent | CIMD OAuth; `mcp__server__tool` + hash suffix on collision; per-server description in system prompt |

Sources per row: Claude Code (https://code.claude.com/docs/en/mcp, /hooks, /memory, /skills);
Codex (https://learn.chatgpt.com/docs/mcp, /hooks, /agent-configuration/agents-md, /memories);
Cursor (https://cursor.com/docs/mcp, /context/rules-for-ai, /agent/hooks);
OpenCode (https://opencode.ai/docs/mcp-servers/, /config/);
Pi (https://github.com/earendil-works/pi, docs/extensions.md, docs/mcp.md).

---

## Open questions

1. **2026-07-28 client adoption**: which of the five runtimes actually implement per-request
   `_meta`, `server/discover`, `subscriptions/listen`, MRTR, and `ttlMs` caching today? None of
   their docs mention these yet [UNVERIFIED]. Blocks any onemem use of the new features.
2. **Cursor Memories**: is there an official doc page? Secondary sources only (flagged above);
   if Cursor auto-writes account-level memories, onemem's dedup/entity-resolution should treat
   them as just another ingest source.
3. **Codex native memories vs. MCP memory**: RESOLVED (mission 7, verified against the Codex
   source): `memories.disable_on_external_context` defaults to **false**, so chats using onememory
   tools are not excluded from Codex's own memory extraction unless the user opts in. No default
   division of labor exists and no flag flip needs recommending.
4. **doobidoo/mcp-memory-service fork lineage** (vlastimil-zim → doobidoo) unverified from
   primary sources; harmless for onemem but worth a footnote correction if resolved.
5. **Pi Durable** (shipped with Pi 1.0, Oct 2026): does it persist session state in a way
   onememory's Pi extension should hook into (session_start/shutdown events) rather than only
   MCP? Deeper Pi docs reading needed.
6. **MCP Apps / Elicitation** (Cursor supports both): could onemem's review/dedup-approval flows
   surface as MCP Apps UI cards instead of CLI prompts for remote users?
7. **Tasks extension**: official extension now — is it a fit for long-running consolidation jobs
   (onemem's consolidate/decay stages) surfaced to the agent as a task?
8. **AGENTS.md vs CLAUDE.md** convergence: both Codex and Cursor read AGENTS.md; Claude Code
   reads it as fallback (configurable). Should `onemem init` maintain a generated index/pointer
   in both, or neither (avoiding stale duplication)?
9. **Naming collision policy**: with several memory servers commonly installed side by side,
   tool names `mcp__onememory__memory_search` vs `mcp__othermem__memory_search` collide
   semantically for models; Pi adds hash suffixes. Should onemem's curated tools use more
   distinctive names (e.g., `memory_context`, `memory_recall`) to survive multi-memory setups?
