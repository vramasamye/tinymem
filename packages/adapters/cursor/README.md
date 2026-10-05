# @onememory/adapter-cursor

The Cursor adapter for onememory (ADR-0010). It is a **translator**: Cursor-native hook activity
becomes validated `OnememoryEvent` envelopes (`source.runtime: 'cursor'`), delivered to the
daemon's public REST surface. It never opens storage, never blocks the agent, and never lets a
secret reach the wire.

`onemem init --with-cursor` writes the three artifacts below; the hook binary `onemem-cursor-hook`
is what Cursor then runs.

## What `onemem init --with-cursor` writes

| Artifact | Purpose | Source of truth |
|---|---|---|
| `.cursor/mcp.json` | `mcpServers.onememory` → the daemon's Streamable HTTP `/mcp` surface | https://cursor.com/docs/mcp |
| `.cursor/hooks.json` | the capture hooks (one bin, dispatched by `hook_event_name`) | https://cursor.com/docs/hooks |
| `.cursor/rules/onememory.mdc` | an always-applied pointer rule steering the agent at the MCP tools | https://cursor.com/docs/rules |

All three merges are idempotent (re-running changes nothing), preserve foreign servers/hooks/keys,
and refuse to overwrite a file they cannot parse. `dryRun: true` returns the exact bytes without
touching disk.

Notes that come from Cursor's own documentation:

- Project rules **must** use the `.mdc` extension with frontmatter; a plain `.md` in
  `.cursor/rules` is ignored. The rule is emitted with `alwaysApply: true` (a bootstrap that is
  only @-mentionable would not bootstrap anything).
- **Project hooks run from the project root**, so the scaffolded command is the relative
  `bun node_modules/@onememory/adapter-cursor/src/bin.ts`. `CURSOR_PROJECT_DIR` is exported to
  every hook and is used as a fallback when discovering the project.
- `mcp.json` values support `${env:NAME}` and `${workspaceFolder}`; values that must come from the
  user's environment (e.g. a Postgres URL in server mode) are emitted as `${env:NAME}`, so no
  secret ever enters the file.
- Cursor asks for **tool approval** before an MCP tool runs. `onemem init` prints this as a
  required review step; approve the onememory tools once (or add them to your Run Mode allowlist).

## Hook coverage

Subscribed (`.cursor/hooks.json`):

| Cursor hook | Onememory event | Notes |
|---|---|---|
| `sessionStart` | `session.start` + context injection | output `{"additional_context": …}`; Cursor runs it **fire-and-forget** ("the agent loop does not wait for or enforce a blocking response"), so injection is best-effort by Cursor's design |
| `sessionEnd` | `session.end` | the daemon's working-memory sweep trigger |
| `beforeSubmitPrompt` | `conversation.message` (user) / `explicit.remember` | an imperative "remember …" prompt becomes one `explicit.remember` |
| `afterAgentResponse` | `conversation.message` (assistant) | the final assistant text |
| `postToolUse` (matcher `Shell`) | `terminal.output` | exit code read from the documented JSON-stringified `tool_output` |
| `postToolUseFailure` | `error.raised` (+ `terminal.output` for Shell) | `origin: 'terminal'` for Shell, `'tool'` otherwise |
| `afterFileEdit` | `file.changed` | exact line deltas from the edit's `old_string`/`new_string` |

Deliberately **not** subscribed, with the reason:

| Cursor hook | Why not |
|---|---|
| `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` | permission hooks — onememory has no permission opinion and will not return an `allow` the user did not ask for |
| `afterShellExecution` | `postToolUse` already carries the Shell command and exit code; subscribing both would double-report one execution |
| `beforeMCPExecution` / `afterMCPExecution` | MCP tool traffic is not captured by the Claude adapter's hook path either (conformance parity) |
| `beforeTabFileRead`, `afterTabFileEdit`, `workspaceOpen` | outside the agent session; no memory event corresponds to them |
| `stop` | per-turn loop end (`{status, loop_count}`): no transcript, no lifecycle semantics. The working-memory sweep rides `sessionEnd` → `session.end` |

## Documented gaps (honest limits of Cursor's contract)

1. **No exit code for a failed command.** `postToolUseFailure` carries `error_message` +
   `failure_type`; `afterShellExecution` carries `command`/`output`. Neither carries an exit code,
   so the failure's `terminal.output` has `exit_code: null`. Failure detection is unaffected: all
   runtimes emit `error.raised`, which is what the extractor reads first. A *successful* Shell
   execution does carry `exitCode` inside the documented `tool_output` JSON.
2. **No transcript parsing.** Cursor exposes `transcript_path` / `CURSOR_TRANSCRIPT_PATH`, but the
   transcript file format is **not documented**. Parsing it would fabricate provenance, so
   conversation capture is limited to `beforeSubmitPrompt` (user) and `afterAgentResponse`
   (assistant). Claude's per-turn transcript deltas have no Cursor equivalent.
3. **Context injection is fire-and-forget.** Cursor documents `additional_context` as an output of
   `sessionStart` but does not wait for or enforce it. The hook still bounds its own work
   (1500 ms fetch + 1000 ms delivery).
4. **No documented size cap on `additional_context`.** The adapter applies its own 10,000-character
   ceiling (`ADDITIONAL_CONTEXT_MAX`), matching the Claude adapter's documented cap, with an honest
   stderr note when it triggers.

## Conformance

`benchmarks/eval/src/adapter-conformance/cursor.test.ts` runs ONE canonical session through all
three adapters' own translation entry points and then through the real engine (PGlite storage +
migrations, the real extract job over the heuristic extractor, the real retrieval engine). Cursor
produces **identical** memories, evidence, working-memory rows, `memory.search` ranking, and
`memory_get` payload to the Claude adapter. Against Codex the results are identical except one
pre-existing Codex normalization difference (Codex keeps the trailing period of an
`explicit.remember` clause; Claude and Cursor strip it), pinned by a dedicated test.

## One owner per data dir

Embedded storage has exactly one owner process — `onemem serve` (ADR-0002). `onemem init` therefore
scaffolds the daemon's HTTP MCP URL, not a stdio server, and the adapter never opens storage itself.
