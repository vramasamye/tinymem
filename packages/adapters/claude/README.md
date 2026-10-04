# @onememory/adapter-claude

The Claude Code adapter for [onememory](../../../README.md) — the local-first persistent memory
engine for AI coding agents. It turns Claude Code's **hook events** into validated
`OnememoryEvent`s and delivers them to the onememory daemon's REST ingest endpoint; it also
injects onememory's compact project context into every new session (ADR-0010 §6: *injection beats
polling*).

```
Claude Code ──hooks──▶ onemem-claude-hook ──translate──▶ OnememoryEvents ──POST──▶ onememory daemon
                              │
                              └──SessionStart──▶ GET /context ──▶ {"hookSpecificOutput": …additionalContext}
```

## What it captures

| Claude Code hook | OnememoryEvent(s) | Notes |
|---|---|---|
| `PostToolUse` (Bash / PowerShell) | `terminal.output` | `exit_code: 0`; stdout (stderr only when stdout is empty), clamped to the schema max. Background runs and interrupted commands are **dropped with counted reasons** — their output is not in the payload. |
| `PostToolUse` of `git commit` | `terminal.output` + `git.commit` | The commit event is enriched from one read-only `git log -1` (sha, author, message, files) and only minted when git's `[branch sha]` summary line agrees with HEAD — `echo "git commit"` and `-q` commits are dropped honestly. |
| `PostToolUse` (Edit / Write / NotebookEdit) | `file.changed` | Paths relativized under the project root; `Edit` reports exact `lines_added`/`lines_removed` from `old_string`/`new_string`; `Write` claims `lines_added` only for a documented `{type: "create"}` response. Unknown deltas are omitted, never guessed. |
| `PostToolUseFailure` | `terminal.output` + `error.raised` (origin `terminal`), or `error.raised` (origin `tool`) | Command failures parse the documented `Exit code N` first line; non-command tools mint a single tool-origin error. Interrupts are not errors — dropped. |
| `Stop` | `conversation.message` + `explicit.remember` | The turn's transcript delta (uuid cursor in `.onememory/adapters/claude.json`): user/assistant utterances as `conversation.message` with the transcript's own timestamps; imperative "remember that…" utterances as `explicit.remember`. The final assistant text comes from the documented `last_assistant_message` field. |
| `SessionStart` | `session.start` | Also fetches `GET /v1/projects/{id}/context?budget=750` and prints the documented `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` on stdout. `source: "compact"` is compaction, not a boundary — context is still injected, no event is minted. |
| `SessionEnd` | `session.end` | Reason recorded in the summary. |

Every event envelope is minted complete (uuidv7 `id`, `occurred_at`, `ingested_at`,
`content_hash`, `redactions: []`) and passes `validateOnememoryEvent` before it leaves the
adapter; anything that cannot be mapped honestly is dropped with a **counted, stable reason code**
— never coerced, never faked.

## The fail-soft contract

The hook binary (`src/bin.ts`, `onemem-claude-hook`) **always exits 0**. Claude Code treats
exit 2 as "block the agent" — onememory never emits it. Every failure (unparseable stdin, no
project, dead daemon, timeout, unreadable transcript, missing git) resolves to a **skipped**
outcome plus one machine-readable JSON line on stderr (exit code 0 sends stderr to the debug
log only, never to Claude). Diagnostics carry reasons and counts only — never payload contents,
never transcripts, never secrets.

Budgets: 1000ms delivery, 1500ms context fetch, 2s git, 32MB transcript read cap, 500 events per
delivery (the daemon's ingest limit). When the daemon is down, nothing is delivered and the
transcript cursor is **not** advanced — the delta retries on the next `Stop` (the daemon dedupes
exact payload duplicates, so over-delivery is safe).

## What the adapter persists

One file: `.onememory/adapters/claude.json` — per-session transcript uuid cursors. **Uuids only,
never content.** Everything else is read from `.onememory/project.json` (the project pointer) and
`.onememory/daemon.json` (the daemon lock, pid-liveness-checked) — both discovered git-style
upward from the hook's `cwd`, with `ONEMEMORY_PROJECT_ID` / `ONEMEMORY_DAEMON_URL` env overrides.

## Scaffolds (what `onemem init` writes)

Pure builders and merges; `onemem init --with-claude` (or the interactive runtime prompt)
performs the writes, and `onemem doctor` reads them back through `inspectClaudeScaffold`:

- **`.mcp.json`** — `mcpServers.onememory = {"type": "http", "url": "http://<daemon.host>:<daemon.port>/mcp"}`,
  the daemon's Streamable HTTP surface (ADR-0010 amendment 2026-10-04: the daemon is the single
  owner of embedded storage). Loopback `http:` only, no headers (Phase 1 has no auth).
  `mergeMcpJson` replaces only the `onememory` entry; every other server and top-level key is
  preserved. The stdio form (`buildMcpJson()` without `transport`, for the standalone
  `onememory-mcp` bin) is still exported for daemon-less / server-profile use, with
  `${CLAUDE_PROJECT_DIR:-.}`-relative paths and env passed **by name**
  (`ONEMEMORY_PG_URL: "${ONEMEMORY_PG_URL}"`) so no URL or secret is ever committed.
- **`.claude/settings.json` hooks** — the five subscriptions above; `PostToolUse` matcher
  `Bash|PowerShell|Edit|Write|NotebookEdit`, `PostToolUseFailure` matcher `*`, `SessionEnd`
  timeout raised to 5s (hook timeouts are in seconds); exec form (`command` + `args`, no shell).
  `mergeClaudeSettingsHooks` removes onememory's own handlers (by bin token or exact invocation)
  and appends the generated groups — user handlers and settings are preserved, re-runs never
  duplicate, and malformed JSON is reported and left untouched.
- **`CLAUDE.md` pointer block** — a marker-delimited, idempotent paragraph stating
  that durable project memory lives in onememory (ADR-0010 §7: *interop, not competition* —
  Claude Code's MEMORY.md stays a valid ingest source, never a duplicate knowledge base).

Claude Code asks you to approve project-scoped `.mcp.json` servers the first time you run
`claude` in the project; until then the server shows as pending approval.

## Install

`onemem init --with-claude` wires all three scaffolds; start the daemon (`onemem serve`) before
launching Claude Code. Manual wiring: `bun add @onememory/adapter-claude`, then register
`onemem-claude-hook` under the hook events above and the http server under
`mcpServers.onememory` in `.mcp.json`.

## Package facts

- Depends only on `@onememory/core` + `zod` — the hook spawns on every tool call, so the import
  graph stays minimal (the two cross-process wire formats, `project.json` and `daemon.json`, are
  re-declared as tiny strict schemas here rather than importing the config/api packages; see
  mission-6.md for the rationale).
- Translation is pure (no clock, fs, or network in `translateHookInput`); every seam of `runHook`
  (fetch, git runner, transcript reader, output sinks, env, clock) is injectable — the whole
  pipeline is tested by spawning the real bin against a fake daemon.
- `bun test` in this package: the translation contract, transcript parsing (the JSONL format is
  documented as internal and version-dependent, so the parser is tolerant and counts every drop),
  remember-utterance patterns, git enrichment, scaffold schema validation, delivery over a real
  fake HTTP server (timeouts, fail-soft, no-secret-leak), and full hook-binary integration runs.
